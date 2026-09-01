#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
md2pdf 技能主入口：将 Markdown 转换为 PDF（支持中文和常用格式）
依赖 `install.sh` 预先准备好中文字体（fonts/cjk.ttf），本脚本只负责注册和转换。
"""
import sys
import os
import json
import re
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, ListFlowable, ListItem, HRFlowable

# ---------- 字体注册 ----------
def register_font():
    """注册技能目录下的 fonts/cjk.ttf（由 install.sh 准备）"""
    font_path = Path(__file__).parent / "fonts" / "cjk.ttf"
    if font_path.exists() and font_path.stat().st_size > 0:
        try:
            pdfmetrics.registerFont(TTFont("CJK", str(font_path)))
            pdfmetrics.registerFont(TTFont("CJKBold", str(font_path)))  # 粗体模拟
            return ("CJK", "CJKBold")
        except Exception as e:
            print(f"字体注册失败：{e}，将使用 Helvetica", file=sys.stderr)
            return None
    else:
        print("未找到准备好的字体文件 fonts/cjk.ttf，请确认 install.sh 已执行", file=sys.stderr)
        return None

# ---------- 样式与 Markdown 解析（与之前相同，此处省略详细代码） ----------
# ...（保留原有的 parse_inline、parse_markdown、markdown_to_pdf 等）

def main():
    if len(sys.argv) != 2:
        print("Usage: python3 run.py '<json_string>'")
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

    output_path = args.get("output") or str(Path(input_path).with_suffix(".pdf"))

    try:
        font_pair = register_font()
        if font_pair:
            normal, bold = font_pair
            print(f"使用中文字体：{normal}")
        else:
            normal, bold = "Helvetica", "Helvetica-Bold"
            print("使用 Helvetica（中文可能显示为方块）")

        # 构建样式、解析 Markdown、生成 PDF
        # ...（调用已有的函数）

        print(f"PDF generated: {output_path}")
    except Exception as e:
        print(f"Error during conversion: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
