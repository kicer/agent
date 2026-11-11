# image-process

`ModuleNotFoundError: No module named 'PIL'`

```sh
python3 -m pip install --target "$AGENT_SKILLS_DEPS" -r "$(dirname "$AGENT_SKILLS_DEPS")/image-process/requirements.txt"
```

`中文水印缺少字体`：传 `font` 参数

```json
{"action":"watermark","input":"a.jpg","text":"机密","font":"/System/Library/Fonts/Hiragino Sans GB.ttc"}
```

字体：macOS `/System/Library/Fonts/Hiragino Sans GB.ttc`；Linux `/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc`；Windows `C:\Windows\Fonts\msyh.ttc`。
