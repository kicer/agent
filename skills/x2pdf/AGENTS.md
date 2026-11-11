# x2pdf

`ModuleNotFoundError`（`markdown`）或提示 WeasyPrint 不可用：把依赖装进 `$AGENT_SKILLS_DEPS`

```sh
python3 -m pip install --target "$AGENT_SKILLS_DEPS" -r "$(dirname "$AGENT_SKILLS_DEPS")/x2pdf/requirements.txt"
```

WeasyPrint 还要系统库 pango/cairo：Linux `apt install libpango-1.0-0 libpangocairo-1.0-0 libcairo2`；
macOS `brew install pango`；Windows 装不起来就跳过——有 LibreOffice 时文本类会自动回落。

Office 类（docx/xlsx/pptx）报「未找到 LibreOffice」：装一个 LibreOffice
（Linux `apt install libreoffice`；macOS `brew install --cask libreoffice`；
Windows `winget install TheDocumentFoundation.LibreOffice`）。

装了 LibreOffice 后文本类也能用（回落路径，`page` 的边距/页码与部分 CSS 不生效），此时不必装 pango。

网络慢或装不上（pip / brew / winget 等）：见技能根目录的 `AGENTS.md`。
