"""纯 numpy 单应变换：等价于 cv2.warpPerspective，只依赖 Pillow + numpy。

用法：
    python homography.py in.jpg out.png --quad x1,y1 x2,y2 x3,y3 x4,y4
四角顺序：左上、右上、右下、左下。不给 --quad 时按整幅图重采样。
"""
import argparse
import numpy as np
from PIL import Image


def _solve_h(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y, -u])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y, -v])
    _, _, vt = np.linalg.svd(np.asarray(A, dtype=np.float64))
    return vt[-1].reshape(3, 3)


def warp_perspective(img, quad, out_size=None, fill=(255, 255, 255)):
    arr = np.asarray(img.convert('RGB') if isinstance(img, Image.Image) else img)
    quad = np.asarray(quad, dtype=np.float64)
    tl, tr, br, bl = quad
    if out_size is None:
        w = int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))))
        h = int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))))
        out_size = (w, h)
    out_w, out_h = out_size
    dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]],
                   dtype=np.float64)
    Hinv = np.linalg.inv(_solve_h(quad, dst))
    xs, ys = np.meshgrid(np.arange(out_w), np.arange(out_h))
    dst_h = np.stack([xs.ravel(), ys.ravel(), np.ones(xs.size)]).astype(np.float64)
    src_h = Hinv @ dst_h
    sx = src_h[0] / src_h[2]
    sy = src_h[1] / src_h[2]
    h, w = arr.shape[:2]
    valid = (sx >= 0) & (sx <= w - 1) & (sy >= 0) & (sy <= h - 1)
    sx = np.clip(sx, 0, w - 1); sy = np.clip(sy, 0, h - 1)
    x0 = np.floor(sx).astype(np.int32); x1 = np.minimum(x0 + 1, w - 1)
    y0 = np.floor(sy).astype(np.int32); y1 = np.minimum(y0 + 1, h - 1)
    fx = (sx - x0)[:, None]; fy = (sy - y0)[:, None]
    a = arr[y0, x0].astype(np.float64); b = arr[y0, x1].astype(np.float64)
    c = arr[y1, x0].astype(np.float64); d = arr[y1, x1].astype(np.float64)
    out = (a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) +
           c * (1 - fx) * fy + d * fx * fy)
    out[~valid] = fill
    out = np.clip(out, 0, 255).astype(np.uint8).reshape(out_h, out_w, -1)
    return Image.fromarray(out)


def trim(img, px=3):
    w, h = img.size
    px = max(0, min(px, (min(w, h) - 1) // 2))
    return img.crop((px, px, w - px, h - px))


def brighten(img, target=245, pct=97):
    arr = np.asarray(img.convert('RGB')).astype(np.float32)
    hi = np.percentile(arr, pct)
    if hi > 1:
        arr = np.clip(arr * (target / hi), 0, 255)
    return Image.fromarray(arr.astype(np.uint8))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--quad', nargs=4, metavar='x,y')
    ap.add_argument('--trim', type=int, default=3)
    a = ap.parse_args()
    im = Image.open(a.src).convert('RGB')
    if a.quad:
        quad = [tuple(float(v) for v in p.split(',')) for p in a.quad]
    else:
        w, h = im.size
        quad = [(0, 0), (w - 1, 0), (w - 1, h - 1), (0, h - 1)]
    out = trim(brighten(warp_perspective(im, quad)), a.trim)
    out.save(a.dst)
    print('written %s  %dx%d' % (a.dst, out.size[0], out.size[1]))
