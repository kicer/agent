# x2pdf

以下命令仅为示例，具体以本机平台实际情况为准。

## ModuleNotFoundError: markdown

把依赖装进 `$AGENT_SKILLS_DEPS`。

```sh
python3 -m pip install --upgrade --target "$AGENT_SKILLS_DEPS" -r "$(dirname "$AGENT_SKILLS_DEPS")/x2pdf/requirements.txt"
```

## 没有可用的 PDF 排版能力

文本类有三个后端可退，从便宜到贵补，别一次全装：

- 浏览器：有 Chrome / Chromium / Edge 就自动用，通常不用装
- LibreOffice：Office 类（docx/xlsx/pptx）必装——Linux `apt install libreoffice`；macOS `brew install --cask libreoffice`；Windows `winget install TheDocumentFoundation.LibreOffice`
- WeasyPrint：先装上面的 Python 包，再补系统库 pango/cairo（见下节）

系统级安装几百 MB，先跟用户说清代价，由他决定装还是接受降级。

## could not import some external libraries

系统库没到位，不是 Python 包的问题：Linux `apt install libpango-1.0-0 libpangocairo-1.0-0 libcairo2`；macOS `brew install pango`；Windows 补 GTK 运行库，装不上就跳过。

装完验证：

```sh
python3 -c "import weasyprint; print(weasyprint.__version__)"
```

## 输出带「排版降级」

无页码或边距偏差不是失败，是后端不全，按需补。
