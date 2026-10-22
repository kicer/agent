# -*- coding: utf-8 -*-
"""prepare 阶段的出图逻辑：坐标网格图 + 脚本候选角点/边线叠加。

产物
    out/N-网格-<图名>.png        网格 + 候选角点（人工读数的主依据）

约定
    - 候选角点只做**参考**：不落盘、不写 corners.json、不参与出件，
      由 pipeline 直接在终端打成 markdown 表格供对照；
    - 图上不写字，避免遮挡纸面内容。
"""
import math
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grid import draw_grid_on

COLOR_EDGE = (0, 0, 0)        # 黑：脚本检出的边线像素
COLOR_CAND = (255, 0, 180)    # 品红：候选四边形与角点
LABELS = ('左上', '右上', '右下', '左下')


def _dashed(d, p0, p1, fill, width=2, dash=14, gap=9):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L = math.hypot(dx, dy)
    if L < 1e-6:
        return
    ux, uy = dx / L, dy / L
    t = 0.0
    while t < L:
        a, b = t, min(t + dash, L)
        d.line([(p0[0] + ux * a, p0[1] + uy * a),
                (p0[0] + ux * b, p0[1] + uy * b)], fill=fill, width=width)
        t += dash + gap


def _extend(p0, p1, px):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L = math.hypot(dx, dy)
    if L < 1e-6:
        return p0, p1
    ux, uy = dx / L, dy / L
    return (p0[0] - ux * px, p0[1] - uy * px), (p1[0] + ux * px, p1[1] + uy * px)


def render(src, dst, corners=None, edge_mask=None, scale=1.0, extend_px=None):
    """画网格图；corners 非空时叠加候选边线与角点。"""
    im = Image.open(src).convert('RGBA')

    if edge_mask is not None:
        m = Image.fromarray((edge_mask * 255).astype('uint8'), 'L')
        if m.size != im.size:
            m = m.resize(im.size, Image.NEAREST)
        lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
        lay.paste(COLOR_EDGE + (200,), (0, 0), m.point(lambda v: 255 if v > 127 else 0))
        im = Image.alpha_composite(im, lay)

    im = draw_grid_on(im)
    if not corners:
        im.convert('RGB').save(dst, quality=92)
        return dst

    d = ImageDraw.Draw(im, 'RGBA')
    n = len(corners)
    ext = extend_px if extend_px is not None else max(30, im.size[1] // 36)
    for i in range(n):
        a, b = _extend(corners[i], corners[(i + 1) % n], ext)
        _dashed(d, a, b, COLOR_CAND + (240,), width=2)

    for x, y in corners:
        d.ellipse([x - 14, y - 14, x + 14, y + 14],
                  outline=(255, 255, 255, 255), width=4)
        d.ellipse([x - 8, y - 8, x + 8, y + 8], fill=COLOR_CAND + (255,))
        d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(255, 255, 255, 255))

    im.convert('RGB').save(dst, quality=92)
    return dst


def detect_corners(src, max_side=1600):
    """调用 auto_quad 取候选角点；失败返回 (None, None)，不抛异常打断 prepare。"""
    try:
        import auto_quad
        pts, info = auto_quad.detect(src, max_side=max_side)
        return (pts or None), info
    except Exception as e:                      # 检测失败不该阻塞流程
        print('[提示] 候选角点检测跳过：%s' % e)
        return None, None



