# 本机安装依赖与字体（image-process 技能）

下文「技能目录」= `$(dirname "$AGENT_SKILLS_DEPS")/image-process`。

## Python 包：Pillow

```bash
python3 -m pip install --target "$AGENT_SKILLS_DEPS" \
  -r "$(dirname "$AGENT_SKILLS_DEPS")/image-process/requirements.txt"
python3 -c "import PIL"      # 验证
```

## 中文字体：只在 `watermark` 且文字含中文时需要

技能不内置字体，也不做跨平台查找，只认两条 Linux 路径（镜像里预装文泉驿）。
本机缺字体时报「中文水印缺少字体」，这时**传 `font` 参数**指向任意中文字体即可：

| 平台 | 常见字体路径 |
|---|---|
| macOS | `/System/Library/Fonts/Hiragino Sans GB.ttc`（简体，推荐）、`/System/Library/Fonts/PingFang.ttc` |
| Linux | `/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc` |
| Windows | `C:\Windows\Fonts\msyh.ttc` |

```json
{"action":"watermark","input":"a.jpg","text":"机密",
 "font":"/System/Library/Fonts/Hiragino Sans GB.ttc"}
```

英文/数字水印不需要字体（走 Pillow 内置默认字体）。其余动作（info / convert / resize / crop /
compress / slice / grid）只依赖 Pillow。
