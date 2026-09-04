---
name: md2pdf
description: 将 Markdown 文件转换为 PDF
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

## 功能说明
- 该技能使用 `reportlab` 将 Markdown 转换为 PDF。
- 支持标题、加粗、斜体、列表、引用、分隔线、图片等常用 Markdown 语法
- 图片：`![alt](src)` 独立成行时嵌入 PDF（居中，超宽时等比缩到版心宽）；
  相对路径按 **Markdown 文件所在目录** 解析（如任务目录里的图表），也支持绝对路径与 http(s) 图片；
  图片加载失败退回 alt 文本占位，不会静默丢失；表格语法暂不支持
- 自动处理中文字体

## 调用方式
通过 `run_skill` 调用，参数：
- `input`：Markdown 文件路径（必填）
- `output`：PDF 输出路径（可选，默认与输入同名）
