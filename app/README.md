# Agent 任务台（app）

按仓库根目录 `README.md` 设计方案实现的自用通用 Agent 系统。

## 目录结构

```
app/
├── server/
│   ├── server.js            # 入口：装配配置/DB/总线/路由/静态资源
│   ├── config.js            # config.yml 加载与校验
│   ├── db.js                # SQLite（better-sqlite3，WAL）
│   ├── engine.js            # 会话管理 + 模型池 FIFO 调度 + Agent 主循环
│   ├── llm.js               # OpenAI 兼容上游流式调用（SSE 解析/工具分片合并）
│   ├── mcp.js               # MCP 客户端：mcp_servers 工具发现（tools/list）与转发（tools/call）
│   ├── sse.js               # 按会话分组的 SSE 事件总线
│   ├── routes/
│   │   ├── sessions.js      # 会话 CRUD（10.1）
│   │   ├── messages.js      # 消息/SSE/start/stop（10.2）
│   │   └── files.js         # 文件上传/列表/下载/删除（10.3）
│   ├── tools/
│   │   ├── definitions.json # 内置 16 个工具的 JSON Schema
│   │   └── executor.js      # 内置工具执行器（任务目录沙箱；未知工具名转 MCP）
│   ├── templates/system-prompt.txt  # System prompt 模板（直接编辑）
│   └── public/              # H5 前端（Vanilla JS + SSE）
├── test/                    # mock 上游 + 端到端冒烟测试
├── config.example.yml
├── Dockerfile / docker-compose.yml
```

## 本地运行

```bash
cd app
npm install
cp config.example.yml config.yml   # 修改 models（每个模型独立 url/api_key）
npm start                            # http://localhost:8090
```

## 测试

```bash
cd app
npm test            # 启动 mock 上游 + 真实 server 的端到端冒烟测试（25 项断言）
```

## 提示词与工具 schema

System prompt 完全静态（所有会话共用，利于上游前缀缓存），在 `server/templates/system-prompt.txt` 直接编辑；工具定义在 `server/tools/definitions.json`。改完重启服务。

## 关键行为速查

- 会话创建即尝试绑定空闲模型；无空闲则进全局队列 FIFO。
- 每轮 AI 完成（无工具调）或用户终止后释放模型；新消息重新入队。
- 规划阶段点「开始执行」：追加固定模板消息并切 execution。
- 终止：置位标志 + kill 进程组 + 中止模型流，不再发新请求。
- 所有文件路径解析到任务目录内，拒绝越界。
- MCP 服务在 config.yml 的 `mcp_servers` 配置（可多个，每项 name?/url/headers/enable?，enable 默认 true、false 时启动不加载其工具）；启动时发现其工具，追加在内置工具之后与 system prompt 一起发给模型；服务不可用仅启动日志告警，工具名重名时加「服务名__」前缀。

部署见 `../docs/DEPLOY.md`。
