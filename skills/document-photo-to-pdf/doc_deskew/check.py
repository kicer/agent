# -*- coding: utf-8 -*-
"""PDF 产出的数值检验：渲染真实页面后评估，不画图、不修改文件。

关键修正（相对旧版）：
  - “边缘背景残留 / 内容贴边”改为在 paper_box 裁出的纸面区域上量。
    旧版量的是 PDF 页面最外圈，而正常出件四周是白边，这两项恒为通过。
  - 渲染页按文件名数字自然排序，≥10 页不会出现 1,10,2 的顺序。
  - 渲染后端增加 PyMuPDF（executor 镜像已装 pymupdf），pdftoppm 不在时也能跑。
"""
import argparse
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from params import P  # noqa: E402


def _natural_key(path):
    name = os.path.basename(path)
    out = []
    cur = ""
    for ch in name:
        if ch.isdigit():
            cur += ch
        else:
            if cur:
                out.append((1, int(cur)))
                cur = ""
            out.append((0, ch.lower()))
    if cur:
        out.append((1, int(cur)))
    return out


def otsu(vals):
    v = np.asarray(vals, dtype=np.float64).ravel()
    if v.size == 0:
        return 128.0
    hist, edges = np.histogram(v, bins=64)
    centers = (edges[:-1] + edges[1:]) / 2.0
    total = hist.sum()
    w0 = np.cumsum(hist)
    w1 = total - w0
    m0 = np.cumsum(hist * centers)
    mt = m0[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        score = (mt * w0 / total - m0) ** 2 / (w0 * w1 / total ** 2)
    score = np.nan_to_num(score)
    return float(centers[int(np.argmax(score))])


def render(pdf, dpi=100, outdir=None):
    """把 PDF 逐页渲染成图片，返回按页序排好的文件列表。

    pdftoppm 默认输出 PPM（无损，且不压缩）。之前用 -png 时 zlib 压缩占了
    整个自检 2 秒里的 2 秒；改 PPM 后像素完全一致，耗时降到 0.1 秒量级。
    """
    outdir = outdir or P["check"]["tmp_dir"]
    os.makedirs(outdir, exist_ok=True)
    for f in os.listdir(outdir):
        if f.startswith("page") and (f.endswith(".png") or f.endswith(".ppm")):
            try:
                os.remove(os.path.join(outdir, f))
            except OSError:
                pass

    base = os.path.join(outdir, "page")
    done = False
    if shutil.which("pdftoppm"):
        try:
            subprocess.run(["pdftoppm", "-r", str(dpi), pdf, base],
                           check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
            done = True
        except Exception:
            done = False

    if not done:
        try:
            import fitz  # PyMuPDF
            doc = fitz.open(pdf)
            scale = float(dpi) / 72.0
            for i, page in enumerate(doc):
                pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
                pix.save("%s-%d.png" % (base, i + 1))
            doc.close()
        except Exception:
            import pypdfium2 as pdfium
            doc = pdfium.PdfDocument(pdf)
            scale = float(dpi) / 72.0
            for i in range(len(doc)):
                doc[i].render(scale=scale).to_pil().save(
                    "%s-%d.png" % (base, i + 1))

    files = [os.path.join(outdir, f) for f in os.listdir(outdir)
             if f.startswith("page") and (f.endswith(".png")
                                          or f.endswith(".ppm"))]
    files.sort(key=_natural_key)
    return files


def analyse(img, params=None):
    """分析一张渲染页，返回纸面框、亮度、边缘与贴边指标。"""
    c = (params or P)["check"]
    g = np.asarray(img.convert("L")).astype(np.float32)
    h, w = g.shape
    res = {"w": int(w), "h": int(h), "ratio": float(w) / max(1, h)}

    # 先用“非纯白”找纸面框：PDF 页面四周是白边，纸面被提亮到 ~245
    flat = float(np.percentile(g, c["flat_pct"]))
    nonwhite = g < (flat - c["nonwhite_delta"])
    row_frac = nonwhite.mean(axis=1)
    col_frac = nonwhite.mean(axis=0)
    rows = np.where(row_frac > c["paper_row_frac"])[0]
    cols = np.where(col_frac > c["paper_row_frac"])[0]
    box = None
    if rows.size > 4 and cols.size > 4:
        box = (int(cols[0]), int(rows[0]), int(cols[-1]), int(rows[-1]))
    res["paper_box"] = box
    res["box_fallback"] = box is None

    if box:
        x0, y0, x1, y1 = box
        gp = g[y0:y1 + 1, x0:x1 + 1]
    else:
        gp = g
    ph, pw = gp.shape

    # 透视采样在纸边常带 1~2px 背景毛边，先内缩再量边缘；
    # 否则会被误判成“边缘背景残留”或“内容贴边”。
    inset = max(2, int(round(min(pw, ph) * c["edge_inset_frac"])))
    if pw > 2 * inset + 4 and ph > 2 * inset + 4:
        gc = gp[inset:-inset, inset:-inset]
    else:
        gc = gp
    gh, gw = gc.shape

    res["paper"] = float(np.percentile(gc, c["paper_pct"]))
    res["back"] = float(np.percentile(gc, c["back_pct"]))
    res["ink"] = min(otsu(gc), res["paper"] * c["ink_ratio"])
    res["paper_ratio"] = float(pw) / max(1, ph)
    res["paper_px"] = (int(pw), int(ph))

    # 边缘背景残留：在纸面区域的最外圈量，而不是 PDF 白边
    b = max(4, int(min(gw, gh) * c["border_band_frac"]))
    border = {
        "top": float(gc[:b, :].mean()),
        "bottom": float(gc[-b:, :].mean()),
        "left": float(gc[:, :b].mean()),
        "right": float(gc[:, -b:].mean()),
    }
    res["border"] = border
    res["border_bad"] = [k for k, v in border.items()
                         if v < res["paper"] * c["border_ratio"]]

    edge_dark = {}
    for k, band in (("top", gc[:b, :]), ("bottom", gc[-b:, :]),
                    ("left", gc[:, :b]), ("right", gc[:, -b:])):
        edge_dark[k] = float(
            (band < res["paper"] * c["edge_dark_ratio"]).mean())
    res["edge_dark"] = edge_dark

    # 内容贴边：纸面最外窄带内成片文字级暗像素
    m = max(2, int(min(gw, gh) * c["cut_band_frac"]))
    cut = []
    for k, band in (("top", gc[:m, :]), ("bottom", gc[-m:, :]),
                    ("left", gc[:, :m]), ("right", gc[:, -m:])):
        frac = float((band < res["ink"]).mean())
        if (frac > c["cut_frac"] and
                float(band.mean()) < res["paper"] * c["cut_mean_ratio"]):
            cut.append((k, frac))
    res["cut"] = cut
    return res


def inspect_pdf(pdf, expect_pages=None, dpi=None, params=None):
    """渲染 + 逐页检验，返回结构化结果；渲染失败时 ok=None。"""
    p = params or P
    c = p["check"]
    dpi = int(dpi or c["dpi"])
    outdir = os.path.join(os.path.dirname(os.path.abspath(pdf)), c["tmp_dir"])
    try:
        files = render(pdf, dpi, outdir)
    except Exception as e:
        return {"ok": None, "error": str(e), "pages": [], "page_count": None}

    actual = len(files)
    count_ok = (expect_pages is None) or (actual == expect_pages)
    out = {
        "ok": bool(count_ok),
        "page_count": {"expected": expect_pages, "actual": actual,
                       "ok": bool(count_ok)},
        "pages": [],
    }

    # 阈值以 150dpi 出件为基准；check 用的是较低的渲染 dpi，要同时按出件 dpi
    # 折算，否则选 300dpi 会白白放宽、选 72dpi 会误报“分辨率不足”。
    render_dpi = float(p["render"]["dpi"])
    min_short = c["min_short"] * dpi / render_dpi
    try:
        for i, path in enumerate(files, 1):
            with Image.open(path) as im:
                r = analyse(im, p)
            pw, ph = r["paper_px"]
            short = min(pw, ph)
            short_ok = short >= min_short
            border_ok = ((not r["border_bad"]) and
                         all(v <= c["edge_dark_frac"]
                             for v in r["edge_dark"].values()))
            cut_ok = not r["cut"]
            dev = (abs(r["paper_ratio"] - r["ratio"]) / r["ratio"]
                   if r["ratio"] else 0.0)

            item = {
                "index": i,
                "paper_px": [int(pw), int(ph)],
                "short_side_px": int(short),
                "short_side_ok": bool(short_ok),
                "paper_ratio": round(float(r["paper_ratio"]), 4),
                "page_ratio": round(float(r["ratio"]), 4),
                "ratio_dev_pct": round(float(dev * 100), 1),
                "border_ok": bool(border_ok),
                "cut_ok": bool(cut_ok),
                "border": {k: round(float(v), 1) for k, v in r["border"].items()},
                "edge_dark": {k: round(float(v), 3)
                              for k, v in r["edge_dark"].items()},
                "cut": [[k, round(float(v), 3)] for k, v in r["cut"]],
                "box_fallback": bool(r["box_fallback"]),
                "paper_luma": round(float(r["paper"]), 1),
                "back_luma": round(float(r["back"]), 1),
            }
            out["pages"].append(item)
            if not (short_ok and border_ok and cut_ok):
                out["ok"] = False
    finally:
        # 渲染图只是自检的中间产物：PPM 未压缩，100dpi 的 A4 一页约 3MB，
        # 检验完立刻删（量已经记录在返回值里），不要留在会话目录占空间。
        shutil.rmtree(outdir, ignore_errors=True)
    return out


def main():
    ap = argparse.ArgumentParser(description="复检已有 PDF（只渲染检验）")
    ap.add_argument("pdf")
    ap.add_argument("--expect-pages", type=int, default=None)
    ap.add_argument("--dpi", type=int, default=P["check"]["dpi"])
    args = ap.parse_args()

    if not os.path.exists(args.pdf):
        raise SystemExit("找不到 PDF：%s" % args.pdf)

    r = inspect_pdf(args.pdf, args.expect_pages, args.dpi)
    print("PDF: %s" % args.pdf)
    print("文件大小: %.0f KB" % (os.path.getsize(args.pdf) / 1024.0))
    if r.get("ok") is None:
        print("渲染失败：%s" % r.get("error"))
        return 1
    print("页数: %d" % r["page_count"]["actual"])
    for item in r["pages"]:
        print("\n第 %d 页  纸面 %dx%d" % (
            item["index"], item["paper_px"][0], item["paper_px"][1]))
        print("  [%s] 纸面短边      %d px"
              % ("OK" if item["short_side_ok"] else "XX",
                 item["short_side_px"]))
        print("  [%s] 边缘背景残留  %s"
              % ("OK" if item["border_ok"] else "XX",
                 "无" if item["border_ok"] else "有"))
        print("  [%s] 内容贴边      %s"
              % ("OK" if item["cut_ok"] else "XX",
                 "无" if item["cut_ok"] else
                 "、".join("%s %.1f%%" % (k, v * 100)
                          for k, v in item["cut"])))
        print("  [--] 纸面比例      %.3f（页面 %.3f）"
              % (item["paper_ratio"], item["page_ratio"]))
    print("\n总判定：%s" % ("全部通过" if r["ok"] else "存在不达标项"))
    return 0 if r["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
