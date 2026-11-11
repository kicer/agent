# image-process：本机环境

```sh
SK="$(dirname "$AGENT_SKILLS_DEPS")/image-process"
```

## Pillow

```sh
python3 -m pip install --target "$AGENT_SKILLS_DEPS" -r "$SK/requirements.txt"
python3 -c "import PIL"
```

## 中文水印缺字体

技能不内置字体，也不跨平台查找。报「中文水印缺少字体」时传 `font` 参数：

- macOS：`/System/Library/Fonts/Hiragino Sans GB.ttc`（简体）、`/System/Library/Fonts/PingFang.ttc`
- Linux：`/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc`
- Windows：`C:\Windows\Fonts\msyh.ttc`

```json
{"action":"watermark","input":"a.jpg","text":"机密","font":"/System/Library/Fonts/Hiragino Sans GB.ttc"}
```

英文/数字水印不需要字体；其余动作只依赖 Pillow。
