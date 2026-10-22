from PIL import Image, ImageDraw, ImageFont
import sys

FONT = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc'

# 网格配色：100px 红线（主线，带坐标刻度）+ 50px 蓝线（辅助），两者同宽，
# 只靠颜色分主次；线太细时缩略图上看不见，所以不靠粗细区分。
COLOR_MAJOR = (255, 0, 0, 110)
COLOR_MINOR = (0, 96, 255, 70)
LINE_WIDTH = 2


def draw_grid_on(im, step=50, major=100):
    """在原图上叠加坐标网格，返回叠加后的图像（不落盘）。

    先画到独立的 RGBA 图层再合成：RGBA 底图直接画会被 ImageDraw 覆盖，
    半透明线变成实心色，跟角标图上的网格对不上。
    """
    W, H = im.size
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    try:
        f = ImageFont.truetype(FONT, 18)
    except Exception:
        f = ImageFont.load_default()
    for x in range(0, W, step):
        d.line([(x, 0), (x, H)],
               fill=COLOR_MAJOR if x % major == 0 else COLOR_MINOR,
               width=LINE_WIDTH)
    for y in range(0, H, step):
        d.line([(0, y), (W, y)],
               fill=COLOR_MAJOR if y % major == 0 else COLOR_MINOR,
               width=LINE_WIDTH)
    # 坐标数字：每 100px 在顶部和左侧标注
    for x in range(0, W, major):
        d.rectangle([x + 1, 1, x + 38, 21], fill=(255, 255, 255, 220))
        d.text((x + 3, 1), str(x), fill=(200, 0, 0), font=f)
    for y in range(0, H, major):
        d.rectangle([1, y + 1, 46, y + 21], fill=(255, 255, 255, 220))
        d.text((2, y + 1), str(y), fill=(0, 0, 200), font=f)
    return Image.alpha_composite(im.convert('RGBA'), layer).convert(im.mode)


def draw_grid(src, dst, step=50, major=100):
    im = draw_grid_on(Image.open(src).convert('RGB'), step, major)
    im.save(dst)
    print('written', dst, im.size)

if __name__ == '__main__':
    draw_grid(sys.argv[1], sys.argv[2])
