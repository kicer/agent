# -*- coding: utf-8 -*-
"""边线检测 + 纸角候选提取（从 edge_clean_c.py v3 抽取的精简模块）。

对外只暴露一个函数：
    detect(image_path, max_side=1600) -> (corners, info)

corners：原图像素坐标系下的四角 [(x, y)]，顺序 左上、右上、右下、左下；
info   ：附加信息（处理尺寸、缩放比、各边覆盖率、边线掩膜），供出图与诊断用。

注意：本模块只产出**候选**坐标。它不写 corners.json，也不参与出件判定——
最终角点必须以人工读角标图的结果为准。
"""
import numpy as np
from PIL import Image, ImageOps, ImageFilter
from collections import deque

# ---------------- 基础工具 ----------------
def load_and_scale(path, max_side=1600):
    pil = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    w, h = pil.size
    s = max_side / max(w, h)
    if s < 1:
        pil = pil.resize((int(round(w * s)), int(round(h * s))), Image.LANCZOS)
    return pil, np.asarray(pil).astype(np.float32) / 255.0


def rgb_to_sv(arr):
    maxc = arr.max(axis=-1)
    minc = arr.min(axis=-1)
    delta = maxc - minc
    S = np.zeros_like(maxc, dtype=np.float32)
    np.divide(delta, maxc, out=S, where=maxc > 1e-6)
    return S.astype(np.float32), maxc.astype(np.float32)


def luminance(arr):
    return (0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]).astype(np.float32)


def box_mean(img, r):
    """O(1)/像素的方框均值（积分图），r 为半径。"""
    img = np.asarray(img, dtype=np.float32)
    H, W = img.shape
    pad = np.zeros((H + 1, W + 1), dtype=np.float32)
    pad[1:, 1:] = img
    ii = pad.cumsum(0).cumsum(1)
    ys = np.arange(H)
    xs = np.arange(W)
    y0 = np.clip(ys - r, 0, H)
    y1 = np.clip(ys + r + 1, 0, H)
    x0 = np.clip(xs - r, 0, W)
    x1 = np.clip(xs + r + 1, 0, W)
    S = (ii[np.ix_(y1, x1)] - ii[np.ix_(y0, x1)]
         - ii[np.ix_(y1, x0)] + ii[np.ix_(y0, x0)])
    cnt = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    return S / np.maximum(cnt, 1).astype(np.float32)


def gaussian_blur_np(img, sigma):
    radius = int(np.ceil(sigma * 3))
    if radius < 1:
        return img.astype(np.float32)
    x = np.arange(-radius, radius + 1, dtype=np.float32)
    k = np.exp(-x * x / (2 * sigma * sigma))
    k /= k.sum()
    H, W = img.shape
    p = np.pad(img, radius, mode="edge")
    tmp = np.zeros((H, W), dtype=np.float32)
    for i, kv in enumerate(k):
        tmp += kv * p[radius:radius + H, i:i + W]
    p = np.pad(tmp, ((radius, radius), (0, 0)), mode="edge")
    out = np.zeros((H, W), dtype=np.float32)
    for i, kv in enumerate(k):
        out += kv * p[i:i + H, :]
    return out


def convolve3x3(img, kernel):
    H, W = img.shape
    p = np.pad(img, 1, mode="edge")
    out = np.zeros((H, W), dtype=np.float32)
    for i in range(3):
        for j in range(3):
            kv = kernel[i, j]
            if kv != 0:
                out += kv * p[i:i + H, j:j + W]
    return out


def sobel_magnitude(gray):
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32)
    ky = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype=np.float32)
    gx = convolve3x3(gray, kx)
    gy = convolve3x3(gray, ky)
    return np.sqrt(gx * gx + gy * gy)


# ---------------- 形态学（Pillow Max/MinFilter）----------------
def _odd(size):
    size = int(size)
    if size < 3:
        size = 3
    if size % 2 == 0:
        size += 1
    return size


def dilate(mask, size):
    pil = Image.fromarray((mask.astype(np.uint8) * 255))
    return np.asarray(pil.filter(ImageFilter.MaxFilter(_odd(size)))) > 127


def erode(mask, size):
    pil = Image.fromarray((mask.astype(np.uint8) * 255))
    return np.asarray(pil.filter(ImageFilter.MinFilter(_odd(size)))) > 127


def closing(mask, size):
    return erode(dilate(mask, size), size)


def opening(mask, size):
    return dilate(erode(mask, size), size)


# ---------------- 连通域 & 填孔（降采样图上做）----------------
def downsample_any(mask, factor):
    if factor <= 1:
        return mask
    H, W = mask.shape
    H2, W2 = H // factor, W // factor
    return mask[:H2 * factor, :W2 * factor].reshape(
        H2, factor, W2, factor).any(axis=(1, 3))


def upsample_nearest(mask_small, target_h, target_w):
    h, w = mask_small.shape
    yi = np.linspace(0, h - 1, target_h).astype(np.int32)
    xi = np.linspace(0, w - 1, target_w).astype(np.int32)
    return mask_small[np.ix_(yi, xi)]


def fill_holes(mask_small):
    H, W = mask_small.shape
    bg = ~mask_small
    visited = np.zeros((H, W), dtype=bool)
    q = deque()
    for x in range(W):
        if bg[0, x] and not visited[0, x]:
            visited[0, x] = True
            q.append((0, x))
        if bg[H - 1, x] and not visited[H - 1, x]:
            visited[H - 1, x] = True
            q.append((H - 1, x))
    for y in range(H):
        if bg[y, 0] and not visited[y, 0]:
            visited[y, 0] = True
            q.append((y, 0))
        if bg[y, W - 1] and not visited[y, W - 1]:
            visited[y, W - 1] = True
            q.append((y, W - 1))
    while q:
        y, x = q.popleft()
        if y > 0 and bg[y - 1, x] and not visited[y - 1, x]:
            visited[y - 1, x] = True
            q.append((y - 1, x))
        if y < H - 1 and bg[y + 1, x] and not visited[y + 1, x]:
            visited[y + 1, x] = True
            q.append((y + 1, x))
        if x > 0 and bg[y, x - 1] and not visited[y, x - 1]:
            visited[y, x - 1] = True
            q.append((y, x - 1))
        if x < W - 1 and bg[y, x + 1] and not visited[y, x + 1]:
            visited[y, x + 1] = True
            q.append((y, x + 1))
    return mask_small | (bg & ~visited)


def largest_connected(mask_small):
    H, W = mask_small.shape
    visited = np.zeros((H, W), dtype=bool)
    best = np.zeros_like(mask_small)
    best_n = 0
    ys, xs = np.where(mask_small)
    for y0, x0 in zip(ys, xs):
        if visited[y0, x0]:
            continue
        stack = [(y0, x0)]
        visited[y0, x0] = True
        comp = []
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            for dy, dx in ((-1, -1), (-1, 0), (-1, 1), (0, -1),
                           (0, 1), (1, -1), (1, 0), (1, 1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and mask_small[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))
        if len(comp) > best_n:
            best_n = len(comp)
            best = np.zeros_like(mask_small)
            for y, x in comp:
                best[y, x] = True
    return best


# ---------------- 纸面掩膜（整形后只用于限定搜索区域）----------------
def otsu_threshold(score):
    """一维 Otsu：返回使类间方差最大的阈值"""
    hist, bin_edges = np.histogram(score, bins=256, range=(0.0, 1.0))
    hist = hist.astype(np.float64)
    total = hist.sum()
    if total <= 0:
        return 0.5
    p = hist / total
    centers = (bin_edges[:-1] + bin_edges[1:]) * 0.5
    w0 = np.cumsum(p)
    w1 = 1.0 - w0
    m0 = np.cumsum(p * centers)
    mt = m0[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        mu0 = m0 / np.maximum(w0, 1e-12)
        mu1 = (mt - m0) / np.maximum(w1, 1e-12)
    between = w0 * w1 * (mu0 - mu1) ** 2
    between = np.nan_to_num(between, nan=-1.0)
    return float(centers[int(np.argmax(between))])


def paper_mask(arr, debug=False):
    H, W = arr.shape[:2]
    S, V = rgb_to_sv(arr)
    # 纸面近白：亮度高、饱和低；木桌面偏色暗。用 Otsu 自动定阈值，
    # 再叠加硬约束 V>0.50 防止桌面亮反射被并入。
    score = (V * (1.0 - S)).astype(np.float32)
    th = otsu_threshold(score)
    th = max(th, 0.50)
    bright = (score > th) & (V > 0.50) & (S < 0.45)
    if debug:
        print(f"[paper_mask] otsu={th:.3f}  bright frac={bright.mean():.3f}")

    factor = max(1, min(H, W) // 400)
    bs = downsample_any(bright, factor)

    size = _odd(max(5, min(bs.shape) // 60))
    m = closing(bs, size)
    m = fill_holes(m)
    m = largest_connected(m)
    m = closing(m, _odd(max(5, min(bs.shape) // 80)))   # 抹掉内凹缺口/阶梯
    m = fill_holes(m)
    # 掩膜轻微内收：纸边最外侧 1~2px 常被阴影/暗边吃掉，内收后环带更贴合真实纸边
    m = erode(m, 3)

    paper = upsample_nearest(m, H, W) if factor > 1 else m
    if debug:
        Image.fromarray((paper * 255).astype(np.uint8)).save("dbg_v3_paper.png")
    return paper


def boundary_band(paper, k):
    """纸面掩膜边界两侧各 k 像素的环带。"""
    k = _odd(k)
    return dilate(paper, k) & ~erode(paper, k)


# ---------------- 边缘图（局部自适应阈值）----------------
def edge_map(arr, local_gain=1.55, low=0.035):
    H = arr.shape[0]
    gray = luminance(arr)
    sigma = max(1.0, H / 800.0)
    blurred = gaussian_blur_np(gray, sigma)
    mag = sobel_magnitude(blurred)
    local = box_mean(mag, max(3, H // 50))
    th = np.maximum(low, local * local_gain)
    return mag > th


def boundary_step_filter(arr, paper, r_small=10, r_big=24, step_th=0.055):
    """跨纸边亮度阶跃检测：比较掩膜内侧/外侧小窗的 V 均值。

    纸边是真实的明暗台阶（阶跃大），木纹/阴影纹理阶跃小。相比固定亮度
    阈值（V>0.60 / V<0.45），不受整体曝影响。两级窗口：掩膜准确的
    位置用 r_small，掩膜略有内收/偏移处依靠 r_big 补上。
    """
    _, V = rgb_to_sv(arr)
    p = paper.astype(np.float32)
    q = 1.0 - p

    def side_means(r):
        din = box_mean(p, r)
        dout = box_mean(q, r)
        vin = box_mean(V * p, r) / np.maximum(din, 1e-6)
        vout = box_mean(V * q, r) / np.maximum(dout, 1e-6)
        ok = (din > 0.08) & (dout > 0.08)
        return np.where(ok, np.abs(vin - vout), 0.0)

    step = np.maximum(side_means(r_small), side_means(r_big))
    return step > step_th



# ---------------- 四角提取（掩膜 -> 四边拟合 -> 交点） ----------------
def mask_boundary_points(mask):
    """掩膜边界像素坐标 (N,2) float32，顺序为 (x, y)"""
    inner = erode(mask, 3)
    ys, xs = np.where(mask & ~inner)
    return np.stack([xs, ys], axis=1).astype(np.float32)


def _fit_line(pts):
    """总体最小二乘拟直线，返回法向量 n 与 n·p = c"""
    c0 = pts.mean(axis=0)
    q = pts - c0
    cov = (q.T @ q) / max(len(pts) - 1, 1)
    w, v = np.linalg.eigh(cov)
    d = v[:, int(np.argmax(w))]          # 主方向
    n = np.array([-d[1], d[0]], dtype=np.float64)
    nn = np.linalg.norm(n)
    if nn < 1e-9:
        return np.array([0.0, 1.0]), float(c0[1])
    n = n / nn
    return n, float(n @ c0)


def _intersect(n1, c1, n2, c2):
    A = np.vstack([n1, n2])
    b = np.array([c1, c2], dtype=np.float64)
    try:
        return np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        return None


def detect_quad_corners(paper, points=None, robust_px=2.0, group_tol=22.0):
    """提取四个纸角，返回 [(x,y)]，顺序 左上、右上、右下、左下。

    锚点一律取自纸面掩膜边界（稳定，不受噪声小刺影响）；points 传入纸边黑线
    像素时，按到四条基准边的距离分组后重新拟合，得到更贴真实纸边的角点。
    每个角都有退化与越界检查，不通过就回退到掩膜基准边交点。
    """
    base = mask_boundary_points(paper)
    if len(base) < 40:
        return []
    bx, by = base[:, 0], base[:, 1]
    a_s = bx + by
    a_d = bx - by
    anchors = np.array([
        base[int(np.argmin(a_s))],   # 左上
        base[int(np.argmax(a_d))],   # 右上
        base[int(np.argmax(a_s))],   # 右下
        base[int(np.argmin(a_d))],   # 左下
    ], dtype=np.float64)

    base_lines = []
    for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
        p0, p1 = anchors[a], anchors[b]
        dv = p1 - p0
        L = float(np.linalg.norm(dv))
        if L < 1e-6:
            base_lines.append(None)
            continue
        dv = dv / L
        n0 = np.array([-dv[1], dv[0]])
        base_lines.append((n0, float(n0 @ p0)))

    corners = []
    for i in range(4):
        l1, l2 = base_lines[i - 1], base_lines[i]
        if l1 is None or l2 is None:
            corners.append(anchors[i].copy())
            continue
        p = _intersect(l1[0], l1[1], l2[0], l2[1])
        corners.append(anchors[i].copy() if p is None else p)

    if points is None:
        return [(float(p[0]), float(p[1])) for p in corners]

    pts = np.asarray(points, dtype=np.float64)
    if len(pts) < 40:
        return [(float(p[0]), float(p[1])) for p in corners]

    dd = []
    for l in base_lines:
        if l is None:
            dd.append(np.full(len(pts), 1e9))
        else:
            dd.append(np.abs(pts @ l[0] - l[1]))
    D = np.stack(dd, axis=1)
    idx = np.argmin(D, axis=1)
    dmin = D[np.arange(len(pts)), idx]

    lines = []
    for i in range(4):
        sel = pts[(idx == i) & (dmin <= group_tol)]
        if len(sel) < 40:
            lines.append(base_lines[i])
            continue
        n, c = _fit_line(sel)
        for _ in range(2):
            res = np.abs(sel @ n - c)
            keep = sel[res <= max(robust_px, 1.0) * 2.5]
            if len(keep) < 40:
                break
            n, c = _fit_line(keep)
            sel = keep
        lines.append((n, c))

    H, W = paper.shape
    for i in range(4):
        l1, l2 = lines[i - 1], lines[i]
        if l1 is None or l2 is None:
            continue
        det = l1[0][0] * l2[0][1] - l2[0][0] * l1[0][1]
        if abs(det) < 1e-3:          # 两边近共线，交点发散
            continue
        p = _intersect(l1[0], l1[1], l2[0], l2[1])
        if p is None:
            continue
        if not (-0.15 * W <= p[0] <= 1.15 * W and -0.15 * H <= p[1] <= 1.15 * H):
            continue
        corners[i] = p

    return [(float(p[0]), float(p[1])) for p in corners]




# ---------------- 覆盖率指标 ----------------
def border_coverage_exact(edges, paper, tol=14):
    """沿掩膜逐行/逐列的真实边界测覆盖率（适配斜边，不受 bbox 影响）。

    对每一列取掩膜的上/下边界，对每一行取左/右边界，检查 ±tol 内是否有边缘像素。
    """
    H, W = paper.shape
    col_has = paper.any(axis=0)
    row_has = paper.any(axis=1)
    top_hit = top_n = 0
    bot_hit = bot_n = 0
    for x in np.where(col_has)[0]:
        ys = np.where(paper[:, x])[0]
        y0, y1 = ys.min(), ys.max()
        if edges[max(0, y0 - tol):min(H, y0 + tol + 1), x].any():
            top_hit += 1
        top_n += 1
        if edges[max(0, y1 - tol):min(H, y1 + tol + 1), x].any():
            bot_hit += 1
        bot_n += 1
    left_hit = left_n = 0
    right_hit = right_n = 0
    for y in np.where(row_has)[0]:
        xs = np.where(paper[y, :])[0]
        x0, x1 = xs.min(), xs.max()
        if edges[y, max(0, x0 - tol):min(W, x0 + tol + 1)].any():
            left_hit += 1
        left_n += 1
        if edges[y, max(0, x1 - tol):min(W, x1 + tol + 1)].any():
            right_hit += 1
        right_n += 1
    return {
        "top": top_hit / max(top_n, 1),
        "bottom": bot_hit / max(bot_n, 1),
        "left": left_hit / max(left_n, 1),
        "right": right_hit / max(right_n, 1),
    }

# ---------------- 对外接口 ----------------

def detect(image_path, max_side=1600):
    """检测纸张四角，返回 (corners_原图坐标, info)。失败返回 ([], info)。"""
    src = ImageOps.exif_transpose(Image.open(image_path)).convert('RGB')
    src_w, src_h = src.size
    pil, arr = load_and_scale(image_path, max_side=max_side)
    H, W = arr.shape[:2]

    paper = paper_mask(arr)
    frac = float(paper.sum()) / (H * W)

    band = boundary_band(paper, _odd(max(15, H // 45)))
    edges = edge_map(arr)
    step = boundary_step_filter(arr, paper)
    cand = closing(edges & band & step, _odd(max(5, H // 160)))
    cand = opening(cand, _odd(max(3, H // 500)))

    ey, ex = np.nonzero(cand)
    pts = np.stack([ex, ey], axis=1).astype(np.float32) if len(ex) > 40 else None
    corners = detect_quad_corners(paper, points=pts)

    scale = min(1.0, float(max_side) / max(src_w, src_h))
    src_pts = [(x / scale, y / scale) for x, y in corners] if corners else []
    info = {
        'source_size': [src_w, src_h],
        'processed_size': [W, H],
        'scale': round(scale, 6),
        'paper_frac': round(frac, 4),
        'edge_pixels': int(cand.sum()),
        'coverage': border_coverage_exact(cand, paper, tol=max(10, H // 110)) if corners else {},
        'processed_pts': corners,
        'edge_mask_small': cand,          # 处理尺寸上的边线掩膜（供叠加出图）
    }
    return src_pts, info
