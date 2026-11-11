# office

`office: command not found`：用技能自带入口

```sh
PATH="$(dirname "$AGENT_SKILLS_DEPS")/office/scripts:$PATH" office help
```

`office.core binary missing`：按本机平台下载对应资产到 `bin/officecli`（Windows 存成 `bin/officecli.exe`），再 `chmod +x`

```sh
SK="$(dirname "$AGENT_SKILLS_DEPS")/office"
curl -fL -o "$SK/bin/officecli" \
  https://github.com/iOfficeAI/OfficeCLI/releases/latest/download/officecli-<平台>-<架构>
chmod +x "$SK/bin/officecli"
```

资产名是 `{mac,linux,win}-{x64,arm64}`，如 `officecli-mac-arm64`、`officecli-linux-x64`、`officecli-win-x64.exe`；
musl 系统（Alpine）用 `officecli-linux-alpine-{x64,arm64}`。`uname -sm` 可判断平台与架构。
