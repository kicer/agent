# 部署说明（Docker + nginx-proxy basic auth）

## 1. 准备配置

```bash
cd app
cp config.example.yaml config.yaml
vi config.yaml     # 至少改 upstream_url 与 models
```

容器内运行时约定（docker-compose.yml 已按此挂载）：

| 宿主机路径 | 容器内路径 | 说明 |
|---|---|---|
| `./config.yaml` | `/app/config.yaml` | 运行配置（AGENT_CONFIG 指向它） |
| `./data/` | `/workspace/tasks` | 任务目录 + SQLite（`.agent.db` 在此目录内） |

> 注意：容器内运行时 `workspace_root` 请写 `/workspace/tasks`（宿主机直接运行则用默认 `./data/tasks` 即可）。

## 2. 构建并启动

```bash
cd app
docker compose up -d --build
docker compose logs -f        # 看到 "Agent server listening on 8080" 即成功
```

## 3. nginx-proxy + basic auth

多用户共享一套认证，不做任务隔离（见 README 8.1）。

生成密码文件（需 apache2-utils 提供的 htpasswd）：

```bash
apt-get install apache2-utils       # 或任何能生成 htpasswd 的方式
htpasswd -c ./deploy/.htpasswd admin
htpasswd ./deploy/.htpasswd user2
```

nginx 站点配置：

```nginx
server {
    listen 80;
    server_name agent.example.com;

    location / {
        auth_basic "Agent";
        auth_basic_user_file /etc/nginx/.htpasswd;

        proxy_pass http://agent:8080;
        proxy_http_version 1.1;
        proxy_buffering off;          # SSE 必须关缓冲
        proxy_read_timeout 3600s;     # 长连接不被掐断
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

> SSE 关键点：`proxy_buffering off`，否则流式输出会被 nginx 攒着不发。

若不想用 nginx，也可直接启用内置认证：在 `config.yaml` 里配置
`auth: {user: admin, password: ...}`（仅适合纯内网测试；上游仍建议 nginx TLS）。

## 4. 升级流程

```bash
git pull
cd app && docker compose up -d --build
```

数据库与任务目录都在 volume 内，升级不丢数据。进程重启时，原 active 会话
会自动退回排队队列，待模型空闲后继续。
