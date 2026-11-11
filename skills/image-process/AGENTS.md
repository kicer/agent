# image-process

`ModuleNotFoundError: No module named 'PIL'`：把依赖装进 `$AGENT_SKILLS_DEPS`

```sh
python3 -m pip install --target "$AGENT_SKILLS_DEPS" -r "$(dirname "$AGENT_SKILLS_DEPS")/image-process/requirements.txt"
```

`中文水印缺少字体`：传 `font` 参数，指向本机任意中文字体文件（ttf/ttc）

```json
{"action":"watermark","input":"a.jpg","text":"机密","font":"<本机中文字体路径>"}
```

找字体：Linux `fc-list :lang=zh`；macOS `ls /System/Library/Fonts`；Windows `C:\Windows\Fonts\msyh*`。

网络慢或装不上（pip / GitHub 等）：见技能根目录的 `AGENTS.md`。
