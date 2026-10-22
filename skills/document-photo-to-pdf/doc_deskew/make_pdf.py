"""多张图等比缩放居中，合并为一个 PDF。默认 A4 纵向 @150dpi。"""
import sys
from PIL import Image

A4_W, A4_H = 1240, 1754
MARGIN = 40
DPI = 150


def fit_page(path):
    im = Image.open(path).convert('RGB')
    bw, bh = A4_W - MARGIN * 2, A4_H - MARGIN * 2
    s = min(bw / im.width, bh / im.height)
    nw, nh = max(1, int(round(im.width * s))), max(1, int(round(im.height * s)))
    im = im.resize((nw, nh), Image.LANCZOS)
    page = Image.new('RGB', (A4_W, A4_H), 'white')
    page.paste(im, ((A4_W - nw) // 2, (A4_H - nh) // 2))
    return page


if __name__ == '__main__':
    *srcs, out = sys.argv[1:]
    pages = [fit_page(p) for p in srcs]
    pages[0].save(out, 'PDF', resolution=DPI, save_all=True, append_images=pages[1:])
    print('written %s (%d pages)' % (out, len(pages)))
