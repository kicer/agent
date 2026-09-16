#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
md2pdf 技能主入口：将 Markdown 转换为 PDF（支持中文和常用格式）
依赖 install.sh 预先准备好中文字体（fonts/cjk.ttf），本脚本只负责注册和转换。
"""
import sys
import io
import json
import re
import urllib.request
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Preformatted, Spacer, ListFlowable, ListItem, HRFlowable, Image,
    Table, TableStyle
)

# 当前正文体名字（注册成功为中文字体，失败退回 Helvetica）：
# 行内代码/代码段含中文时用它渲染——Courier 没有中文字形，会变方块。
_CJK_FONT = 'Helvetica'

# ---------- 字体注册 ----------
def register_font():
    """注册技能目录下的 fonts/cjk.ttf（由 install.sh 准备）"""
    font_path = Path(__file__).parent / "fonts" / "cjk.ttf"
    if font_path.exists() and font_path.stat().st_size > 0:
        try:
            pdfmetrics.registerFont(TTFont("CJK", str(font_path)))
            pdfmetrics.registerFont(TTFont("CJKBold", str(font_path)))  # 粗体模拟
            # 注册字体族:否则段落里的 <b>/<i> 标签解析后找不到 CJK 的粗/斜变体,<b> 不生效。
            # 中文斜体可读性差且无真斜体变体,italic 映射回常规体(仅西文可见伪斜或不变)。
            pdfmetrics.registerFontFamily("CJK", normal="CJK", bold="CJKBold", italic="CJK", boldItalic="CJKBold")
            return ("CJK", "CJKBold")
        except Exception as e:
            print(f"字体注册失败：{e}，将使用 Helvetica", file=sys.stderr)
            return None
    else:
        print("未找到准备好的字体文件 fonts/cjk.ttf，请确认 install.sh 已执行", file=sys.stderr)
        return None

# ---------- 样式定义 ----------
def build_styles(normal_font, bold_font):
    """构建 PDF 样式，使用指定字体"""
    return {
        "title": ParagraphStyle(
            name="Title",
            fontName=bold_font,
            fontSize=22,
            leading=28,
            alignment=1,  # 居中
            spaceAfter=12,
        ),
        "h1": ParagraphStyle(
            name="H1",
            fontName=bold_font,
            fontSize=18,
            leading=24,
            spaceBefore=16,
            spaceAfter=8,
            textColor="#1a3d6d",
        ),
        "h2": ParagraphStyle(
            name="H2",
            fontName=bold_font,
            fontSize=15,
            leading=20,
            spaceBefore=12,
            spaceAfter=6,
            textColor="#2c3e50",
        ),
        "h3": ParagraphStyle(
            name="H3",
            fontName=bold_font,
            fontSize=12.5,
            leading=17,
            spaceBefore=10,
            spaceAfter=4,
            textColor="#34495e",
        ),
        "body": ParagraphStyle(
            name="Body",
            fontName=normal_font,
            fontSize=10.5,
            leading=16,
            spaceAfter=4,
            alignment=TA_LEFT,
        ),
        "quote": ParagraphStyle(
            name="Quote",
            fontName=normal_font,
            fontSize=10.5,
            leading=16,
            leftIndent=12,
            rightIndent=12,
            spaceBefore=4,
            spaceAfter=4,
            textColor="#555555",
            backColor="#f8f8f8",
            borderPadding=(6, 6, 6, 6),
        ),
        "list_item": ParagraphStyle(
            name="List",
            fontName=normal_font,
            fontSize=10.5,
            leading=16,
            leftIndent=4,
        ),
    }

# ---------- Markdown 解析辅助 ----------
def escape_xml(text):
    """转义 XML 特殊字符。必须在 parse_inline 之前调用:
    先转义原文、再注入 <b>/<i>/<link> 等标签;顺序反了会把生成的标签也转义成字面量。"""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def parse_inline(text):
    """处理行内格式:加粗、斜体、行内代码、链接。入参必须是 escape_xml 之后的文本。"""
    # 行内代码 `code`：先占位保护，避免其中的 * [ ] 被后续规则误伤
    code_spans = []
    def _stash(m):
        code_spans.append(m.group(1))
        return '\x00%d\x00' % (len(code_spans) - 1)
    text = re.sub(r'`(.+?)`', _stash, text)
    # 行内图片 ![alt](src)：段落里无法嵌图，降级为 alt 文本；必须在链接规则之前，
    # 否则 [alt](src) 部分会被下面的链接规则改写成可点链接，图片变成“!+链接”残骸
    text = re.sub(IMG_MD_RE, lambda m: m.group(1) or '[图片]', text)
    # 链接 [text](url) → reportlab <link>（可点击；转义后 URL 里的 & 已是 &amp;，属性内合法）
    text = re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)', r'<link href="\2" color="#3964FE">\1</link>', text)
    # 加粗 **text**
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    # 斜体 *text*(避免匹配加粗中的单个星号)
    text = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<i>\1</i>', text)
    # 还原行内代码：含中文时用正文字体（Courier 无中文字形），纯西文用 Courier 保证等宽
    def _restore(m):
        code = code_spans[int(m.group(1))]
        face = 'Courier' if code.isascii() else _CJK_FONT
        return '<font face="' + face + '">' + code + '</font>'
    text = re.sub(r'\x00(\d+)\x00', _restore, text)
    return text

def render_inline(text):
    """统一入口:先转义再走行内格式(顺序错了标签会被转义成字面量显示)。"""
    return parse_inline(escape_xml(text))

def is_ordered_list(line):
    """判断是否为有序列表行"""
    return re.match(r'^\d+\.\s+', line)

# ---------- 图片 ----------
# Markdown 图片语法：![alt](src) 或 ![alt](src "title")
IMG_MD_RE = re.compile(r'!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)')

def load_image_source(src, md_dir):
    """加载 md 引用的图片，返回可交给 ImageReader 的对象（路径或 BytesIO），失败返回 None。
    相对路径按 **md 文件所在目录** 解析：技能子进程的 cwd 是技能目录而非任务目录，
    不能直接 open 相对路径；另外兼容绝对路径与 http(s) 远程图。"""
    if re.match(r'^https?://', src):
        try:
            req = urllib.request.Request(src, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return io.BytesIO(resp.read())
        except Exception as e:
            print(f"图片下载失败：{src}（{e}）", file=sys.stderr)
            return None
    candidates = [Path(src)] if Path(src).is_absolute() else [md_dir / src, Path.cwd() / src]
    for c in candidates:
        try:
            if c.is_file():
                return str(c)
        except OSError:
            continue
    print(f"图片未找到：{src}（在 {md_dir} 下未命中）", file=sys.stderr)
    return None

def image_flowable(src, md_dir, max_width):
    """Markdown 图片 → platypus Image（居中，超宽时等比缩到版心宽）；失败返回 None 由调用方文字兜底"""
    obj = load_image_source(src, md_dir)
    if obj is None:
        return None
    try:
        iw, ih = ImageReader(obj).getSize()
    except Exception as e:
        print(f"图片格式不支持：{src}（{e}）", file=sys.stderr)
        return None
    if not iw or not ih:
        return None
    if isinstance(obj, io.BytesIO):
        obj.seek(0)  # getSize 读过字节，绘制前要回到开头
    # 像素按 96dpi 换算磅值；小图不放大，大图缩到版心宽
    w = min(iw * 72.0 / 96.0, max_width)
    h = ih * (w / iw)
    img = Image(obj, width=w, height=h)
    img.hAlign = 'CENTER'
    return img

# ---------- 表格 ----------
# 数据/表头行：| a | b |；分隔行：| --- | :---: | ---: | --- |
TABLE_ROW_RE = re.compile(r'^\|.*\|\s*$')
TABLE_SEP_RE = re.compile(r'^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$')

def split_row(line):
    """按未转义的竖线拆分表格行，保留 `\|` 转义出来的字面竖线"""
    line = line.strip()
    cells = re.split(r'(?<!\\)\|', line)
    cells = [c.replace('\\|', '|').strip() for c in cells]
    # 首尾的空单元格（来自行首/行尾的 |）去掉；全空则删掉
    if cells and cells[0] == '': cells = cells[1:]
    if cells and cells[-1] == '': cells = cells[:-1]
    return cells

def table_flowable(rows, max_width, styles):
    """表格行 → platypus Table（首行为表头加底纹，超宽时分列撑满版心）"""
    ncols = max(len(r) for r in rows)
    colw = max_width / ncols
    cell_style = ParagraphStyle(
        name='TableCell',
        fontName=styles['body'].fontName,
        fontSize=8.5, leading=12,
        leftIndent=3, rightIndent=3,
        alignment=TA_LEFT,
    )
    header_style = ParagraphStyle(
        name='TableHeader', parent=cell_style,
        fontName=styles['h3'].fontName,  # 粗体
        textColor=colors.white,
    )
    data = []
    for ri, row in enumerate(rows):
        row = row + [''] * (ncols - len(row))
        data.append([
            Paragraph(render_inline(c), header_style if ri == 0 else cell_style)
            for c in row
        ])
    # splitInRow=1：单行超页高时也能跨页（否则极长的单元格会让整个转换报 Flowable too large）
    t = Table(data, colWidths=[colw] * ncols, splitInRow=1)
    t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#c9d4e4')),
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2c3e50')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f4f7fb')]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    t.hAlign = 'CENTER'
    return t

# ---------- 代码段 ----------
# 围栏：``` 或 ~~~（可带语言标记）；围栏内原样输出、不解析 Markdown
FENCE_OPEN_RE = re.compile(r'^(```|~~~)\s*\S*\s*$')
FENCE_CLOSE_RE = re.compile(r'^(```|~~~)\s*$')

# setext 标题下划线（普通段落下一行是 ===/--- 时升级为标题）
SETEXT_H1_RE = re.compile(r'^=+\s*$')
SETEXT_H2_RE = re.compile(r'^-+\s*$')

def code_block_flowable(code_text, styles, max_width):
    """代码段 → 等宽 Preformatted，外套 Table 提供浅灰底/细边框与内边距。
    Preformatted 用 textLine 原样绘制、不解析标记，故代码里的 < & 无需转义。
    字体：含中文时用正文字体（Courier 无中文字形），纯西文用 Courier 保证等宽对齐。"""
    has_cjk = any(ord(ch) > 0x2E80 for ch in code_text)
    style = ParagraphStyle(
        name='CodeBlock',
        fontName=styles['body'].fontName if has_cjk else 'Courier',
        fontSize=8.5,
        leading=12.5,
        textColor=colors.HexColor('#24292f'),
    )
    # splitInRow=1：单元格内容（Preformatted）可跨页分裂。默认 0 时超页高的代码块会让整个转换
    # 报 "Flowable too large on page" 而失败。
    box = Table([[Preformatted(code_text, style)]], colWidths=[max_width], splitInRow=1)
    box.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f6f8fa')),
        ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor('#d8dee6')),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    box.hAlign = 'LEFT'
    box.spaceBefore = 6
    box.spaceAfter = 6
    return box

# ---------- 列表 ----------
def indent_width(raw):
    """行首缩进宽度（tab 按 4 列计）——用于判定列表嵌套层级"""
    expanded = raw.expandtabs(4)
    return len(expanded) - len(expanded.lstrip(' '))

def _normalize_levels(items):
    """按缩进宽度归一化嵌套层级：[(缩进, kind, text, num)] → [(depth, ...)]（首项为第 0 层）"""
    out, stack = [], []
    for indent, kind, text, num in items:
        while len(stack) > 1 and indent < stack[-1]:
            stack.pop()
        if not stack or indent > stack[-1]:
            stack.append(indent)
        out.append((len(stack) - 1, kind, text, num))
    return out

def _make_list(children, kind, start):
    if kind == 'ol':
        return ListFlowable(children, bulletType='1', start=start, leftIndent=18)
    return ListFlowable(children, bulletType='bullet', start='circle', leftIndent=18)

def _one_list(items, pos, depth, kind, styles):
    """消费连续的同层同类型条目；更深缩进的条目作为子列表挂到上一个条目下"""
    children, start = [], '1'
    while pos < len(items) and items[pos][0] == depth and items[pos][1] == kind:
        _, _, text, num = items[pos]
        if not children:
            start = num or '1'   # 有序列表只认首项编号
        pos += 1
        body = [Paragraph(text, styles['list_item'])]
        if pos < len(items) and items[pos][0] > depth:
            subs, pos = _sub_lists(items, pos, styles)
            body.extend(subs)
        children.append(ListItem(body, leftIndent=18))
    return _make_list(children, kind, start), pos

def _sub_lists(items, pos, styles):
    """一个条目下的全部子列表（可能跨类型、多层）"""
    out = []
    child = items[pos][0]
    while pos < len(items) and items[pos][0] >= child:
        flowable, pos = _one_list(items, pos, items[pos][0], items[pos][1], styles)
        out.append(flowable)
    return out, pos

def build_lists(items, styles):
    """列表条目 → [flowable]（顶层；同层类型切换会产生多个列表）"""
    items = _normalize_levels(items)
    out, pos = [], 0
    while pos < len(items):
        flowable, pos = _one_list(items, pos, items[pos][0], items[pos][1], styles)
        out.append(flowable)
    return out

def strip_front_matter(md_text):
    """去掉文件开头的 YAML front matter（--- ... ---）：属元数据，不该渲染进 PDF。
    仅当第一行就是 --- 且能找到收尾 --- 时生效，避免误删以分隔线开头的正文。"""
    lines = md_text.split('\n')
    if not lines or lines[0].strip() != '---':
        return md_text
    for j in range(1, len(lines)):
        if lines[j].strip() == '---':
            return '\n'.join(lines[j + 1:])
    return md_text

# ---------- Markdown 解析主函数 ----------
def parse_markdown(md_text, styles, md_dir=None, max_width=170 * mm):
    """解析 Markdown 文本，返回 platypus 故事列表"""
    md_dir = md_dir or Path.cwd()
    story = []
    lines = md_text.split('\n')
    current_list = []          # 当前列表条目：[(缩进宽度, 'ul'|'ol', 已渲染文本, 首项编号)]

    def flush_list():
        nonlocal current_list
        if current_list:
            for flowable in build_lists(current_list, styles):
                story.append(flowable)
            current_list = []

    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        line = raw.strip()
        i += 1
        if not line:
            # 空行不打断列表：Markdown 允许条目间空行（松散列表），
            # 否则 1./2./3. 会各自成为独立 ListFlowable，编号全部重置为 1。
            # 列表遇非列表行时，由各分支自己的 flush_list() 收尾。
            continue

        # 代码段围栏：``` 或 ~~~（可带语言标记），围栏内原样输出、不解析 Markdown
        if FENCE_OPEN_RE.match(line):
            flush_list()
            code_lines = []
            while i < n and not FENCE_CLOSE_RE.match(lines[i].strip()):
                code_lines.append(lines[i])  # 保留原始缩进
                i += 1
            if i < n:
                i += 1  # 跳过收尾围栏
            story.append(code_block_flowable('\n'.join(code_lines), styles, max_width))
            continue

        # 分隔线
        if re.match(r'^(-{3,}|\*{3,})$', line):
            flush_list()
            story.append(HRFlowable(
                width="100%", thickness=0.5, color="#cccccc",
                spaceBefore=8, spaceAfter=8
            ))
            continue

        # 独立成行的图片：![alt](src) → 嵌入 PDF；加载失败退回 alt/路径文本，不丢行
        m_img = IMG_MD_RE.fullmatch(line)
        if m_img:
            flush_list()
            alt, src = m_img.group(1), m_img.group(2)
            img = image_flowable(src, md_dir, max_width)
            if img is not None:
                story.append(img)
            else:
                label = alt or src
                story.append(Paragraph(render_inline('[图片缺失：' + label + ']'), styles["body"]))
            continue

        # 标题
        if line.startswith('# '):
            flush_list()
            story.append(Paragraph(render_inline(line[2:]), styles["title"]))
        elif line.startswith('## '):
            flush_list()
            story.append(Paragraph(render_inline(line[3:]), styles["h1"]))
        elif line.startswith('### '):
            flush_list()
            story.append(Paragraph(render_inline(line[4:]), styles["h2"]))
        elif line.startswith('#### '):
            flush_list()
            story.append(Paragraph(render_inline(line[5:]), styles["h3"]))
        # 无序列表
        elif line.startswith(('- ', '* ')):
            current_list.append((indent_width(raw), 'ul', render_inline(line[2:]), None))
        # 有序列表
        elif is_ordered_list(line):
            m = re.match(r'^(\d+)\.\s+', line)
            current_list.append((indent_width(raw), 'ol', render_inline(line[m.end():]), m.group(1)))
        # 引用
        elif line.startswith('> '):
            flush_list()
            story.append(Paragraph(render_inline(line[2:]), styles["quote"]))
        # 表格：当前行是表头行，且下一行是分隔行 → 收拢成整张表
        elif TABLE_ROW_RE.match(line) and i < n and TABLE_SEP_RE.match(lines[i].strip()):
            flush_list()
            i += 1  # 跳过分隔行
            rows = [split_row(line)]
            while i < n and TABLE_ROW_RE.match(lines[i].strip()):
                rows.append(split_row(lines[i].strip()))
                i += 1
            story.append(table_flowable(rows, max_width, styles))
        # 普通段落（下一行是 ===/--- 下划线时按 setext 标题处理）
        else:
            flush_list()
            if i < n and SETEXT_H1_RE.match(lines[i].strip()):
                i += 1
                story.append(Paragraph(render_inline(line), styles["title"]))
            elif i < n and SETEXT_H2_RE.match(lines[i].strip()):
                i += 1
                story.append(Paragraph(render_inline(line), styles["h1"]))
            else:
                story.append(Paragraph(render_inline(line), styles["body"]))

    flush_list()
    return story

# ---------- 主转换函数 ----------
def markdown_to_pdf(md_path, pdf_path):
    """读取 Markdown 文件并转换为 PDF"""
    md_text = strip_front_matter(Path(md_path).read_text(encoding="utf-8"))

    # 注册字体
    font_pair = register_font()
    if font_pair:
        normal_font, bold_font = font_pair
        print(f"使用中文字体：{normal_font}")
    else:
        normal_font, bold_font = "Helvetica", "Helvetica-Bold"
        print("使用 Helvetica（中文可能显示为方块）")
    global _CJK_FONT
    _CJK_FONT = normal_font

    # 构建样式
    styles = build_styles(normal_font, bold_font)

    # 解析 Markdown（图片相对路径按 md 所在目录解析；版心宽 = A4 宽 - 左右边距）
    story = parse_markdown(md_text, styles, md_dir=Path(md_path).resolve().parent, max_width=A4[0] - 40 * mm)

    # 创建 PDF
    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=Path(md_path).stem,
    )
    doc.build(story)

# ---------- 入口 ----------
def main():
    if len(sys.argv) != 2:
        print("Usage: python3 run.py '<json_string>'")
        sys.exit(1)

    try:
        args = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(f"Invalid JSON argument: {e}", file=sys.stderr)
        sys.exit(1)

    input_path = args.get("input")
    if not input_path:
        print("Error: 'input' field is required", file=sys.stderr)
        sys.exit(1)

    output_path = args.get("output")
    if not output_path:
        output_path = str(Path(input_path).with_suffix(".pdf"))

    try:
        markdown_to_pdf(input_path, output_path)
        print(f"PDF generated: {output_path}")
    except Exception as e:
        print(f"Error during conversion: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
