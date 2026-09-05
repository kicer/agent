# web_search

免费网页搜索 MCP server 的本地重构版（上游开源实现：[@sheep233_/dsh-web-search-free](https://github.com/sheep-programmer/dsh-web-search-free)，MIT）。

零运行时依赖，只用 Node 内置 `fetch`（Node ≥ 18），**无需 npm install，直接 `node server.js` 启动**。

## 结构

| 文件 | 职责 |
| --- | --- |
| `core.js` | 搜索后端：Parallel（默认）/ Exa（备用）免费 MCP 端点封装 + 响应解析 |
| `mcp.js` | MCP 协议层：`web_search` 工具定义 + JSON-RPC 分发 |
| `server.js` | 入口：CLI 参数 + stdio / HTTP/SSE 双传输 |

## 本地启动

```bash
# HTTP/SSE 模式（默认 127.0.0.1:3100）
node server.js --http --port 3100

# stdio 模式（Claude Code / Codex 直接拉起时用）
node server.js
```

MCP 端点：

- `POST /` — Streamable HTTP（也接受 `Accept: text/event-stream`）
- `GET /sse` + `POST /messages` — 老式 SSE 传输
- `GET /health` — 健康检查

环境变量（均可选）：

- `EXA_API_KEY` — 提升 Exa 匿名限额
- `SEARCH_TIMEOUT_MS` — 上游搜索超时，默认 30000

## Docker

`docker-compose.yml` 中的 `mcp_web_search` 服务直接构建本目录，Dockerfile 已改为拷贝源码启动（不再有 `npm install -g`）。

```bash
docker compose build mcp_web_search && docker compose up -d mcp_web_search
```
