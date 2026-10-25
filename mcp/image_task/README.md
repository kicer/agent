# MCP Image Task

一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的图片生成 / 编辑服务。
对外只有一个工具 `image_task`，用 `op` 区分动作（`create` / `get`），异步任务契约与 `video_task` 一致。

上游必须是 OpenAI 兼容的 `/images/generations` 端点（智谱 `https://open.bigmodel.cn/api/paas/v4`
与各类网关走同一套协议）。`X-Image-Task-Base-Url` / `X-Image-Task-Model` / `Authorization`
三个 header 都必填，服务不存密钥、也不预设厂商或默认模型。

- 协议：MCP **Streamable HTTP**（单端点 `/mcp`，支持 SSE 流）
- 端口：容器内 `3000`（**不映射宿主机**，只在 `agent-mcp-net` 内被 agent 访问）
- 鉴权：**无服务端密钥**，每次请求从 `Authorization` header 读取上游 key

---

## 快速开始

### 启动（docker-compose）

```bash
cd /root/workspace/tools/agent
docker compose up -d --build mcp_image_task
```

服务容器名 `mcp_image_task`，**默认不占宿主机端口**，由 agent 走 `agent-mcp-net` 按容器名访问。
要从宿主机 curl 调试，自行给该服务加 `ports` 映射。

```bash
# 不占端口的健康检查
docker exec mcp_image_task node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
# {"status":"ok","service":"image_task","sessions":0,"tasks":0}
```

### MCP 客户端配置

```jsonc
{
  "mcpServers": {
    "image_task": {
      "url": "http://localhost:8082/mcp",
      "headers": {
        "Authorization": "Bearer <upstream-api-key>",
        "X-Image-Task-Base-Url": "https://open.bigmodel.cn/api/paas/v4",
        "X-Image-Task-Model": "CogView-4"
      }
    }
  }
}
```

> 客户端必须在**每一个 HTTP 请求**（`initialize` / `notifications/initialized` / `tools/call`）都带上
> `Authorization`。`X-Image-Task-Base-Url` / `X-Image-Task-Model` 在 `tools/call` 时读取。

---

## 工具：image_task

典型流程：`op=create` 拿 `task_id`，然后不断 `op=get` 直到 `task_status` 为 `SUCCESS` 或 `FAIL`。

| op | 作用 | 说明 |
|---|---|---|
| `create` | 提交图片生成 / 编辑任务，**立即**返回 `task_id`，生成在后台执行 | 需要 `prompt` |
| `get` | 查询任务状态；`SUCCESS` 时返回图片 URL | 需要 `task_id` |

> 上游是同步阻塞的；这里的异步是对外统一形态（对齐 `video_task`），服务内部把同步调用丢到后台跑并回写任务表。

### 参数（AI 可见）

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | `"create"` \| `"get"` | ✅ | 要执行的操作 |
| `prompt` | string | op=create 时 ✅ | 提示词；文生图描述画面，图生图描述要改成什么样 |
| `task_id` | string | op=get 时 ✅ | `op=create` 返回的任务 ID |
| `image` | string | ❌ | 一张图的公网 `http(s)` URL，用于图生图 / 修图 |

`image` 是模式开关：

- 不传 → **文生图**；
- 传一个公网 URL → **图生图 / 编辑**。

本地图片先用 `mint_public_link` 换成公网 URL，再传给 `image`。

> 尺寸、质量、模型、上游地址都**不是**工具参数：它们属于部署策略，由调用方在 header 里固定，
> 避免 AI 乱填尺寸档位或模型名白烧额度。尺寸/质量直接走上游默认值。

### 返回

`op=create` 成功时立即返回 `task_id`（生成已转入后台）：

```jsonc
{
  "content": [
    { "type": "text", "text": "Model: CogView-4\nMode: text-to-image\ntask_id: <uuid>\ntask_status: PROCESSING\n\nImage generation is running in background. Call this tool again with op=\"get\" and task_id=\"<uuid>\" to fetch the result." }
  ]
}
```

`op=get` 按任务状态返回：

- `PROCESSING`：带上已等待秒数 `elapsed`，建议等待 `min(30, 3 + floor(elapsed / 5))` 秒后再查；
- `SUCCESS`：单个 `text` 块，摘要后跟图片 URL（单图直接给 `Image URL:`，多图按 `Image N:` 逐行列出）；`elapsed` 为从 `create` 到完成的总耗时：

```jsonc
{
  "content": [
    { "type": "text", "text": "task_id: <uuid>\nmodel: CogView-4\nelapsed: 12s\ntask_status: SUCCESS\nImage URL: https://..." }
  ]
}
```

- `FAIL`：`isError: true`，正文含 `task_status: FAIL`、总耗时 `elapsed` 与错误信息（上游 4xx/5xx、无 URL 返回等都会归档到这里）。

URL 由上游签名下发，**带有效期**（通常 24h），需要长期保存请及时转存。

---

## Headers（只有三个）

| Header | 必填 | 说明 |
|---|---|---|
| `Authorization` | ✅ | `Bearer <key>`，原样作为上游 Bearer token |
| `X-Image-Task-Base-Url` | ✅ | 上游 base URL（完整 `http(s)` 地址）；已给到 `/images/generations` 就直接用，否则自动补上 |
| `X-Image-Task-Model` | ✅ | 模型名原样透传 |

地址与模型只由 header 决定，AI 看不到也填不了；换模型 = 改 header 后重启 core。

### 图生图

传了 `image` 时，请求体带 `images: [url]`（数组形式）。是否支持由上游模型决定——不支持时
上游会回 4xx，`op=get` 里以 `task_status: FAIL` 呈现。

### 请求体

固定 `{ model, prompt, n: 1, response_format: "url" }`，传图时追加 `images: [url]`。
`size` / `quality` 一律不传，交给上游默认值。

---

## 配置示例

智谱与网关走同一套协议，只换地址与模型：

```yaml
  - name: image_task
    url: "http://mcp_image_task:3000/mcp"
    headers:
      Authorization: "Bearer <KEY>"
      X-Image-Task-Base-Url: "https://open.bigmodel.cn/api/paas/v4"
      X-Image-Task-Model: "CogView-4"
    mode: skill
```

```yaml
  - name: image_task
    url: "http://mcp_image_task:3000/mcp"
    headers:
      Authorization: "Bearer <网关 KEY>"
      X-Image-Task-Base-Url: "https://wb.ai.foresh.com/v1"
      X-Image-Task-Model: "global:gpt-image-2.5-sunburst"
    mode: skill
```

---

## 错误响应

| 场景 | HTTP 状态 | 表现 |
|---|---|---|
| 缺 `Authorization` | `200`（MCP 工具返回） | `isError: true`，提示补 header |
| 缺 `X-Image-Task-Base-Url` / 不是完整 http(s) URL | `200`（MCP 工具返回） | `isError: true`，提示填完整地址 |
| 缺 `X-Image-Task-Model` | `200`（MCP 工具返回） | `isError: true`，提示补 header |
| `image` 不是公网 http(s) URL | `200`（MCP 工具返回） | `isError: true`，提示只接受公网 URL，不接受文件上传 / base64 |
| `op=create` 缺 prompt / `op=get` 缺 task_id | `200`（MCP 工具返回） | `isError: true`，参数提示 |
| `op=get` 查不到任务 | `200`（MCP 工具返回） | `isError: true`，提示 unknown task_id |
| 上游 4xx/5xx | `200`（MCP 工具返回） | 在 `op=get` 中以 `task_status: FAIL` 呈现，正文含上游状态码和 body |
| 上游只回 `b64_json` | `200`（MCP 工具返回） | `task_status: FAIL`，提示本服务只接受 URL |
| 网络失败 / 超时（>180s） | `200`（MCP 工具返回） | `task_status: FAIL`，不会出现永久 PROCESSING 的僵尸任务 |

> JSON 请求体上限保持 2MB：`image` 只接受 URL，不接收文件或 base64。

---

## 用 curl 手工调试

MCP Streamable HTTP **必须按顺序**：`initialize` → `notifications/initialized` → `tools/call`。

```bash
TOKEN="<upstream-api-key>"

# 1. initialize 拿 sessionId
SESSION=$(curl -s -D - -X POST http://localhost:8082/mcp \
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
curl -s -X POST http://localhost:8082/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc": "2.0", "method": "notifications/initialized"}'

# 3. 文生图（三个 header 都必填）
curl -s -X POST http://localhost:8082/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Image-Task-Base-Url: https://open.bigmodel.cn/api/paas/v4" \
  -H "X-Image-Task-Model: CogView-4" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "image_task",
      "arguments": {
        "op": "create",
        "prompt": "一只可爱的小猫咪，坐在阳光明媚的窗台上，背景是蓝天白云"
      }
    }
  }'

# 4. 图生图
curl -s -X POST http://localhost:8082/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Image-Task-Base-Url: https://wb.ai.foresh.com/v1" \
  -H "X-Image-Task-Model: global:gpt-image-2.5-sunburst" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "image_task",
      "arguments": {
        "op": "create",
        "prompt": "把背景改成雪夜，其他保持不变",
        "image": "https://example.com/input.png"
      }
    }
  }'

# 5. 轮询结果
curl -s -X POST http://localhost:8082/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "image_task",
      "arguments": {
        "op": "get",
        "task_id": "<上一步返回的 task_id>"
      }
    }
  }'
```

响应是 SSE 格式（`event: message` + `data: {...}`），用 `grep '^data:'` 抽 JSON 即可。

---

## 架构与文件

```
image_task/
├── Dockerfile          # node:22-slim，安装依赖后启动 MCP HTTP server
├── .dockerignore       # 排除 node_modules
├── package.json        # @modelcontextprotocol/sdk + express + zod
├── README.md           # 本文件
└── src/
    └── mcp-server.js   # 单文件实现：HTTP server + MCP transport + 单工具（op 分发）
```

### 关键设计

- **单工具 + `op` 分发**：`image_task(op=create|get)`，与 `video_task` 的服务形态一致，agent 侧一套轮询逻辑通吃图片/视频
- **同步上游 → 异步契约**：上游同步阻塞，所以服务自维护一张任务表来模拟异步：
  - `create` 本地生成 `task_id`（`randomUUID`），登记 `PROCESSING`，把同步调用丢后台（fire-and-forget），立即返回
  - 后台完成时回写 `SUCCESS`（含 URLs）或 `FAIL`（含错误）；上游同步调用带 180s 超时（`AbortSignal.timeout`），超时记 `FAIL`，杜绝僵尸 `PROCESSING`
  - `get` 只读本地表，不碰上游
  - 表为进程内存 Map：已完成任务保留 1 小时（TTL）、容量上限 1000，每次 `create` 顺带淘汰；**容器重启后任务丢失**，`get` 会报 unknown task_id；**不适用于多副本部署**
  - token / 上游地址 / 模型在 `create` 那一刻从请求 header 捕获进闭包，后台完成前不再读取
- **每 session 一个 transport + server**：通过 `Mcp-Session-Id` 复用
- **模型 / 上游地址不入 schema**：只从 HTTP header 读取，AI 不可见
- **`image` 单一开关**：不传 = 文生图，传一个公网 URL = 图生图；`image` 是单个字符串，只接受公网 `http(s)` URL
- **URL 提取**：只接受 `data[].url` 形式的 http(s) URL；上游若回 `b64_json` 则记 `FAIL` 并给出明确错误

---

## 常见问题

**Q: AI 不知道有哪些 model 可选，怎么办？**
A: 这是设计意图。模型选择属于部署 / 路由策略，由调用方在 `X-Image-Task-Model` 里固定，不让 AI 决策。

**Q: 换模型 / 换供应商要重连 MCP session 吗？**
A: 不需要重建 session，但 core 的 `mcp_servers[].headers` 是启动时读取的，改完要 `docker compose restart agent-core`。

**Q: 为什么只支持一张参考图？**
A: 当前上游契约只稳定支持单张；`image` 因此是单个 URL 字符串。

**Q: 图生图报错？**
A: 是否支持取决于上游模型；不支持时上游回 4xx，在 `op=get` 里以 `task_status: FAIL` 呈现。换一个支持 `images` 字段的模型即可。

**Q: 本地图片怎么传？**
A: 先调用 agent 内置的 `mint_public_link` 工具，把会话目录里的文件换成短期公网 URL，再传给 `image`。本服务不接受文件上传或 base64，上游服务器也无法访问你的本地路径。

**Q: 上游是同步接口，为什么对外做成异步？**
A: 和 `video_task` 保持同一套任务型契约；同时避免一次生图把 core 的 `tools/call` 拖超时。

**Q: 任务一直 PROCESSING 会不会没完没了？**
A: 不会。上游调用封顶 180s，超时直接记 `FAIL`。

**Q: 为什么 PROCESSING 时建议的等待时间会变长？**
A: 轮询间隔按 `min(30, 3 + floor(elapsed / 5))` 退避：前期密查尽快拿到结果，后期拉长间隔减少无意义轮询，封顶 30s。

**Q: create 之后服务容器重启了，get 会怎样？**
A: 任务表在进程内存里，重启即丢失，`get` 会返回 unknown task_id。需要重新 `create`。

**Q: Token 会不会泄露到日志？**
A: 不会。只从 header 读取，不写入日志。

**Q: 收到 `Missing valid Mcp-Session-Id` 错误？**
A: 漏发了 `Mcp-Session-Id` header，或调 `tools/call` 前没先 `initialize`。

**Q: URL 多久过期？**
A: 上游签发的 URL 通常 24h 左右。需要长期使用请自行转存。
