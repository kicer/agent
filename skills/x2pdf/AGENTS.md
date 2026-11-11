# x2pdf

`ModuleNotFoundError`（`markdown`）：把依赖装进 `$AGENT_SKILLS_DEPS`

```sh
python3 -m pip install --upgrade --target "$AGENT_SKILLS_DEPS" -r "$(dirname "$AGENT_SKILLS_DEPS")/x2pdf/requirements.txt"
```

## 后端缺哪个，代价多大

| 后端 | 缺了的影响 | 怎么补 |
|---|---|---|
| LibreOffice | **Office 类（docx/xlsx/pptx）完全不能转**，必装 | Linux `apt install libreoffice`；macOS `brew install --cask libreoffice`；Windows `winget install TheDocumentFoundation.LibreOffice` |
| 浏览器 | 文本类落到 LibreOffice，CSS 基本失效 | 通常不用装：已有 Chrome / Chromium / Edge 就自动用 |
| WeasyPrint | 文本类没有页码、`@page` 精确排版失效 | 先装 Python 包（见上），再补系统库 pango/cairo：Linux `apt install libpango-1.0-0 libpangocairo-1.0-0 libcairo2`；macOS `brew install pango`；Windows 补 GTK 运行库，装不上就跳过 |

报「没有可用的 PDF 排版能力」时：文本类有三个后端可退，按上表从便宜到贵补，别一次全装。
输出带着「排版降级」（无页码/边距偏差）不是失败，是后端不全，按需补。
系统级安装（几百 MB，老系统上可能源码编译十几分钟）先跟用户说清代价，由他决定装还是接受降级。

## 装完必须验证

`pip install` 成功不代表能用，缺系统库时 import 就炸：

```sh
python3 -c "import weasyprint; print(weasyprint.__version__)"
```

报 `could not import some external libraries` = 系统库（pango/cairo）还没到位，不是 Python 包的问题。
