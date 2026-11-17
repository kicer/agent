# MCP Video Task

对接**任意 OpenAI 兼容的视频生成端点**：提交走 `POST {base}/videos/generations`，查询走
`GET {base}/videos/{task_id}`。对外只有一个工具 `video_task`，用 `op` 区分动作：

- `op=create` 提交任务，立刻回 `task_id`
- `op=get` 按 `task_id` 单次查询，**Server 不内部轮询**

- 协议：MCP **Streamable HTTP**（单端点 `/mcp`）
- 端口：容器内 `3000`（`/mcp` + `/health`）
- 鉴权：**服务端不存密钥**，每个请求从 header 读
- 上游：**不预设任何厂商**，Base-Url / 模型 / 凭据全部由调用方带入

---

## 快速开始

### 启动（docker-compose）

仓库根目录 `docker-compose.yml` 已包含本服务：

```bash
cd /root/workspace/tools/agent
docker compose up -d --build mcp_video_task
```

容器名 `mcp_video_task`，不占宿主机端口，由 agent 走 `agent-mcp-net` 按容器名访问。

```bash
# 容器内健康检查
docker exec mcp_video_task node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
# {"status":"ok","service":"video_task","sessions":0}
```

### MCP 客户端配置

```jsonc
{
  "mcpServers": {
    "video_task": {
      "type": "http",
      "url": "http://mcp_video_task:3000/mcp",
      "headers": {
        "Authorization": "Bearer <上游 API Key>",
        "X-Video-Task-Base-Url": "https://<host>/v1",
        "X-Video-Task-Model": "<上游模型 id>"
      }
    }
  }
}
```

---

## 三个 header

| header | 必填 | 说明 |
|---|---|---|
| `Authorization` | 是 | `Bearer <token>`，原样转给上游 |
| `X-Video-Task-Base-Url` | 是 | 完整 http(s) 地址，填到 `/v1` 即可；直接填到 `/videos/generations` 或 `/videos` 也会被剥回 base |
| `X-Video-Task-Model` | 是 | 上游模型 id，原样透传；不猜缺省值 |

配置缺失或非法时，工具直接回 `isError` 并说明缺哪个 header，不会去打上游。

---

## 工具：video_task

### 参数（AI 可见）

| 参数 | 类型 | 说明 |
|---|---|---|
| `op` | `create` \| `get` | 必填 |
| `prompt` | string | 视频描述，`create` 时与 `image_url` 至少给一个 |
| `image_url` | string | 参考图（图生视频），公开可访问的 png/jpeg URL |
| `seconds` | int | 时长（秒），留空用上游默认 |
| `aspect_ratio` | string | 画幅，如 `16:9` / `9:16` / `1:1` |
| `resolution` | string | 分辨率，如 `768P` / `1080P` |
| `negative_prompt` | string | 不希望出现的画面 |
| `enable_audio` | bool | 是否生成音频，默认 false（旧名 `with_audio` 同样接受） |
| `task_id` | string | `create` 返回的 id，`get` 时必填 |

### 返回（op=create）

```
task_id: <id>
model: <上游模型 id>
status: queued

Video generation is asynchronous. Call this tool again with op="get" and task_id="<id>" to fetch the result.
```

### 返回（op=get）

任务完成：

```
task_id: <id>
model: <上游模型 id>
status: completed
Video URL: https://...
credit: 62.29
note: <上游附带的提示，如直链有效期>
```

未完成 / 失败：回 `status` 与 `progress`，失败时附上游 `error` 原文，并置 `isError=true`。

---

## 上游要求

只要满足这两条，任何实现都能接（自建网关、云厂商、本地服务）：

1. `POST {base}/videos/generations` 返回 `task_id` 或 `id`
2. `GET {base}/videos/{task_id}` 返回 `status`；完成时带 `videos[].url` 或 `data[].url`

`status` 按小写比较：`completed` / `succeeded` / `success` 视为完成，`failed` / `error` /
`cancelled` 视为失败，其余按进行中处理。

---

## 本地文件 → 公网 URL（本服务不搬字节）

图生视频要的是**公网可访问的 URL**，不是字节流。本地文件这样走：

```
AI ──调用 agent 内置的「公开临时 URL」工具（直接传文件路径）──► 拿到一条短命公网 URL
      │
      ▼
AI 把 URL 当 image_url 交给 video_task:3000/mcp（转成上游的 image 字段）
      │
      ▼
上游 ──匿名 GET──►  agent 侧提供的公开临时 URL（文件始终躺在任务目录里，零拷贝）
```

链接短命：到期或 agent 重启后失效；上游只在提交任务那一刻拉一次图，够用。

---

## 用 curl 手工调试

```bash
URL=http://127.0.0.1:3000/mcp        # 容器内；宿主机调试需自行映射端口
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream'
   -H 'Authorization: Bearer <token>'
   -H 'X-Video-Task-Base-Url: https://<host>/v1'
   -H 'X-Video-Task-Model: <model>')

# 1. initialize，从响应头取 mcp-session-id
curl -s -D - "${H[@]}" -X POST $URL \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}'

# 2. 提交任务
curl -s "${H[@]}" -H 'mcp-session-id: <sid>' -X POST $URL \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"video_task","arguments":{"op":"create","prompt":"一只猫在草地上跑"}}}'

# 3. 查结果
curl -s "${H[@]}" -H 'mcp-session-id: <sid>' -X POST $URL \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"video_task","arguments":{"op":"get","task_id":"<id>"}}}'
```

响应是 SSE（`event: message` + `data: {...}`），取 `data:` 那行解析。

---

## 架构与文件

```
mcp/video_task/
├── Dockerfile
├── package.json
├── README.md
└── src/mcp-server.js     # 全部逻辑：header 解析 / 上游调用 / MCP 服务
```

### 关键设计

- **无状态**：不存密钥、不存任务，重启即忘。任务状态由上游持有，`task_id` 就是全部上下文。
- **不轮询**：`op=get` 只拉一次。轮询节奏由 AI 决定，避免服务端挂着长任务占资源。
- **配置错误不打上游**：缺 header 时同步返回 `isError`，省一次无意义的 400。
- **`wait=false` 提交**：立刻拿 `task_id`，不让工具调用被上游排队拖死。
