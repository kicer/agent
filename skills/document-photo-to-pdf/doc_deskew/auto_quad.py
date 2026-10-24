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


QUAD_INFO = {}


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


def _mask_from_bright(bright, factor, d, ref_side=None):
    """把“合格像素”图收敛成单张纸的掩膜（小尺寸）。

    关键一步是开运算（erode→dilate）：布面高光、塑料袋反光这类细小高亮
    块会被整块抹掉，而纸面（一块几百像素宽的大区域）毫发无损。旧实现只有
    闭运算，高光点反而被“连”到纸上，把最小外接矩形撑得老远，这就是
    rect_fill 只有 0.5、角点飞出去的根源。

    ref_side 是原图短边：形态学核按它换算，保证不同 factor 下降采样后
    用的是同一个“物理尺寸”的核，否则不同分辨率下的打分不可比。
    """
    bs = downsample_any(bright, factor)
    if not bs.any():
        return bs, 0.0
    f = max(1, int(factor))
    if ref_side is None:
        ref_side = min(bs.shape) * f

    def _k(div, minpx):
        return _odd(max(minpx, int(max(minpx, ref_side // max(1, div)) / f)))

    k_open = _k(d.get("paper_open_div", 90), d.get("paper_open_min", 5))
    k_close = _k(d["paper_close_div"], d["paper_close_min"])
    k_close2 = _k(d["paper_close2_div"], d["paper_close_min"])
    k_close_max = max(k_close, k_close2)

    # 掩膜收敛：开 → 闭 → 填洞 → 取最大连通域 → 填洞，共 4 次形态学。
    # 不再重复开运算与第二次闭运算：闭运算幂等，且取最大连通域后已无细小
    # 碎块，重复一遍结果不变、耗时翻倍（实测单候选 0.3s → 0.15s）。
    m = opening(bs, k_open)          # 去细小高光与细桥
    if not m.any():
        m = bs
    m = closing(m, k_close_max)
    m = fill_holes(m)
    m = largest_connected(m)
    m = fill_holes(m)
    return m, float(bs.mean())


def convex_hull(pts):
    """Andrew monotone chain 凸包，返回逆时针顶点（不含重复首点）。"""
    p = np.asarray(pts, dtype=np.float64)
    if len(p) < 3:
        return None
    order = np.lexsort((p[:, 1], p[:, 0]))
    p = p[order]

    def cross(o, a, b):
        return ((a[0] - o[0]) * (b[1] - o[1])
                - (a[1] - o[1]) * (b[0] - o[0]))

    lower = []
    for q in p:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    upper = []
    for q in p[::-1]:
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    hull = lower[:-1] + upper[:-1]
    return np.array(hull, dtype=np.float64) if len(hull) >= 3 else None


def _poly_area(q):
    """多边形面积（绝对值）。"""
    q = np.asarray(q, dtype=np.float64)
    x, y = q[:, 0], q[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)


def quad_iou(mask, quad, step=2):
    """凸四边形与二值掩膜的交并比（粗网格采样，用于候选择优）。

    为什么用它而不是“和矩形的夹角/位移上限”：真实拍摄的纸张是梯形，
    左右两条边本来就该一个往里收、一个往外放，用“偏离矩形的位移”当门槛
    会把整张梯形的透视关系判成错误，最后退回成一个平行四边形。
    IoU 直接衡量“这个四边形是不是把纸面圈住了”，不预设形状。
    """
    m = np.asarray(mask, dtype=bool)
    q = np.asarray(quad, dtype=np.float64)
    if q.shape != (4, 2) or not np.isfinite(q).all():
        return 0.0
    area2 = 0.0
    for i in range(4):
        p0, p1 = q[i], q[(i + 1) % 4]
        area2 += p0[0] * p1[1] - p1[0] * p0[1]
    if area2 < 0:
        q = q[::-1]
    H, W = m.shape
    st = max(1, int(step))
    ys = np.arange(0, H, st)
    xs = np.arange(0, W, st)
    gx, gy = np.meshgrid(xs, ys)
    inside = np.ones(gx.shape, dtype=bool)
    for i in range(4):
        p0, p1 = q[i], q[(i + 1) % 4]
        cr = (p1[0] - p0[0]) * (gy - p0[1]) - (p1[1] - p0[1]) * (gx - p0[0])
        inside &= (cr >= 0)
    mm = m[::st, ::st]
    h = min(mm.shape[0], inside.shape[0])
    w = min(mm.shape[1], inside.shape[1])
    mm = mm[:h, :w]
    inside = inside[:h, :w]
    inter = float((inside & mm).sum())
    union = float((inside | mm).sum())
    return inter / union if union > 0 else 0.0


def min_area_rect(pts):
    """旋转卡壳求点集的最小外接矩形，返回 4 个角点（未排序）。

    旧实现用“四个方向的极值点”当锚点，纸张有圆角/掩膜有毛刺时四个极值
    会挤到同一段弧上，相邻两边近似平行，求交得到病态角点（实测出现过
    两角相距 9px、甚至跑到画面外）。最小外接矩形天然凸、天然有序。
    """
    hull = convex_hull(pts)
    if hull is None:
        return None
    n = len(hull)
    best = None
    for i in range(n):
        p0 = hull[i]
        p1 = hull[(i + 1) % n]
        e = p1 - p0
        L = float(np.hypot(e[0], e[1]))
        if L < 1e-9:
            continue
        u = e / L
        v = np.array([-u[1], u[0]], dtype=np.float64)
        pu = hull @ u
        pv = hull @ v
        u0, u1 = float(pu.min()), float(pu.max())
        v0, v1 = float(pv.min()), float(pv.max())
        area = (u1 - u0) * (v1 - v0)
        if best is None or area < best[0]:
            best = (area, u, v, u0, u1, v0, v1)
    if best is None:
        return None
    _, u, v, u0, u1, v0, v1 = best
    return np.array([u * u0 + v * v0, u * u1 + v * v0,
                     u * u1 + v * v1, u * u0 + v * v1], dtype=np.float64)


def order_quad(quad):
    """把四个角点排成 左上→右上→右下→左下（屏幕坐标，y 向下）。"""
    q = np.asarray(quad, dtype=np.float64)
    c = q.mean(axis=0)
    ang = np.arctan2(q[:, 1] - c[1], q[:, 0] - c[0])
    q = q[np.argsort(ang)]
    # 起点选最左上的那个
    k = int(np.argmin(q[:, 0] + q[:, 1]))
    q = np.roll(q, -k, axis=0)
    # 屏幕坐标下顺时针，第二点应在前点右侧；否则反向重排
    if q[1][0] - q[0][0] < 0 or q[2][1] - q[1][1] < 0:
        q = q[::-1]
        k = int(np.argmin(q[:, 0] + q[:, 1]))
        q = np.roll(q, -k, axis=0)
    return q


def quad_ok(quad, min_area=1.0):
    """四边形是否可用：凸 + 有面积 + 边长不退化。"""
    q = np.asarray(quad, dtype=np.float64)
    if q.shape != (4, 2) or not np.isfinite(q).all():
        return False
    a = _poly_area(q)
    if a < min_area:
        return False
    for i in range(4):
        if float(np.hypot(*(q[(i + 1) % 4] - q[i]))) < 2.0:
            return False
    sign = None
    for i in range(4):
        p0, p1, p2 = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        cr = ((p1[0] - p0[0]) * (p2[1] - p1[1])
              - (p1[1] - p0[1]) * (p2[0] - p1[0]))
        s = 1 if cr > 0 else -1
        if sign is None:
            sign = s
        elif s != sign:
            return False
    return True


def _border_touch_frac(mask):
    """掩膜贴画面四条边的最大覆盖率：纸不应贴边，贴边说明混进了背景。"""
    if not mask.any():
        return 1.0
    return float(max(mask[0, :].mean(), mask[-1, :].mean(),
                     mask[:, 0].mean(), mask[:, -1].mean()))


def _mask_quality(m, d):
    """给一个候选掩膜打分：越像“一整张塞在画面里的纸”分越高。

    性能要点：只取掩膜边界像素并降采样后再做凸包。旧写法对全部非零像素
    （~30 万）做纯 Python 的单调链凸包，单个候选要 3.4 s，六个候选就把
    整页拖到 30 s 以上。边界点只有几千个，结果几乎不差。
    """
    w = d["mask_score"]
    area = float(m.mean())
    if area < d["mask_area_min"] or area > d["mask_area_max"]:
        return None
    ys, xs = np.nonzero(m)
    if len(xs) < 32:
        return None

    pts = mask_boundary_points(m, {"detect": d})
    if len(pts) < 32:
        return None
    cap = int(d.get("mask_quality_max_pts", 1500))
    if len(pts) > cap:
        pts = pts[::max(1, len(pts) // cap)]
    pts = pts.astype(np.float64)

    hull = convex_hull(pts)
    if hull is None or len(hull) < 3:
        return None
    hull_area = _poly_area(hull)
    if hull_area <= 1e-6:
        return None
    solidity = min(1.0, area * m.size / hull_area)
    rect = min_area_rect(pts)
    rect_fill = 0.0
    if rect is not None:
        ra = _poly_area(rect)
        if ra > 1e-6:
            rect_fill = min(1.0, area * m.size / ra)
    aspect = float(xs.max() - xs.min() + 1) / max(1.0, float(ys.max() - ys.min() + 1))
    asp_ok = (d["mask_aspect_min"] <= aspect <= d["mask_aspect_max"])
    border = _border_touch_frac(m)
    scoring = (w["solidity"] * solidity
               + w["rect_fill"] * rect_fill
               - w["border_touch"] * border
               + (w["aspect"] if asp_ok else -w["aspect"]))
    return {"score": float(scoring), "solidity": float(solidity),
            "rect_fill": float(rect_fill), "area": float(area),
            "aspect": float(aspect), "border": border}


def paper_masks(arr, P):
    """返回 (raw, eroded, info)。

    raw：未腐蚀的纸面掩膜，用于回退几何，避免角点内收。
    eroded：腐蚀后的掩膜，只用于限定边缘搜索环带。
    info：选中的候选参数与打分（用于审核页/排查）。

    相比旧实现：不再把一组固定阈值当真理（旧值没有用真实样张标定）。
    这里跑一梯子候选，按“像不像一张纸”打分选最好的那个——关键是
    solidity / 最小外接矩形填充率要高高、贴画面边缘要低低。
    “白纸放在亮背景（蓝花布、塑料袋、白台面）上”这类场景下，旧阈值会把
    背景并进纸面，掩膜一路贴到画面边缘，后续拟合出的“纸边”其实是照片边框。
    """
    d = P["detect"]
    H, W = arr.shape[:2]
    S, V = rgb_to_sv(arr)
    score = (V * (1.0 - S)).astype(np.float32)
    base_th = float(otsu_threshold(score))
    factor = max(1, min(H, W) // d["paper_mask_factor_div"])

    best = None
    tried = []
    for cand in d["mask_ladder"]:
        th = base_th * float(cand["o"])
        bright = ((score > th) & (V > float(cand["v"]))
                  & (S < float(cand["s"])))
        fb = float(bright.mean())
        if fb < d["mask_min_bright_frac"] or fb > d["mask_max_bright_frac"]:
            tried.append({"cand": cand, "bright_frac": round(fb, 4),
                          "skip": "bright_frac"})
            continue
        m, _ = _mask_from_bright(bright, factor, d, ref_side=min(H, W))
        q = _mask_quality(m, d)
        if q is None:
            tried.append({"cand": cand, "bright_frac": round(fb, 4),
                          "skip": "area"})
            continue
        q.update({"cand": cand, "bright_frac": round(fb, 4)})
        tried.append({k: (round(v, 4) if isinstance(v, float) else v)
                      for k, v in q.items()})
        if best is None or q["score"] > best[0]["score"]:
            best = (q, m)

    if best is None:
        # 完全选不出来：退回旧的那组固定阈值，保证不做到“空掩膜”
        th = max(base_th, d["paper_otsu_floor"])
        bright = ((score > th) & (V > d["paper_v_min"])
                  & (S < d["paper_s_max"]))
        m, _ = _mask_from_bright(bright, factor, d, ref_side=min(H, W))
        info = {"mask_pick": None, "mask_tried": tried[:6],
                "mask_fallback_legacy": True}
    else:
        q, m = best
        info = {"mask_pick": {k: (round(v, 4) if isinstance(v, float) else v)
                              for k, v in q.items()},
                "mask_tried": tried[:6],
                "mask_fallback_legacy": False}

    eroded_small = erode(m, _odd(d["mask_erode_kernel"]))
    if factor > 1:
        raw = upsample_nearest(m, H, W)
        eroded = upsample_nearest(eroded_small, H, W)
    else:
        raw, eroded = m, eroded_small
    return raw, eroded, info


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
    """从掩膜边界 + 边缘点估四角，返回 (corners, fallback_sides)。

    与旧实现的区别：初始四边形不再用“四个方向极值点”（遇圆角/毛刺会把
    四个锚点挤到同一段弧上，导致相邻边近乎平行、角点飞出去），而是用
    掩膜的最小外接矩形——它天然凸、天然有序，再在此基础上用真实边缘点
    逐边收紧。最后再用 quad_ok() 看门，不合格就退回矩形本身。
    """
    d = P["detect"]
    base = mask_boundary_points(paper_raw, P)
    if len(base) < 40:
        return [], [0, 1, 2, 3]

    rect = min_area_rect(base)
    if rect is None:
        return [], [0, 1, 2, 3]
    anchors = order_quad(rect)

    init = [_side_line(anchors[i], anchors[(i + 1) % 4]) for i in range(4)]

    # 用整条掩膜边界重拟合每一边（排除两端，避开角点圆角）
    base_lines = []
    side_ok = []
    for i in range(4):
        sl = init[i]
        if sl is None:
            base_lines.append(None)
            side_ok.append(False)
            continue
        n, c, u, L = sl
        p0 = anchors[i]
        dist = np.abs(base @ n - c)
        proj = (base - p0) @ u
        m = d["boundary_side_margin"]
        sel = base[(dist <= d["group_tol_px"]) &
                   (proj >= L * m) & (proj <= L * (1.0 - m))]
        # 支撑度：一条边上的边界点应当与边长成比例。点太少说明这条边在掩膜上
        # 几乎没被“看到”（被背景吃掉、或被另一条边盖住），此时用这条线去和
        # 邻边求交会把角点甩出去（实测出现过 300px），必须退回矩形边。
        need = max(d["min_edge_points"],
                   float(d.get("side_support_frac", 0.25)) * L)
        ok = len(sel) >= need
        if ok:
            n2, c2 = _robust_fit(sel, d["robust_px"])
            base_lines.append((n2, c2))
        else:
            base_lines.append((n, c))
        side_ok.append(ok)

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
            # 边缘点同样要求“支撑度”：点太少就保留上一步的线（掩膜拟合/矩形边）
            need_e = max(d["min_edge_points"],
                         float(d.get("side_support_frac", 0.25)) *
                         (float(sl[3]) if sl is not None else 0.0))
            if len(sel) >= need_e:
                n2, c2 = _robust_fit(sel, d["robust_px"])
                final_lines[i] = (n2, c2)
            else:
                fallback_sides.append(i)

    H, W = paper_raw.shape
    oob = d["corner_oob_frac"]

    def _intersect_all(lines):
        """四条直线两两求交得到四角；任一条缺失/越界就返回 None。"""
        q = []
        for i in range(4):
            l1, l2 = lines[i - 1], lines[i]
            if l1 is None or l2 is None:
                return None
            det = l1[0][0] * l2[0][1] - l2[0][0] * l1[0][1]
            if abs(det) < 1e-3:
                return None
            p = _intersect(l1[0], l1[1], l2[0], l2[1])
            if p is None:
                return None
            if not (-oob * W <= p[0] <= (1.0 + oob) * W and
                    -oob * H <= p[1] <= (1.0 + oob) * H):
                return None
            q.append([float(p[0]), float(p[1])])
        return q

    # 候选几何：矩形（保守）、掩膜边界拟合（贴合纸面）、边缘点拟合（贴合真实边缘）
    candidates = [("rect", [list(map(float, p)) for p in anchors])]
    q_mask = _intersect_all(base_lines)
    if q_mask is not None:
        candidates.append(("mask", q_mask))
    q_edge = _intersect_all(final_lines)
    if q_edge is not None:
        candidates.append(("edge", q_edge))

    min_area = 0.0005 * paper_raw.size
    step = int(d.get("iou_step", 2))
    best = None
    scores = {}
    for name, q in candidates:
        qq = np.asarray(q, dtype=np.float64)
        if not quad_ok(qq, min_area=min_area):
            continue
        iou = quad_iou(paper_raw, qq, step=step)
        scores[name] = round(iou, 4)
        if best is None or iou > best[0]:
            best = (iou, q, name)

    if best is None:
        out = [tuple(map(float, p)) for p in anchors]
        fallback_sides = [0, 1, 2, 3]
    else:
        out = [tuple(map(float, p)) for p in best[1]]
        if best[2] == "rect":
            fallback_sides = [0, 1, 2, 3]
        elif best[2] == "mask":
            pass          # 用掩膜边界拟合，fallback_sides 保留“没找到边缘点”的边
        else:
            fallback_sides = []
    QUAD_INFO["scores"] = scores
    QUAD_INFO["picked"] = None if best is None else best[2]
    QUAD_INFO["iou"] = None if best is None else round(float(best[0]), 4)

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

    paper_raw, paper_eroded, mask_info = paper_masks(arr, P)
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
    info.update(mask_info)

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
    info["quad_scores"] = dict(QUAD_INFO.get("scores") or {})
    info["quad_picked"] = QUAD_INFO.get("picked")
    info["quad_iou"] = QUAD_INFO.get("iou")
    if not corners:
        return [], info

    if d.get("snap_enable", True):
        snapped = snap_quad(arr, corners, P)
        if quad_ok(np.asarray(snapped), min_area=1.0):
            info["snapped"] = round(float(np.linalg.norm(
                np.asarray(snapped) - np.asarray(corners), axis=1).max()), 2)
            corners = snapped

    if d.get("shrink_enable", True):
        shrunk = shrink_to_mask(paper_raw, corners, P)
        if quad_ok(np.asarray(shrunk), min_area=1.0):
            info["shrunk"] = round(float(np.linalg.norm(
                np.asarray(shrunk) - np.asarray(corners), axis=1).max()), 2)
            corners = shrunk

    info["coverage"] = {
        k: float(v) for k, v in border_coverage_exact(
            cand, paper_eroded,
            tol=max(d["coverage_tol_min"], H // d["coverage_tol_div"])).items()
    }
    src_pts = [(float(x / scale), float(y / scale)) for x, y in corners]
    return src_pts, info


def rect_quad(img, P):
    """只取纸面掩膜的最小外接矩形（不做边线收紧）。

    用于“检测到了但校验不过”时的保守补救：矩形一定凸、一定有序，
    比直接换成画面内缩兜底框贴近真实纸张。返回 (quad_原图坐标, info)。
    """
    d = P["detect"]
    src_w, src_h = img.size
    scale = min(1.0, d["max_side"] / float(max(src_w, src_h)))
    if scale < 1.0:
        pil = img.resize((int(round(src_w * scale)), int(round(src_h * scale))),
                         Image.LANCZOS)
    else:
        pil = img
    arr = np.asarray(pil).astype(np.float32) / 255.0
    paper_raw, _, mask_info = paper_masks(arr, P)
    base = mask_boundary_points(paper_raw, P)
    info = dict(mask_info)
    if len(base) < 40:
        info["rect_fail"] = "boundary_too_few"
        return [], info
    rect = min_area_rect(base)
    if rect is None:
        info["rect_fail"] = "rect_none"
        return [], info
    q = order_quad(rect)
    if not quad_ok(q, min_area=1.0):
        info["rect_fail"] = "rect_degenerate"
        return [], info
    info["quad_source"] = "min_area_rect"
    if d.get("snap_enable", True):
        snapped = snap_quad(arr, q, P)
        if quad_ok(np.asarray(snapped), min_area=1.0):
            info["quad_source"] = "min_area_rect+snap"
            q = np.asarray(snapped, dtype=np.float64)
    if d.get("shrink_enable", True):
        shrunk = shrink_to_mask(paper_raw, q, P)
        if quad_ok(np.asarray(shrunk), min_area=1.0):
            info["quad_source"] = str(info.get("quad_source")) + "+shrink"
            q = np.asarray(shrunk, dtype=np.float64)
    out = [[float(x / scale), float(y / scale)] for x, y in q]
    return out, info


def _snap_side(mag, p0, p1, band, th, n):
    """沿一条边的法向找梯度最大处，返回拟合用的点集。"""
    H, W = mag.shape
    dv = np.asarray(p1, dtype=np.float64) - np.asarray(p0, dtype=np.float64)
    L = float(np.hypot(dv[0], dv[1]))
    if L < 4.0:
        return None
    u = dv / L
    nv = np.array([-u[1], u[0]], dtype=np.float64)
    pts = []
    hits = 0
    offs = np.arange(-band, band + 0.5, 1.0)
    for t in np.linspace(0.10, 0.90, n):
        base = np.asarray(p0, dtype=np.float64) + dv * t
        best = (-1.0, 0.0)
        for o in offs:
            q = base + nv * o
            xi, yi = int(round(q[0])), int(round(q[1]))
            if 0 <= xi < W and 0 <= yi < H:
                m = float(mag[yi, xi])
                if m > best[0]:
                    best = (m, o)
        if best[0] >= th:
            hits += 1
            pts.append(base + nv * best[1])
    if hits < max(12, int(0.45 * n)) or len(pts) < 12:
        return None
    return np.array(pts, dtype=np.float64)


def snap_quad(arr, quad, P, rounds=2):
    """把四边形的每条边吸附到真实图像边缘上。

    矩形容器给的是“把纸装进去的最小框”，它容易在毛刺、反光处偏出去几十像素
    （实测第 2 张上边偏 30px）。这里沿每条边的法向在 ±band 内找梯度极值，
    稳健拟合出新边；只有拟合点数够、边仍合法时才采纳，否则保留原边。
    """
    d = P["detect"]
    q = np.asarray(quad, dtype=np.float64)
    if q.shape != (4, 2) or not quad_ok(q, min_area=1.0):
        return [[float(x), float(y)] for x, y in q]
    gray = luminance(arr)
    sigma = max(1.0, gray.shape[0] / float(d["edge_sigma_div"]))
    mag = sobel_magnitude(gaussian_blur_np(gray, sigma))

    band = float(d.get("snap_band", 40))
    th = float(d.get("snap_grad_min", 0.05))
    n = int(d.get("snap_samples", 96))

    cur = q.copy()
    for r in range(max(1, int(rounds))):
        lines = []
        for i in range(4):
            pts = _snap_side(mag, cur[i], cur[(i + 1) % 4], band, th, n)
            if pts is not None and len(pts) >= 12:
                try:
                    nvec, c = _robust_fit(pts, d["robust_px"])
                    lines.append((nvec, c))
                    continue
                except Exception:
                    pass
            sl = _side_line(cur[i], cur[(i + 1) % 4])
            lines.append((sl[0], sl[1]) if sl is not None else None)
        nxt = []
        for i in range(4):
            l1, l2 = lines[i - 1], lines[i]
            if l1 is None or l2 is None:
                nxt.append(cur[i])
                continue
            det = l1[0][0] * l2[0][1] - l2[0][0] * l1[0][1]
            if abs(det) < 1e-3:
                nxt.append(cur[i])
                continue
            p = _intersect(l1[0], l1[1], l2[0], l2[1])
            nxt.append(np.asarray(p, dtype=np.float64) if p is not None
                       else cur[i])
        nxt = np.asarray(nxt, dtype=np.float64)
        if not quad_ok(nxt, min_area=1.0):
            break
        # 吸附只允许小幅修正，避免越修越野
        lim = float(d.get("snap_max_shift_frac", 0.05)) * float(min(mag.shape))
        if float(np.linalg.norm(nxt - q, axis=1).max()) > lim:
            break
        cur = nxt
        band = max(6.0, band * 0.4)
    return [[float(x), float(y)] for x, y in cur]


def shrink_to_mask(mask, quad, P):
    """把每条边沿法向向纸内推到掩膜边界（中位数），去掉背景毛边。

    最小外接矩形/边线拟合给出的框通常比纸面大 5~40px（阈值分割本身会
    吃掉纸边一圈），裁出来四边就挂着背景。这里沿每条边的法向量“向内多远
    才是纸”，取中位数后内推，既去毛边又不会被局部的凹陷带走。
    只许向内、不许向外，且单边内推有上限，避免把正文切掉。
    """
    d = P["detect"]
    m = np.asarray(mask, dtype=bool)
    q = np.asarray(quad, dtype=np.float64)
    if q.shape != (4, 2) or not m.any():
        return quad
    H, W = m.shape
    ys, xs = np.nonzero(m)
    cen = np.array([xs.mean(), ys.mean()], dtype=np.float64)
    search = float(d.get("shrink_search", 80))
    cap = float(d.get("shrink_max_frac", 0.05)) * float(min(H, W))
    keep = float(d.get("shrink_keep_px", 1.5))

    lines = []
    for i in range(4):
        p0, p1 = q[i], q[(i + 1) % 4]
        dv = p1 - p0
        L = float(np.hypot(dv[0], dv[1]))
        if L < 4.0:
            return quad
        u = dv / L
        nv = np.array([-u[1], u[0]], dtype=np.float64)
        if float((cen - p0) @ nv) < 0:
            nv = -nv                      # 指向纸内
        offs = []
        for t in np.linspace(0.12, 0.88, 64):
            base = p0 + dv * t
            hit = None
            for o in np.arange(0.0, search, 1.0):
                pt = base + nv * o
                xi, yi = int(round(pt[0])), int(round(pt[1]))
                if 0 <= xi < W and 0 <= yi < H and m[yi, xi]:
                    hit = o
                    break
            offs.append(search if hit is None else hit)
        off = float(np.median(offs)) - keep
        off = max(0.0, min(cap, off))
        c = float(nv @ p0) + off
        lines.append((nv, c))

    out = []
    for i in range(4):
        p = _intersect(lines[i - 1][0], lines[i - 1][1], lines[i][0], lines[i][1])
        if p is None:
            return quad
        out.append([float(p[0]), float(p[1])])
    out = np.asarray(out, dtype=np.float64)
    if not quad_ok(out, min_area=1.0):
        return quad
    if _poly_area(out) >= _poly_area(q):
        return quad
    return out
