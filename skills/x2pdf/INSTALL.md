# 本机安装渲染后端（x2pdf 技能）

两条渲染路径，依赖各不相同。`requirements.txt` 列的是 Python 包（服务器 init 也按它装）。
下文「技能目录」= `$(dirname "$AGENT_SKILLS_DEPS")/x2pdf`。

## 文本类（md / txt / html）：默认 WeasyPrint

```bash
python3 -m pip install --target "$AGENT_SKILLS_DEPS" -r "$(dirname "$AGENT_SKILLS_DEPS")/x2pdf/requirements.txt"
```

WeasyPrint 除了 Python 包，还要系统库 pango/cairo：

- macOS：`brew install pango`
- Linux：见同目录 `install.sh`（apt 装 那串 `libpango*` / `libcairo2` / 字体）

**不想装 pango 也行**：装 LibreOffice（见下），技能在 WeasyPrint 不可用时（缺包或缺 pango 符号）
会自动回落到 LibreOffice 渲染文本。代价是 `page` 的边距/页码与大部分 CSS 不生效——够看，不够精确。

## Office 类（docx / xlsx / pptx / odt / ods / odp）：必须 LibreOffice

- macOS：`brew install --cask libreoffice`
  装完**不需要**把 `soffice` 加进 `PATH`，技能会自己找 `/Applications/LibreOffice.app/Contents/MacOS/soffice`。
- Linux：`apt-get install libreoffice-writer libreoffice-calc libreoffice-impress`（服务器镜像已预装）。

## 验证

```bash
python3 -c "import weasyprint, markdown"                                          # 文本类（走 WeasyPrint）
/Applications/LibreOffice.app/Contents/MacOS/soffice --version                     # LibreOffice
```

两者都没有时，技能会报「这台机器没有可用的 PDF 渲染后端」。装完不需要重启 agent。
