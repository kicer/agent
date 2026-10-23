# -*- coding: utf-8 -*-
"""纯 numpy 单应变换：等价于 cv2.warpPerspective，只依赖 Pillow + numpy。

与旧实现的区别：
  - 按行分块采样，峰值内存从“整页 × 多份 float64”降到几十 MB；
  - 只接受 PIL 图，坐标/方向由调用方统一（exif_transpose 已在入口做过）；
  - 不再提供 CLI，出件统一走技能入口。
"""
import numpy as np
from PIL import Image


def _solve_h(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y, -u])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y, -v])
    _, _, vt = np.linalg.svd(np.asarray(A, dtype=np.float64))
    return vt[-1].reshape(3, 3)


def warp_perspective(img, quad, out_size=None, fill=(255, 255, 255),
                     chunk_rows=256):
    """把 quad 指定的四边形透视校正到 out_size。

    quad 顺序：左上、右上、右下、左下（屏幕坐标）。
    out_size=None 时按四边形自然边长输出（保留照片原始比例）。
    """
    arr = np.asarray(img if img.mode == "RGB" else img.convert("RGB"))
    src_h, src_w = arr.shape[:2]
    quad = np.asarray(quad, dtype=np.float64)
    tl, tr, br, bl = quad

    if out_size is None:
        w = int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))))
        h = int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))))
        out_size = (w, h)
    out_w = max(1, int(out_size[0]))
    out_h = max(1, int(out_size[1]))

    dst = np.array([[0, 0], [out_w - 1, 0],
                    [out_w - 1, out_h - 1], [0, out_h - 1]],
                   dtype=np.float64)
    Hinv = np.linalg.inv(_solve_h(quad, dst))

    out = np.empty((out_h, out_w, 3), dtype=np.uint8)
    step = max(1, int(chunk_rows))
    for y0 in range(0, out_h, step):
        y1 = min(y0 + step, out_h)
        ys, xs = np.mgrid[y0:y1, 0:out_w]
        dst_h = np.stack([xs.ravel(), ys.ravel(),
                          np.ones(xs.size)], axis=0).astype(np.float64)
        sp = Hinv @ dst_h
        den = sp[2]
        den = np.where(np.abs(den) < 1e-9, 1e-9, den)
        sx = sp[0] / den
        sy = sp[1] / den

        valid = (sx >= 0) & (sx <= src_w - 1) & (sy >= 0) & (sy <= src_h - 1)
        sx = np.clip(sx, 0, src_w - 1)
        sy = np.clip(sy, 0, src_h - 1)

        x0 = np.floor(sx).astype(np.int32)
        x1 = np.minimum(x0 + 1, src_w - 1)
        y0i = np.floor(sy).astype(np.int32)
        y1i = np.minimum(y0i + 1, src_h - 1)
        fx = (sx - x0)[:, None]
        fy = (sy - y0i)[:, None]

        a = arr[y0i, x0].astype(np.float32)
        b = arr[y0i, x1].astype(np.float32)
        c = arr[y1i, x0].astype(np.float32)
        d = arr[y1i, x1].astype(np.float32)
        block = (a * (1 - fx) * (1 - fy) + b * fx * (1 - fy)
                 + c * (1 - fx) * fy + d * fx * fy)
        block[~valid] = fill
        out[y0:y1] = np.clip(block, 0, 255).astype(np.uint8).reshape(
            y1 - y0, out_w, 3)

    return Image.fromarray(out)


def brighten(img, target=245, pct=97):
    """全局等比提亮：把 pct 分位映射到 target，保持相对对比度。"""
    arr = np.asarray(img if img.mode == "RGB" else img.convert("RGB")).astype(np.float32)
    hi = float(np.percentile(arr, pct))
    if hi > 1.0:
        arr = np.clip(arr * (float(target) / hi), 0, 255)
    return Image.fromarray(arr.astype(np.uint8))
