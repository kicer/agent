#!/usr/bin/env python3
"""
x2pdf 技能主入口:通用 PDF 转换。

分派策略(按输入文件扩展名):
- .md / .markdown / .txt / .html / .htm → WeasyPrint 渲染
- .docx / .xlsx / .pptx / .odt / .ods / .odp → LibreOffice headless 转换

依赖不假设镜像预烘:Python 包由 requirements.txt 声明,系统库由 install.sh 就绪校验。
中文字体走 fontconfig(系统文泉驿/Noto),技能不携带字体文件。
"""
import html as html_mod
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TEXT_EXTS = {'.md', '.markdown', '.txt', '.html', '.htm'}
MD_EXTS = {'.md', '.markdown'}
HTML_EXTS = {'.html', '.htm'}
OFFICE_EXTS = {'.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp'}
SUPPORTED_EXTS = TEXT_EXTS | OFFICE_EXTS

PAGE_DEFAULTS = {'size': 'A4', 'margin': '20mm', 'font_size': '10.5pt'}

# 默认样式:黑白友好、打印向。字号用 em 相对值,整体缩放只依赖 html font-size
# (由 page.font_size 参数注入),因此压单页只需调小字号/边距。
DEFAULT_CSS = """
body {
  font-family: "WenQuanYi Micro Hei", "Noto Sans CJK SC", "Source Han Sans SC",
               "DejaVu Sans", sans-serif;
  color: #1a1a1a;
  line-height: 1.6;
  margin: 0;
}
h1, h2, h3, h4, h5, h6 {
  font-weight: 700; line-height: 1.35; margin: 1.25em 0 0.55em;
  break-after: avoid; break-inside: avoid;
}
h1 { font-size: 1.85em; margin-top: 0; }
h2 { font-size: 1.45em; }
h3 { font-size: 1.22em; }
h4, h5, h6 { font-size: 1.08em; }
p { margin: 0.62em 0; }
ul, ol { margin: 0.55em 0; padding-left: 2.1em; }
li { margin: 0.28em 0; }
li > ul, li > ol { margin: 0.2em 0; }
blockquote {
  margin: 0.9em 0; padding: 0.45em 1.05em; color: #444;
  border-left: 3px solid #999; background: #f7f7f7; break-inside: avoid;
}
code {
  font-family: "DejaVu Sans Mono", "WenQuanYi Micro Hei Mono", monospace;
  font-size: 0.88em; background: #f0f0f0;
  border: 1px solid #ddd; border-radius: 3px; padding: 0.05em 0.28em;
}
pre {
  background: #f7f7f7; border: 1px solid #ddd; border-radius: 3px;
  padding: 0.7em 0.95em; line-height: 1.45;
}
pre, pre code { white-space: pre-wrap; overflow-wrap: break-word; }
pre code { background: none; border: none; padding: 0; font-size: 0.85em; }
table { border-collapse: collapse; margin: 0.9em auto; font-size: 0.93em; }
th, td { border: 1px solid #777; padding: 0.32em 0.65em; }
th { background: #e6e6e6; font-weight: 700; }
tr:nth-child(even) td { background: #f7f7f7; }
img { max-width: 100%; }
hr { border: none; border-top: 1px solid #999; margin: 1.5em 0; }
a { color: inherit; text-decoration: none; }
del { color: #888; }
"""

# page 参数值最终会拼进 CSS 声明,白名单字符防注入(拒绝 } < ; 等)
CSS_VALUE_RE = re.compile(r'^[A-Za-z0-9.,%\s()/+-]+$')


def safe_css_value(value, name):
    text = str(value).strip()
    if not text or not CSS_VALUE_RE.match(text):
        raise ValueError('page.%s 取值不合法:%r(仅允许字母数字与 . , %% ( ) + - 空格)' % (name, value))
    return text


def page_css(page, with_defaults):
    """由 page 参数生成 CSS。with_defaults=True(md/txt)补全默认值并加页脚页码;
    False(html)只应用显式传入的字段,避免干扰文档自带版式。"""
    page = page or {}
    vals = {}
    for key in ('size', 'margin', 'font_size'):
        v = page.get(key)
        if v is None and with_defaults:
            v = PAGE_DEFAULTS[key]
        if v is not None:
            vals[key] = safe_css_value(v, key)
    unknown = set(page) - {'size', 'margin', 'font_size'}
    if unknown:
        raise ValueError('page 含未知字段:%s(支持 size/margin/font_size)' % '、'.join(sorted(unknown)))

    parts = []
    decl = ''
    if 'size' in vals:
        decl += 'size: %s; ' % vals['size']
    if 'margin' in vals:
        decl += 'margin: %s; ' % vals['margin']
    if with_defaults:
        decl += ('@bottom-center { content: counter(page) " / " counter(pages); '
                 'font-size: 8.5pt; color: #666; } ')
    if decl:
        parts.append('@page { %s}' % decl)
    if 'font_size' in vals:
        parts.append('html { font-size: %s; }' % vals['font_size'])
    return '\n'.join(parts)


def strip_front_matter(text):
    """markdown 的 frontmatter 扩展只吃 '---' 围栏;为行为明确(且避免其对
    非 '---' 起始的键值块解析不一致),这里自行剔除文首 YAML 块。"""
    lines = text.split('\n')
    if lines and lines[0].strip() == '---':
        for i in range(1, len(lines)):
            if lines[i].strip() in ('---', '...'):
                return '\n'.join(lines[i + 1:])
    return text


def build_document(title, body_html):
    return (
        '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n'
        '<title>%s</title>\n</head>\n<body>\n%s\n</body>\n</html>'
        % (html_mod.escape(title), body_html)
    )


def convert_text_pdf(input_path, output_path, css_arg, page_arg):
    """md/txt/html → WeasyPrint"""
    from weasyprint import CSS, HTML

    ext = input_path.suffix.lower()
    text = input_path.read_text(encoding='utf-8', errors='replace')
    user_css = None
    if css_arg:
        css_path = Path(css_arg)
        if not css_path.exists():
            raise FileNotFoundError('CSS 文件不存在:%s' % css_path)
        user_css = css_path.read_text(encoding='utf-8', errors='replace')

    base_url = str(input_path.resolve().parent)

    if ext in HTML_EXTS:
        # HTML:不套默认 CSS;page 参数仅显式传入的字段生效。
        # 外部样式表通过 stylesheets 参数追加在文档样式之后,同名声明可覆盖文档内样式。
        document = text
        sheets = [s for s in (page_css(page_arg, with_defaults=False), user_css) if s]
    else:
        if ext in MD_EXTS:
            import markdown
            # extra 已含 tables/fenced_code/footnotes/attr_list/md_in_html/sane_lists 等;
            # 不可再单独传其中的扩展名,否则 ExtensionAlreadyConfigured
            body = markdown.markdown(
                strip_front_matter(text),
                extensions=['extra', 'toc'],
            )
        else:  # .txt:不解析,转义后整篇 <pre>
            body = '<pre>%s</pre>' % html_mod.escape(text)
        document = build_document(input_path.stem, body)
        sheets = [DEFAULT_CSS, page_css(page_arg, with_defaults=True)]
        if user_css:
            sheets.append(user_css)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    # 注:stylesheets 参数只接受 CSS 对象,传字符串会被当成文件路径
    HTML(string=document, base_url=base_url).write_pdf(
        str(output_path), stylesheets=[CSS(string=s) for s in sheets] or None)


def convert_office_pdf(input_path, output_path):
    """docx/xlsx/pptx 等 → LibreOffice headless。
    每次用独立临时 UserInstallation/HOME,避免并发实例互踩共享配置。"""
    soffice = shutil.which('soffice') or shutil.which('libreoffice')
    if not soffice:
        raise FileNotFoundError('未找到 soffice/libreoffice,无法转换 Office 文档(需镜像预装)')

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_root = Path(tempfile.mkdtemp(prefix='x2pdf-office-'))
    profile = tmp_root / 'lo-profile'
    pdf_dir = tmp_root / 'pdf'
    profile.mkdir()
    pdf_dir.mkdir()
    try:
        env = dict(os.environ, HOME=str(profile))
        cmd = [
            soffice, '--headless', '--norestore',
            '-env:UserInstallation=%s' % profile.resolve().as_uri(),
            '--convert-to', 'pdf',
            '--outdir', str(pdf_dir),
            str(input_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, env=env)
        generated = pdf_dir / (input_path.stem + '.pdf')
        if not generated.exists():
            detail = (proc.stderr or proc.stdout or '').strip().replace('\n', ' ')[:300]
            raise RuntimeError('LibreOffice 转换失败(exit=%s):%s' % (proc.returncode, detail or '无输出'))
        shutil.move(str(generated), str(output_path))
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 run.py '<json_string>'")
        sys.exit(1)

    try:
        args = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(f'Invalid JSON argument: {e}', file=sys.stderr)
        sys.exit(1)

    input_arg = args.get('input')
    if not input_arg:
        print("Error: 'input' field is required", file=sys.stderr)
        sys.exit(1)

    input_path = Path(input_arg)
    if not input_path.is_file():
        print('Error: 输入文件不存在:%s' % input_path, file=sys.stderr)
        sys.exit(1)

    ext = input_path.suffix.lower()
    if ext not in SUPPORTED_EXTS:
        print('Error: 不支持的输入类型 %r(支持:%s)'
              % (ext, ' '.join(sorted(SUPPORTED_EXTS))), file=sys.stderr)
        sys.exit(1)

    output_arg = args.get('output')
    output_path = Path(output_arg) if output_arg else input_path.with_suffix('.pdf')

    try:
        if ext in OFFICE_EXTS:
            ignored = [k for k in ('css', 'page') if args.get(k)]
            if ignored:
                print('提示:Office 输入忽略参数 %s' % '、'.join(ignored))
            convert_office_pdf(input_path, output_path)
        else:
            convert_text_pdf(input_path, output_path, args.get('css'), args.get('page'))
    except Exception as e:
        print('Error during conversion: %s' % e, file=sys.stderr)
        sys.exit(1)

    print('PDF generated: %s' % output_path.resolve())


if __name__ == '__main__':
    main()
