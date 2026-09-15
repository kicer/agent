# MCP 服务集合

三个独立 MCP（Model Context Protocol）服务，各占一个目录，共用仓库根目录的 `docker-compose.yml`：

| 目录 | 容器名 | 作用 | 容器内端口 | MCP 端点 |
|---|---|---|---|---|
| `web_search/` | `mcp_web_search` | 免费网页搜索（Parallel / Exa，无需 key） | `3000` | `POST /` |
| `image_gen/` | `mcp_image_gen` | 智谱 CogView 图片生成 | `3000` | `POST /mcp` |
| `video_gen/` | `mcp_video_gen` | 智谱 CogVideo 视频生成（异步） | `3000` | `POST /mcp` |

**这些服务一个宿主机端口都不占**——它们只挂在 `agent-mcp-net` 上，由 `agent-core` / `agent-executor`
按容器名访问。所以整台服务器对外只需要开 agent-core 那一个端口（`AGENT_PORT`，默认 8090）。
（要从宿主机 curl 调试时，把 `docker-compose.yml` 里对应服务注释掉的 `ports` 两行打开。）

## 部署（无 nginx-proxy）

网络 `agent-mcp-net` 由 **agent 的 compose 创建**，所以全新机器上必须先起一次 agent：

```bash
# 1) 先起 agent（它会创建 agent-mcp-net；首次还要先备好 config.yml 与 .env）
cd /root/workspace/tools/agent && docker compose up -d --build

# 2) 再起 mcp
cd /root/workspace/tools/mcp && docker compose up -d --build
```

> mcp 单独在一个没有该网络的机器上先起会报错（`network agent-mcp-net declared as external, but could not be found`），这是预期行为。
> 拆的时候反着来（先 down mcp 再 down agent）。

`image_gen` / `video_gen` 需要智谱 token，但 token **不由服务端保存**——每个请求从 header 读取
（agent 侧配在 `config.yml` 的 `mcp_servers[].headers`）。所以这里不用配任何密钥。

### 环境变量

写在仓库顶层 `.env` 里即可（不写就用默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PUBLIC_LINK_URL` | `http://agent-core:8081/public-link` | video_gen 用：告诉 AI「本地图片怎么换成公网 URL」的 agent 内网签发入口 |
| `WEB_SEARCH_PORT` | `8081` | 只在临时打开 web_search 调试端口时用 |
| `IMAGE_GEN_PORT` | `8082` | 只在临时打开 image_gen 调试端口时用 |
| `VIDEO_GEN_PORT` | `8083` | 只在临时打开 video_gen 调试端口（MCP 口，仅本机短时调试）时用 |

## 图片是怎么到智谱手上的（只有 video_gen 关心）

智谱服务器生成视频前要**自己来拉参考图**，它不带 cookie、不带 `Authorization`。这套链路里**没有任何人上传文件**：

```
AI（agent 的 executor 沙箱里）
      │ curl -s "http://agent-core:8081/public-link?path=/workspace/tasks/<会话>/foo.png"
      ▼
agent-core :8081（内网、不映射宿主机 -> 无需凭据）
      │ 现签一个不透明短 ID（22 字符随机），内存表记着“哪个会话的哪个文件 + 何时过期”
      ▼
AI 把拿到的 URL 当 image_url 交给 video_gen:3000/mcp
      │
      ▼
智谱  ──匿名 GET──►  http://<服务器IP>:8090/p/9fQ2mZ7xK4tR1vBn
                        那个文件始终躺在 agent 的任务目录里，零拷贝
```

- 链接：`/p/<22 字符随机 ID>`，约 50 字符、纯 ASCII（不带文件名/会话名/签名）——因为这条 URL 会被模型
  抄进工具参数、并永久留在会话历史里每轮重发，越短越安全也越省 token。
- 过期：agent 侧 `public_link.ttl_ms`（默认 30 分钟）；agent 重启或过期后该 ID 立即失效（内存表）。
- 前提：agent 侧 `config.yml` 配了 `public_link.base_url`（就是那个对外地址），否则签发端口不启动。
- 唯一公网可达的东西是 agent 的 8090，以及那条**签名**下载路径；mcp 这三家一个端口都不露。

## 端口与安全

| 服务 | 公网暴露 | 说明 |
|---|---|---|
| `mcp_web_search` | 无 | 服务端无鉴权，**永远不要映射出去**（会被白嫖搜索额度）；agent 走内网访问 |
| `mcp_image_gen` | 无 | token 由调用方自带，暴露后可被拿去消耗你的智谱额度 |
| `mcp_video_gen` | 无 | 它需要的公网下载路径由 agent 现签的匿名短链（`/p/<id>`）提供，自己不占端口 |

## 单独调试

```bash
docker compose up -d --build mcp_web_search
# 不占端口的健康检查
docker exec mcp_web_search node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
```

各目录下的 `README.md` 有该服务的工具说明、header 覆盖项与 curl 调试脚本。
