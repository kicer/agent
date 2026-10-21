---
name: image-process
description: 图像处理（Pillow）。查看图片信息、格式转换、缩放、裁剪、压缩、文字水印、九宫格切片、多图拼图。仅做确定性图像处理，不做 AI 生成/修图
input_schema:
  type: object
  properties:
    action:
      type: string
      description: 操作类型：info | convert | resize | crop | compress | watermark | slice | grid
    input:
      type: string
      description: 输入图片路径（grid 时为图片所在目录）
    output:
      type: string
      description: 输出文件路径（可选；slice 时为输出目录，grid 时也可省略）
    width:
      type: integer
      description: resize 目标宽 / crop 裁切宽
    height:
      type: integer
      description: resize 目标高 / crop 裁切高
    keep_ratio:
      type: boolean
      description: resize 是否保持宽高比（默认 true；false 时需同时给 width 与 height）
    left:
      type: integer
      description: crop 起始横坐标（默认 0）
    top:
      type: integer
      description: crop 起始纵坐标（默认 0）
    quality:
      type: integer
      description: JPEG/WebP 输出质量 1-95（默认 85）
    max_dim:
      type: integer
      description: compress 可选：长边先缩到该值以内再压缩
    text:
      type: string
      description: watermark 水印文字
    font:
      type: string
      description: watermark 字体 TTF/TTC 路径（可选；中文缺省自动找系统文泉驿/Noto 字体）
    font_size:
      type: integer
      description: watermark 字号（默认取图片宽的 1/20）
    position:
      type: string
      description: watermark 位置 tl/tc/tr/ml/mc/mr/bl/bc/br（默认 br 右下）
    color:
      type: string
      description: watermark 颜色 white/black/red 等或 #RRGGBB（默认 white）
    opacity:
      type: integer
      description: watermark 不透明度 0-255（默认 200）
    margin:
      type: integer
      description: watermark 距边缘像素（默认 20）
    rows:
      type: integer
      description: slice 行数（默认 3；只给 rows 或 cols 时按方形推算）
    cols:
      type: integer
      description: slice 列数（默认 3）
    cell:
      type: integer
      description: grid 每格缩略图长边像素（默认 800）
    padding:
      type: integer
      description: grid 格间距与外边距像素（默认 10）
    background:
      type: string
      description: grid 背景色 white/black 等或 #RRGGBB（默认 white）
  required: [action, input]
output_schema:
  type: string
  description: 操作结果描述；需要保存的动作会返回输出文件路径（slice 返回全部切片文件清单）
---

## 功能
- `info`：查看图片尺寸、色彩模式、格式、文件大小（需要裁剪/拼图前先看尺寸时很有用）
- `convert`：格式转换（按 `output` 的扩展名输出，支持 jpg/jpeg/png/webp/bmp/gif/tiff）
- `resize`：缩放，默认保持宽高比（fit）；`keep_ratio=false` 时为精确宽高
- `crop`：按 `left/top/width/height` 裁剪，默认从 (0,0) 裁到右下角
- `compress`：压缩图片体积（`quality`；可选 `max_dim` 先缩长边）；PNG 用 optimize 无损优化
- `watermark`：给图片加文字水印（支持中文；默认右下、白色、80% 不透明度）
- `slice`：等分切片（默认 3×3 九宫格），输出到独立目录，方便朋友圈/小红书九图
- `grid`：把同一目录下多张图拼成一张 contact sheet（缩略图网格）

## 使用说明
通过 `skill` 的 `{"op":"run","name":"image-process","args":{...}}` 调用，参数：
- `action`：操作类型（必填）
- `input`：输入图片或目录（必填；相对会话工作目录的路径即可，会自动转绝对路径）
- `output`：输出路径（建议给全；不给时自动生成 `<原名>_<动作>.<原扩展名>`，绝不覆盖原图）
- 其余参数见上方 schema，按动作选用

示例：
```json
{"action": "resize", "input": "photo.jpg", "width": 800, "output": "photo_800.jpg"}
{"action": "compress", "input": "big.png", "quality": 80}
{"action": "watermark", "input": "pic.png", "text": "内部资料", "position": "tr", "color": "white", "opacity": 180}
{"action": "grid", "input": ".", "output": "contact.jpg", "cols": 3}
{"action": "slice", "input": "nine.png", "rows": 3, "cols": 3, "output": "nine_slice"}
```

## 注意事项
- 本技能**只做确定性图像处理**（转换/缩放/裁剪/压缩/水印/拼图），不含 AI 生成、抠图、换脸、扩图、修复等生成式/语义编辑能力。
- 若用户的需求属于"文生图 / AI 修图"等生成式范畴，不要用本技能硬凑，应说明能力边界并推荐第三方工具（豆包、即梦、可灵、Photoshop 等）。
- 任何操作都不会覆盖输入原图；输出目录不存在时自动创建。
- 中文水印需要字体：优先用 `font` 参数指定；否则依赖系统字体（镜像预装文泉驿，install.sh 会兑底安装）。
- 输入依赖预装的 Pillow，无需额外 Python 依赖；系统级字体依赖见 install.sh。
