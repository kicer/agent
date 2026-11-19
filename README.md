# Agent 任务台

自托管的 Agent 系统。浏览器或微信下发任务，模型在独立工作目录里读写文件、执行命令、调用技能，产物直接回传。

![Agent 任务台](docs/agent.jpg)

## 快速开始

### 服务器

需要 Docker 与 Compose v2：

```bash
./scripts/init.sh
docker compose up -d --build
```

打开 `http://<服务器 IP>:8090`，用 `admin` / `admin` 登录，先改密码，再到「设置 → 模型」添加平台和 API Key，保存后点「重启服务」。

### 本机运行

macOS / Linux，Node 20+，不需要 Docker：

```bash
./local/start.sh    # 后台启动
./local/stop.sh
```

首次运行会让你选一个工作目录（技能、会话、数据库都在里面）。命令直接在本机执行，没有沙箱隔离，只监听 `127.0.0.1`。

需要从外网访问时，配好 [`tunnel/client.yml`](tunnel/README.md) 后 `start.sh` 会一并拉起隧道 client；未配置则跳过。

## 组成

| 目录 | 说明 |
|---|---|
| [`app/`](app/README.md) | agent-core：Express + SQLite + 前端静态资源，唯一对外端口 |
| `executor/` | agent-executor：隔离的命令执行、Office 预览网关 |
| [`wxbot/`](wxbot/README.md) | 微信接入 |
| [`mcp/`](mcp/README.md) | 四个 MCP 服务：网页搜索、图片生成、视频生成、语音转写 |
| [`skills/`](skills/README.md) | 内置技能 |
| [`local/`](local/README.md) | 本机模式启动器 |
| [`tunnel/`](tunnel/README.md) | 反向隧道：把本机服务经服务器中转，供外网访问 |
| [`device/`](device/README.md) | 设备执行端：任意机器装上就连回来，模型可在上面跑命令、传文件 |

## 远端设备

把任意一台机器（Mac / Linux / Windows / OpenWrt 盒子）接进来，让模型在它上面执行命令、读写文件：

1. 编译或下载 `device/` 的二进制，和 `config.json` 放在同一个目录：

   ```json
   { "server": "wss://你的域名/dev/ws", "token": "<DEVICE_TOKEN>", "root": "/Users/you", "name": "mac-01" }
   ```

2. 直接运行（默认读同目录的 `config.json`，token 不会出现在 `ps` 里）：

   ```bash
   ./agent-device-darwin-amd64
   ```

3. 服务器 `.env` 里配同一个 `DEVICE_TOKEN` 并重启 core。

设备**主动出站**连接，不需要公网 IP、不需要开端口。连上后模型侧多出 `device` 工具：
`list` 看在线设备、`health` 看负载、`exec` 跑命令、`pull`/`push` 收发文件（单个 2 GiB 以内）。
盒子上的常驻用系统自带的服务管理器（systemd / procd / schtasks），细节见 [`device/README.md`](device/README.md)。

## 配置

`./scripts/init.sh` 首次生成 `config.yml`，只有 agent-core 读取。日常改动走设置页，保存后点「重启服务」。

```yaml
platforms:
  - name: bigmodel
    url: https://open.bigmodel.cn/api/paas/v4
    models:
      - id: glm-5.3-flash
        vision: true
    keys:
      - api_key: "sk-..."
```

端口与其余环境变量在 `docker-compose.yml` 里。

## 升级

```bash
git pull
docker compose up -d --build
```

数据在 `data/`、`tasks/` 和 `config.yml` 里，升级不受影响。

## 安全

- 对外只开 agent-core 一个端口，其余服务只在 Docker 内网
- 隧道只经服务器 nginx（TLS）对外，宿主机端口仅绑 `127.0.0.1`；`server.yml` 与 `client.yml` 的 token 必须一致
- 命令在 executor 容器里执行，只挂当前会话目录，根文件系统只读
- 单租户设计：除管理员接口外不做用户级资源隔离，不要开放给互不信任的人
- `config.yml`、`.env`、`wxbot/data/` 存密钥，已加入 `.gitignore`

## License

AGPL-3.0，见 [LICENSE](LICENSE)。
