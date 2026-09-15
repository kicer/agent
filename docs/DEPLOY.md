# 部署说明（Docker，IP:端口直连，无 nginx-proxy）

配置与编排文件都放在**仓库顶层**，方便直接调整：

| 宿主机路径 | 容器内路径 | 说明 |
|---|---|---|
| `./docker-compose.yml` | — | 编排（构建 `./app`，把容器 8080 映射到宿主机 8090） |
| `./config.yml` | `/app/config.yml` | 运行配置（AGENT_CONFIG 指向它；含密钥，已被 .gitignore 忽略） |
| `./tasks/` | `/workspace/tasks` | 任务目录：AI 的文件工作区（与 executor 必须同路径） |
| `./data/` | `/workspace/data` | 数据目录 + SQLite（`.agent.db`） |
| `./skills/` | `/workspace/skills` | 技能目录：所有任务/会话共享 |
| `./.env` | — | 编排变量（`EXECUTOR_TOKEN` / `AGENT_PORT` / `AUTH_SECRET`），已被 .gitignore 忽略 |
| `./scripts/init.sh` | — | 一键生成上面两个文件并起服务（见第 0 节） |

> `config.yml` 与 `.env` 推荐交给 `scripts/init.sh` 生成（见第 0 节）；不想用脚本的话也可以自己建（见第 2 节）。

## 0. 一键生成配置并启动（推荐）

`scripts/init.sh` 读取一组环境变量（通常由服务器上的 `/root/init_repos.sh` 从 `/root/deploy.conf` 传过来），
生成 `.env` 与 `config.yml`，然后按顺序起 agent → mcp：

```bash
# 直接跑（或在仓库根：./scripts/init.sh）
BIGMODEL_KEY=xxx DEEPSEEK_KEY=yyy PUBLIC_IP=1.2.3.4 ./scripts/init.sh
```

| 输入变量 | 说明 |
|---|---|
| `BIGMODEL_KEY` / `DEEPSEEK_KEY` / `QWEN_KEY` | 模型平台 key，**填几个启用几个**（可 0~3 个） |
| `ZHIPU_KEY` | image-gen / video-gen 用；**留空则这两个服务 `enable: false`**（工具不加载） |
| `AUTH_USER` / `AUTH_PASSWORD` | 登录账号（默认 `admin`/`admin`，记得改） |
| `PUBLIC_IP` / `AGENT_PORT` | 对外地址与端口（`PUBLIC_IP` 空则尝试自动探测） |
| `MCP_DIR` | mcp 仓库位置（默认 `../mcp`） |

自动处理、不用配：`AUTH_SECRET` / `EXECUTOR_TOKEN`（生成一次后存进 `.env`，**重跑保持不变**，所以不会掉登录态）、`LOG_LEVEL`（脚本顶部默认 `debug`，日常改 `info`）。

⚠️ **`config.yml` 是生成物，不要再手改**：每次生成都会把旧的备份成 `config.yml.bak.<时间戳>`。要改配置请改上游的 `deploy.conf` 后重跑，或者不用脚本、按第 2 节手动维护。

## 1. 网络（自动创建，无需手动）

`agent-core` 与 `mcp` 仓库的服务共用网络 `my-app-network`：agent 按容器名访问 MCP
（如 `http://mcp_web_search:3000/`）。该网络由**本仓库的 compose 创建**（固定名字，不带项目名前缀），
`mcp` 侧声明为 `external` 直接加入。

所以全新机器上有**先后顺序**：先起 agent（创建网络），再起 mcp（mcp 单独先起会因为网络不存在而报错）。

```bash
# 1) 先 agent，创建网络
docker compose up -d --build

# 2) 再 mcp
cd ../mcp && docker compose up -d --build
```

> 拆的时候反着来：先 `down` mcp，再 `down` agent。否则 agent 侧会报
> `network my-app-network has active endpoints`（容器照删、网络留下，重新 up 就恢复，不损数据）。

## 2. 准备配置（手动方式）

不用 `scripts/init.sh` 时，自己建这两个文件：

```bash
cp app/config.example.yml config.yml
cp .env.example .env
vi .env         # 填 EXECUTOR_TOKEN，生成：openssl rand -hex 32
vi config.yml
```

`config.yml` 至少改这几处。**容器内必须写绝对路径**——core 与 executor 靠同一份
`/workspace/tasks` 看到彼此的产物，留成示例里的相对路径（`./data/tasks`）会解析到
`/app/data/tasks`，命令会因为不在 executor 白名单里而失败：

```yaml
platforms: ...                       # 模型池：每个平台 url + keys.api_key
workspace_root: /workspace/tasks     # 不能留示例里的 ./data/tasks
data_root: /workspace/data           # SQLite 与 prompt dump 落在这个挂载卷里
skills:
  skills_root: /workspace/skills
public_link:                         # 需要给外部服务公网 URL 时才配（图生视频用）；见第 4.1 节
  base_url: "http://<服务器IP>:8090"
auth:                                # 建议启用，否则谁都能访问
  secret: "换一个随机串"
  users:
    - user: admin
      password: "换一个密码"
mcp_servers:                         # 无域名时按容器名访问（模板已写好，按需启用）
  - name: web-search
    url: "http://mcp_web_search:3000/"
```

> ⚠️ 必须先有 `config.yml` 再 `up`：compose 挂载的是 `./config.yml:/app/config.yml`，
> 文件不存在时 Docker 会在宿主机建一个同名**目录**，容器起来会读不到配置。

## 3. 构建并启动

```bash
# 在仓库顶层（含 docker-compose.yml 的位置）执行
docker compose up -d --build
docker compose logs -f agent-core    # 看到 "Agent server listening on 8080" 即成功
```

首次启动会先跑一次 `agent-executor-init`（把技能依赖落到宿主机 `./skills`），跑完自动退出，
属正常现象。

## 4. 访问

浏览器打开 **`http://<服务器IP>:8090`**（端口可用 `.env` 里的 `AGENT_PORT` 改）。
登录用第 2 步 `auth.users` 里配的账号。

**对外只需要放行这一个端口**：`agent-executor`（9000）和 mcp 的三个服务都只在 `my-app-network`
内网，没有映射到宿主机（需要从宿主机 curl 调试时，去 mcp 仓库的 `docker-compose.yml` 里临时
把对应服务的 `ports` 两行取消注释）。

### 4.1 公网临时链接（只有“把本地文件交给外部服务”时才用到）

场景：图生视频时，智谱服务器生成视频前要**自己来拉参考图**，它不带 cookie、不带 `Authorization`，
所以必须有一条公网匿名可达的 URL。做法是复用登录下载那套签名链接（`app/server/download-token.js`）：
不可猜（HMAC）、会过期、绑会话、进程重启即全部失效。

AI 拿链接的姿势：core 额外在**内网**监听一个**不映射到宿主机**的端口（`PUBLIC_LINK_PORT`，默认 8081），
上面只有一条签发接口。因为压根没 publish，外部连不上，所以它**不需要任何凭据**：

```bash
# AI 在 executor 沙箱里执行（路径就是它平时看到的那个绝对路径）
curl -s "http://agent-core:8081/public-link?path=/workspace/tasks/<会话>/foo.png"
# → http://<服务器IP>:8090/api/sessions/<会话>/files/download-name/foo.png?path=foo.png&expires=…&t=…
#   stdout 就是现成 URL，直接当 image_url 用
```

```
智谱  ──匿名 GET──►  /api/sessions/<会话>/files/download-name/…&t=…   （core :8090）
                          │  验签（会话 + 路径 + 时效）
                          ▼
                     ./tasks/<会话>/foo.png    ← 文件仍在原地，零拷贝
```

- 必须在 `config.yml` 配 `public_link.base_url = "http://<服务器IP>:8090"`；不配则不启动签发端口，
  video_gen 的工具描述里也不会出现那条命令（它会退化成“请运维配 PUBLIC_LINK_URL”）。
- 链接有效期 `public_link.ttl_ms`，默认 30 分钟；签完尽快用掉。
- 沙箱外的人要用上这条链接，得同时知道 IP、路径和签名；签名猜不出来，过期即废。
- 这条路不搬字节：文件始终在它原本的位置，也不需要 video_gen 参与上传/落盘。

## 5. 没有 HTTPS 的影响（可忽略，仅记录）

HTTP 直连时浏览器不认为这是"安全上下文"，以下能力自动降级，不影响主流程：

- PWA / Service Worker 不注册（`http://IP` 不是 secure context），离线缓存与「添加到主屏」不可用。
- 复制按钮的 `navigator.clipboard` 不可用，前端自动回退到旧 API。
- 登录 cookie 本身没带 `Secure` 标志，HTTP 下正常签发与携带（`auth.js` 用的是 HttpOnly + SameSite=Lax）。

日后若加回 nginx / HTTPS 反代，注意 **SSE 必须关代理缓冲**，否则流式输出会被攒住不发：

```
location / {
    proxy_pass http://agent-core:8080;   # 或宿主机 IP:8090
    proxy_http_version 1.1;
    proxy_buffering off;                 # SSE 关键
    proxy_read_timeout 3600s;
}
```

## 6. 升级流程

```bash
git pull
docker compose up -d --build    # 仓库顶层执行
```

数据库与任务目录都在 bind 挂载的 `./data`、`./tasks` 内，升级不丢数据。进程重启时，
原 active 会话会自动退回排队队列，待模型空闲后继续。
