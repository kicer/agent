# -*- coding: utf-8 -*-
"""角点几何校验：纯函数，返回结论和指标，不打印、不落盘。

判定只看几何与亮度关系，不依赖固定像素常量：
  1. 四边形凸，且顺序为 左上→右上→右下→左下
  2. 越界幅度在允许范围内（角点出画面属正常）
  3. 框内以纸面（亮像素）为主
  4. 每边内侧都是纸面（混入桌面说明取点落在纸外）
外侧偏亮只作提示：可能是取点偏内，也可能是纸边倾斜，亮度无法区分。
"""
import numpy as np


def _sample_map(a, pts, n, shrink=1.0, outward=0.0):
    """在四边形内部取网格点（shrink<1 向内收），或在外部环带取点（outward>0）。"""
    h, w = a.shape
    tl, tr, br, bl = [np.asarray(p, dtype=np.float64) for p in pts]
    c = (tl + tr + br + bl) / 4.0
    if shrink != 1.0:
        tl, tr, br, bl = [c + (p - c) * shrink for p in (tl, tr, br, bl)]
    if outward > 0:
        tl, tr, br, bl = [c + (p - c) * (1.0 + outward)
                          for p in (tl, tr, br, bl)]
    vals = []
    for u in np.linspace(0.03, 0.97, n):
        p1 = tl + (tr - tl) * u
        p2 = bl + (br - bl) * u
        for v in np.linspace(0.03, 0.97, n):
            x, y = p1 + (p2 - p1) * v
            xi, yi = int(round(x)), int(round(y))
            if 0 <= xi < w and 0 <= yi < h:
                vals.append(a[yi, xi])
    return np.asarray(vals)


def _cross(o, a, b):
    return ((a[0] - o[0]) * (b[1] - o[1])
            - (a[1] - o[1]) * (b[0] - o[0]))


def validate(img, pts, P):
    """返回 {ok, metrics, failures, warnings}。"""
    g = P["gate"]
    a = np.asarray(img.convert("L")).astype(np.float32)
    h, w = a.shape
    paper = float(np.percentile(a, 80))
    back = float(np.percentile(a, 2))
    thr = back + (paper - back) * 0.5

    failures = []
    warnings = []
    metrics = {}

    # 1. 凸性与顺序
    signs = [_cross(pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4])
             for i in range(4)]
    convex = all(s > 0 for s in signs)
    metrics["convex"] = bool(convex)
    if not convex:
        failures.append("角点顺序/凸性不对，应为 左上→右上→右下→左下")

    # 2. 越界幅度
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    out = [max(0.0, -min(xs)), max(0.0, max(xs) - w),
           max(0.0, -min(ys)), max(0.0, max(ys) - h)]
    oob = max(out) / float(max(w, h)) * 100.0
    metrics["oob_pct"] = round(float(oob), 2)
    if oob >= g["oob_max_pct"]:
        failures.append("角点越界 %.1f%%，超过 %.0f%%"
                        % (oob, g["oob_max_pct"]))

    # 3. 框内纸面占比
    inner = _sample_map(a, pts, g["sample_n"], shrink=g["sample_shrink"])
    if inner.size == 0:
        frac_paper = 0.0
    else:
        frac_paper = float((inner > thr).mean())
    metrics["inner_paper_frac"] = round(frac_paper, 4)
    if frac_paper <= g["inner_paper_min"]:
        failures.append("框内纸面占比 %.0f%%，偏低（可能取到桌面）"
                        % (frac_paper * 100))

    # 4. 四边外侧：只提示
    names = ["上边", "右边", "下边", "左边"]
    outer_dark = {}
    span = float(max(w, h))
    for i in range(4):
        p1, p2 = np.asarray(pts[i], float), np.asarray(pts[(i + 1) % 4], float)
        mid = (p1 + p2) / 2.0
        c = sum(np.asarray(p, float) for p in pts) / 4.0
        d = mid - c
        norm = float(np.linalg.norm(d))
        if norm < 1e-6:
            continue
        d = d / norm
        vals = []
        for t in np.linspace(0.15, 0.85, 12):
            base = p1 + (p2 - p1) * t
            for k in (span * 0.02, span * 0.035, span * 0.05):
                x, y = base + d * k
                xi, yi = int(round(x)), int(round(y))
                if 0 <= xi < w and 0 <= yi < h:
                    vals.append(a[yi, xi])
        if len(vals) < 8:
            continue
        vals = np.asarray(vals)
        dark_frac = float((vals < thr).mean())
        outer_dark[names[i]] = round(dark_frac, 3)
        if dark_frac < g["outer_dark_min"]:
            warnings.append("%s外侧仍偏亮（可能取点偏内，也可能纸边倾斜）"
                            % names[i])
    metrics["outer_dark"] = outer_dark

    # 5. 四边内侧：必须是纸面
    inner_paper = {}
    for i in range(4):
        p1, p2 = np.asarray(pts[i], float), np.asarray(pts[(i + 1) % 4], float)
        mid = (p1 + p2) / 2.0
        c = sum(np.asarray(p, float) for p in pts) / 4.0
        d = mid - c
        norm = float(np.linalg.norm(d))
        if norm < 1e-6:
            continue
        d = d / norm
        vals = []
        for t in np.linspace(0.15, 0.85, 12):
            base = p1 + (p2 - p1) * t
            for k in (span * 0.015, span * 0.03, span * 0.045):
                x, y = base - d * k
                xi, yi = int(round(x)), int(round(y))
                if 0 <= xi < w and 0 <= yi < h:
                    vals.append(a[yi, xi])
        if len(vals) < 8:
            continue
        vals = np.asarray(vals)
        paper_frac = float((vals > thr).mean())
        inner_paper[names[i]] = round(paper_frac, 3)
        if paper_frac < g["inner_edge_min"]:
            failures.append("%s内侧混入桌面（纸面仅 %.0f%%），取点落在纸外"
                            % (names[i], paper_frac * 100))
    metrics["inner_paper"] = inner_paper

    return {
        "ok": not failures,
        "metrics": metrics,
        "failures": failures,
        "warnings": warnings,
    }
