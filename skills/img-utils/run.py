#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
img-utils 技能主入口：用 Pillow 做确定性的图像处理（不含 AI 生成/语义修图）。

支持动作 action：
- info        查看图片信息（尺寸/模式/格式/体积）
- convert     格式转换（按 output 扩展名）
- resize      缩放（keep_ratio 默认保持宽高比）
- crop        裁剪（left/top/width/height）
- compress    压缩（quality；可选 max_dim 先缩长边）
- watermark   文字水印（text；中文需系统字体或 font 参数）
- slice       等分切片（rows/cols，默认 3×3，输出到独立目录）
- grid        多图拼图 contact sheet（input 为图片所在目录）

约定：输出绝不覆盖输入原图；相对路径由 Skill Manager 预先转成绝对路径。
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff'}
POSITIONS = {
    'tl': ('l', 't'), 'tc': ('c', 't'), 'tr': ('r', 't'),
    'ml': ('l', 'm'), 'mc': ('c', 'm'), 'mr': ('r', 'm'),
    'bl': ('l', 'b'), 'bc': ('c', 'b'), 'br': ('r', 'b'),
}
NAMED_COLORS = {
    'white': (255, 255, 255), 'black': (0, 0, 0), 'red': (255, 0, 0),
    'green': (0, 128, 0), 'blue': (0, 0, 255), 'yellow': (255, 255, 0),
    'gray': (128, 128, 128), 'grey': (128, 128, 128), 'orange': (255, 165, 0),
    'purple': (128, 0, 128), 'cyan': (0, 255, 255),
}
CJK_FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
]
# Noto 只作最后兑底：Pillow(FreeType) 能读它的 CFF 轮廓，但 ttc 默认字型（索引 0）是 JP 字形，
# 中文水印会出日式写法；因此系统文泉驿（CJK_FONT_CANDIDATES）排在它前面。
NOTO_CJK_FALLBACK = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'


def to_int(v, default=0):
    if v is None or v == '':
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        raise ValueError('参数应为整数：%r' % (v,))


def to_bool(v, default=True):
    if v is None or v == '':
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ('1', 'true', 'yes', 'y', 'on')
    return bool(v)


def parse_color(s, default=(255, 255, 255)):
    s = (s or '').strip().lower()
    if not s:
        return default
    if s in NAMED_COLORS:
        return NAMED_COLORS[s]
    if s.startswith('#'):
        h = s[1:]
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        if len(h) == 6:
            try:
                return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
            except ValueError:
                pass
    raise ValueError('无法识别的颜色：%s（支持 white/black/red/... 或 #RRGGBB）' % s)


def open_image(path):
    """打开图片并按 EXIF 方向摆正；返回 (img, 原始格式名)。"""
    img = Image.open(str(path))
    fmt = img.format or ''
    img.load()
    img = ImageOps.exif_transpose(img)
    return img, fmt


def ensure_rgb(img):
    if img.mode in ('RGBA', 'LA', 'P'):
        return img.convert('RGB')
    return img


def save_image(img, out_path, quality=None):
    """按输出扩展名保存；JPEG/WebP 用 quality，PNG 走 optimize。"""
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fmt = (p.suffix or '').lstrip('.').upper()
    q = to_int(quality, 90)
    q = max(1, min(95, q))
    if fmt in ('JPG', 'JPEG'):
        ensure_rgb(img).save(str(p), format='JPEG', quality=q, optimize=True)
    elif fmt == 'WEBP':
        img.save(str(p), format='WEBP', quality=q)
    elif fmt == 'PNG':
        img.save(str(p), format='PNG', optimize=True)
    elif fmt in ('BMP', 'GIF', 'TIFF', 'TIF', 'ICO'):
        img.save(str(p))
    else:
        raise ValueError('不支持的输出扩展名：%s（支持 jpg/jpeg/png/webp/bmp/gif/tiff）'
                         % (p.suffix or '(无)'))


def default_out(input_path, tag):
    """缺省输出：同目录 <原名>_<tag><原扩展名>，不覆盖原图。"""
    p = Path(input_path)
    return str(p.parent / ('%s_%s%s' % (p.stem, tag, p.suffix if p.suffix else '.png')))


def ensure_different(src, dst):
    if Path(src).resolve() == Path(dst).resolve():
        raise ValueError('输出路径与输入相同：%s，不允许覆盖原图，请指定新的 output' % src)


def resample():
    return getattr(Image, 'Resampling', Image).LANCZOS


# ---------- 各动作实现 ----------

def action_info(img, fmt, args):
    w, h = img.size
    lines = ['图片信息：']
    lines.append('- 文件：%s' % args['_input'])
    lines.append('- 尺寸：%dx%d 像素' % (w, h))
    lines.append('- 色彩模式：%s' % img.mode)
    lines.append('- 格式：%s' % (fmt or '未知'))
    try:
        kb = Path(args['_input']).stat().st_size / 1024.0
        lines.append('- 文件大小：%.1f KB' % kb)
    except OSError:
        pass
    return '\n'.join(lines)


def action_convert(img, fmt, args):
    out = args.get('output')
    if not out:
        raise ValueError('convert 需要 output 参数（带目标扩展名，如 out.png）')
    ensure_different(args['_input'], out)
    save_image(img, out, quality=args.get('quality'))
    return '格式转换完成：%s -> %s' % (args['_input'], out)


def action_resize(img, fmt, args):
    w = to_int(args.get('width'))
    h = to_int(args.get('height'))
    keep = to_bool(args.get('keep_ratio'), True)
    if not w and not h:
        raise ValueError('resize 需要 width 或 height（至少一个）')
    iw, ih = img.size
    if keep:
        if w and h:
            scale = min(w / iw, h / ih)
            nw, nh = max(1, round(iw * scale)), max(1, round(ih * scale))
        elif w:
            nw, nh = w, max(1, round(ih * (w / iw)))
        else:
            nw, nh = max(1, round(iw * (h / ih))), h
    else:
        if not (w and h):
            raise ValueError('keep_ratio=false 时 width 与 height 都要提供')
        nw, nh = w, h
    img2 = img.resize((max(1, nw), max(1, nh)), resample())
    out = args.get('output') or default_out(args['_input'], 'resized')
    ensure_different(args['_input'], out)
    save_image(img2, out, quality=args.get('quality'))
    return '缩放完成：%dx%d -> %dx%d，输出 %s' % (iw, ih, img2.size[0], img2.size[1], out)


def action_crop(img, fmt, args):
    iw, ih = img.size
    left = to_int(args.get('left'))
    top = to_int(args.get('top'))
    width = to_int(args.get('width'), max(1, iw - left))
    height = to_int(args.get('height'), max(1, ih - top))
    if width < 1 or height < 1:
        raise ValueError('crop 的 width/height 必须 >= 1')
    left = max(0, left)
    top = max(0, top)
    right = min(iw, left + width)
    bottom = min(ih, top + height)
    if right <= left or bottom <= top:
        raise ValueError('裁剪区域超出图片范围（图片 %dx%d）' % (iw, ih))
    out = args.get('output') or default_out(args['_input'], 'cropped')
    ensure_different(args['_input'], out)
    save_image(img.crop((left, top, right, bottom)), out, quality=args.get('quality'))
    return '裁剪完成：区域 (%d,%d)-(%d,%d)，输出 %s' % (left, top, right, bottom, out)


def action_compress(img, fmt, args):
    img2 = img
    md = to_int(args.get('max_dim'))
    if md > 0 and max(img2.size) > md:
        img2 = ImageOps.contain(img2, (md, md), resample())
    out = args.get('output') or default_out(args['_input'], 'compressed')
    ensure_different(args['_input'], out)
    q = to_int(args.get('quality'), 85)
    try:
        before = Path(args['_input']).stat().st_size
    except OSError:
        before = 0
    save_image(img2, out, quality=q)
    try:
        after = Path(out).stat().st_size
    except OSError:
        after = 0
    pct = (100.0 * after / before) if before else 0
    return '压缩完成：%.1f KB -> %.1f KB（%.0f%%），输出 %s' % (before / 1024.0, after / 1024.0, pct, out)


def find_font(explicit):
    """字体查找：显式 font > 系统 wqy > Noto 兑底。"""
    if explicit:
        p = Path(explicit)
        if not p.exists():
            raise ValueError('指定的字体不存在：%s' % explicit)
        return str(p)
    candidates = list(CJK_FONT_CANDIDATES)
    candidates.append(NOTO_CJK_FALLBACK)
    for c in candidates:
        if Path(c).exists():
            return c
    return None


def action_watermark(img, fmt, args):
    text = (args.get('text') or '').strip()
    if not text:
        raise ValueError('watermark 需要 text 参数')
    w, h = img.size
    font_size = to_int(args.get('font_size'), max(14, w // 20))
    font_size = max(8, min(400, font_size))
    need_cjk = any(ord(ch) > 0x2E80 for ch in text)
    font_path = find_font((args.get('font') or '').strip())
    if font_path:
        font = ImageFont.truetype(font_path, font_size)
    elif need_cjk:
        raise ValueError('中文水印缺少字体：请传 font 参数（TTF/TTC 路径），或确认系统已装文泉驿/Noto 字体')
    else:
        try:
            font = ImageFont.load_default(size=font_size)
        except TypeError:
            font = ImageFont.load_default()

    pos = (args.get('position') or 'br').strip().lower()
    if pos not in POSITIONS:
        raise ValueError('position 必须是 tl/tc/tr/ml/mc/mr/bl/bc/br 之一')
    align_x, align_y = POSITIONS[pos]
    margin = max(0, to_int(args.get('margin'), 20))
    color = parse_color(args.get('color'), (255, 255, 255))
    opacity = max(0, min(255, to_int(args.get('opacity'), 200)))

    # 在透明层上画字再合成，保证半透明水印且边缘平滑
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if align_x == 'l':
        ox = margin - bbox[0]
    elif align_x == 'c':
        ox = (w - tw) / 2.0 - bbox[0]
    else:
        ox = w - margin - bbox[2]
    if align_y == 't':
        oy = margin - bbox[1]
    elif align_y == 'm':
        oy = (h - th) / 2.0 - bbox[1]
    else:
        oy = h - margin - bbox[3]
    draw.text((ox, oy), text, font=font, fill=color + (opacity,))

    base = img.convert('RGBA')
    composed = Image.alpha_composite(base, layer)
    out = args.get('output') or default_out(args['_input'], 'watermarked')
    ensure_different(args['_input'], out)
    save_image(composed, out, quality=args.get('quality'))
    return '水印完成（位置 %s，字号 %d，不透明度 %d）：%s' % (pos, font_size, opacity, out)


def action_slice(img, fmt, args):
    w, h = img.size
    rows = to_int(args.get('rows'))
    cols = to_int(args.get('cols'))
    if rows and not cols:
        cols = rows
    if cols and not rows:
        rows = cols
    rows = max(1, min(20, rows or 3))
    cols = max(1, min(20, cols or 3))
    src = Path(args['_input'])
    out_dir = Path(args.get('output')) if args.get('output') else src.parent / (src.stem + '_slice')
    out_dir.mkdir(parents=True, exist_ok=True)
    ext = src.suffix.lower()
    if ext not in IMAGE_EXTS:
        ext = '.png'
    cw = max(1, w // cols)
    chh = max(1, h // rows)
    files = []
    for r in range(rows):
        for c in range(cols):
            box = (c * cw, r * chh, min(w, (c + 1) * cw), min(h, (r + 1) * chh))
            tile = img.crop(box)
            name = '%s_%02d_%02d%s' % (src.stem, r + 1, c + 1, ext)
            save_image(tile, str(out_dir / name))
            files.append(str(out_dir / name))
    return '切片完成：%d×%d 共 %d 块，输出目录 %s\n%s' % (cols, rows, len(files), out_dir, '\n'.join(files))


def action_grid(args):
    in_dir = Path(args.get('input'))
    if not in_dir.is_dir():
        raise ValueError('grid 的 input 应为图片所在目录：%s' % in_dir)
    out = args.get('output')
    if not out:
        out = str(in_dir / ('%s_grid.jpg' % (in_dir.name or 'images')))
    imgs = sorted(
        p for p in in_dir.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS
        and not p.name.startswith('.')
        and Path(p).resolve() != Path(out).resolve()
    )
    if not imgs:
        raise ValueError('目录中没有可拼图的图片：%s' % in_dir)
    n = len(imgs)
    cols = to_int(args.get('cols'))
    if not cols:
        cols = max(1, int(n ** 0.5 + 0.999))  # 缺省近似正方形网格
    cols = max(1, min(20, cols))
    rows = (n + cols - 1) // cols
    cell = max(50, min(2048, to_int(args.get('cell'), 800)))
    pad = max(0, to_int(args.get('padding'), 10))
    bg = parse_color(args.get('background'), (255, 255, 255))

    sheet = Image.new('RGB', (cols * cell + (cols + 1) * pad, rows * cell + (rows + 1) * pad), bg)
    placed = []
    for i, p in enumerate(imgs):
        try:
            im, _ = open_image(p)
        except Exception as e:
            print('跳过无法读取的图片：%s（%s）' % (p, e))
            continue
        thumb = im.copy()
        thumb.thumbnail((cell, cell), resample())
        thumb = ensure_rgb(thumb)
        x = pad + (i % cols) * cell + (cell - thumb.size[0]) // 2
        y = pad + (i // cols) * cell + (cell - thumb.size[1]) // 2
        sheet.paste(thumb, (x, y))
        im.close()
        placed.append(p.name)
    if not placed:
        raise ValueError('目录中的图片都无法读取：%s' % in_dir)
    save_image(sheet, out)
    return '拼图完成：%d/%d 张 -> %s（网格 %d×%d，每格长边 %dpx）' % (len(placed), n, out, cols, rows, cell)


ACTIONS = {
    'info': action_info,
    'convert': action_convert,
    'resize': action_resize,
    'crop': action_crop,
    'compress': action_compress,
    'watermark': action_watermark,
    'slice': action_slice,
    'grid': action_grid,
}


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 run.py '<json_string>'", file=sys.stderr)
        sys.exit(1)
    try:
        args = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print('参数不是合法 JSON：%s' % e, file=sys.stderr)
        sys.exit(1)
    action = (args.get('action') or '').strip().lower()
    if not action:
        print('Error: 缺少 action（可选：%s）' % '/'.join(sorted(ACTIONS)), file=sys.stderr)
        sys.exit(1)
    if action not in ACTIONS:
        print('Error: 不支持的 action：%s（可选：%s）' % (action, '/'.join(sorted(ACTIONS))), file=sys.stderr)
        sys.exit(1)
    try:
        if action == 'grid':
            text = action_grid(args)
        else:
            input_path = (args.get('input') or '').strip()
            if not input_path:
                raise ValueError('缺少 input 参数')
            if not Path(input_path).exists():
                raise ValueError('输入文件不存在：%s' % input_path)
            img, fmt = open_image(input_path)
            try:
                args['_input'] = input_path
                text = ACTIONS[action](img, fmt, args)
            finally:
                img.close()
        print(text)
    except Exception as e:
        print('Error: %s' % e, file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
