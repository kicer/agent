#!/usr/bin/env python3
import sys
import json
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem
from reportlab.lib.enums import TA_LEFT

def markdown_to_pdf(md_path: str, pdf_path: str):
    """简化版 Markdown 转 PDF，支持标题、段落、无序列表"""
    md_text = Path(md_path).read_text(encoding="utf-8")
    lines = md_text.split("\n")

    doc = SimpleDocTemplate(pdf_path, pagesize=A4,
                            right_margin=72, left_margin=72,
                            top_margin=72, bottom_margin=72)
    styles = getSampleStyleSheet()
    # 自定义样式
    h1_style = ParagraphStyle('H1Custom', parent=styles['Heading1'], fontSize=20, spaceAfter=12)
    h2_style = ParagraphStyle('H2Custom', parent=styles['Heading2'], fontSize=16, spaceAfter=10)
    body_style = ParagraphStyle('BodyCustom', parent=styles['BodyText'], fontSize=12, leading=16)
    list_style = ParagraphStyle('ListCustom', parent=styles['BodyText'], fontSize=12, leading=16)

    story = []
    current_list = []
    in_list = False

    def flush_list():
        nonlocal in_list, current_list
        if in_list and current_list:
            story.append(ListFlowable(
                [ListItem(Paragraph(item, list_style), leftIndent=20) for item in current_list],
                bulletType='bullet',
                start='circle',
                leftIndent=20
            ))
            current_list = []
            in_list = False

    for line in lines:
        line = line.strip()
        if not line:
            flush_list()
            continue

        if line.startswith('# '):
            flush_list()
            story.append(Paragraph(line[2:], h1_style))
        elif line.startswith('## '):
            flush_list()
            story.append(Paragraph(line[3:], h2_style))
        elif line.startswith('- ') or line.startswith('* '):
            in_list = True
            current_list.append(line[2:])
        else:
            flush_list()
            story.append(Paragraph(line, body_style))

    flush_list()

    doc.build(story)

def main():
    if len(sys.argv) != 2:
        print("Usage: python run.py '<json_string>'")
        sys.exit(1)

    try:
        args = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(f"Invalid JSON argument: {e}")
        sys.exit(1)

    input_path = args.get("input")
    if not input_path:
        print("Error: 'input' field is required")
        sys.exit(1)

    output_path = args.get("output")
    if not output_path:
        output_path = str(Path(input_path).with_suffix(".pdf"))

    try:
        markdown_to_pdf(input_path, output_path)
        print(f"PDF generated: {output_path}")
    except Exception as e:
        print(f"Error during conversion: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
