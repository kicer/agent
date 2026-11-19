# agent-device：远端设备执行端

把一台机器（Linux 盒子、Windows、macOS）变成 agent 的一双“手”：**主动出站**连到 core 的
WebSocket 端点，接收 shell 命令、流式回传输出与退出码、上报主机指标。

设备不需要公网 IP、不需要开任何入站端口，NAT、公司网络、随身热点都能用。

> 这不是通用 agent，只是执行端。会话、模型、记忆都在服务端；这里只负责“在那台机器上跑东西”。

## 二进制里没有服务器地址

`-server` 与 token 都**没有默认值**，不显式给就启动失败。所以拿到的二进制不会连到别人的服务器上——
它只连你指定的那一台。

## 安装

### 自己编译

需要 Go 1.22+：

```sh
git clone <本仓库> && cd device
go build -trimpath -ldflags "-s -w" -o bin/agent-device ./cmd/agent
```

交叉编译（一次出五个平台）：

```sh
sh scripts/build.sh all
```

脚本只做构建：不联网、不推送、不依赖任何特定服务器。本机没有 Go 但装了 docker 时，
会自动用 `golang:1.23-alpine` 容器编译。

### 下载预编译

从本仓库的 Releases 页面取对应平台的文件（`agent-device-linux-arm64`、`agent-device-windows-amd64.exe` 等），
`chmod +x` 即可，静态链接、无运行时依赖，一个文件约 5.5 MB。

## 运行

```sh
# 推荐：二进制旁边放一个 config.json，直接启动（token 不出现在 ps 里）
./agent-device

# 或者全走命令行
./agent-device -server wss://your-host.example/dev/ws -token <TOKEN> -root /var/agent-work -name box-01

# 配置文件不在默认位置时显式指定
./agent-device -config /etc/agent-device.json
```

**默认会自动读可执行文件同目录的 `config.json`**（存在才读，不存在就当没配），所以部署时把二进制和配置放一个目录、直接跑就行：

```json
{
  "server": "wss://your-host.example/dev/ws",
  "token": "…",
  "root": "/var/agent-work",
  "name": "box-01"
}
```

优先级：**命令行显式参数 > 环境变量 `NODE_TOKEN`（仅 token）> 配置文件 > 默认值**。

### shell 用哪个

默认：macOS / Linux 用 `/bin/sh`（固定，不读 `$SHELL`——用户把默认 shell 设成 fish 时，
模型写的 POSIX 语法会全废）；Windows 用 `cmd`。

想换就在 `config.json` 里写 `shell`，**不做自动探测**：装了 Git Bash / busybox 就写路径，
没装就保持默认。

```json
{ "shell": "C:\\Program Files\\Git\\bin\\bash.exe" }
```

报给 core 的是短标签（`sh` / `bash` / `busybox` / `cmd` / `powershell`），同时带上解释器路径与版本。

| 参数 | 说明 |
|---|---|
| `-server` | core 的接入地址，`wss://…/dev/ws` |
| `-token` | Bearer token，须与服务端 `DEVICE_TOKEN` 一致 |
| `-root` | 工作根目录，命令的 `cwd` 必须落在它之内（默认 `~/agent-work`，会自动建） |
| `-name` | 设备名，服务端用它区分设备（默认 hostname） |
| `-shell` | `sh` / `cmd` / `powershell`，默认按平台 |
| `-config` | 配置文件路径，默认 `<二进制所在目录>/config.json` |
| `-insecure` | 跳过证书校验（自签证书调试用） |
| `-fix-clock` | 证书报错时用服务器 `Date` 头校准本机时间（小设备没有 RTC 时用，Linux 需 root） |

设备名重复时后接入的会顶掉前一个连接（换机、重装不留僵尸连接）。

## 协议

一条 WebSocket 上全是 JSON 文本帧，`t` 区分类型：

| 方向 | 消息 |
|---|---|
| 设备 → core | `{t:"hello", ver, name, os, arch, shell, shell_path, shell_ver, root}` |
| core → 设备 | `{t:"exec", id, cmd, cwd, timeout_ms}` · `{t:"kill", id}` · `{t:"ping"}` · `{t:"health", id}` |
| 文件通道 | `{t:"file", id, op:"read"\|"write", path, size?, sha256?}` · `{t:"file.chunk", id, data:<base64>}` ×N · `{t:"file.done", id, size?, sha256?, err?}` |
| 设备 → core | `{t:"chunk", id, out:"out"\|"err", chunk:<base64>}` · `{t:"exit", id, code, killed_by, ms, truncated}` · `{t:"pong"}` · `{t:"health", …}` |

- 保活：core 每 20 秒发 `ping`，设备回 `pong`；90 秒无任何消息即断开重连。
- 断线：指数退避 1s → 2s → 4s → … 上限 30s，连上后重置。
- 超时：命令超过 `timeout_ms` 由设备侧杀**进程组**，回 `killed_by:"timeout"`。
- 输出：单流超过上限截断并置 `truncated`。
- `shell` 报的是实际解释器（`/bin/sh` 可能是 dash / bash / busybox），连同版本，供模型决定命令语法。

## 文件通道

core 通过同一条连接搬文件，**设备不需要任何额外端口**：

| 方向 | 流程 |
|---|---|
| 拉取（设备 → 会话目录） | `file{op:read}` → 设备分块回 `file.chunk` → `file.done{size,sha256}` |
| 推送（会话目录 → 设备） | `file{op:write,size,sha256}` → 分块 `file.chunk` → `file.done` |

- 每块 256 KiB（base64 后约 341 KiB），单文件上限 2 GiB；
- 超时按**空闲**算：首块 30s，之后每收到一块重置 30s——链路慢但不卡就不会被误杀；
- 写盘先落 `<path>.part`，`size` 与 `sha256` 都对上才 `rename`；
- 设备侧路径必须在工作根内（与 `exec` 的 cwd 校验同一套）。

## 安全边界

- 设备主动出站，服务端不需要知道设备 IP；
- token 走 `Authorization: Bearer`，与业务 token 分开；
- `cwd` 只约束**起始目录**，命令内部仍可 `cd` 到别处——给了 shell 就是这个语义，需要强隔离请用容器/namespaces；
- 同一个 token 可被多台设备共用（当前设计），吊销需换 token 并重启所有设备。

## 实测

| 用例 | 结果 |
|---|---|
| exec 基本 | cwd 自动创建，stdout/stderr 分流，退出码透传 |
| 超时 | 杀进程组，`killed_by=timeout` |
| 起始 cwd 越界 | 拒绝 |
| 断线重连 | 1s→2s→4s 退避，恢复后自动注册 |

在 Linux / macOS / Windows 三平台编译验证（amd64 + arm64）。
