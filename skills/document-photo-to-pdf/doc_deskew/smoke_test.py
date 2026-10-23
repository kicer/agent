#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""合成样张回归测试（不依赖真实照片）。

覆盖：
  1. 单页透视校正 + JSON 输出 + PDF 生成 + state 文件
  2. EXIF Orientation=6 的转正
  3. 批次方向不一致时的旋转告警
  4. paper=a4 的画布尺寸
  5. orientation=none 的混排
  6. orientation=landscape 的强制方向

运行：
    python3 skills/document-photo-to-pdf/doc_deskew/smoke_test.py
"""
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from homography import _solve_h  # noqa: E402
import check  # noqa: E402
from params import P  # noqa: E402

W_PAGE, H_PAGE = 900, 1272
QUAD = [(200, 240), (1080, 190), (1120, 1420), (150, 1380)]
PHOTO_SIZE = (1200, 1600)


def make_page():
    im = Image.new("RGB", (W_PAGE, H_PAGE), "white")
    d = ImageDraw.Draw(im)
    for i in range(18):
        y = 90 + i * 58
        d.line([(90, y), (W_PAGE - 90, y)], fill=(30, 30, 30), width=8)
        if i % 4 == 0:
            d.line([(90, y + 18), (W_PAGE - 300, y + 18)],
                   fill=(60, 60, 60), width=5)
    return im


def make_photo(page, quad=QUAD, size=PHOTO_SIZE):
    bg = Image.new("RGB", size, (38, 42, 48))
    dst = [(0, 0), (W_PAGE - 1, 0), (W_PAGE - 1, H_PAGE - 1),
           (0, H_PAGE - 1)]
    H = _solve_h(quad, dst)
    H = H / H[2, 2]
    coeffs = (H[0, 0], H[0, 1], H[0, 2],
              H[1, 0], H[1, 1], H[1, 2],
              H[2, 0], H[2, 1])
    warped = page.transform(size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    mask = Image.new("L", (W_PAGE, H_PAGE), 255)
    mask = mask.transform(size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    mask = mask.point(lambda v: 255 if v > 127 else 0)
    photo = bg.copy()
    photo.paste(warped, mask=mask)
    return photo


def run_skill(args, cwd):
    proc = subprocess.run(
        [sys.executable, os.path.join(SKILL, "run.py"),
         json.dumps(args, ensure_ascii=False)],
        cwd=cwd, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    # stdout 必须是纯 JSON（不含进度日志）
    data = json.loads(proc.stdout)
    assert isinstance(data, dict)
    return data


def assert_corners(got, want, tol=35):
    assert len(got) == 4, got
    for (gx, gy), (ex, ey) in zip(got, want):
        assert abs(gx - ex) <= tol and abs(gy - ey) <= tol, (
            "角点偏差过大：got=%s want=%s" % (got, want))


def assert_checks(res):
    checks = res.get("checks") or {}
    if checks.get("ok") is None:
        print("[skip] PDF 渲染不可用：%s" % checks.get("error"))
        return
    assert checks.get("ok") is True, checks
    assert checks["page_count"]["ok"], checks


def verbose(label, res):
    if not os.environ.get("SMOKE_VERBOSE"):
        return
    print("[%s] %s" % (label, json.dumps({
        "summary": res.get("summary"),
        "batch": res.get("batch"),
        "warnings": res.get("warnings"),
        "checks": res.get("checks"),
    }, ensure_ascii=False, indent=2)))


def make_composed_page(strip=None, edge_text=False):
    """造一张“PDF 渲染页”：白画布 + 居中纸面（~245 亮度）。"""
    canvas = Image.new("RGB", (1240, 1754), "white")
    paper = Image.new("RGB", (1160, 1640), (245, 245, 245))
    d = ImageDraw.Draw(paper)
    for i in range(12):
        y = 120 + i * 90
        d.line([(100, y), (1060, y)], fill=(30, 30, 30), width=8)
    if strip is not None:
        d.rectangle([0, 0, 1159, strip - 1], fill=(60, 60, 60))
    if edge_text:
        d.rectangle([60, 0, 1100, 4], fill=(0, 0, 0))
    canvas.paste(paper, (40, 57))
    return canvas


def test_analyse():
    """直接验证 check.analyse 量的是纸边，不是 PDF 白边。"""
    normal = check.analyse(make_composed_page(), P)
    assert not normal["border_bad"], normal["border_bad"]
    assert not normal["cut"], normal["cut"]

    residue = check.analyse(make_composed_page(strip=12), P)
    assert "top" in residue["border_bad"], residue["border_bad"]
    assert residue["edge_dark"]["top"] > P["check"]["edge_dark_frac"], residue

    cut = check.analyse(make_composed_page(edge_text=True), P)
    assert any(k == "top" for k, _ in cut["cut"]), cut["cut"]


def main():
    test_analyse()
    page = make_page()
    photo = make_photo(page)

    with tempfile.TemporaryDirectory() as td:
        # 1. 单页 + auto
        src = os.path.join(td, "图1.jpg")
        photo.save(src, quality=92)
        res = run_skill({"images": ["图1.jpg"], "output": "结果.pdf",
                         "paper": "auto"}, td)
        assert res["ok"], res
        assert res["output"]["pages"] == 1, res
        assert os.path.exists(res["output"]["path"])
        assert_corners(res["pages"][0]["corners"], QUAD)
        assert_checks(res)
        # 低分辨率纸面也要放大到内容区，避免各页大小不一
        assert res["pages"][0]["out_size"][0] == 1160, res["pages"][0]
        assert os.path.exists(res["output"]["state"])
        verbose("auto", res)

        # check.py CLI 也跑一遍（executor 有渲染后端时）
        if (res.get("checks") or {}).get("ok") is not None:
            cli = subprocess.run(
                [sys.executable, os.path.join(HERE, "check.py"),
                 res["output"]["path"], "--expect-pages", "1"],
                capture_output=True, text=True)
            assert cli.returncode == 0, cli.stdout + cli.stderr

        # 2. EXIF Orientation=6：存 90° CCW + 标记 6，读入应转回原方向
        stored = photo.transpose(Image.ROTATE_90)
        exif = Image.Exif()
        exif[274] = 6
        exif_src = os.path.join(td, "exif.jpg")
        stored.save(exif_src, quality=92, exif=exif)
        res2 = run_skill({"images": ["exif.jpg"], "output": "exif.pdf"}, td)
        assert res2["ok"], res2
        assert_corners(res2["pages"][0]["corners"], QUAD)
        assert_checks(res2)
        verbose("exif", res2)

        # 3. 批次方向：第二页横拍，应被旋转并告警
        sideways = photo.transpose(Image.ROTATE_270)
        side_src = os.path.join(td, "图2.jpg")
        sideways.save(side_src, quality=92)
        res3 = run_skill({"images": ["图1.jpg", "图2.jpg"],
                          "output": "批次.pdf"}, td)
        assert res3["ok"], res3
        assert res3["output"]["pages"] == 2, res3
        assert res3["batch"]["rotated_pages"] == [2], res3["batch"]
        assert res3["pages"][1]["warnings"], res3["pages"][1]
        # 同批页面即使一竖一横，也应放大/缩放到同一版式宽度
        s1, s2 = res3["pages"][0]["out_size"], res3["pages"][1]["out_size"]
        assert s1[0] == s2[0] == 1160, (s1, s2)
        assert abs(s1[1] - s2[1]) <= 2, (s1, s2)
        assert_checks(res3)
        verbose("batch", res3)

        # 4. paper=a4 画布
        res4 = run_skill({"images": ["图1.jpg"], "output": "a4.pdf",
                          "paper": "a4"}, td)
        assert res4["ok"], res4
        assert res4["batch"]["canvas_px"] == [1240, 1754], res4["batch"]
        assert res4["batch"]["content_px"] == [1160, 1674], res4["batch"]
        assert_checks(res4)
        verbose("a4", res4)

        # 5. orientation=none：不旋转，允许横竖混排
        res5 = run_skill({"images": ["图1.jpg", "图2.jpg"],
                          "output": "none.pdf", "orientation": "none"}, td)
        assert res5["ok"], res5
        assert res5["batch"]["orientation"] == "mixed", res5["batch"]
        assert res5["batch"]["rotated_pages"] == [], res5["batch"]
        assert res5["batch"]["canvas_px"] is None, res5["batch"]
        assert_checks(res5)
        verbose("none", res5)

        # 6. orientation=landscape：强制横版，第一页（竖版）被旋转
        res6 = run_skill({"images": ["图1.jpg", "图2.jpg"],
                          "output": "land.pdf",
                          "orientation": "landscape"}, td)
        assert res6["ok"], res6
        assert res6["batch"]["rotated_pages"] == [1], res6["batch"]
        assert_checks(res6)
        verbose("landscape", res6)

    print("SMOKE OK")


if __name__ == "__main__":
    main()
