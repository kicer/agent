# MCP 服务集合

三个独立 MCP（Model Context Protocol）服务，各占一个目录，共用仓库根目录的 `docker-compose.yml`：

| 目录 | 容器名 | 作用 | 容器内端口 | MCP 端点 |
|---|---|---|---|---|
| `web_search/` | `mcp_web_search` | 免费网页搜索（Parallel / Exa，无需 key） | `3000` | `POST /` |
| `image_gen/` | `mcp_image_gen` | 智谱 CogView 图片生成 | `3000` | `POST /mcp` |
| `video_gen/` | `mcp_video_gen` | 智谱 CogVideo 视频生成（异步）+ 图片上传 | `3000` 全量 / `3001` 只读 | `POST /mcp` |

**这些服务默认不占宿主机端口**——它们只挂在 `my-app-network` 上，由 `agent-core` / `agent-executor`
按容器名访问。所以整台服务器对外只需要开 agent-core 那一个端口（`AGENT_PORT`，默认 8090）。

## 部署（无 nginx-proxy）

网络 `my-app-network` 由 **agent 的 compose 创建**，所以全新机器上必须先起一次 agent：

```bash
# 1) 先起 agent（它会创建 my-app-network；首次还要先备好 config.yml 与 .env）
cd /root/workspace/tools/agent && docker compose up -d --build

# 2) 再起 mcp
cd /root/workspace/tools/mcp && docker compose up -d --build
```

> mcp 单独在一个没有该网络的机器上先起会报错（`network my-app-network declared as external, but could not be found`），这是预期行为。
> 拆的时候反着来（先 down mcp 再 down agent）。

`image_gen` / `video_gen` 需要智谱 token，但 token **不由服务端保存**——每个请求从 header 读取
（agent 侧配在 `config.yml` 的 `mcp_servers[].headers`）。所以这里不用配任何密钥。

### 环境变量

写在仓库顶层 `.env` 里即可（不写就用默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://localhost:8090/mcp-uploads` | **必须改**。video_gen `/upload` 返回给智谱的 URL 前缀，指向 agent-core 的只读中转；无域名时填 `http://<服务器IP>:<AGENT_PORT>/mcp-uploads` |
| `WEB_SEARCH_PORT` | `8081` | 只在临时打开 web_search 调试端口时用 |
| `IMAGE_GEN_PORT` | `8082` | 只在临时打开 image_gen 调试端口时用 |
| `VIDEO_GEN_PORT` | `8083` | 只在临时打开 video_gen 调试端口（只读监听）时用 |

## 图片是怎么到智谱手上的（video_gen 特有）

只有 `video_gen` 需要一个"公网可达的地址"，因为智谱服务器生成视频前要**自己来拉这张参考图**，
它不带 cookie、不带 `Authorization`。链路是：

```
AI（agent-executor 内执行 curl）
        │ POST /upload（走 docker 内网，不经过公网）
        ▼
mcp_video_gen:3000 ──存储──► ./uploads/<randomUUID>.png
        │ 返回 url = PUBLIC_BASE_URL + /uploads/<name>
        ▼
视频任务提交给智谱，image_url 就是上面那个 url
        │
        ▼
智谱  ──匿名 GET──►  http://<服务器IP>:8090/mcp-uploads/uploads/<name>
                        │ agent-core 只转发 GET/HEAD
                        ▼
                   mcp_video_gen:3001（只读监听，那边没有任何写路由）
```

所以：**写路径（`POST /upload`）永远不出公网**，公网只暴露一个只读、不可枚举、24h 过期的下载路径。

## 端口与安全

| 服务 | 公网暴露 | 说明 |
|---|---|---|
| `mcp_web_search` | 无 | 服务端无鉴权，**永远不要映射出去**（会被白嫖搜索额度）；agent 走内网访问 |
| `mcp_image_gen` | 无 | token 由调用方自带，暴露后可被拿去消耗你的智谱额度 |
| `mcp_video_gen` | 无 | 只读路径已经由 agent-core 的 `/mcp-uploads` 代拉，无需自己占端口 |

需要从宿主机直接 curl 调试时，去 `docker-compose.yml` 把对应服务注释掉的 `ports` 两行打开
（video_gen 那个映的是只读监听 3001，不会暴露 `POST /upload`），调试完记得再注释回去。
`video_gen` 的用户上传文件落在宿主 `./uploads/`（已 gitignore，24h 自动清理）。

## 单独调试

```bash
docker compose up -d --build mcp_web_search
docker exec mcp_web_search node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
```

各目录下的 `README.md` 有该服务的工具说明、header 覆盖项与 curl 调试脚本。
