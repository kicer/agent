---
name: document-photo-to-pdf
description: 纸质文档（合同/发票/证件/书页）拍照/扫描件校正后，导出 PDF 和 out/ 下的单页 PNG 原图（未调色未缩放）；自动找纸边、透视拉正、多页合并，附审核页微调
visit_url: /app/{task_id}/doc-review/
input_schema:
  type: object
  properties:
    images:
      type: array
      items: {type: string}
      description: 图片路径，按合并顺序；可只传一张
    output:
      type: string
      description: 输出 PDF 文件名，默认 文档照片_校正.pdf
---

# 文档照片转 PDF

```json
{"images": ["图1.jpg", "图2.jpg"], "output": "合同_校正.pdf"}
```

`images` 必填，按顺序合并；`output` 可选，默认 `文档照片_校正.pdf`。纸张、方向、调色、
清晰度不要传，交给审核页。

## 返回值

- `ok:true`：`summary` 一句话摘要，`pdf` 文件名，`images` 是 `out/` 下的原图路径；
  末尾附完整「访问地址」。把 PDF、地址和图片路径一起给用户。
- `ok:false`：转述 `error.message` / `error.hint`，忽略访问地址。

每次运行还会把校正后的单页原图（未调色、未缩放、无白边）导出到 `out/`，文件名与 PDF
同名：`合同_校正.pdf` → `out/合同_校正-01.png`、`out/合同_校正-02.png`。不需要图片时
忽略 `images` 即可。

```json
{"ok":true,"summary":"3 页已生成；1 页建议在审核页确认；原始页图见 out/","pdf":"合同_校正.pdf","images":["out/合同_校正-01.png","out/合同_校正-02.png","out/合同_校正-03.png"]}
访问地址：https://agent.ai.foresh.com/app/task-20261023-001/doc-review/
```

审核页可拖角、旋转、删页/排序、改纸张与清晰度；改动后点「重新生成 PDF」覆盖同名文件。

## 失败与拍摄

- 图片打不开：确认路径与格式（jpg/png/webp/bmp/tif）。
- 检测不到纸张：整张纸入画，四边留 3%~5% 背景，换反差大的桌面。
- 只有全部页都出不了才 `ok:false`；单页失败会用兜底框出件，审核页会标出来。

## 边界

- 纸出画面无法还原；角点可外扩。
- 自动方向只判 90°，180° 在审核页旋转。
- 默认按同批中位比例；严格 A4/16K/B5 在审核页选。
- 支持 jpg/png/webp/bmp/tif；HEIC 不支持。
- 一图一纸；同框多纸只取最大。
- 建议 ≤20 页；更多或 300dpi 可能超 120s，可分批。
- `out/` 里的原图是自然尺寸（不缩放、不调色），页与页尺寸可能不同；PDF 仍按纸张/批次统一。
