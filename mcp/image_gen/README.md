# MCP Image Gen

一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的图片生成服务，对接智谱 BigModel 的 `CogView` 系列模型。每次调用通过 HTTP header 传入智谱 API 的 Bearer Token，支持在工具参数中按需切换模型。

- 协议：MCP **Streamable HTTP**（单端点 `/mcp`，支持 SSE 流）
- 上游：[智谱 BigModel Images Generations API](https://open.bigmodel.cn/dev/api#images)
- 默认模型：`CogView-3-Flash`
- 端口：`3000`
- 鉴权：**无服务端密钥**，每次请求必须从 header 携带智谱 token

---

## 快速开始

### 启动（docker-compose）

仓库根目录 `docker-compose.yml` 已包含本服务：

```bash
cd /root/workspace/tools/mcp
docker compose up -d --build mcp_image_gen
```

服务容器名 `mcp_image_gen`，容器内端口 3000，**默认不占宿主端口**：agent 走 `agent-mcp-net`
按容器名访问（`http://mcp_image_gen:3000/mcp`）。需要从宿主机 curl 调试时，去仓库根
`docker-compose.yml` 把 `mcp_image_gen` 注释掉的 `ports` 两行打开（默认写的是 8082），调试完记得注释回去。

```bash
# 不占端口的健康检查
docker exec mcp_image_gen node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
# {"status":"ok","service":"image_gen","sessions":0}
```

### MCP 客户端配置

#### Claude Desktop / Cursor 等支持 `headers` 配置的客户端

```jsonc
// Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json
// Cursor:       ~/.cursor/mcp.json
{
  "mcpServers": {
    "image_gen": {
      "url": "http://localhost:8082/mcp",
      "headers": {
        "Authorization": "Bearer <your-zhipu-api-key>"
      }
    }
  }
}
```

> 上面 `url` 里的端口 `8082` 需要先把 compose 里注释的 `ports` 打开（默认不占宿主端口）。

> **重要**：客户端必须在 **每一个 HTTP 请求**（`initialize` / `notifications/initialized` / `tools/call`）都带上 `Authorization` header。配置在 `headers` 里、由客户端自动重发即可。直连模式下 token 不在 session 间共享。

#### 不支持 `headers` 字段的客户端

如果客户端只支持 `command`/`args` 启动方式，可改用 stdio 模式（需自行包一层把 token 注入环境变量，再让工具回调从环境变量读——当前实现 HTTP 模式下不依赖环境变量，需自行扩展）。

---

## 工具：image_gen

调用智谱图片生成接口，返回图片 URL。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string | ✅ | 图片生成提示词，描述想要的画面内容 |
| `size` | string | ❌ | 图片尺寸，例如 `1024x1024`、`1280x1280`、`1024x1792`、`1792x1024`、`768x1344`、`1344x768`，遵循智谱 API 规格 |

### Model 控制（不在工具参数中暴露）

模型名由调用方在 **tools/call 这一次的 HTTP header** 中传递，**AI 看不到也填不了**，避免其误传。识别顺序（首个非空值生效）：

| 优先级 | Header |
|---|---|
| 1 | `X-Image-Gen-Model` |
| 2 | `X-Mcp-Model` |
| 3 | `X-Model` |

如果都没传，走代码内常量 `DEFAULT_MODEL = "CogView-3-Flash"`。

**为什么不放进工具参数？** 调用方一般是 AI 助手（Claude / Cursor 等），它不需要也没能力选择用哪个模型；模型选择属于部署/路由策略，由请求的发起方在 HTTP header 里注入更可控。

### 返回

### 返回

工具成功时返回若干 `text` 块，第一块是摘要，后续每块各包含一张图片的 URL（方便 LLM 直接贴图或下载）：

```jsonc
{
  "content": [
    { "type": "text", "text": "模型: CogView-3-Flash\n提示词: ...\n图片 1: https://maas-watermark-prod-new.cn-wlcb.ufileos.com/..." },
    { "type": "text", "text": "https://maas-watermark-prod-new.cn-wlcb.ufileos.com/..." }
  ]
}
```

URL 由智谱签名下发，**带有效期**（通常 24h），如需长期保存请在收到后及时转存到自己的存储。

失败时返回 `isError: true` 的错误描述。

---

## 鉴权细节

每个 HTTP 请求必须携带智谱 API Token，server 从以下 header 字段按顺序识别，**首个非空值生效**：

| 优先级 | Header | 说明 |
|---|---|---|
| 1 | `X-Image-Gen-Token: <token>` | 直传，避免与客户端自身的 Authorization 冲突 |
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

## 用 curl 手工调试

MCP Streamable HTTP 不是普通 REST，**必须按顺序**：`initialize` → `notifications/initialized` → `tools/call`。下面用一行版串起来：

```bash
# 把 <your-zhipu-api-key> 替换成你智谱的 API Key
TOKEN="<your-zhipu-api-key>"

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

# 3. 列出工具（可选验证）
curl -s -X POST http://localhost:8082/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}'

# 4. 调 image_gen
curl -s -X POST http://localhost:8082/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "image_gen",
      "arguments": {
        "prompt": "一只可爱的小猫咪，坐在阳光明媚的窗台上，背景是蓝天白云",
        "size": "1280x1280"
      }
    }
  }'
```

响应是 SSE 格式（`event: message` + `data: {...}`），用 `grep '^data:'` 抽 JSON 即可。

---

## 架构与文件

```
image_gen/
├── Dockerfile          # node:22-slim，安装依赖后启动 MCP HTTP server
├── .dockerignore       # 排除 node_modules
├── package.json        # @modelcontextprotocol/sdk + express + zod
├── README.md           # 本文件
└── src/
    └── mcp-server.js   # 单文件实现：HTTP server + MCP transport + tool
```

### 关键设计

- **每 session 一个 transport + server**：通过 `Mcp-Session-Id` 复用，避免每请求重建
- **Token 闭包注入**：在 Express 入口处从 header 提取 token，闭包传给 `buildServer({ token })`，tool 回调里直接使用；不依赖 SDK 内部字段
- **模型参数单链**：`arguments.model` → `DEFAULT_MODEL`，无 header 干预
- **URL 提取**：`response.data[].url` 为准，若返回 `b64_json` 也会一并返回

### 默认模型

```js
// src/mcp-server.js
const DEFAULT_MODEL = "CogView-3-Flash";
```

修改后 `docker compose up -d --build mcp_image_gen` 即可生效。

---

## 常见问题

**Q: AI 不知道有哪些 model 可选，怎么办？**
A: 这是设计意图。模型选择属于路由策略，不让 AI 决策。调用方在 HTTP header `X-Image-Gen-Model` 里注入即可。

**Q: 换模型需要重连 MCP session 吗？**
A: 不需要。Model header 在每次 `tools/call` 都从当前请求读取，不需要重建 session。

**Q: 为什么 Model 优先级不是「工具参数 > header」？**
A: 因为我们故意不在 schema 暴露 model 参数，AI 根本不会传 model，所以「工具参数 > header」这条分支实际上不存在。

**Q: Token 会不会泄露到日志？**
A: 当前实现只在 session 内存里持有，不会写入 stdout/stderr。Container 日志只打印 session id。

**Q: 收到 `Missing valid Mcp-Session-Id` 错误？**
A: 漏发了 `Mcp-Session-Id` header，或调 `tools/call` 前没先 `initialize`。

**Q: URL 多久过期？**
A: 智谱签发 URL 默认 24h 左右，详见响应里的 `Expires` 参数。需要长期使用请自行转存到 OSS/S3。

**Q: 能否限制 `size` 白名单？**
A: 当前透传给智谱 API，不做强制校验。如需加白名单，修改 `src/mcp-server.js` 中 `image_gen` 的 `size` schema 即可。
