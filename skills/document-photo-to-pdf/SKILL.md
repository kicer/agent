---
name: document-photo-to-pdf
description: 把手机拍摄的纸质文档照片裁剪、拉正，合并为 PDF，并给出可预览/微调的审核页
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

- `ok:true`：`summary` 一句话摘要，`pdf` 文件名；末尾附完整「访问地址」。把 PDF 和地址
  一起给用户。
- `ok:false`：转述 `error.message` / `error.hint`，忽略访问地址。

```json
{"ok":true,"summary":"3 页已生成；1 页建议在审核页确认","pdf":"合同_校正.pdf"}
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
