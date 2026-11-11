# 本机安装 Python 依赖（document-photo-to-pdf 技能）

依赖由同目录 `requirements.txt` 声明（服务器 init 按它装；本机自己装）。纯 wheel，无编译、无系统库。
下文「技能目录」= `$(dirname "$AGENT_SKILLS_DEPS")/document-photo-to-pdf`。

```bash
python3 -m pip install --target "$AGENT_SKILLS_DEPS" \
  -r "$(dirname "$AGENT_SKILLS_DEPS")/document-photo-to-pdf/requirements.txt"
```

## 依赖说明

| 包 | 用途 |
|---|---|
| `numpy` | 透视校正、统计与阈值计算 |
| `Pillow` | 图片读写、缩放、调色 |
| `pymupdf` | 生成 PDF（import 名是 `fitz`）与自检渲染 |

自检渲染优先用系统 `pdftoppm`（poppler，可选）；没有就用 `pymupdf`；再不行才落到 `pypdfium2`。
`pypdfium2` **不必装**，只在 `pymupdf` 也缺失时才有意义。

## 验证

```bash
python3 -c "import numpy, PIL, fitz"
```

缺依赖时技能会抛 `ModuleNotFoundError`（最先撞到的是 `numpy`）。装完不需要重启 agent：
每次 `skill run` 都是新进程，`$AGENT_SKILLS_DEPS` 已在 `PYTHONPATH` 里。
