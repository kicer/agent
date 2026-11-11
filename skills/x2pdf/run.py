#!/usr/bin/env python3
"""
x2pdf 技能主入口:通用 PDF 转换。

分派策略(按输入文件扩展名):
- .md / .markdown / .txt / .html / .htm → 依次尝试 WeasyPrint / 无头浏览器 / LibreOffice
  三者都是本机可能没有的渲染后端:WeasyPrint 缺包或缺 pango/cairo 时不可用,
  浏览器(Chrome/Chromium/Edge)不需要任何 Python 依赖,保真度介于两者之间
- .docx / .xlsx / .pptx / .odt / .ods / .odp → LibreOffice headless 转换

依赖不假设镜像预烘:Python 包由 requirements.txt 声明,系统库由 install.sh 就绪校验。
LibreOffice 与浏览器的定位不只看 PATH:macOS 的 app bundle 与 Windows 的安装目录都不进 PATH,
which() 找不到不等于没装(见 find_soffice / find_browser)。
中文字体走 fontconfig(系统文泉驿/Noto),技能不携带字体文件。
"""
import contextlib
import html as html_mod
import io
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

SKILL_DIR = Path(__file__).resolve().parent


def find_soffice():
    """定位 LibreOffice 可执行文件。
    PATH 优先(服务器/apt 装的都在);再探 macOS 的 app bundle 与 Windows 的安装目录——
    这两个位置正常安装都不进 PATH,只用 shutil.which() 会把「装了」误判成「没装」。"""
    for name in ('soffice', 'libreoffice'):
        p = shutil.which(name)
        if p:
            return p
    for c in ('/Applications/LibreOffice.app/Contents/MacOS/soffice',
              str(Path.home() / 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
              r'C:\Program Files\LibreOffice\program\soffice.exe',
              r'C:\Program Files (x86)\LibreOffice\program\soffice.exe'):
        if Path(c).is_file():
            return c
    return None


def find_browser():
    """定位支持 --headless --print-to-pdf 的浏览器(Chrome / Chromium / Edge)。
    不要求用户为了转 PDF 装 Python 侧渲染栈:pango 在老系统上只能现编。
    同 find_soffice:macOS app bundle 与 Windows 安装目录都不进 PATH。"""
    for name in ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
                 'microsoft-edge', 'msedge'):
        p = shutil.which(name)
        if p:
            return p
    for c in ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              '/Applications/Chromium.app/Contents/MacOS/Chromium',
              '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
              str(Path.home() / 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
              r'C:\Program Files\Google\Chrome\Application\chrome.exe',
              r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
              r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
              r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'):
        if Path(c).is_file():
            return c
    return None


def req_hint():
    return '本机环境: %s' % (SKILL_DIR / 'AGENTS.md')

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
    """md/txt/html → PDF。返回一句后端提示(正常走 WeasyPrint 时为空串)。"""
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
            try:
                import markdown
            except ImportError:
                raise RuntimeError('缺 Python 包 markdown,无法解析 Markdown;%s' % req_hint())
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
    try:
        # 导入失败时 WeasyPrint 会往 stdout 打一大段「could not import some external libraries」
        # (text/ffi.py 里裸 print),模型会把这段当成真错。降级是预期行为,噪声吞掉,
        # 由返回值那句 note 告知实际后端。
        sink = io.StringIO()
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            from weasyprint import CSS, HTML
    except (ImportError, OSError):
        # 缺 Python 包是 ImportError;装了包但缺它要 dlopen 的 libpango/libgobject 时是 OSError。
        # 两种都当作「本机没有 WeasyPrint」:先试浏览器(只需装了 Chrome 系),再回落 LibreOffice。
        browser = find_browser()
        if browser:
            return convert_html_browser(browser, document, output_path, base_url, sheets, ext)
        return convert_html_pdf(document, output_path, ext)
    # 注:stylesheets 参数只接受 CSS 对象,传字符串会被当成文件路径
    HTML(string=document, base_url=base_url).write_pdf(
        str(output_path), stylesheets=[CSS(string=s) for s in sheets] or None)
    return ''


def inject_styles(document, sheets, base_url):
    """把 CSS 与 base 标签塞进已有 HTML:浏览器后端只能吃单个文件。
    注入点是 </head>(其次 <body>),绝不能落到 doctype 前面——那会触发怪异模式。"""
    head = ''
    if base_url:
        head += '<base href="%s/">\n' % Path(base_url).resolve().as_uri()
    if sheets:
        head += '<style>\n%s\n</style>\n' % '\n'.join(sheets)
    if not head:
        return document
    m = re.search(r'</head\s*>', document, re.I) or re.search(r'<body[^>]*>', document, re.I)
    if m:
        return document[:m.start()] + head + document[m.start():]
    d = re.match(r'\s*<!doctype[^>]*>', document, re.I)
    if d:
        return document[:d.end()] + '\n' + head + document[d.end():]
    return head + document


def convert_html_browser(browser, document, output_path, base_url, sheets, ext):
    """HTML → 无头浏览器打印:WeasyPrint 不可用时的中间档。
    浏览器能完整解析 CSS(表格边框/底纹/分页),但页码是 WeasyPrint 的 CSS 计数器特性,
    这里不生效;@page 的 size/margin 视浏览器版本部分生效。"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_root = Path(tempfile.mkdtemp(prefix='x2pdf-browser-'))
    try:
        # 浏览器默认纸张是 Letter,WeasyPrint 默认 A4。文档自己没写 @page 时补上 A4,
        # 否则同一份 html 换后端就换纸型。
        if not any('@page' in s for s in sheets) and '@page' not in document:
            sheets = list(sheets) + ['@page { size: A4; }']
        src = tmp_root / 'document.html'
        src.write_text(inject_styles(document, sheets, base_url), encoding='utf-8')
        cmd = [browser, '--headless', '--disable-gpu', '--no-pdf-header-footer',
               '--virtual-time-budget=2000',
               '--print-to-pdf=%s' % str(output_path.resolve()), src.as_uri()]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if not output_path.is_file() or output_path.stat().st_size == 0:
            detail = (proc.stderr or proc.stdout or '').strip().replace('\n', ' ')[:300]
            raise RuntimeError('PDF 生成失败(exit=%s):%s' % (proc.returncode, detail or '无输出'))
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
    return '排版降级:无页码,尺寸/边距可能与预期有偏差'


def convert_html_pdf(document, output_path, ext):
    """HTML → LibreOffice:最后一道回落(浏览器也没有时)。
    代价是保真度:@page 的边距/页码与大部分 CSS 在 LibreOffice 的 HTML 导入里不生效,
    适合「拿到一份能看的 PDF」,不适合精确排版。"""
    if not find_soffice():
        raise RuntimeError('这台机器没有可用的 PDF 排版能力,无法转换 %s;%s' % (ext, req_hint()))
    tmp_root = Path(tempfile.mkdtemp(prefix='x2pdf-html-'))
    try:
        src = tmp_root / 'document.html'
        src.write_text(document, encoding='utf-8')
        convert_office_pdf(src, output_path)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
    return '排版降级:边距/页码与部分 CSS 不生效'


def convert_office_pdf(input_path, output_path):
    """docx/xlsx/pptx 等 → LibreOffice headless。
    每次用独立临时 UserInstallation/HOME,避免并发实例互踩共享配置。"""
    soffice = find_soffice()
    if not soffice:
        raise FileNotFoundError('这台机器没有可用于转换 Office 文档的组件;%s' % req_hint())

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
            raise RuntimeError('文档转换失败(exit=%s):%s' % (proc.returncode, detail or '无输出'))
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

    note = ''
    try:
        if ext in OFFICE_EXTS:
            ignored = [k for k in ('css', 'page') if args.get(k)]
            if ignored:
                print('提示:Office 输入忽略参数 %s' % '、'.join(ignored))
            convert_office_pdf(input_path, output_path)
        else:
            note = convert_text_pdf(input_path, output_path, args.get('css'), args.get('page'))
    except Exception as e:
        print('Error during conversion: %s' % e, file=sys.stderr)
        sys.exit(1)

    print('PDF generated: %s' % output_path.resolve())
    if note:
        print(note)


if __name__ == '__main__':
    main()
