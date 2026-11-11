# document-photo-to-pdf

`ModuleNotFoundError`（`numpy` / `PIL` / `fitz`）：把依赖装进 `$AGENT_SKILLS_DEPS`

```sh
python3 -m pip install --upgrade --target "$AGENT_SKILLS_DEPS" -r "$(dirname "$AGENT_SKILLS_DEPS")/document-photo-to-pdf/requirements.txt"
```

`fitz` 是 `pymupdf` 的 import 名，`pypdfium2` 不用装。没有 `python3` 先装运行时（Windows 上解释器常是 `python` / `py`）。
