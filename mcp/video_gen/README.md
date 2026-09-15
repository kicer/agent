# MCP Video Gen

基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的视频生成服务，对接智谱 BigModel 的视频生成**异步**接口，支持**文生视频**和**图生视频**。Server 只负责提交任务 + 单次查询结果，**不内部轮询**——AI 拿到 `task_id` 后自己决定什么时候调用 `query_video` 复查。

- 协议：MCP **Streamable HTTP**（单端点 `/mcp`，支持 SSE 流）
- 上游：[智谱 BigModel 视频生成(异步)](https://docs.bigmodel.cn/api-reference/模型-api/视频生成异步) + [查询异步结果](https://docs.bigmodel.cn/api-reference/模型-api/查询异步结果)
- 默认模型：`cogvideox-flash`
- 端口：容器内 `3000`（MCP `/mcp` + `/health`，**容器外不映射**，只在 `agent-mcp-net` 内被 agent 访问）
- 鉴权：**无服务端密钥**，每次请求必须从 header 携带智谱 token
- 本地文件需要公网 URL 时：不传字节，让 AI 去 agent 的内网签发入口现签一条短命链接（见下节）

---

## 快速开始

### 启动（docker-compose）

仓库根目录 `docker-compose.yml` 已包含本服务：

```bash
cd /root/workspace/tools/mcp
docker compose up -d --build mcp_video_gen
```

服务容器名 `mcp_video_gen`，**默认不占宿主机端口**：由 agent 走 `agent-mcp-net` 按容器名访问
（`http://mcp_video_gen:3000/mcp`）。需要从宿主机 curl 调试时，去仓库根 `docker-compose.yml`
把 `mcp_video_gen` 注释掉的 `ports` 两行打开（映的是 MCP 端口 3000，仅本机短时调试用）。

```bash
# 容器内健康检查（无需占端口）
docker exec mcp_video_gen node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
# {"status":"ok","service":"video_gen","sessions":0}
```

> 下文 curl 示例里的 `localhost:8083` 均指“临时打开了调试端口”的情形。

### MCP 客户端配置

#### Claude Desktop / Cursor 等支持 `headers` 配置的客户端

```jsonc
// Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json
// Cursor:       ~/.cursor/mcp.json
{
  "mcpServers": {
    "video_gen": {
      "url": "http://localhost:8083/mcp",
      "headers": {
        "Authorization": "Bearer <your-zhipu-api-key>"
      }
    }
  }
}
```

> 上面 `url` 里的端口 `8083` 需要先把 compose 里注释的 `ports` 打开（默认不占宿主端口）。

> **重要**：客户端必须在 **每一个 HTTP 请求**（`initialize` / `notifications/initialized` / `tools/call`）都带上 `Authorization` header。

---

## 工具一览

| 工具 | 作用 | 同步/异步 |
|---|---|---|
| `video_gen` | 提交一个视频生成任务，立刻返回 `task_id` | 同步（仅提交） |
| `query_video` | 用 `task_id` 拉一次当前结果 | 同步（单次查询，不轮询） |

---


## 本地文件 → 公网 URL（本服务不搬字节）

`image_url` 必须是一个**公网可达**的 URL（智谱服务器会自己去拉）。图片在本地盘上时，本服务不负责上传，
而是让 AI 去 agent 那边现签一条短命的公网链接（实现见 agent 仓库 `app/server/routes/public-link.js`）：

```bash
# AI 在 agent 的 executor 沙箱里执行；路径就是它平时看到的那个绝对路径
curl -s "http://agent-core:8081/public-link?path=/workspace/tasks/<会话>/foo.png"
# stdout 就是现成 URL（纯文本，不需要解析 JSON）：
# http://124.221.199.237:8090/p/9fQ2mZ7xK4tR1vBn
```

- 那条链接是不透明短 ID：22 字符随机、纯 ASCII、不带文件名/会话名/签名，约 50 字符
  （签完由 agent 的 `public_files` 内存表记住“哪个文件 + 何时过期”）。刻意做短是因为它会被模型
  抄进 `image_url` 参数、并永久留在会话历史里每轮重发。
- 不可猜、会过期（默认 30 分钟）、agent 重启即全失效。
- `8081` 是 agent 侧的**内网**签发端口（`PUBLIC_LINK_PORT`），**不映射到宿主机**，所以接它不需要任何凭据；
  地址由 env `PUBLIC_LINK_URL` 告诉本服务（compose 已默认指向 `http://agent-core:8081/public-link`）。
- `PUBLIC_LINK_URL` 没配时，工具描述里不会出现这条命令，而是提示“请运维配置”。

---

## 工具：video_gen

提交一个视频生成任务，支持**文生视频**和**图生视频**。`prompt` 为**必填**；图生视频另传 `image_url`（两者都传也行，此时 prompt 会附加为运动/动作描述）。

### 参数（AI 可见）

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string | ✅ | 视频文本描述，最大 512 字符 |
| `image_url` | string (URL) | ❌ | 参考图 URL（**单张**，不支持数组 / 多张 / 首尾帧）。图片 ≤ 5MB，格式 png/jpeg/jpg。本地文件请先用上一节的命令换一条公网链接 |
| `size` | string | ❌ | 视频尺寸，例如 `1920x1080`、`1080x1920`、`1024x1024`、`1280x960` 等 |
| `with_audio` | boolean | ❌ | 是否生成 AI 音效，默认 `false` |

### 服务端 Header 覆盖项（AI 看不到）

| Header | 类型 | 默认 | 说明 |
|---|---|---|---|
| `X-Video-Gen-Model` / `X-Mcp-Model` / `X-Model` | string | `cogvideox-flash` | 覆盖模型 |
| `X-Video-Gen-Quality` | string | `speed` | `speed`（速度优先）或 `quality`（质量优先） |
| `X-Video-Gen-Fps` | int | `30` | `30` 或 `60` |
| `X-Video-Gen-Watermark` | bool | `true` | 是否添加 AI 水印；关闭需先在智谱后台签署免责声明 |

模型名串识别顺序（首个非空值生效）：`X-Video-Gen-Model` → `X-Mcp-Model` → `X-Model` → 默认。

### 返回

工具立刻返回智谱提交结果：

```jsonc
{
  "content": [
    { "type": "text", "text": "Model: cogvideox-flash\ntask_id: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\nrequest_id: yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy\ntask_status: PROCESSING\n\nVideo generation is asynchronous. Call query_video with task_id=\"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\" to fetch the result." }
  ]
}
```

`task_status` 通常为 `PROCESSING`，极少数情况下可能直接 `SUCCESS`（极快完成的短任务）。

---

## 工具：query_video

根据 `task_id` 拉一次智谱异步结果。**不内部轮询**——AI 自己决定调几次、调多频。

### 参数（AI 可见）

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `task_id` | string | ✅ | `video_gen` 返回的 `id` |

### 返回

- **`SUCCESS`**：返回 `Video URL`（智谱签名 URL，**24h 左右有效**，需及时转存），外加一张 `Cover` 封面图：
  ```jsonc
  {
    "content": [
      { "type": "text", "text": "task_id: ...\nmodel: cogvideox-flash\ntask_status: SUCCESS\nVideo URL: https://...\nCover: https://..." },
      { "type": "text", "text": "https://...video url..." }
    ]
  }
  ```
- **`PROCESSING`**：`isError: false`，正文给出当前状态，建议稍候再查。
- **`FAIL`**：`isError: true`，正文含 `task_status` 和智谱返回的 `error` 详情。

---

## 鉴权细节

每个 HTTP 请求必须携带智谱 API Token，server 从以下 header 字段按顺序识别，**首个非空值生效**：

| 优先级 | Header | 说明 |
|---|---|---|
| 1 | `X-Video-Gen-Token: <token>` | 直传，避免与客户端自身的 Authorization 冲突 |
| 2 | `X-Mcp-Token: <token>` | 通用兜底 |
| 3 | `Authorization: Bearer <token>` | 标准 OAuth 风格（排最后是为避免误用） |

Token 仅在每次 tool call 时从 header 读取，不写入任何存储、不进 session。

### 错误响应

| 场景 | HTTP 状态 | 表现 |
|---|---|---|
| initialize 时缺 token | `401` | JSON-RPC `error.message` 提示补充 header |
| 智谱 API 4xx/5xx | `200`（MCP 工具返回） | `isError: true`，正文含智谱返回的状态码和 body |
| 网络失败 | `200`（MCP 工具返回） | `isError: true`，正文含 `fetch` 错误信息 |

---

## 推荐用法（AI 视角）

```
1. 如果手头是【本地文件】：先 `curl -s "http://agent-core:8081/public-link?path=<绝对路径>"` 拿到一条公网链接（上一节），再进第 2 步
2. 调用 video_gen({ prompt, image_url?, size?, with_audio? })
3. 拿到 task_id → 等待若干秒（建议 2~5 秒）
4. 调用 query_video({ task_id })
   - 若 PROCESSING → 等一会再调
   - 若 SUCCESS → 拿到 video URL，贴给用户 / 下载 / 二次编辑
   - 若 FAIL → 展示错误信息，结束
```

> `video_gen` 的 tool description 里已经嵌入了完整 curl 上传命令，AI 一看就知道怎么传本地图片。

---

## 用 curl 手工调试

MCP Streamable HTTP 不是普通 REST，**必须按顺序**：`initialize` → `notifications/initialized` → `tools/call`。下面用一行版串起来：

```bash
# 把 <your-zhipu-api-key> 替换成你智谱的 API Key
TOKEN="<your-zhipu-api-key>"

# 1. initialize 拿 sessionId
SESSION=$(curl -s -D - -X POST http://localhost:8083/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "1.0" }
    }
  }' | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r\n')

echo "Session: $SESSION"

# 2. notifications/initialized
curl -s -X POST http://localhost:8083/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc": "2.0", "method": "notifications/initialized"}'

# 3. 列出工具（可选验证）
curl -s -X POST http://localhost:8083/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}'

# 4. 提交文生视频任务
curl -s -X POST http://localhost:8083/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "video_gen",
      "arguments": {
        "prompt": "A cat is playing with a ball.",
        "size": "1920x1080",
        "with_audio": true
      }
    }
  }'

# 5. 查结果（替换下面的 <task_id>）
curl -s -X POST http://localhost:8083/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "query_video",
      "arguments": { "task_id": "<task_id>" }
    }
  }'
```

响应是 SSE 格式（`event: message` + `data: {...}`），用 `grep '^data:'` 抽 JSON 即可。

## 架构与文件

```
video_gen/
├── Dockerfile          # node:22-slim，安装依赖后启动 MCP HTTP server
├── .dockerignore       # 排除 node_modules
package.json        # @modelcontextprotocol/sdk + express + multer
├── README.md           # 本文件
└── src/
    └── mcp-server.js   # 单文件实现：HTTP server + MCP transport + 双工具
```

### 关键设计

- **每 session 一个 transport + server**：通过 `Mcp-Session-Id` 复用，避免每请求重建
- **Token 闭包注入**：在 Express 入口处从 header 提取 token，闭包传给 tool 回调；不依赖 SDK 内部字段
- **AI 可见 vs AI 不可见**：
  - AI 只看到 `prompt / image_url / size / with_audio`
    - `model / quality / fps / watermark_enabled` 全部由 HTTP header 注入，避免 AI 误传或被诱导调高价档
- **异步语义暴露给 AI**：服务端不做轮询，`video_gen` 只提交、`query_video` 只查一次。AI 自主决定节奏
- **服务端自动 `request_id`**：每次提交服务端生成一个 UUID 作为智谱 `request_id`，便于日志关联，但不暴露给 AI
- **不搬字节**：本地文件 -> 公网 URL 完全由 agent 侧完成（`GET /public-link` 现签一个 22 字符随机短 ID），本服务只把命令拼进工具描述；所以能给本体不加任何写入口、不落盘、不需要额外端口
- **链接短命且极短**：默认 30 分钟过期、agent 重启即全失效；`PUBLIC_LINK_URL` 未配时工具描述退化为“请运维配置”

### 默认模型

```js
// src/mcp-server.js
const DEFAULT_MODEL = "cogvideox-flash";
```

修改后 `docker compose up -d --build mcp_video_gen` 即可生效。

---

## 常见问题

**Q: AI 拿到 task_id 后立刻调 query_video 一直 PROCESSING，怎么办？**
A: AI 自己 sleep 几秒再调（建议 2~5 秒间隔）。这是设计取舍：把节奏控制权交给 AI 模型，而不是服务端硬编码超时。

**Q: 视频 URL 多久过期？**
A: 智谱签发 URL 默认 24h 左右。需要在收到后及时转存到自己的 OSS/S3。

**Q: 为什么 quality / fps 不让 AI 直接传？**
A: 这些是技术档位，与成本/单价挂钩。让 AI 自主挑 `quality=quality + fps=60` 会爆账号预算。改成 header 由部署方注入更可控。

**Q: 能否限制 `size` 白名单？**
A: 当前透传给智谱 API，不做强制校验。如需加白名单，修改 `src/mcp-server.js` 中 `video_gen` 的 `size` schema 即可。

**Q: 报错 `Missing valid Mcp-Session-Id`？**
A: 漏发了 `Mcp-Session-Id` header，或调 `tools/call` 前没先 `initialize`。

**Q: 同一 task_id 能并发查吗？**
A: 可以。`/async-result/{id}` 是幂等的读接口，并发无副作用。

**Q: 换模型需要重连 MCP session 吗？**
A: 不需要。Model header 在每次 `tools/call` 都从当前请求读取。

**Q: 上传的图片多久过期？**
A: 本服务不存图，不存在“上传的图片”：要用的图在 agent 的任务目录里，AI 现签一个短 ID 给智谱拉。链接按 agent 的 `public_link.ttl_ms`（默认 30 分钟）过期，过期或 agent 重启后该 URL 变 404。

**Q: `PUBLIC_LINK_URL` 不配会怎样？**
A: 工具描述里不会出现“怎么把本地文件变成公网 URL”的命令，而是提示让运维配置，AI 就只能用已经是公网 URL 的图片（比如 image_gen 刚生成的图）。配的时候注意：它指向的是 agent 侧的**内网**签发端口（`http://agent-core:8081/public-link`），不是 agent 对外的 8090。