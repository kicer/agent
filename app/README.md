# Agent 任务台（app）

按仓库根目录 `README.md` 设计方案实现的自用通用 Agent 系统。

## 目录结构

```
app/
├── server/
│   ├── server.js            # 入口：装配配置/DB/总线/路由/静态资源
│   ├── config.js            # config.yaml 加载与校验
│   ├── db.js                # SQLite（better-sqlite3，WAL）
│   ├── engine.js            # 会话管理 + 模型池 FIFO 调度 + Agent 主循环
│   ├── llm.js               # OpenAI 兼容上游流式调用（SSE 解析/工具分片合并）
│   ├── sse.js               # 按会话分组的 SSE 事件总线
│   ├── routes/
│   │   ├── sessions.js      # 会话 CRUD（10.1）
│   │   ├── messages.js      # 消息/SSE/start/stop（10.2）
│   │   └── files.js         # 文件上传/列表/下载/删除（10.3）
│   ├── tools/
│   │   ├── definitions.json # 由 README 7.2 生成（npm run gen）
│   │   └── executor.js      # 13 个工具执行器（任务目录沙箱）
│   ├── templates/system-prompt.txt  # 由 README 7.1 生成
│   └── public/              # H5 前端（Vanilla JS + SSE）
├── test/                    # mock 上游 + 端到端冒烟测试
├── scripts（在上层仓库根目录）gen-from-readme.js  # README → 提示词/工具 schema
├── config.example.yaml
├── Dockerfile / docker-compose.yml
```

## 本地运行

```bash
cd app
npm install
cp config.example.yaml config.yaml   # 修改 upstream_url / models
npm start                            # http://localhost:8080
```

## 测试

```bash
cd app
npm test            # 启动 mock 上游 + 真实 server 的端到端冒烟测试（25 项断言）
```

## 从 README 重新生成提示词与工具 schema

README 是 system prompt 与工具 JSON schema 的唯一事实来源（与 Zed 逐字一致以利用前缀缓存）：

```bash
cd app
npm run gen         # 读 ../README.md → templates/system-prompt.txt + tools/definitions.json
```

修改 `README.md` 第七章节后必须重跑 `npm run gen` 并重启服务。

## 关键行为速查

- 会话创建即尝试绑定空闲模型；无空闲则进全局队列 FIFO。
- 每轮 AI 完成（无工具调）或用户终止后释放模型；新消息重新入队。
- 规划阶段点「开始执行」：追加固定模板消息并切 execution。
- 终止：置位标志 + kill 进程组 + 中止模型流，不再发新请求。
- 所有文件路径解析到任务目录内，拒绝越界。
- web_search 调用内网 MCP 服务（config.web_search.url/authorization，默认已内置）；如服务不可用会返回错误文本。

部署见 `../docs/DEPLOY.md`。
