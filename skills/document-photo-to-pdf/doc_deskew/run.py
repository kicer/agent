"""拉正合成的核心模块：四边形透视变换 + 按页拼版。

由 pipeline.py 的 build 子命令调用，不单独提供命令行入口（原来那套
--grid/--page/--check 已分别由 prepare / build / check 接管，免得两个入口各说各话）。

设计原则：
  1. 不做中间校正。角点只用来定义纸张四边，几何变换一次到位，
     校正结果直接进 PDF；所有质量判定都在最终 PDF 上做。
  2. 不在流程里"自动收紧/自动修补"。这类启发式规则容易误裁内容，
     只保留能明确判定对错的检验项。
  3. 判定阈值来自每页图像自身统计，不是针对某份文档调出来的常量。
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np
from homography import brighten, warp_perspective
from PIL import Image

# 纸张宽高比（宽/高）：pipeline 与 run 共用这一份，避免两套系数漂移
PAPERS = {'a4': 210 / 297, 'letter': 8.5 / 11, '16k': 185 / 260, 'b5': 176 / 250}


def parse_page(spec):
    src, _, quad_s = spec.partition(':')
    if not src or not quad_s:
        raise SystemExit('格式应为 "图片:左上;右上;右下;左下"：%s' % spec)
    quad = []
    for pt in quad_s.split(';'):
        x, y = pt.split(',')
        quad.append((float(x), float(y)))
    if len(quad) != 4:
        raise SystemExit('角点必须 4 个：%s' % spec)
    return src, quad


def build(specs, out_pdf, workdir='out', ratio=None):
    """一次几何变换得到页面图，直接合并。不做二次裁切。

    ratio=None 时按四边形自然尺寸输出（保留照片原始比例）；
    给定 ratio（如 A4=0.707）时强制映射到该纸张比例，纠正透视压缩。
    """
    os.makedirs(workdir, exist_ok=True)
    pages = []
    for i, spec in enumerate(specs, 1):
        src, quad = parse_page(spec)
        im = Image.open(src).convert('RGB')
        if ratio is None:
            page = brighten(warp_perspective(im, quad))
        else:
            q = np.array(quad, float)
            wpx = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2
            hpx = wpx / ratio
            page = brighten(warp_perspective(
                im, quad, out_size=(int(round(wpx)), int(round(hpx)))))
        path = os.path.join(workdir, 'p%d.png' % i)
        page.save(path)
        pages.append(path)
        nw, nh = page.size
        print('  第 %d 页 %-28s -> %s  %dx%d  比例 %.3f'
              % (i, os.path.basename(src), path, nw, nh, nw / nh))

    subprocess.run([sys.executable, os.path.join(HERE, 'make_pdf.py')]
                   + pages + [out_pdf], check=True)
    return pages
