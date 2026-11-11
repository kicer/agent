# document-photo-to-pdf：本机环境

```sh
SK="$(dirname "$AGENT_SKILLS_DEPS")/document-photo-to-pdf"
```

缺依赖时（`ModuleNotFoundError`，最先撞到的是 `numpy`）：

```sh
python3 -m pip install --target "$AGENT_SKILLS_DEPS" -r "$SK/requirements.txt"
python3 -c "import numpy, PIL, fitz"
```

- `fitz` 是 `pymupdf` 的 import 名
- `pypdfium2` 不必装：只在 `pymupdf` 也缺失时才用得上
- 自检渲染优先系统 `pdftoppm`（poppler，可选）
