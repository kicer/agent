# -*- coding: utf-8 -*-
"""纸张边线检测：从一张已转正的 PIL 图里估四个纸角。

对外只有 detect(img, P) -> (corners, info)：
  - img 是已做 exif_transpose 的 RGB 图；
  - corners 是原图像素坐标 [(x, y)]，顺序 左上、右上、右下、左下；
  - info 里带覆盖率、纸面占比、回退标记，供上层做置信度告警。

设计要点：
  - 不打印、不落盘、不画图。检测失败返回 ([], info)，由调用方决定是否终止。
  - 纸面掩膜保留两份：腐蚀过的只用于限定边缘搜索环带；回退几何用未腐蚀的
    原始掩膜，避免角点系统性内收（旧实现两次 erode 会让角点切进纸内）。
  - 回退时不再只用 4 个极值点连线，而是用整条掩膜边界按边拟合，再求交点。
"""
import numpy as np
from PIL import Image


# ---------------------------------------------------------------- 基础工具

def _odd(size):
    size = int(size)
    if size < 3:
        size = 3
    if size % 2 == 0:
        size += 1
    return size


def _slide_reduce(a, k, op, axis):
    """沿 axis 做窗口 k 的滑动 max/min，越界按中性值填充（与 PIL 的边缘复制等价）。

    van Herk / Gil-Werman：块内前缀极值 + 块内后缀极值，O(1)/像素。
    二维 max/min 可分离，故行列两遍与二维滤波逐像素等价，
    但避开了 PIL rankfilter 的 O(k^2)/像素（k=35 时慢 30 倍以上）。
    """
    a = np.moveaxis(np.asarray(a, dtype=bool).astype(np.uint8) * 255,
                    axis, -1)
    M, N = a.shape
    r = k // 2
    n = N + 2 * r
    nb = (n + k - 1) // k
    m = nb * k
    p = np.full((M, m), 0 if op == "max" else 255, dtype=np.uint8)
    p[:, r:r + N] = a
    blk = p.reshape(M, nb, k)
    if op == "max":
        fwd = np.maximum.accumulate(blk, axis=-1).reshape(M, m)
        bwd = np.maximum.accumulate(blk[:, :, ::-1], axis=-1)[:, :, ::-1]
        bwd = bwd.reshape(M, m)
        out = np.maximum(bwd[:, :N], fwd[:, k - 1:k - 1 + N])
    else:
        fwd = np.minimum.accumulate(blk, axis=-1).reshape(M, m)
        bwd = np.minimum.accumulate(blk[:, :, ::-1], axis=-1)[:, :, ::-1]
        bwd = bwd.reshape(M, m)
        out = np.minimum(bwd[:, :N], fwd[:, k - 1:k - 1 + N])
    return np.moveaxis(out, -1, axis) > 127


def dilate(mask, size):
    k = _odd(size)
    return _slide_reduce(_slide_reduce(mask, k, "max", 1), k, "max", 0)


def erode(mask, size):
    k = _odd(size)
    return _slide_reduce(_slide_reduce(mask, k, "min", 1), k, "min", 0)


def closing(mask, size):
    return erode(dilate(mask, size), size)


def opening(mask, size):
    return dilate(erode(mask, size), size)


def rgb_to_sv(arr):
    maxc = arr.max(axis=-1)
    minc = arr.min(axis=-1)
    delta = maxc - minc
    S = np.zeros_like(maxc, dtype=np.float32)
    np.divide(delta, maxc, out=S, where=maxc > 1e-6)
    return S.astype(np.float32), maxc.astype(np.float32)


def luminance(arr):
    return (0.299 * arr[..., 0] + 0.587 * arr[..., 1]
            + 0.114 * arr[..., 2]).astype(np.float32)


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
    # 边界裁剪等价于把积分图向外按边复制 r 行/列，这样四个角全部可用切片取，
    # 避开 np.ix_ 花式索引的 4 次全图 gather（快 3 倍以上）。
    k = 2 * r + 1
    pe = np.pad(ii, ((r, r + 1), (r, r + 1)), mode="edge")
    S = (pe[k:k + H, k:k + W] - pe[0:H, k:k + W]
         - pe[k:k + H, 0:W] + pe[0:H, 0:W])
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


# ---------------------------------------------------------------- 连通域 & 填孔

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


def _row_runs(mask):
    """把二值掩膜拆成每行的连续段，返回 (row, start, end)，end 不含。"""
    H, W = mask.shape
    pm = np.zeros((H, W + 2), dtype=np.int8)
    pm[:, 1:-1] = mask
    d = np.diff(pm, axis=1)
    ry, rs = np.nonzero(d == 1)
    _, re_ = np.nonzero(d == -1)
    return ry, rs, re_


def _run_labels(ry, rs, re_, H, eight):
    """行程级并查集：4/8 邻接，返回每个行程的连通分量标号。"""
    n = len(ry)
    parent = np.arange(n)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    row_start = np.searchsorted(ry, np.arange(H + 1))
    for y in range(H - 1):
        a0, a1 = row_start[y], row_start[y + 1]
        b0, b1 = row_start[y + 1], row_start[y + 2]
        i, j = a0, b0
        while i < a1 and j < b1:
            s1, e1 = rs[i], re_[i]
            s2, e2 = rs[j], re_[j]
            hit = (s2 <= e1 and s1 <= e2) if eight else (s2 < e1 and s1 < e2)
            if hit:
                ra, rb = find(i), find(j)
                if ra != rb:
                    parent[rb] = ra
            if e1 <= e2:
                i += 1
            else:
                j += 1
    return np.array([find(i) for i in range(n)], dtype=np.int64)


def fill_holes(mask_small):
    """填掉不与画面边界连通的背景（4 邻接），行程 + 并查集实现。"""
    m = np.asarray(mask_small, dtype=bool)
    H, W = m.shape
    bg = ~m
    if not bg.any():
        return m.copy()
    ry, rs, re_ = _row_runs(bg)
    if len(ry) == 0:
        return m.copy()
    lab = _run_labels(ry, rs, re_, H, eight=False)
    touch = (ry == 0) | (ry == H - 1) | (rs == 0) | (re_ >= W)
    nlab = int(lab.max()) + 1
    edge = np.zeros(nlab, dtype=bool)
    np.logical_or.at(edge, lab, touch)
    sel = ~edge[lab]
    out = m.copy()
    for y, s, e in zip(ry[sel], rs[sel], re_[sel]):
        out[y, s:e] = True
    return out


def largest_connected(mask_small):
    """取最大 8 邻接连通域（行程 + 并查集，逐像素计数）。"""
    m = np.asarray(mask_small, dtype=bool)
    H, W = m.shape
    if not m.any():
        return np.zeros_like(m)
    ry, rs, re_ = _row_runs(m)
    lab = _run_labels(ry, rs, re_, H, eight=True)
    w = (re_ - rs).astype(np.int64)
    nlab = int(lab.max()) + 1
    size = np.bincount(lab, weights=w, minlength=nlab)
    best = int(np.argmax(size))
    sel = lab == best
    out = np.zeros((H, W), dtype=bool)
    for y, s, e in zip(ry[sel], rs[sel], re_[sel]):
        out[y, s:e] = True
    return out


# ---------------------------------------------------------------- 纸面掩膜

def otsu_threshold(score):
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


def paper_masks(arr, P):
    """返回 (raw, eroded)。

    raw：未腐蚀的纸面掩膜，用于回退几何，避免角点内收。
    eroded：腐蚀后的掩膜，只用于限定边缘搜索环带。
    """
    d = P["detect"]
    H, W = arr.shape[:2]
    S, V = rgb_to_sv(arr)
    score = (V * (1.0 - S)).astype(np.float32)
    th = max(otsu_threshold(score), d["paper_otsu_floor"])
    bright = (score > th) & (V > d["paper_v_min"]) & (S < d["paper_s_max"])

    factor = max(1, min(H, W) // d["paper_mask_factor_div"])
    bs = downsample_any(bright, factor)

    m = closing(bs, _odd(max(d["paper_close_min"],
                             min(bs.shape) // d["paper_close_div"])))
    m = fill_holes(m)
    m = largest_connected(m)
    m = closing(m, _odd(max(d["paper_close_min"],
                            min(bs.shape) // d["paper_close2_div"])))
    m = fill_holes(m)

    raw_small = m
    eroded_small = erode(m, _odd(d["mask_erode_kernel"]))

    if factor > 1:
        raw = upsample_nearest(raw_small, H, W)
        eroded = upsample_nearest(eroded_small, H, W)
    else:
        raw, eroded = raw_small, eroded_small
    return raw, eroded


# ---------------------------------------------------------------- 边缘图

def boundary_band(paper, k):
    k = _odd(k)
    return dilate(paper, k) & ~erode(paper, k)


def edge_map(arr, P):
    d = P["detect"]
    H = arr.shape[0]
    gray = luminance(arr)
    sigma = max(1.0, H / float(d["edge_sigma_div"]))
    blurred = gaussian_blur_np(gray, sigma)
    mag = sobel_magnitude(blurred)
    local = box_mean(mag, max(3, H // d["edge_box_div"]))
    th = np.maximum(d["edge_low"], local * d["edge_local_gain"])
    return mag > th


def boundary_step_filter(arr, paper, P):
    """跨纸边亮度阶跃：比较掩膜内侧/外侧小窗的 V 均值。

    纸边是真实的明暗台阶，木纹/阴影纹理阶跃小。两级窗口：掩膜准确处用
    r_small，掩膜略有偏移处依靠 r_big 补上。
    """
    d = P["detect"]
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

    step = np.maximum(side_means(d["step_r_small"]),
                      side_means(d["step_r_big"]))
    return step > d["step_th"]


# ---------------------------------------------------------------- 四角提取

def mask_boundary_points(mask, P):
    """掩膜边界像素坐标 (N, 2)，顺序 (x, y)。"""
    inner = erode(mask, _odd(P["detect"]["mask_erode_kernel"]))
    ys, xs = np.where(mask & ~inner)
    if len(xs) == 0:
        return np.zeros((0, 2), dtype=np.float32)
    return np.stack([xs, ys], axis=1).astype(np.float32)


def _fit_line(pts):
    """总体最小二乘拟直线，返回法向量 n 与 n·p = c。"""
    c0 = pts.mean(axis=0)
    q = pts - c0
    cov = (q.T @ q) / max(len(pts) - 1, 1)
    w, v = np.linalg.eigh(cov)
    direction = v[:, int(np.argmax(w))]
    n = np.array([-direction[1], direction[0]], dtype=np.float64)
    nn = np.linalg.norm(n)
    if nn < 1e-9:
        return np.array([0.0, 1.0]), float(c0[1])
    n = n / nn
    return n, float(n @ c0)


def _robust_fit(pts, robust_px):
    n, c = _fit_line(pts)
    sel = pts
    for _ in range(2):
        res = np.abs(sel @ n - c)
        keep = sel[res <= max(robust_px, 1.0) * 2.5]
        if len(keep) < 40:
            break
        n, c = _fit_line(keep)
        sel = keep
    return n, c


def _intersect(n1, c1, n2, c2):
    A = np.vstack([n1, n2])
    b = np.array([c1, c2], dtype=np.float64)
    try:
        return np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        return None


def _side_line(p0, p1):
    dv = np.asarray(p1, dtype=np.float64) - np.asarray(p0, dtype=np.float64)
    L = float(np.linalg.norm(dv))
    if L < 1e-6:
        return None
    u = dv / L
    n = np.array([-u[1], u[0]], dtype=np.float64)
    return n, float(n @ np.asarray(p0, dtype=np.float64)), u, L


def detect_quad_corners(paper_raw, points, P):
    """从掩膜边界 + 边缘点估四角，返回 (corners, fallback_sides)。"""
    d = P["detect"]
    base = mask_boundary_points(paper_raw, P)
    if len(base) < 40:
        return [], [0, 1, 2, 3]

    bx, by = base[:, 0], base[:, 1]
    anchors = np.array([
        base[int(np.argmin(bx + by))],   # 左上
        base[int(np.argmax(bx - by))],   # 右上
        base[int(np.argmax(bx + by))],   # 右下
        base[int(np.argmin(bx - by))],   # 左下
    ], dtype=np.float64)

    init = [_side_line(anchors[i], anchors[(i + 1) % 4]) for i in range(4)]

    # 用整条掩膜边界重拟合每一边（排除两端，避开角点圆角）
    base_lines = []
    for i in range(4):
        sl = init[i]
        if sl is None:
            base_lines.append(None)
            continue
        n, c, u, L = sl
        p0 = anchors[i]
        dist = np.abs(base @ n - c)
        proj = (base - p0) @ u
        m = d["boundary_side_margin"]
        sel = base[(dist <= d["group_tol_px"]) &
                   (proj >= L * m) & (proj <= L * (1.0 - m))]
        if len(sel) >= 40:
            n2, c2 = _robust_fit(sel, d["robust_px"])
            base_lines.append((n2, c2))
        else:
            base_lines.append((n, c))

    final_lines = list(base_lines)
    fallback_sides = [0, 1, 2, 3]

    if points is not None and len(points) >= d["min_edge_points"]:
        pts = np.asarray(points, dtype=np.float64)
        dists = []
        for line in base_lines:
            if line is None:
                dists.append(np.full(len(pts), 1e9))
            else:
                dists.append(np.abs(pts @ line[0] - line[1]))
        D = np.stack(dists, axis=1)
        idx = np.argmin(D, axis=1)
        dmin = D[np.arange(len(pts)), idx]

        fallback_sides = []
        for i in range(4):
            line = base_lines[i]
            if line is None:
                fallback_sides.append(i)
                continue
            sel = pts[(idx == i) & (dmin <= d["group_tol_px"])]
            sl = init[i]
            if sl is not None:
                u, L = sl[2], sl[3]
                p0 = anchors[i]
                m = d["boundary_side_margin"]
                proj = (sel - p0) @ u
                sel = sel[(proj >= L * m) & (proj <= L * (1.0 - m))]
            if len(sel) >= d["min_edge_points"]:
                n2, c2 = _robust_fit(sel, d["robust_px"])
                final_lines[i] = (n2, c2)
            else:
                fallback_sides.append(i)

    H, W = paper_raw.shape
    oob = d["corner_oob_frac"]
    out = []
    for i in range(4):
        chosen = None
        for lines in (final_lines, base_lines):
            l1, l2 = lines[i - 1], lines[i]
            if l1 is None or l2 is None:
                continue
            det = l1[0][0] * l2[0][1] - l2[0][0] * l1[0][1]
            if abs(det) < 1e-3:
                continue
            p = _intersect(l1[0], l1[1], l2[0], l2[1])
            if p is None:
                continue
            if (-oob * W <= p[0] <= (1.0 + oob) * W and
                    -oob * H <= p[1] <= (1.0 + oob) * H):
                chosen = (float(p[0]), float(p[1]))
                break
        if chosen is None:
            chosen = (float(anchors[i][0]), float(anchors[i][1]))
            if i not in fallback_sides:
                fallback_sides.append(i)
        out.append(chosen)

    return out, sorted(set(fallback_sides))


# ---------------------------------------------------------------- 覆盖率

def border_coverage_exact(edges, paper, tol):
    """沿掩膜逐行/逐列的真实边界测边缘覆盖率。"""
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


# ---------------------------------------------------------------- 对外接口

def detect(img, P):
    """检测纸张四角，返回 (corners_原图坐标, info)。失败返回 ([], info)。"""
    d = P["detect"]
    src_w, src_h = img.size
    scale = min(1.0, d["max_side"] / float(max(src_w, src_h)))
    if scale < 1.0:
        pil = img.resize((int(round(src_w * scale)), int(round(src_h * scale))),
                         Image.LANCZOS)
    else:
        pil = img
    arr = np.asarray(pil).astype(np.float32) / 255.0
    H, W = arr.shape[:2]

    paper_raw, paper_eroded = paper_masks(arr, P)
    frac = float(paper_raw.sum()) / float(H * W)

    info = {
        "source_size": [int(src_w), int(src_h)],
        "processed_size": [int(W), int(H)],
        "scale": round(scale, 6),
        "paper_frac": round(frac, 4),
        "edge_pixels": 0,
        "coverage": {},
        "fallback": True,
        "fallback_sides": [0, 1, 2, 3],
    }

    if frac < 0.005 or not paper_raw.any():
        return [], info

    band = boundary_band(paper_eroded,
                         _odd(max(d["band_min"], H // d["band_div"])))
    edges = edge_map(arr, P)
    step = boundary_step_filter(arr, paper_eroded, P)
    cand = closing(edges & band & step,
                   _odd(max(d["cand_close_min"], H // d["cand_close_div"])))
    cand = opening(cand,
                   _odd(max(d["cand_open_min"], H // d["cand_open_div"])))

    ey, ex = np.nonzero(cand)
    pts = (np.stack([ex, ey], axis=1).astype(np.float32)
           if len(ex) >= d["min_edge_points"] else None)

    corners, fallback_sides = detect_quad_corners(paper_raw, pts, P)
    info["edge_pixels"] = int(cand.sum())
    info["fallback_sides"] = fallback_sides
    info["fallback"] = bool(fallback_sides)
    if not corners:
        return [], info

    info["coverage"] = {
        k: float(v) for k, v in border_coverage_exact(
            cand, paper_eroded,
            tol=max(d["coverage_tol_min"], H // d["coverage_tol_div"])).items()
    }
    src_pts = [(float(x / scale), float(y / scale)) for x, y in corners]
    return src_pts, info
