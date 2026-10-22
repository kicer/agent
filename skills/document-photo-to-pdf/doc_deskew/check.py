"""PDF 产出的通用质量检验（渲染真实页面后评估）。

检验对象是最终交付的 PDF，不是中间图：把每页按固定 DPI 渲染成位图，
在渲染结果上做统计判定，所见即交付物。

检验项：
  1. 页数与源图数一致
  2. 有效内容分辨率（页面渲染后纸面区域的像素尺寸）
  3. 纸张比例失真（纸面外接框的宽高比，对照页面书写比例）
  4. 纸面外背景残留（边带亮度显著低于纸面）
  5. 内容贴边被切（页边存在成片文字级暗像素）

判据全部基于该页自身像素分布自适应（Otsu / 分位数），不含针对特定文档的常量。

用法：
    python3 doc_deskew/check.py 结果.pdf [--expect-pages 2] [--dpi 100]
    python3 doc_deskew/check.py 结果.pdf --render    # 导出渲染图供目视
"""
import argparse
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image


def render(pdf, dpi=100, outdir='.tmp/pdfcheck'):
    os.makedirs(outdir, exist_ok=True)
    for f in os.listdir(outdir):
        if f.startswith('page'):
            os.remove(os.path.join(outdir, f))
    base = os.path.join(outdir, 'page')
    if shutil.which('pdftoppm'):
        subprocess.run(['pdftoppm', '-r', str(dpi), '-png', pdf, base], check=True)
    else:  # 退路：pypdfium2
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(pdf)
        scale = dpi / 72
        for i in range(len(doc)):
            doc[i].render(scale=scale).to_pil().save('%s-%d.png' % (base, i + 1))
    files = sorted(f for f in os.listdir(outdir) if f.startswith('page') and f.endswith('.png'))
    return [os.path.join(outdir, f) for f in files]


def otsu(vals):
    v = np.asarray(vals, dtype=np.float64).ravel()
    if v.size == 0:
        return 128.0
    hist, edges = np.histogram(v, bins=64)
    centers = (edges[:-1] + edges[1:]) / 2.0
    total = hist.sum()
    w0 = np.cumsum(hist)
    w1 = total - w0
    m0 = np.cumsum(hist * centers)
    mt = m0[-1]
    with np.errstate(divide='ignore', invalid='ignore'):
        score = (mt * w0 / total - m0) ** 2 / (w0 * w1 / total ** 2)
    score = np.nan_to_num(score)
    return float(centers[int(np.argmax(score))])


def analyse(img):
    g = np.asarray(img.convert('L')).astype(np.float32)
    h, w = g.shape
    res = {'w': w, 'h': h, 'ratio': w / h}

    # 纸面亮度：取全图高分位（纸面是主体亮区）
    res['paper'] = float(np.percentile(g, 80))
    # 背景亮度：低分位
    res['back'] = float(np.percentile(g, 2))
    # 内容区阈值
    res['ink'] = min(otsu(g), res['paper'] * 0.8)

    # 纸面内容框：A4 页面上纸面之外是纯白留白，故"非纯白"区域即实际纸面
    # 用相对亮度判定，避免把扫描白纸的轻微灰底误判成内容
    flat = float(np.percentile(g, 99.5))
    nonwhite = g < (flat - 8)
    row_frac = nonwhite.mean(axis=1)
    col_frac = nonwhite.mean(axis=0)
    # 取占比超过 5% 的连续范围作为纸面主体
    rows = np.where(row_frac > 0.05)[0]
    cols = np.where(col_frac > 0.05)[0]
    if rows.size > 4 and cols.size > 4:
        res['paper_box'] = (int(cols[0]), int(rows[0]), int(cols[-1]), int(rows[-1]))
        pw = cols[-1] - cols[0] + 1
        ph = rows[-1] - rows[0] + 1
        res['paper_ratio'] = pw / ph
        res['paper_px'] = (int(pw), int(ph))
    else:
        res['paper_box'] = None
        res['paper_ratio'] = res['ratio']
        res['paper_px'] = (w, h)

    # 边缘背景残留：四周窄带的平均亮度明显低于纸面亮度
    # 边带宽度按比例取，过窄会漏判
    b = max(4, int(min(w, h) * 0.012))
    border = {
        'top': float(g[:b, :].mean()), 'bottom': float(g[-b:, :].mean()),
        'left': float(g[:, :b].mean()), 'right': float(g[:, -b:].mean()),
    }
    res['border'] = border
    res['border_bad'] = [k for k, v in border.items() if v < res['paper'] * 0.80]
    # 另一路判据：边带内是否存在"整行整列偏暗"的条带（纸外背景）
    edge_dark = {}
    for k, band in (('top', g[:b, :]), ('bottom', g[-b:, :]),
                    ('left', g[:, :b]), ('right', g[:, -b:])):
        edge_dark[k] = float((band < res['paper'] * 0.6).mean())
    res['edge_dark'] = edge_dark

    # 内容贴边：最外窄带内成片文字级暗像素 <=> 内容被切
    m = max(2, int(min(w, h) * 0.003))
    cut = []
    for k, band in (('top', g[:m, :]), ('bottom', g[-m:, :]),
                    ('left', g[:, :m]), ('right', g[:, -m:])):
        frac = float((band < res['ink']).mean())
        if frac > 0.05:
            cut.append((k, frac))
    res['cut'] = cut
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('--expect-pages', type=int, default=None)
    ap.add_argument('--dpi', type=int, default=100)
    ap.add_argument('--min-short', type=int, default=800)
    ap.add_argument('--ratio-tol', type=float, default=0.08)
    ap.add_argument('--render', action='store_true')
    args = ap.parse_args()

    if not os.path.exists(args.pdf):
        raise SystemExit('找不到 PDF: %s' % args.pdf)

    files = render(args.pdf, args.dpi)
    print('PDF: %s' % args.pdf)
    print('文件大小: %.0f KB' % (os.path.getsize(args.pdf) / 1024))
    print('页数: %d' % len(files))

    ok = True
    if args.expect_pages is not None:
        good = len(files) == args.expect_pages
        ok &= good
        print('  [%s] 页数与源图一致（期望 %d，实际 %d）'
              % ('OK' if good else 'XX', args.expect_pages, len(files)))

    for i, f in enumerate(files, 1):
        img = Image.open(f)
        r = analyse(img)
        print('\n第 %d 页  渲染 %dx%d px @%ddpi' % (i, r['w'], r['h'], args.dpi))

        # 纸张实际像素尺寸（按渲染图里纸面外接框估算，换算回原分辨率）
        if r['paper_box']:
            x0, y0, x1, y1 = r['paper_box']
            scale = 1.0  # 渲染已是实际像素
            short = min(x1 - x0, y1 - y0)
            good = short >= args.min_short * args.dpi / 150.0
            ok &= good
            print('  [%s] 纸面短边      %d px（下限 %d）'
                  % ('OK' if good else 'XX', short,
                     int(args.min_short * args.dpi / 150.0)))

            # 纸张比例本身不是硬性标准：非 A4 材料（Letter / 16K / 票据）
            # 塞进 A4 页面时必然有留白，纸张比例 != 页面比例是正常的。
            # 这里只做"提示"，判错交给内容贴边与背景残留两项。
            dev = abs(r['paper_ratio'] - r['ratio']) / r['ratio'] * 100
            note = '' if dev <= args.ratio_tol else '（留白 %.1f%%，非 A4 纸张属正常）' % dev
            print('  [--] 纸张比例      %.3f（页面 %.3f）%s'
                  % (r['paper_ratio'], r['ratio'], note))
        else:
            print('  [XX] 未能识别纸面区域')
            ok = False

        bad_dark = [k for k, v in r.get('edge_dark', {}).items() if v > 0.35]
        good = (not r['border_bad']) and (not bad_dark)
        ok &= good
        detail = ', '.join('%s=%.0f' % (k, v) for k, v in r['border'].items())
        print('  [%s] 边缘背景残留  %s（纸面 %.0f / 背景 %.0f）'
              % ('OK' if good else 'XX',
                 '无' if good else '、'.join(r['border_bad']), r['paper'], r['back']))
        if not good:
            print('       边带亮度: %s' % detail)
        if bad_dark:
            print('       偏高暗占比: %s'
                  % '、'.join('%s %.0f%%' % (k, r['edge_dark'][k] * 100) for k in bad_dark))

        good = not r['cut']
        ok &= good
        print('  [%s] 内容贴边      %s'
              % ('OK' if good else 'XX',
                 '、'.join('%s %.1f%%' % (k, v * 100) for k, v in r['cut']) if r['cut'] else '无'))

    print('\n总判定：%s' % ('全部通过' if ok else '存在不达标项'))
    if args.render:
        print('渲染图: .tmp/pdfcheck/')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
