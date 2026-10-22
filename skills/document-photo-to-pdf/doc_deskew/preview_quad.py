"""角点回画预览：把已落盘的四角画回原图，供二次确认。

用途：把落盘的数字角点重新变成可看的画面。
本脚本把四边形 + 四角标记 + 边标签画回原图，让"数字"重新变成可看的画面，
在出件前确认四条边是否真的压在纸张亮面与桌面暗面的交界线上。

图上元素：
  绿色四边形      —— 当前角点连线，应紧贴纸边
  红色十字 + 序号 —— 四个角点（1左上 2右上 3右下 4左下）
  黄色短刻度线    —— 每条边中点的外法线，用于看边是否贴边
  右下角文字      —— 两行：文件名 / 角点串（避开顶部/左侧刻度）

用法：
    python3 doc_deskew/preview_quad.py 图1.jpg 图2.jpg
    python3 doc_deskew/preview_quad.py --corners .tmp/corners.json
    python3 doc_deskew/preview_quad.py --corners .tmp/corners.json --zoom 右

输出：.tmp/quad_<名称>.png
    --zoom 另存右侧/左侧/上边/下边放大块，.tmp/quad_<名称>_<区域>.png
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

DEFAULT_CORNERS = '.tmp/corners.json'
OUT_DIR = '.tmp'

LABELS = ['1 左上', '2 右上', '3 右下', '4 左下']
COLOR_QUAD = (0, 255, 0)
COLOR_CORNER = (255, 40, 40)
COLOR_EDGE = (255, 220, 0)


def load_corners(path):
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    out = {}
    for name, quad in data.items():
        if isinstance(quad, dict):
            quad = quad.get('quad') or quad.get('corners')
        out[name] = [(float(p[0]), float(p[1])) for p in quad]
    return out


def get_font(size=26):
    # 先找中文字体（图上要画 "1 左上" 这类标签，西文字体会变成豆腐块）
    for p in ('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
              '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
              '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
              '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
              '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_quad(img_path, pts, scale=1.0, base_path=None, with_grid=False):
    """在底图上叠加四角标注。

    base_path 非空时直接用该图当底图（通常是 prepare 生成的网格图，连同候选标记一起继承）；
    为空时退回原图，with_grid=True 则即时叠一层网格。
    """
    im = Image.open(base_path or img_path).convert('RGB')
    if with_grid and base_path is None:
        from grid import draw_grid_on
        im = draw_grid_on(im)
    if scale != 1.0:
        im = im.resize((int(im.width * scale), int(im.height * scale)),
                       Image.LANCZOS)
    d = ImageDraw.Draw(im)
    font = get_font(max(14, int(26 * min(1.0, scale + 0.15))))
    sml = get_font(max(11, int(18 * min(1.0, scale + 0.15))))
    w = max(2, int(3 * scale + 0.5))
    P = [(x * scale, y * scale) for x, y in pts]

    # 四边形
    d.line(P + [P[0]], fill=COLOR_QUAD, width=w)

    # 四角十字 + 序号
    r = max(10, int(22 * scale + 0.5))
    for i, (x, y) in enumerate(P):
        d.line([(x - r, y), (x + r, y)], fill=COLOR_CORNER, width=w)
        d.line([(x, y - r), (x, y + r)], fill=COLOR_CORNER, width=w)
        tx, ty = x + r + 4, y - r - 4
        d.text((tx, ty), LABELS[i], fill=COLOR_CORNER, font=sml,
               stroke_width=2, stroke_fill=(0, 0, 0))

    # 每条边中点外法线刻度
    cx = sum(p[0] for p in P) / 4.0
    cy = sum(p[1] for p in P) / 4.0
    L = max(16, int(40 * scale + 0.5))
    for i in range(4):
        a, b = P[i], P[(i + 1) % 4]
        mx, my = (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0
        dx, dy = mx - cx, my - cy
        n = (dx * dx + dy * dy) ** 0.5 or 1.0
        dx, dy = dx / n, dy / n
        d.line([(mx, my), (mx + dx * L, my + dy * L)],
               fill=COLOR_EDGE, width=max(2, w - 1))

    # 右下角信息条（避开顶部/左侧的网格刻度）：第一行文件名，第二行角点串
    lines = [os.path.basename(img_path),
             ';'.join('%g,%g' % (p[0], p[1]) for p in pts)]
    pad = 8
    gap = 6
    tw = int(max(d.textlength(s, font=font) for s in lines))
    ascent, descent = font.getmetrics()
    line_h = ascent + descent
    th = line_h * len(lines) + gap * (len(lines) - 1)
    tx = max(pad, im.width - tw - pad * 2)
    ty = max(pad, im.height - th - pad * 2)
    d.rectangle([tx - 4, ty - 4, tx + tw + 4, ty + th + 4], fill=(0, 0, 0))
    for i, s in enumerate(lines):
        d.text((tx, ty + i * (line_h + gap)), s, fill=(255, 255, 255), font=font)
    return im


def zoom_boxes(im, pts):
    """按角点外接框给出四侧放大区域。"""
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    W, H = im.size
    mx = (x1 - x0) * 0.18
    my = (y1 - y0) * 0.18
    boxes = {
        'left': (max(0, x0 - mx), max(0, y0 - my), min(W, x0 + mx), min(H, y1 + my)),
        'right': (max(0, x1 - mx), max(0, y0 - my), min(W, x1 + mx), min(H, y1 + my)),
        'top': (max(0, x0 - mx), max(0, y0 - my), min(W, x1 + mx), min(H, y0 + my)),
        'bottom': (max(0, x0 - mx), max(0, y1 - my), min(W, x1 + mx), min(H, y1 + my)),
    }
    return boxes


def main():
    ap = argparse.ArgumentParser(description='把角点画回原图做二次确认')
    ap.add_argument('images', nargs='*', help='图片文件名（角点已在 corners.json 中）')
    ap.add_argument('--corners', default=DEFAULT_CORNERS)
    ap.add_argument('--zoom', choices=['left', 'right', 'top', 'bottom', 'all'],
                    default=None, help='另存某侧放大块')
    ap.add_argument('--scale', type=float, default=1.0, help='整体缩放，>1 放大')
    ap.add_argument('--out', default=None, help='输出目录，默认 .tmp')
    args = ap.parse_args()

    data = load_corners(args.corners)
    names = args.images or list(data.keys())
    missing = [n for n in names if n not in data]
    if missing:
        raise SystemExit('corners.json 中没有这些图的角点：%s' % ', '.join(missing))

    outdir = args.out or OUT_DIR
    os.makedirs(outdir, exist_ok=True)

    for name in names:
        pts = data[name]
        im = draw_quad(name, pts, args.scale)
        base = os.path.splitext(os.path.basename(name))[0]
        dst = os.path.join(outdir, 'quad_%s.png' % base)
        im.save(dst)
        print('written %s (%dx%d) %s' % (dst, im.width, im.height,
                                         ';'.join('%g,%g' % p for p in pts)))
        if args.zoom:
            boxes = zoom_boxes(im, [(x * args.scale, y * args.scale) for x, y in pts])
            keys = list(boxes) if args.zoom == 'all' else [args.zoom]
            for k in keys:
                box = tuple(int(v) for v in boxes[k])
                if box[2] <= box[0] or box[3] <= box[1]:
                    continue
                crop = im.crop(box)
                f = min(3.0, max(1.0, 700.0 / max(1, crop.width)))
                if f > 1.0:
                    crop = crop.resize((int(crop.width * f), int(crop.height * f)),
                                       Image.LANCZOS)
                z = os.path.join(outdir, 'quad_%s_%s.png' % (base, k))
                crop.save(z)
                print('written %s (%dx%d)' % (z, crop.width, crop.height))


if __name__ == '__main__':
    main()
