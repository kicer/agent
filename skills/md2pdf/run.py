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
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem, HRFlowable, Image
)

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
    # 还原行内代码
    def _restore(m):
        return '<font face="Courier">' + code_spans[int(m.group(1))] + '</font>'
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

# ---------- Markdown 解析主函数 ----------
def parse_markdown(md_text, styles, md_dir=None, max_width=170 * mm):
    """解析 Markdown 文本，返回 platypus 故事列表"""
    md_dir = md_dir or Path.cwd()
    story = []
    lines = md_text.split('\n')
    current_list = []          # 当前列表项
    current_list_type = None   # 'ul' 或 'ol'

    def flush_list():
        nonlocal current_list, current_list_type
        if current_list:
            items = [
                ListItem(Paragraph(item, styles["list_item"]), leftIndent=18)
                for item in current_list
            ]
            if current_list_type == 'ol':
                flowable = ListFlowable(items, bulletType='1', start='1', leftIndent=18)
            else:
                flowable = ListFlowable(items, bulletType='bullet', start='circle', leftIndent=18)
            story.append(flowable)
            current_list = []
            current_list_type = None

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            flush_list()
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
            if current_list_type != 'ul':
                flush_list()
                current_list_type = 'ul'
            current_list.append(render_inline(line[2:]))
        # 有序列表
        elif is_ordered_list(line):
            if current_list_type != 'ol':
                flush_list()
                current_list_type = 'ol'
            text = re.sub(r'^\d+\.\s+', '', line)
            current_list.append(render_inline(text))
        # 引用
        elif line.startswith('> '):
            flush_list()
            story.append(Paragraph(render_inline(line[2:]), styles["quote"]))
        # 普通段落
        else:
            flush_list()
            story.append(Paragraph(render_inline(line), styles["body"]))

    flush_list()
    return story

# ---------- 主转换函数 ----------
def markdown_to_pdf(md_path, pdf_path):
    """读取 Markdown 文件并转换为 PDF"""
    md_text = Path(md_path).read_text(encoding="utf-8")

    # 注册字体
    font_pair = register_font()
    if font_pair:
        normal_font, bold_font = font_pair
        print(f"使用中文字体：{normal_font}")
    else:
        normal_font, bold_font = "Helvetica", "Helvetica-Bold"
        print("使用 Helvetica（中文可能显示为方块）")

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
