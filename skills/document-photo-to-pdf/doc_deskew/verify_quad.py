"""几何校验：四角坐标是否合理覆盖了纸张。

不依赖图像亮度，只看几何关系，因此不受白底干扰：
  1. 四边形必须凸，且顺序为 左上→右上→右下→左下
  2. 四边形必须落在源图范围内（允许少量越界，用于角点出画面的情况）
  3. 四边形内应基本是纸面（亮像素占多数），说明没有取到桌面
  4. 沿四条边外侧一圈应是桌面（暗像素占多数），说明没有少取纸张

任一项失败即说明该角点需调整，并指出是哪条边。

用法：
    python3 doc_deskew/verify_quad.py 图.jpg "左上;右上;右下;左下"
"""
import argparse
import sys

import numpy as np
from PIL import Image


def parse(qs):
    pts = []
    for pt in qs.split(';'):
        x, y = pt.split(',')
        pts.append((float(x), float(y)))
    if len(pts) != 4:
        raise SystemExit('需要 4 个角点')
    return pts


def sample_map(a, pts, n=60, shrink=1.0, outward=0.0):
    """在四边形内部取网格点（shrink<1 向内收），或在外部环带取点（outward>0）。"""

    h, w = a.shape
    tl, tr, br, bl = [np.asarray(p, float) for p in pts]
    c = (tl + tr + br + bl) / 4.0
    if shrink != 1.0:
        tl, tr, br, bl = [c + (p - c) * shrink for p in (tl, tr, br, bl)]
    if outward > 0:
        tl, tr, br, bl = [c + (p - c) * (1 + outward) for p in (tl, tr, br, bl)]
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


def cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def check(img, pts, verbose=True):
    a = np.asarray(Image.open(img).convert('L')).astype(np.float32)
    h, w = a.shape
    paper = float(np.percentile(a, 80))
    back = float(np.percentile(a, 2))
    thr = back + (paper - back) * 0.5
    ok = True

    # 1. 凸性与顺序
    signs = [cross(pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]) for i in range(4)]
    convex = all(s > 0 for s in signs)
    if verbose:
        print('  [%s] 角点顺序/凸性' % ('OK' if convex else 'XX'))
    if not convex:
        print('       方向不一致，顺序应为 左上→右上→右下→左下')
        ok = False

    # 2. 越界幅度
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    out = [max(0, -min(xs)), max(0, max(xs) - w), max(0, -min(ys)), max(0, max(ys) - h)]
    oob = max(out) / max(w, h) * 100
    good = oob < 15
    if verbose:
        print('  [%s] 越界幅度 %.1f%%（角点出画面属正常，上限 15%%）'
              % ('OK' if good else 'XX', oob))
    ok &= good

    # 3. 内部应是纸面（亮）
    inner = sample_map(a, pts, shrink=0.88)
    frac_paper = float((inner > thr).mean())
    good = frac_paper > 0.6
    if verbose:
        print('  [%s] 框内纸面占比 %.0f%%（应 >60%%，偏低说明取到桌面）'
              % ('OK' if good else 'XX', frac_paper * 100))
    ok &= good

    # 4. 四条边外侧应是桌面（暗）——逐边判定，指出问题边
    names = ['上边', '右边', '下边', '左边']
    bad_edges = []
    for i in range(4):
        p1, p2 = pts[i], pts[(i + 1) % 4]
        mid = (np.asarray(p1) + np.asarray(p2)) / 2
        c = sum(np.asarray(p, float) for p in pts) / 4
        d = mid - c
        norm = np.linalg.norm(d)
        if norm < 1e-6:
            continue
        d = d / norm
        # 沿该边外侧取样
        tc = (np.asarray(p1) + np.asarray(p2)) / 2
        fracs = []
        for t in np.linspace(0.15, 0.85, 12):
            base = np.asarray(p1) + (np.asarray(p2) - np.asarray(p1)) * t
            span = max(w, h)
            for k in (span * 0.02, span * 0.035, span * 0.05):  # 外移 2%%~5%% 图幅
                x, y = base + d * k
                xi, yi = int(round(x)), int(round(y))
                if 0 <= xi < w and 0 <= yi < h:
                    fracs.append(a[yi, xi])
        if len(fracs) < 8:
            continue
        fracs = np.asarray(fracs)
        dark_frac = float((fracs < thr).mean())
        # 外侧大部分应是暗背景；若几乎全亮，说明该边取进了纸内，纸边被切
        if dark_frac < 0.35:
            bad_edges.append((names[i], dark_frac))
    # 5. 沿四条边内侧取样: 应全是纸面; 若混入桌面说明该边取到纸外
    outside_edges = []
    for i in range(4):
        p1, p2 = pts[i], pts[(i + 1) % 4]
        mid = (np.asarray(p1) + np.asarray(p2)) / 2
        c = sum(np.asarray(p, float) for p in pts) / 4
        d = mid - c
        norm = np.linalg.norm(d)
        if norm < 1e-6:
            continue
        d = d / norm
        vals = []
        span = max(w, h)
        for t in np.linspace(0.15, 0.85, 12):
            base = np.asarray(p1) + (np.asarray(p2) - np.asarray(p1)) * t
            for k in (span * 0.015, span * 0.03, span * 0.045):
                x, y = base - d * k     # 向内
                xi, yi = int(round(x)), int(round(y))
                if 0 <= xi < w and 0 <= yi < h:
                    vals.append(a[yi, xi])
        if len(vals) < 8:
            continue
        vals = np.asarray(vals)
        paper_frac = float((vals > thr).mean())
        if paper_frac < 0.75:
            outside_edges.append((names[i], paper_frac))
    good2 = not outside_edges

    if verbose:
        if not bad_edges:
            print('  [OK] 四边外侧检测到桌面，纸边已被框住')
        else:
            # 外侧仍偏亮有两种可能：取点偏内（会切内容），或纸边本身倾斜导致
            # 固定外移采样仍落在纸内。二者无法用亮度区分，故只作提示不判错。
            print('  [--] 提示：下列边外侧仍偏亮（可能取点偏内，也可能是纸边倾斜）：')
            for n, f in bad_edges:
                print('       %s 外侧纸面占比 %.0f%% → 可尝试再向外扩 3~5px 后目视确认'
                      % (n, (1 - f) * 100))

    if verbose:
        if good2:
            print('  [OK] 四边内侧均为纸面')
        else:
            print('  [XX] 下列边内侧混入桌面，说明取点落在纸外：')
            for n, f in outside_edges:
                print('       %s（内侧纸面仅 %.0f%%）→ 该边角点向内收 5px' % (n, f * 100))
    ok &= good2
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('img'); ap.add_argument('quad')
    a = ap.parse_args()
    pts = parse(a.quad)
    print('校验 %s  角点 %s' % (a.img, a.quad))
    ok = check(a.img, pts)
    print('\n结论：%s' % ('角点可用' if ok else '需调整上面标 XX 的项'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
