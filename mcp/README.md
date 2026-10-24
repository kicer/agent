# MCP 服务集合

四个 MCP（Model Context Protocol）服务，各占一个目录，由仓库根 `docker-compose.yml` 统一编排：

| 目录 | 容器名 | 作用 | 容器内端口 | MCP 端点 |
|---|---|---|---|---|
| `web_search/` | `mcp_web_search` | 免费网页搜索（Parallel / Exa，无需 key） | `3000` | `POST /` |
| `image_task/` | `mcp_image_task` | 图片生成 / 编辑（智谱原生或任意 OpenAI 兼容 `/images/generations`，单工具 op=create/get） | `3000` | `POST /mcp` |
| `video_task/` | `mcp_video_task` | 智谱 CogVideo 视频生成（异步，单工具 op=create/get） | `3000` | `POST /mcp` |
| `asr/` | `mcp_asr` | 语音转文字（上游 OpenAI 兼容 `/audio/transcriptions`），**额外带一个给输入框用的 `POST /transcribe`** | `3000` | `POST /mcp` |

**这些服务一个宿主机端口都不占**——它们只挂在 `agent-mcp-net` 上，由 `agent-core` / `agent-executor`
按容器名访问。所以整台服务器对外只需要开 agent-core 那一个端口（`AGENT_PORT`，默认 8090）。
（要从宿主机 curl 调试时，把根 `docker-compose.yml` 里对应服务注释掉的 `ports` 两行打开。）

## 部署

它们和 `agent-core` / `agent-executor` / `wxbot` 同属一个 compose 项目，无需单独启动，也没有先后顺序：

```bash
cd /root/workspace/tools/agent
docker compose up -d --build
```

`config.yml` 里的地址与容器名一一对应：

```yaml
mcp_servers:
  - name: web_search
    url: "http://mcp_web_search:3000/"
  - name: image_task
    url: "http://mcp_image_task:3000/mcp"
  - name: video_task
    url: "http://mcp_video_task:3000/mcp"
  # 可选：语音转写（低频，建议 skill 模式，不占每轮工具表）
  - name: asr
    url: "http://mcp_asr:3000/mcp"
    headers:
      Authorization: Bearer <key>              # 免鉴权的自建服务可省
      X-ASR-Base-Url: "https://<host>/v1"
      X-ASR-Model: "whisper-1"
    mode: skill
```

服务没起来时，core 只在启动日志里告警，不影响 Web 主流程，但对应工具不会下发给模型。工具发现只在启动时做一次，失败后会自动按 2s / 20s / 1min 重试 3 次；三次都失败则需重启 core。四个服务都配了 `/health` 健康检查，`docker ps` 可直接看状态。

> 从旧的「agent + mcp 双仓库」部署升级：先在旧 mcp 仓库目录 `docker compose down`（只需一次，否则同名容器与网络会冲突），再 `up` 本栈。

`image_task` / `video_task` 的 token **不由服务端保存**——每个请求从 `Authorization` header 读取
（agent 侧配在 `config.yml` 的 `mcp_servers[].headers`）。`video_task` 用智谱 token；
`image_task` 用对应上游（智谱或 OpenAI 兼容网关）的 token，上游地址与模型分别由
`X-Image-Task-Base-Url` / `X-Image-Task-Model` 指定。所以这两个服务不用配任何密钥。

`asr` 同理：上游的 key / base_url / model 全部由调用方随请求 header 带入
（`Authorization` / `X-ASR-Base-Url` / `X-ASR-Model`，agent 侧配在 `config.yml` 的
`mcp_servers[name=asr].headers`）。输入框那条路（`agent-core` → `POST /transcribe`）不经过 MCP 调用，
但 core 同样会从那段 `headers` 取值转发过去，所以两边只有一处配置。容器自己不存任何平台密钥，
也不预设任何厂商——任何 OpenAI 兼容的 `/audio/transcriptions` 都能用。

### 调试端口

写在仓库顶层 `.env` 里即可（不写就用默认值；开了端口记得调试完注释回去）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEB_SEARCH_PORT` | `8081` | 只在临时打开 web_search 调试端口时用 |
| `IMAGE_TASK_PORT` | `8082` | 只在临时打开 image_task 调试端口时用 |
| `VIDEO_TASK_PORT` | `8083` | 只在临时打开 video_task 调试端口（MCP 口，仅本机短时调试）时用 |

## 图片是怎么到智谱手上的（只有 video_task 关心）

智谱服务器生成视频前要**自己来拉参考图**，它不带 cookie、不带 `Authorization`。这套链路里**没有任何人上传文件**：

```
AI ──调用 agent 内置的「公开临时 URL」工具（直接传文件路径）──► 拿到一条短命公网 URL
      │
      ▼
AI 把拿到的 URL 当 image_url 交给 video_task:3000/mcp
      │
      ▼
智谱  ──匿名 GET──►  agent 侧提供的公开临时 URL
                        那个文件始终躺在 agent 的任务目录里，零拷贝
```

- 签发与托管全在 agent 侧（它已集成为一个 tool，AI 直接调用即可，不需要 curl 任何内网入口）。
- 链接短命：到期或 agent 重启后失效；智谱只在提交任务那一刻拉一次图，完全够用。
- mcp 这三家一个端口都不露，唯一公网可达的东西只有 agent 自己。

## 端口与安全

| 服务 | 公网暴露 | 说明 |
|---|---|---|
| `mcp_web_search` | 无 | 服务端无鉴权，**永远不要映射出去**（会被白嫖搜索额度）；agent 走内网访问 |
| `mcp_image_task` | 无 | token 由调用方自带，暴露后可被拿去消耗你的上游图片额度 |
| `mcp_video_task` | 无 | 它需要的公开临时 URL 由 agent 侧集成的工具提供，自己不占端口 |
| `mcp_asr` | 无 | `/mcp` 与 `/transcribe` 都无鉴权，只能由 core 经内网调用；它不存密钥（上游参数随请求带入） |

## 单独调试

```bash
cd /root/workspace/tools/agent
docker compose up -d --build mcp_web_search
# 不占端口的健康检查
docker exec mcp_web_search node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
```

各目录下的 `README.md` 有该服务的工具说明、header 覆盖项与 curl 调试脚本。
