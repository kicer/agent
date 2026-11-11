# x2pdf：本机环境

```sh
SK="$(dirname "$AGENT_SKILLS_DEPS")/x2pdf"
```

## 文本类 md / txt / html

```sh
python3 -m pip install --target "$AGENT_SKILLS_DEPS" -r "$SK/requirements.txt"
brew install pango        # macOS；Linux 的系统库见 install.sh
```

不装 pango 也能用：技能在 WeasyPrint 不可用时回落 LibreOffice，代价是 `page` 的边距/页码与部分 CSS 不生效。

## Office 类 docx / xlsx / pptx / odt / ods / odp

必须有 LibreOffice（文本类也可用它渲染）：

```sh
brew install --cask libreoffice      # macOS：soffice 在 app bundle 内，技能会自己找到
apt-get install libreoffice-writer libreoffice-calc libreoffice-impress   # Linux（镜像已预装）
```

## 验证

```sh
python3 -c "import weasyprint, markdown"
/Applications/LibreOffice.app/Contents/MacOS/soffice --version
```
