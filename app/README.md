# agent-core

`agent` 仓库的 core 服务：Express + SQLite + 静态 H5 前端。

对外能力、部署与配置见仓库根 [`../README.md`](../README.md)。

## 本地运行

```bash
cd app
npm install
cp config.example.yml config.yml
# 本地调试时把 workspace_root / data_root 改到仓库内可写目录
AGENT_CONFIG=./config.yml node server/server.js
```

默认监听 `8090`。`platforms` 可以留空，启动后到设置页添加模型并重启。

## 关键文件

| 文件 | 职责 |
|---|---|
| `server/server.js` | 装配配置、DB、SSE、路由与启动顺序 |
| `server/engine.js` | 会话、模型池、Agent 主循环、压缩、标题、日记收口 |
| `server/llm.js` | 消息组装与上游流式调用 |
| `server/tools/executor.js` | 内置工具与路径沙箱 |
| `server/tools/definitions.json` | 内置工具 schema |
| `server/routes/` | HTTP API |
| `server/public/` | 前端（无构建，按序加载脚本） |
