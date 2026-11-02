# web_search

网页搜索 MCP server 的本地重构版（上游开源实现：[@sheep233_/dsh-web-search-free](https://github.com/sheep-programmer/dsh-web-search-free)，MIT）。

零运行时依赖，只用 Node 内置 `fetch`（Node ≥ 18），**无需 npm install，直接 `node server.js` 启动**。

## 三路上游

| 条件 | 走哪 | 说明 |
| --- | --- | --- |
| 请求带了 `X-Web-Search-Base-Url` | 你的 `POST {base}/search` | key 可选（`Authorization`）。**失败直接报错，不静默退回免费后端** |
| 没带 | Parallel（免费匿名） | 失败自动退 Exa |
| stdio 模式 | 只能免费 | stdio 没有 HTTP header |

自定义上游的协议：

```http
POST {base}/search
Authorization: Bearer <key>
Content-Type: application/json

{"query":"2027山东省考公告","max_results":5}
```

```json
{"query":"...","type":"text2text","results":[{"title":"...","url":"https://...","snippet":"..."}]}
```

响应归一化成 `[{url, title?, snippet?, publishedAt?}]`：`results[]` 里没有 `url` 的条目丢弃，
`snippet` 压平空白并截断到 500 字（搜索结果会进对话历史、之后每轮都可能被整条重放，不截等于白烧 token），
`published_at` / `publishedAt` / `publish_date` 任一存在则映射为 `publishedAt`。

## 结构

| 文件 | 职责 |
| --- | --- |
| `core.js` | 搜索后端：自定义 `/search` + Parallel / Exa 免费 MCP 端点封装 + 响应解析 |
| `mcp.js` | MCP 协议层：`web_search` 工具定义 + JSON-RPC 分发 + 从 header 取上游参数 |
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

上游地址 / 鉴权**不是**环境变量：由调用方随每个请求用 header 带入（见上面「三路上游」），
agent 侧写在 `config.yml` 的 `mcp_servers[name=web_search].headers`。换接口只改 YAML + 重启 core，
不碰 `.env`、不重建镜像；容器自身不存任何平台密钥。

## Docker

`docker-compose.yml` 中的 `mcp_web_search` 服务直接构建本目录，Dockerfile 已改为拷贝源码启动（不再有 `npm install -g`）。

容器内监听 3000，**默认不占宿主端口**：agent 走 `agent-mcp-net` 按容器名访问
（`http://mcp_web_search:3000/`）。要从宿主机 curl 调试，自行给该服务加 `ports` 映射。

```bash
docker compose build mcp_web_search && docker compose up -d mcp_web_search
# 不占端口的健康检查
docker exec mcp_web_search node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
# {"name":"web_search","version":"...","transport":"http/sse","port":3000}
```

该服务**无服务端鉴权**，**永远不要**对外映射端口——会被白嫖搜索额度（自定义上游时还会把你的 key 白送出去）。
