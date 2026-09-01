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
- 该技能使用 `reportlab` 将 Markdown 转换为 PDF。
- 支持标题、加粗、斜体、列表、引用、分隔线等常用 Markdown 语法
- 自动处理中文字体

## 使用说明
通过 `run_skill` 调用，参数：
- `input`：Markdown 文件路径（必填）
- `output`：PDF 输出路径（可选，默认与输入同名）
