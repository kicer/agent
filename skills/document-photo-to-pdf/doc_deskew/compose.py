# -*- coding: utf-8 -*-
"""出页与合成：批次方向、目标尺寸、页面拼版、PDF 保存。

坐标与尺寸约定：
  - 所有 quad 都是“转正后原图”坐标；
  - 目标尺寸把 PDF 画布内容区（页面尺寸 - 四周留白）的一条边填满，可放大低分辨率照片，
    避免同一批页面因原图像素多少而大小不一；
  - raw 页图（裁剪 + 透视拉正、自然尺寸、不调色）由 warp_raw 产出，PDF 页从它派生。
"""
import os
import statistics

import numpy as np
from PIL import Image

from homography import brighten, warp_perspective, warp_perspective_pil


# ---------------------------------------------------------------- 纸张

def resolve_paper(paper, P):
    """把 paper 参数解析成 {name, canvas_mm, ratio}。

    auto       不指定标准纸面比例；画布用 A4，比例由调用方按批次中位数决定
    a4/letter… 画布和纸面比例都用该标准纸
    数字       画布用 A4，纸面比例用该数字（宽/高）
    """
    r = P["render"]
    name = str(paper or r["default_paper"]).strip().lower()
    a4 = r["papers_mm"]["a4"]
    if name in ("", "auto"):
        return {"name": "auto", "canvas_mm": a4, "ratio": None}
    if name in r["papers_mm"]:
        w_mm, h_mm = r["papers_mm"][name]
        return {"name": name, "canvas_mm": (w_mm, h_mm),
                "ratio": float(w_mm) / float(h_mm)}
    try:
        ratio = float(name)
    except ValueError:
        raise ValueError("未知纸张：%s（可选 %s / 数字宽高比 / auto）"
                         % (paper, "/".join(r["papers_mm"])))
    if not (0.02 < ratio < 50.0):
        raise ValueError("纸张比例超出合理范围：%s" % paper)
    return {"name": "custom", "canvas_mm": a4, "ratio": ratio}


def canvas_px(paper, orientation, P):
    """按 dpi 换算画布像素；orientation=landscape 时交换宽高。"""
    w_mm, h_mm = paper["canvas_mm"]
    dpi = float(P["render"]["dpi"])
    cw = int(round(w_mm / 25.4 * dpi))
    ch = int(round(h_mm / 25.4 * dpi))
    if orientation == "landscape":
        cw, ch = ch, cw
    return max(1, cw), max(1, ch)


# ---------------------------------------------------------------- 方向

def aspect_of(quad):
    """四边形在屏幕坐标下的自然宽高（像素）。"""
    q = np.asarray(quad, dtype=np.float64)
    w = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2.0
    h = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2.0
    return max(float(w), 1e-6), max(float(h), 1e-6)


def classify(aspect, deadband):
    if aspect > 1.0 + deadband:
        return "landscape"
    if aspect < 1.0 - deadband:
        return "portrait"
    return "square"


def decide_orientation(aspects, mode, P):
    """返回 (batch_orientation, source, median_aspect)。"""
    dead = P["gate"]["aspect_deadband"]
    median = float(statistics.median(aspects)) if aspects else 1.0
    if mode == "none":
        return "mixed", "none", median
    if mode in ("portrait", "landscape"):
        return mode, "forced", median
    classes = [classify(a, dead) for a in aspects]
    n_land = sum(1 for c in classes if c == "landscape")
    n_port = sum(1 for c in classes if c == "portrait")
    if n_land > n_port:
        return "landscape", "majority", median
    if n_port > n_land:
        return "portrait", "majority", median
    if n_land == 0 and n_port == 0:
        return "portrait", "default", median
    return "portrait", "tie", median


def rotate_quad_cw(quad):
    """把角点序列旋转一位，等价于把页面顺时针转 90°。"""
    q = list(quad)
    return [q[3], q[0], q[1], q[2]]


# ---------------------------------------------------------------- 目标尺寸

def target_size(quad, paper, page_orientation, P, out_ratio=None):
    """返回 (target_w, target_h, (canvas_w, canvas_h))。

    out_ratio 是 auto 模式下按批次中位比例算出的输出宽高比；None 表示按本页
    自然比例。两种分支都把内容区的一条边填满：低分辨率照片会被放大，从而
    避免同一批页面因原图尺寸/分辨率不同而大小不一。
    """
    w_src, h_src = aspect_of(quad)
    cw, ch = canvas_px(paper, page_orientation, P)
    margin = int(P["render"]["margin_px"])
    cont_w = max(1, cw - 2 * margin)
    cont_h = max(1, ch - 2 * margin)

    if paper["ratio"] is not None:
        # 强制纸面比例：宽高比纠正透视压缩。
        r = (paper["ratio"] if page_orientation == "portrait"
             else 1.0 / paper["ratio"])
    else:
        r = out_ratio

    if r is not None:
        tw = float(cont_w)
        th = tw / r
        if th > cont_h:
            th = float(cont_h)
            tw = th * r
    else:
        # auto 且未形成批次比例：按四边形自然比例填满内容区（可放大）。
        s = min(float(cont_w) / w_src, float(cont_h) / h_src)
        tw, th = w_src * s, h_src * s

    return max(1, int(round(tw))), max(1, int(round(th))), (cw, ch)


def warp_raw(img, quad):
    """只做裁剪 + 透视拉正：自然尺寸、不调色。raw 页图的唯一来源。"""
    return warp_perspective_pil(img, quad, None)


def page_for_pdf(raw, size, P):
    """从 raw 页图派生 PDF 页：先调色，再按目标尺寸缩放（LANCZOS）。

    与旧 warp_page 的差别只在采样顺序：先在自然尺寸做透视（超采样），
    再缩到画布内容区，缩小时比直接按目标尺寸采样更少混叠。
    """
    r = P["render"]
    spec = P["enhance"].get(r.get("enhance") or r["default_enhance"])
    page = tone(raw, spec, r["brighten_target"], r["brighten_pct"])
    if page.size != tuple(size):
        page = page.resize(tuple(size), Image.LANCZOS)
    return page


def warp_page(img, quad, size, P):
    """旧路径：直接按目标尺寸 warp + 调色。PIL 实现出问题时回退用。"""
    r = P["render"]
    page = warp_perspective(img, quad, size,
                            chunk_rows=r["warp_chunk_rows"])
    spec = P["enhance"].get(r.get("enhance") or r["default_enhance"])
    return tone(page, spec, r["brighten_target"], r["brighten_pct"])


def tone(img, spec, target=245, pct=97):
    """按调色档做整体映射；spec=None 表示原样返回。

    只做“分位数 -> 目标亮度”的等比缩放（加可选灰度），不碰像素间的
    局部关系，所以同一张图重跑结果一致，也不会重绘文字边缘。
    """
    if not spec:
        return img
    if spec.get("gray"):
        img = img.convert("L").convert("RGB")
    return brighten(img, spec.get("target", target), spec.get("pct", pct))


# ---------------------------------------------------------------- PDF

def build_pdf(pages, out_pdf, canvases, P):
    """把已校正的页面图居中放进各自画布，按顺序写 PDF。

    pages / canvases 一一对应；画布可能因 orientation=none 而不同。
    """
    r = P["render"]
    margin = int(r["margin_px"])
    dpi = int(r["dpi"])
    composed = []
    meta = []

    for img, (cw, ch) in zip(pages, canvases):
        cw, ch = max(1, int(cw)), max(1, int(ch))
        cont_w = max(1, cw - 2 * margin)
        cont_h = max(1, ch - 2 * margin)
        s = min(1.0, float(cont_w) / img.width, float(cont_h) / img.height)
        if s < 1.0:
            nw = max(1, int(round(img.width * s)))
            nh = max(1, int(round(img.height * s)))
            img = img.resize((nw, nh), Image.LANCZOS)
        else:
            nw, nh = img.width, img.height
        canvas = Image.new("RGB", (cw, ch), "white")
        canvas.paste(img, ((cw - nw) // 2, (ch - nh) // 2))
        composed.append(canvas)
        meta.append({"canvas": [cw, ch], "pasted": [nw, nh]})

    if not composed:
        raise ValueError("没有可合成的页面")

    out_dir = os.path.dirname(os.path.abspath(out_pdf))
    os.makedirs(out_dir, exist_ok=True)
    tmp = out_pdf + ".part.pdf"
    try:
        composed[0].save(tmp, "PDF", resolution=dpi, save_all=True,
                         append_images=composed[1:])
        os.replace(tmp, out_pdf)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return meta
