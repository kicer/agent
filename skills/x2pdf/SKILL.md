---
name: x2pdf
description: 通用 PDF 转换。把 Markdown / HTML / txt / Word / Excel / PPT 转为 PDF
required: true
input_schema:
  type: object
  properties:
    input:
      type: string
      description: 输入文件路径,支持 .md/.markdown/.txt/.html/.htm/.docx/.xlsx/.pptx/.odt/.ods/.odp
    output:
      type: string
      description: 输出 PDF 路径(可选,默认与输入同名)
    css:
      type: string
      description: 自定义 CSS 文件路径(可选,仅对 md/html/txt 生效,优先级最高)
    page:
      type: object
      description: 页面设置(可选,仅对 md/html/txt 生效;Office 文档版式由原文件决定,忽略本参数)
      properties:
        size:
          type: string
          description: 页面尺寸,默认 A4;也可传 "A5"、"letter"、"210mm 297mm" 等
        margin:
          type: string
          description: 页边距,默认 20mm;可单值或 "上 右 下 左" 四值
        font_size:
          type: string
          description: 正文字号,默认 10.5pt;标题/代码等按 em 相对缩放,压页数时调小本值
  required: [input]
output_schema:
  type: string
  description: 生成的 PDF 文件路径
---

## 功能说明

统一 PDF 转换入口,按扩展名自动分派两条渲染路径:

- **md / txt / html → WeasyPrint**(CSS 排版,字体走 fontconfig,中文用系统文泉驿/Noto,无需字体文件)
- **docx / xlsx / pptx / odt / ods / odp → LibreOffice headless**(忠于原文档版式,`page`/`css` 参数不生效)

### Markdown 输入(`.md` / `.markdown`)
- 标准语法之外,支持表格(管道语法)、围栏代码块(```/~~~)、脚注、定义列表、
  标题锚点、属性列表、HTML 内联(Markdown `extra` 全家桶);
- 文首 YAML front matter 当元数据剔除,不渲染;
- 图片:相对路径按 **输入文件所在目录** 解析,也支持绝对路径与 http(s) 图片;
- 自动套用默认 CSS(见下)。

### txt 输入(`.txt`)
- **不解析**,按原文转义后整篇以等宽 `<pre>` 渲染(保换行,超长行自动折行)。

### HTML 输入(`.html` / `.htm`)
- 文档原样渲染,**不套默认 CSS**——自带 `<style>`/外链样式即所见即所得;
- `page` 参数仅在显式传入对应字段时生效(默认不注入 `@page`,避免干扰文档自带版式);
- `css` 文件作为外部样式表追加在文档自带样式**之后**,同优先级声明可覆盖文档内样式(用于强制微调);
- 渲染媒体默认为 `print`:文档里只写给 `screen` 的样式不生效,请把打印样式写进 `css` 文件或 `@media print`。

### 默认 CSS(md/txt 自动套用)
- 黑白友好:字号分明、浅灰底代码块/表头、隔行底纹表格,不依赖颜色传达信息;
- A4 页脚自动页码(`当前页 / 总页数`);标题 `break-after: avoid` 不落页尾。

### 样式优先级(md/txt)
默认 CSS < `page` 参数(生成 CSS)< `css` 文件。压单页的常用手法:
`page.font_size` 调小(如 `9pt`)+ `page.margin` 收窄(如 `12mm`)。

## 调用方式

通过 `skill` 的 `{"op":"run","name":"x2pdf","args":{...}}` 调用,参数:
- `input`:输入文件路径(必填)
- `output`:PDF 输出路径(可选,默认与输入同名)
- `css`:自定义 CSS 文件路径(可选,仅 md/html/txt)
- `page`:`{size, margin, font_size}`(可选,仅 md/html/txt)

选择建议:**简单文档直接写 Markdown** 交给本技能,默认样式即可;**需要精确控版面**
(分页、边距、多栏、黑白打印细节)再写 HTML + CSS。

## 示例

```json
{"input": "report.md"}
```

```json
{"input": "cheatsheet.md", "page": {"font_size": "9pt", "margin": "12mm"}}
```

```json
{"input": "layout.html", "css": "print-override.css"}
```
