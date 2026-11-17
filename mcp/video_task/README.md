# MCP Video Task

对接 **WorkBuddy 网关**（`wb.ai`）的 OpenAI 兼容视频接口。只有一个工具 `video_task`，用 `op` 区分提交与查询。
Server **不内部轮询**——AI 拿到 `task_id` 后自己决定什么时候复查。

- 协议：MCP **Streamable HTTP**（单端点 `/mcp`，支持 SSE 流）
- 上游：`POST /v1/videos/generations`（提交，`wait=false` 立刻回 `task_id`）、`GET /v1/videos/{task_id}`（查询）
- 默认模型：`cn:minimax-video-h3`；可选 `cn:kling-video-v3`、`global:kling-video-v3`
- 端口：容器内 `3000`（MCP `/mcp` + `/health`，容器外不映射，只在 `agent-mcp-net` 内被 agent 访问）
- 鉴权：**无服务端密钥**，每次请求必须从 header 携带网关 API Key

---

## 快速开始

### 启动（docker-compose）

仓库根目录 `docker-compose.yml` 已包含本服务：

```bash
docker compose up -d --build mcp_video_task
```

```bash
# 容器内健康检查（无需占端口）
docker exec mcp_video_task node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
# {"status":"ok","service":"video_task","upstream":"https://wb.ai.foresh.com","sessions":0}
```

### MCP 客户端配置

```yaml
mcp_servers:
  - name: video_task
    url: "http://mcp_video_task:3000/mcp"
    mode: skill
    headers:
      Authorization: Bearer <wb.ai 的 API Key>
      X-Video-Task-Model: cn:minimax-video-h3   # 可选，覆盖默认模型
```

---

## 工具：`video_task`

### 参数（AI 可见）

| 参数 | 类型 | 说明 |
|---|---|---|
| `op` | `create` \| `get` | 提交 / 查询，必填 |
| `prompt` | string ≤ 2000 | `create` 必填。图生视频时描述画面如何运动 |
| `image_url` | url | 图生视频的参考图，公网可访问的 png/jpeg/jpg |
| `seconds` | 4–15 | 时长，默认 4。越长越慢越贵 |
| `aspect_ratio` | string | `16:9` / `9:16` / `1:1`。上游不严格校验 |
| `resolution` | string | `768P` / `1080P`，留空用上游默认 |
| `negative_prompt` | string | 不希望出现的画面 |
| `enable_audio` | boolean | 是否生成音频，默认 false（别名 `with_audio`） |
| `task_id` | string | `get` 必填，`create` 返回 |

### 返回（`op=create`）

```
task_id: 1312831544-minimax_video_h3-5c12…
model: cn:minimax-video-h3
status: queued
提示：生成是异步的，用 op="get" + task_id 查结果。
```

### 返回（`op=get`）

```
task_id: …
model: cn:minimax-video-h3
status: completed
Video URL: https://…mp4?q-signature=…
credit: 62.29

注意：视频是签名直链，约 12 小时失效；要长期保存请立刻下载到本地。
```

`status` 归一化为 `queued` / `in_progress` / `completed` / `failed`。
`failed` 时返回 `isError: true` 并把上游原话带出来。

---

## 模型与计费（2026-11-17 实测）

| 模型 | 请求 | 实际扣费 | 出片耗时 | 分辨率 |
|---|---|---|---|---|
| `cn:minimax-video-h3` | 4s / 16:9 | **62.29** | **128 秒** | 768P |
| `cn:kling-video-v3` | 4s（实际出 5s） | 102.86 | ≈473 秒 | — |

- 扣费发生在**出片那一刻**，提交不扣；重复查询不重复计费
- 上游 `usage` 只回一次，之后重复查询不带 `credit` 属正常
- `kling` 慢一个量级，客户端超时要给到 15 分钟以上

## 本地文件 → 公网 URL

本服务不搬字节：图生视频要的是**公网可访问的 URL**。本地文件先由 agent 内置的
「公开临时 URL」工具（`mint_public_link`）换一个短命链接，再把该链接作为 `image_url` 传进来。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WB_BASE_URL` | `https://wb.ai.foresh.com` | 网关地址，末尾斜杠自动去掉 |

## curl 调试

```bash
# 1. initialize 拿 session id
curl -s -D - -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $WB_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}'
# 响应头里的 mcp-session-id 后续要带上

# 2. 提交
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" -H "Authorization: Bearer $WB_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"video_task","arguments":{"op":"create","prompt":"一只橘猫在草地上奔跑","seconds":4}}}'

# 3. 查结果
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" -H "Authorization: Bearer $WB_KEY" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"video_task","arguments":{"op":"get","task_id":"<task_id>"}}}'
```

响应是 SSE 帧（`event: message` + `data: {...}`），解析时取 `data:` 那一行。

---

## 架构与文件

| 文件 | 作用 |
|---|---|
| `src/mcp-server.js` | 全部逻辑：Express + MCP SDK，`buildServer()` 注册工具，`startHttp()` 起 Streamable HTTP |
| `Dockerfile` | node:22-alpine，`node src/mcp-server.js --http --port 3000` |
| `package.json` | `@modelcontextprotocol/sdk` + `express` + `zod` |

### 关键设计

- **服务端不轮询**：`create` 提交完立刻返回，`get` 只拉一次，由 AI 控制节奏
- **状态归一化**：上游 `queued` / `in_progress` / `completed` / `failed` 统一成小写，AI 不用猜
- **错误透传**：上游 4xx/5xx 的原话进 `content[0].text`，模型能读到「模型不存在」这类可行动信息
- **鉴权随请求走**：服务端不落任何密钥，多实例共用一份镜像也不串号
