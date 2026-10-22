#!/usr/bin/env python3
"""文档照片 -> 校正 PDF：全流程串起来的一站式脚本。

把原来手工分步的活（网格图 -> 读角点 -> 落盘 -> 回画确认 -> 出 PDF -> 检验）
压成几条命令，且**产物都落在 out/ 里按序号命名**：

    out/1-网格-<原图名>.png      每页的坐标网格图（读角点用）
    out/1-角标-<原图名>.png      每页角点回画图（原图 + 网格 + 四角标注，核查是否贴纸边）
    out/1-成品-<原图名>.png      每页矫正后的页面图
    out/corners.json             角点坐标（落盘，跨会话可用）
    out/<名字>.pdf               最终 PDF

角点约定（顺序固定，别写反）：
    左上 ; 右上 ; 右下 ; 左下      —— 屏幕坐标，原点在图片左上角，单位像素

子命令：
    prepare  出网格图 + 生成 corners.json 模板（坐标留空待填）
    set      把某一页的四角坐标写进 corners.json（可反复调用）
    build    回画角标图 + 校验 + 出 PDF + 出成品图 + PDF 检验，一次跑完
    all      prepare + build 合体（角点已存在则直接 build）
    check    复检已有 PDF（只渲染检验，不重新出件）

典型用法（脚本用绝对路径调用：cwd 是会话任务目录，不是本目录）：
    # 1) 出网格图
    python3 /workspace/skills/document-photo-to-pdf/doc_deskew/pipeline.py prepare 图1.jpg 图2.jpg
    # 2) 看 out/1-网格-图1.png，把坐标写进文件
    python3 /workspace/skills/document-photo-to-pdf/doc_deskew/pipeline.py set "图1.jpg" --quad "150,360;1020,355;1050,1690;90,1660"
    python3 /workspace/skills/document-photo-to-pdf/doc_deskew/pipeline.py set "图2.jpg" --quad "120,345;1010,345;1010,1710;120,1710"
    # 3) 一路出 PDF
    python3 /workspace/skills/document-photo-to-pdf/doc_deskew/pipeline.py build --out 合同_校正.pdf

    # 想一步到位（角点已落盘）：
    python3 /workspace/skills/document-photo-to-pdf/doc_deskew/pipeline.py all 图1.jpg 图2.jpg --out 合同_校正.pdf

    # 列出 / 检查已落盘角点
    python3 /workspace/skills/document-photo-to-pdf/doc_deskew/pipeline.py show

退出码：0 全部通过；2 角点校验未通过（已出件但需人工判断）；3 PDF 检验未通过。
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# 提示里回显的命令：cwd 是会话任务目录，必须用脚本绝对路径，写相对的跑不起来
SELF = 'python3 ' + os.path.join(HERE, 'pipeline.py')

OUT_DIR = 'out'
CORNERS = os.path.join(OUT_DIR, 'corners.json')
LABELS = ('左上', '右上', '右下', '左下')

IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff')


# ---------------------------------------------------------------- 基础工具

def natural_key(name):
    return [int(t) if t.isdigit() else t.lower()
            for t in re.split(r'(\d+)', os.path.basename(name))]


def quad_to_str(quad):
    return ';'.join('%g,%g' % (p[0], p[1]) for p in quad)


def load_corners(path=CORNERS):
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        raw = json.load(f)
    out = {}
    for name, v in raw.items():
        if isinstance(v, dict):
            v = v.get('quad') or v.get('corners')
        if not v:
            continue
        out[name] = [(float(p[0]), float(p[1])) for p in v]
    return out


def save_corners(data, path=CORNERS):
    os.makedirs(os.path.dirname(os.path.abspath(path)) or '.', exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({k: [[int(c) if float(c).is_integer() else c for c in p]
                       for p in v] for k, v in data.items()},
                  f, ensure_ascii=False, indent=2)
        f.write('\n')
    os.replace(tmp, path)


def parse_quad(text):
    quad = []
    for pt in text.replace('；', ';').split(';'):
        pt = pt.strip()
        if not pt:
            continue
        xy = pt.replace(' ', '').split(',')
        if len(xy) != 2:
            raise SystemExit('角点格式不对：%r（应为 x,y）' % pt)
        try:
            quad.append((float(xy[0]), float(xy[1])))
        except ValueError:
            raise SystemExit('角点不是数字：%r' % pt)
    if len(quad) != 4:
        raise SystemExit('角点必须 4 个（左上;右上;右下;左下），实际 %d 个' % len(quad))
    return quad


def collect_images(args):
    """参数里的图片 + 当前目录全部图片（去重、按自然序）。"""
    names = list(args)
    if not names:
        names = [f for f in os.listdir('.')
                 if f.lower().endswith(IMG_EXT) and os.path.isfile(f)]
    seen, out = set(), []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    if not out:
        raise SystemExit('没有找到图片：可在命令后面直接列文件名')
    missing = [n for n in out if not os.path.exists(n)]
    if missing:
        raise SystemExit('图片不存在：%s' % ', '.join(missing))
    return sorted(out, key=natural_key)


def page_tag(i):
    return '%d' % i


def out_path(prefix, i, name, ext='.png'):
    base = os.path.splitext(os.path.basename(name))[0]
    return os.path.join(OUT_DIR, '%s-%s-%s%s' % (page_tag(i), prefix, base, ext))


# ---------------------------------------------------------------- prepare

def cmd_prepare(images):
    os.makedirs(OUT_DIR, exist_ok=True)
    from grid import draw_grid
    data = load_corners()
    for i, name in enumerate(images, 1):
        dst = out_path('网格', i, name)
        draw_grid(name, dst)
        data.setdefault(name, None)
    save_corners({k: v for k, v in data.items() if v})
    print('\n网格图已写入 %s/' % OUT_DIR)
    print('下一步：照着网格图读数，把角点写进 %s：' % CORNERS)
    for i, name in enumerate(images, 1):
        print('  %s set "%s" --quad "左上x,左上y;右上x,右上y;'
              '右下x,右下y;左下x,左下y"' % (SELF, name))
    return 0


# ---------------------------------------------------------------- set / show

def cmd_set(args):
    """一次只写一张图：参数是 图片 + 一个 --quad，不批配、不错位。"""
    if '|' in args.image or ':' in args.image:
        raise SystemExit('图片名里不要带 : 或 |：%s' % args.image)
    if not os.path.exists(args.image):
        raise SystemExit('图片不存在：%s' % args.image)
    if len(args.quad) != 1:
        raise SystemExit('set 只能给一个 --quad（实际 %d 个）。一张图一次。'
                         % len(args.quad))

    name = args.image
    quad_s = args.quad[0]

    data = load_corners()
    old = data.get(name)
    data[name] = parse_quad(quad_s)
    save_corners(data)
    if old is not None:
        print('已更新 %-36s %s（原 %s）'
              % (name, quad_to_str(data[name]), quad_to_str(old)))
    else:
        print('已写入 %-36s %s' % (name, quad_to_str(data[name])))
    print('→ %s（已存：%s）'
          % (CORNERS, '、'.join(sorted(data, key=natural_key))))
    left = [n for n in data if not os.path.exists(n)]
    if left:
        print('[注意] 这些图在 corners.json 里但文件不存在：%s' % '、'.join(left))
    return 0


def cmd_show():
    data = load_corners()
    if not data:
        print('%s 里还没有角点' % CORNERS)
        return 1
    for i, name in enumerate(sorted(data, key=natural_key), 1):
        print('%d. %-40s %s' % (i, name, quad_to_str(data[name])))
    return 0


# ---------------------------------------------------------------- 角标图

def draw_marks(name, pts, dst):
    """把四角画回原图（底图叠加与网格图相同的网格），供人工核查。"""
    from preview_quad import draw_quad
    im = draw_quad(name, pts, with_grid=True)
    im.save(dst)
    return dst


def make_zooms(name, marked_png, idx, zoom):
    """从角标图上裁出四侧放大块，命名同其它核查图的序号规则。"""
    from PIL import Image
    from preview_quad import zoom_boxes
    im = Image.open(marked_png)
    boxes = zoom_boxes(im, [(0, 0), (im.width, 0), (im.width, im.height), (0, im.height)])
    keys = list(boxes) if zoom == 'all' else [zoom]
    base = os.path.join(OUT_DIR, '%d-角标放大-%s' % (idx, os.path.basename(name)))
    base = os.path.splitext(base)[0]
    for k in keys:
        box = tuple(int(v) for v in boxes[k])
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        crop = im.crop(box)
        # 细长条按方向切成两段，否则 585x5760 没法看
        segs = []
        if k in ('left', 'right') and crop.height > crop.width * 2.2:
            h = crop.height // 2
            segs = [('上', crop.crop((0, 0, crop.width, h))),
                    ('下', crop.crop((0, h, crop.width, crop.height)))]
        elif k in ('top', 'bottom') and crop.width > crop.height * 2.2:
            w = crop.width // 2
            segs = [('左', crop.crop((0, 0, w, crop.height))),
                    ('右', crop.crop((w, 0, crop.width, crop.height)))]
        else:
            segs = [('', crop)]
        for tag, c in segs:
            f = min(3.0, max(1.0, 700.0 / max(1, c.width)))
            if f > 1.0:
                c = c.resize((int(c.width * f), int(c.height * f)), Image.LANCZOS)
            z = '%s-%s%s.png' % (base, k, tag)
            c.save(z)
            print('  放大块 %s (%dx%d)' % (z, c.width, c.height))


# ---------------------------------------------------------------- build

def cmd_build(images, out_pdf, paper, dpi, force, zoom):
    data = load_corners()
    if images:
        names = images
    else:
        names = sorted(data, key=natural_key)
    if not names:
        raise SystemExit('还没有角点。先跑 prepare 出网格图，再用 set 落盘角点。')

    lacking = [n for n in names if n not in data]
    if lacking:
        raise SystemExit('这些图还没有角点：%s\n先跑 %s set ...'
                         % (', '.join(lacking), SELF))

    os.makedirs(OUT_DIR, exist_ok=True)
    from verify_quad import check as verify_quad
    from run import build, PAPERS

    ratio = None
    if paper:
        key = paper.strip().lower()
        ratio = PAPERS.get(key)
        if ratio is None:
            try:
                ratio = float(paper)
            except ValueError:
                raise SystemExit('未知纸张：%s（可选 %s 或数字比例）'
                                 % (paper, '/'.join(PAPERS)))

    # 1. 角标图 + 校验
    print('=== 步骤 1/4：回画角点（核查用） ===')
    verdicts = []
    for i, name in enumerate(names, 1):
        dst = out_path('角标', i, name)
        draw_marks(name, data[name], dst)
        print('\n第 %d 页 %s → %s' % (i, name, dst))
        ok = verify_quad(name, data[name])
        verdicts.append(ok)
        if zoom:
            make_zooms(name, dst, i, zoom)
    print('\n>>> 请打开上面这些 角标 图，逐个角确认是否压在纸角上。\n')

    bad_pages = [i for i, ok in enumerate(verdicts, 1) if not ok]
    if bad_pages:
        print('!! 角点校验未通过：第 %s 页（上面标 [XX] 的项）。'
              % '、'.join(map(str, bad_pages)))
        if not force:
            print('已停止，未出件。按上面的提示调整角点，再重跑 set + build。')
            return 2
        print('已按 --force 继续出件：结果需人工确认，不能当作校验通过交付。\n')

    # 2. 出 PDF
    print('=== 步骤 2/4：透视矫正 + 合成 PDF ===')
    workdir = os.path.join(OUT_DIR, '_pages')
    specs = ['%s:%s' % (n, quad_to_str(data[n])) for n in names]
    pages = build(specs, out_pdf, workdir, ratio)

    # 成品图按页序号重命名进 out/
    for i, (name, page) in enumerate(zip(names, pages), 1):
        dst = out_path('成品', i, name)
        os.replace(page, dst)
        print('  成品图 %s' % dst)

    # 3. PDF 检验
    print('\n=== 步骤 3/4：最终 PDF 检验 ===')
    rc = subprocess.run([sys.executable, os.path.join(HERE, 'check.py'), out_pdf,
                         '--dpi', str(dpi), '--expect-pages', str(len(names))]).returncode

    # 4. 汇总
    bad = bad_pages
    print('\n=== 步骤 4/4：汇总 ===')
    print('PDF        ：%s（%.0f KB，%d 页）' % (out_pdf, os.path.getsize(out_pdf) / 1024, len(names)))
    print('角点校验   ：%s' % ('全部通过' if not bad else '第 %s 页未通过' % '、'.join(map(str, bad))))
    print('PDF 检验   ：%s' % ('通过' if rc == 0 else '未通过'))
    print('核查材料   ：')
    for i, name in enumerate(names, 1):
        print('  %s   %s   %s' % (out_path('网格', i, name), out_path('角标', i, name),
                                  out_path('成品', i, name)))
    if bad or rc != 0:
        print('注意：以上为原样结果，未做任何自动修正。')
        return 2 if bad else 3
    return 0


# ---------------------------------------------------------------- check

def cmd_check(pdf, expect_pages, dpi):
    """复检已有 PDF：只渲染检验，不重新校正、不改动文件。"""
    if not os.path.exists(pdf):
        raise SystemExit('找不到 PDF：%s' % pdf)
    cmd = [sys.executable, os.path.join(HERE, 'check.py'), pdf, '--dpi', str(dpi)]
    if expect_pages is not None:
        cmd += ['--expect-pages', str(expect_pages)]
    return subprocess.run(cmd).returncode


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(
        description='文档照片 -> 校正 PDF 全流程脚本',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('prepare', help='出网格图（out/1-网格-*.png）')
    p.add_argument('images', nargs='*', help='图片名，省略则取当前目录所有图片')

    p = sub.add_parser('set', help='把一张图的角点写进 out/corners.json')
    p.add_argument('image', metavar='IMG', help='图片名（一次一张）')
    p.add_argument('--quad', action='append', default=[], required=True,
                   metavar='左上x,左上y;右上x,右上y;右下x,右下y;左下x,左下y',
                   help='这一张图的四个角点（顺序固定：左上 右上 右下 左下）')

    p = sub.add_parser('show', help='查看已落盘角点')

    p = sub.add_parser('check', help='复检已有 PDF（只渲染检验，不重新出件）')
    p.add_argument('pdf', metavar='PDF')
    p.add_argument('--expect-pages', type=int, default=None)
    p.add_argument('--dpi', type=int, default=100)

    p = sub.add_parser('build', help='回画角标 + 校验 + 出 PDF + 检验')
    p.add_argument('images', nargs='*', help='图片名，省略则用 corners.json 里的全部')
    p.add_argument('--out', default='文档_校正.pdf')
    p.add_argument('--paper', default=None, help='a4/letter/16k/b5 或比例数字')
    p.add_argument('--dpi', type=int, default=100, help='PDF 检验渲染 dpi')
    p.add_argument('--force', action='store_true', help='角点校验不通过也继续')
    p.add_argument('--zoom', default=None,
                   choices=['left', 'right', 'top', 'bottom', 'all'],
                   help='另存边角放大块，便于细看')

    p = sub.add_parser('all', help='prepare + build 一步到位')
    p.add_argument('images', nargs='*')
    p.add_argument('--out', default='文档_校正.pdf')
    p.add_argument('--paper', default=None)
    p.add_argument('--dpi', type=int, default=100)
    p.add_argument('--force', action='store_true')
    p.add_argument('--zoom', default=None)

    args = ap.parse_args()

    if args.cmd == 'prepare':
        return cmd_prepare(collect_images(args.images))
    if args.cmd == 'set':
        return cmd_set(args)
    if args.cmd == 'show':
        return cmd_show()
    if args.cmd == 'check':
        return cmd_check(args.pdf, args.expect_pages, args.dpi)
    if args.cmd == 'build':
        imgs = collect_images(args.images) if args.images else []
        return cmd_build(imgs, args.out, args.paper, args.dpi, args.force, args.zoom)
    if args.cmd == 'all':
        imgs = collect_images(args.images)
        cmd_prepare(imgs)
        data = load_corners()
        lacking = [n for n in imgs if n not in data]
        if lacking:
            print('\n这些图还没有角点，填好后重跑 build：%s' % ', '.join(lacking))
            return 2
        return cmd_build(imgs, args.out, args.paper, args.dpi, args.force, args.zoom)
    return 1


if __name__ == '__main__':
    sys.exit(main())
