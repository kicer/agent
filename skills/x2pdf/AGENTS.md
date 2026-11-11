# x2pdf

`ModuleNotFoundError`（文本类报 `markdown`，或提示 WeasyPrint 不可用）

```sh
python3 -m pip install --target "$AGENT_SKILLS_DEPS" -r "$(dirname "$AGENT_SKILLS_DEPS")/x2pdf/requirements.txt"
```

WeasyPrint 还要系统库：macOS `brew install pango`。

Office 类（docx/xlsx/pptx）报「未找到 LibreOffice」

```sh
brew install --cask libreoffice
```

装了 LibreOffice 后文本类也能用（自动回落，`page` 的边距/页码与部分 CSS 不生效），此时不必装 pango。
