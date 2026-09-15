# 部署说明（Docker，IP:端口直连，无 nginx-proxy）

配置与编排文件都放在**仓库顶层**，方便直接调整：

| 宿主机路径 | 容器内路径 | 说明 |
|---|---|---|
| `./docker-compose.yml` | — | 编排（构建 `./app`，把容器 8080 映射到宿主机 8090） |
| `./config.yml` | `/app/config.yml` | 运行配置（AGENT_CONFIG 指向它；含密钥，已被 .gitignore 忽略） |
| `./tasks/` | `/workspace/tasks` | 任务目录：AI 的文件工作区（与 executor 必须同路径） |
| `./data/` | `/workspace/data` | 数据目录 + SQLite（`.agent.db`） |
| `./skills/` | `/workspace/skills` | 技能目录：所有任务/会话共享 |
| `./.env` | — | 编排变量（`EXECUTOR_TOKEN` / `AGENT_PORT`），已被 .gitignore 忽略 |

> 本仓库不含 `config.yml` 与 `.env`，需自行创建（见第 2 步）。

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

## 2. 准备配置

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

对外只需放行这一个端口：`agent-executor`（9000）只在 `agent-internal` 内网，没有映射到宿主机。

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
