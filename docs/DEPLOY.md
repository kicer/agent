# 部署说明（Docker + nginx-proxy，域名 agent.ai.foresh.com）

配置与编排文件都放在**仓库顶层**，方便直接调整：

| 宿主机路径 | 容器内路径 | 说明 |
|---|---|---|
| `./docker-compose.yml` | — | 编排（构建 `./app`，仅内网 expose 8080） |
| `./config.yml` | `/app/config.yml` | 运行配置（AGENT_CONFIG 指向它；含密钥，已被 .gitignore 忽略） |
| `./data/` | `/workspace/tasks` | 任务目录 + SQLite（`.agent.db` 在此目录内） |

## 1. 准备配置

```bash
cp app/config.example.yml config.yml
vi config.yml   # 至少改 models（每个模型独立 url/api_key）
```

> 容器内运行时 `workspace_root` 写 `/workspace/tasks`（docker-compose.yml 已把 `./data` 挂到这里）。
> 本仓库 git 只跟踪示例 `app/config.example.yml`，真正的 `config.yml` 在顶层且被忽略，密钥不会进库。

## 2. 构建并启动

```bash
# 在仓库顶层（含 docker-compose.yml 的位置）执行
docker compose up -d --build
docker compose logs -f     # 看到 "Agent server listening on 8080" 即成功
```

## 3. nginx-proxy 对外暴露（agent.ai.foresh.com）

compose 已通过 `VIRTUAL_HOST` / `VIRTUAL_PORT` / `CERT_NAME` 接入 nginx-proxy：

- 前置的 nginx-proxy 容器必须与业务容器共用同一个外部网络 `my-app-network`（compose 声明为 external），并监听 80/443。
- 域名 `agent.ai.foresh.com` 的 DNS 指向 nginx-proxy 所在宿主机。
- 若你的 nginx-proxy 未默认关闭代理缓冲，需额外配置 `proxy_buffering off`——**SSE 必须关缓冲**，否则流式输出会被攒住不发。可给 nginx-proxy 挂一个自定义 conf：
  ```
  server {
      listen 80;
      server_name agent.ai.foresh.com;
      location / {
          proxy_pass http://agent:8080;
          proxy_http_version 1.1;
          proxy_buffering off;          # SSE 关键
          proxy_read_timeout 3600s;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
      }
  }
  ```
- 认证交给 nginx-proxy（htpasswd）或在此 config 里启用内置 `auth`（见 config.example.yml 注释），二选一即可。

## 4. 升级流程

```bash
git pull
docker compose up -d --build    # 仓库顶层执行
```

数据库与任务目录都在 volume 内，升级不丢数据。进程重启时，原 active 会话会自动退回排队队列，待模型空闲后继续。