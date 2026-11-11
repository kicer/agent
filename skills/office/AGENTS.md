# office

`office: command not found`

```sh
PATH="$(dirname "$AGENT_SKILLS_DEPS")/office/scripts:$PATH" office help
```

`office.core binary missing`

```sh
SK="$(dirname "$AGENT_SKILLS_DEPS")/office"
curl -fL --progress-bar -o "$SK/bin/officecli" \
  https://github.com/iOfficeAI/OfficeCLI/releases/latest/download/officecli-mac-x64
chmod +x "$SK/bin/officecli"
```

资产按 `uname -sm` 选：`officecli-mac-x64` / `officecli-mac-arm64` / `officecli-linux-x64` / `officecli-linux-arm64`。下载慢就在地址前加 `https://gh-proxy.com/`。
