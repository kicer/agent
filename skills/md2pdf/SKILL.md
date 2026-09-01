---
name: md2pdf
description: 将 Markdown 文件转换为 PDF（仅英文，简单排版）
input_schema:
  type: object
  properties:
    input:
      type: string
      description: 输入 Markdown 文件路径
    output:
      type: string
      description: 输出 PDF 文件路径（可选，默认与输入同名）
  required: [input]
output_schema:
  type: string
  description: 生成的 PDF 文件路径
---

## 使用说明
该技能使用 `reportlab` 将 Markdown 转换为 PDF。

本技能由 `run_skill` 调用，参数：
- `input`（必填）：Markdown 文件路径，支持相对路径（自动转为绝对路径）。
- `output`（可选）：PDF 输出路径，默认与输入文件同名。
