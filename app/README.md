# agent-core

`agent` 仓库的 core 服务：Express + SQLite + 静态 H5 前端。

对外能力、部署与配置见仓库根 [`../README.md`](../README.md)；内部结构、数据模型与修改约束见 [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)。

## 本地运行

```bash
cd app
npm install
cp config.example.yml config.yml
# 本地调试时把 workspace_root / data_root 改到仓库内可写目录
AGENT_CONFIG=./config.yml node server/server.js
```

默认监听 `8090`。`platforms` 可以留空，启动后到设置页添加模型并重启。

## 测试

```bash
npm test
```

端到端冒烟测试会启动 mock 模型上游（`:9999`）和真实 server（`:8099`），测试数据隔离在 `test/tmp`。

> 注意：`test/smoke.js` 仍有旧断言——排队已从运行期移除，且 `GET /api/sessions/:id` 不再直接返回 `role=tool` 行（改为按需加载）。当前会在 `[2] 工具调用` 与 `[5] 排队调度` 失败；修改相关路径时先同步测试，不要把它当作全绿基线。

其他测试：

```bash
node test/remote-exec.test.js   # 远端 executor 集成
node test/trim-smoke.js         # 历史裁剪
node test/dep-check.js          # 依赖完整性
```

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

修改前先读架构文档的「修改时必须遵守的约束」一节。
