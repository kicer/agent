# MCP 服务集合

三个独立 MCP（Model Context Protocol）服务，各占一个目录，共用仓库根目录的 `docker-compose.yml`：

| 目录 | 容器名 | 作用 | 宿主机端口（默认） | MCP 端点 |
|---|---|---|---|---|
| `web_search/` | `mcp_web_search` | 免费网页搜索（Parallel / Exa，无需 key） | `8081` | `POST /` |
| `image_gen/` | `mcp_image_gen` | 智谱 CogView 图片生成 | `8082` | `POST /mcp` |
| `video_gen/` | `mcp_video_gen` | 智谱 CogVideo 视频生成（异步）+ 图片 `/upload` | `8083` | `POST /mcp` |

## 部署（无 nginx-proxy，IP:端口直连）

这些服务与 `agent` 仓库的 `agent-core` 共用网络 `my-app-network`（agent 按**容器名**访问，
如 `http://mcp_web_search:3000/`）。该网络由 **agent 的 compose 创建**，所以全新机器上必须先起一次 agent：

```bash
# 1) 先起 agent（它会创建 my-app-network；首次还要先备好 config.yml 与 .env）
cd /root/workspace/tools/agent && docker compose up -d --build

# 2) 再起 mcp
cd /root/workspace/tools/mcp && docker compose up -d --build
```

> mcp 单独在一个没有该网络的机器上先起会报错（`network my-app-network declared as external, but could not be found`），这是预期行为。
> 拆的时候反着来（先 down mcp 再 down agent）。

`image_gen` / `video_gen` 需要智谱 token，但 token **不由服务端保存**——每个请求从 header 读取
（agent 侧配在 `config.yml` 的 `mcp_servers[].headers`）。所以这里不用配任何密钥，直接起：

```bash
cd /root/workspace/tools/mcp
docker compose up -d --build
```

可选环境变量（写在仓库顶层 `.env` 即可，不写就用默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEB_SEARCH_PORT` | `8081` | web_search 映射到宿主机的端口 |
| `IMAGE_GEN_PORT` | `8082` | image_gen 映射到宿主机的端口 |
| `VIDEO_GEN_PORT` | `8083` | video_gen 映射到宿主机的端口 |
| `PUBLIC_BASE_URL` | `http://localhost:8083` | video_gen `/upload` 返回的 URL 前缀，必须是**外部可达**地址（智谱要能取到这张图）；无域名时填 `http://<服务器IP>:<VIDEO_GEN_PORT>` |

## 端口暴露范围（安全）

agent 走 `my-app-network` 用容器名 + 容器内端口（3000）访问，**不依赖宿主机端口**。所以对外
只建议放行 `8083`（原因见下），`8081` / `8082` 建议不对公网开放：

- `web_search`：服务端无鉴权，暴露即被白嫖搜索额度。
- `image_gen`：token 由调用方自带，暴露后可被拿来消耗你自己的智谱额度（若 token 泄露）。
- `video_gen`：`PUBLIC_BASE_URL` 指向它，智谱服务器要能下载你上传的参考图，所以**做图生视频时
  必须对外放行**。注意它的 `/upload` 与 `/uploads/*` 本身不鉴权（8MB / 24h 临时文件），
  不需要图生视频就别放行。

## 单独调试

```bash
docker compose up -d --build mcp_web_search
curl http://localhost:8081/health
```

各目录下的 `README.md` 有该服务的工具说明、header 覆盖项与 curl 调试脚本。
