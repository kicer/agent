# office：本机环境

服务器由镜像与 `agent-executor-init` 准备（跑同目录 `install.sh`）。本机不要跑它，按下面装，装完不需要重启。

```sh
SK="$(dirname "$AGENT_SKILLS_DEPS")/office"
```

## 缺二进制（报 `office.core binary missing`）

```sh
mkdir -p "$SK/bin"
curl -fL --progress-bar -o "$SK/bin/officecli" \
  https://github.com/iOfficeAI/OfficeCLI/releases/latest/download/officecli-mac-x64
chmod +x "$SK/bin/officecli" && "$SK/bin/officecli" --version
```

资产名：mac Intel `officecli-mac-x64`、Apple Silicon `officecli-mac-arm64`、Linux `officecli-linux-x64` / `officecli-linux-arm64`。
GitHub 慢时加 `https://gh-proxy.com/` 前缀。用 `latest` 即可，不必对齐服务器的 pin。

## `office` 命令不在 PATH

本机启动器不注入 PATH。按次指定目录：

```sh
PATH="$SK/scripts:$PATH" office help
```
