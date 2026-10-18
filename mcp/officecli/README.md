# officecli

Office 文档（.docx / .xlsx / .pptx）创建、检视、修改 + 浏览器实时预览的 MCP 服务。

上游开源 CLI：[officecli](https://d.officecli.ai)（.NET self-contained 单文件二进制，**不进 git 也不进镜像**；容器首次启动由 `scripts/entrypoint.sh` 拉取到命名卷缓存，pin 版本 + 每次启动 sha256 校验）。
本目录是一个**零 npm 依赖**的 node shim：把 officecli 自带的 stdio 形态 MCP 桥成
Streamable HTTP，外加一个按任务路径路由的预览网关。

- 协议：MCP **Streamable HTTP**，端点 `POST /`（任何路径都收）
- 鉴权：**无服务端鉴权**，只挂 `agent-mcp-net`（公网必须经 agent-core 登录门禁反代进来），永远不要映射出去
- 端口：`3000`（MCP）+ `3100`（预览网关，单入口）；`26315..26318` 是 watch 进程内部回环端口，不出容器

## 结构

| 文件 | 职责 |
| --- | --- |
| `server.js` | 入口（容器 PID1）：常驻 `officecli mcp` stdio 子进程 + JSON-RPC id 重映射；命令治理（绝对化 / 隐去命令 / 扩展命令 / help 对齐，见下）；save/close 附交付取件链、文件缺失附同步教学；桥级失败自动换子进程 |
| `watch.js` | 预览槽位管理：spawn `officecli watch`（只绑 127.0.0.1，vendor 限制），url 按任务组织，槽位号不出容器；`/f/<id>` 交付能力链签发与取件；scratch 过期清理 |
| `gateway.js` | 预览网关（:3100）：按路径把请求路由到槽位 watch；Referer 兜底 vendor 页面硬编码的根绝对 API；Host/Origin 成对改写回环自源 + 头白名单 |
| `scripts/entrypoint.sh` | 容器入口（ENTRYPOINT）：确保二进制就位（`/opt/officecli`，compose 挂命名卷 `officecli-bin` 缓存；pin 在本文件，镜像升级=版本升级；源链 GitHub → gh-proxy 备源，可 `OFFICECLI_URL`/`OFFICECLI_MIRROR` 加源）→ exec 服务命令；拉不到 fail fast 教手动动作 |

## 工具面与命令治理

只有**一个工具** `officecli`（command 字符串或 argv 数组，原样交给 CLI；schema 查询 `{"command":"help docx paragraph"}`）。
模型看到的描述 = vendor 原文 + 一句扩展命令能力陈述；**行为约束全部代码化，不写教条**：

| 机制 | 行为 |
| --- | --- |
| 相对路径自动绝对化 | 调用方（agent-core）每请求带 `X-Session-Dir`，裸文件名/相对路径自动补全会话目录（`key=value` 属性值亦可，如 `src=a.png`；AI 无感，与 terminal 直觉一致）；`--type picture` 的 `path=` 属性自动别名为 vendor 真名 `src=` |
| 隐去命令（报原生风格 `Unrecognized command or argument 'X'.`，help 清单同步对齐：删隐去行、补录扩展行） | `mcp`（自锁死）、`skills` / `install` / `plugins`（装环境类）；`watch` 的 mark/unmark/marks/goto 子命令同理 |
| `view` 渲染族屏蔽 | 其它模式（outline/stats/issues/text/annotated）照常透传；仅渲染族 `view <file> html` / `screenshot` / `svg` / `pdf` / `forms`（需无头浏览器/导出插件）拦截，返回 `view <mode> is disabled by environment policy. Use 'view <file> outline' or 'view <file> issues' for structural/semantic checks.` |
| 回包文案 | `create` / `open` / `push` 成功只回 `Created/Opened/Imported: <相对会话目录文件名>`；预览链接不随回包出现（固定格式 `<公网前缀>/preview/<会话id>/<相对路径>/`，前端自己拼，AI 面不需要知道）；`save` / `close` 成功附 `download url:`（限时取件链，同文件复用同一链接）；失败文案剥掉工作区路径前缀与 vendor 异常包装，只留文件名 |
| 桥内拦截（对 AI 不公示） | `watch` / `unwatch <file>` 仅本会话目录（必须拦截：vendor 原生 watch 会占死 stdio；help 里同步不显示）；`unwatch --session <id> [--purge]` 校验 id==X-Session-Dir 尾段，core 会话清理钩子专用 [--purge 杀槽外连带删会话目录副本，幂等]；`get-pos <file>` 改写原生 `get … selected --json`；`push <url> <file>` 外链拉入（http(s) only、100MB、非覆盖需 `--force`；读不到外链时报「读取文件失败」而非「下载失败」——AI 视角是上传） |
| 用法指引投递 | `load_skill office-preview` 只讲：get-pos / 两份盘同步；不出现 watch、不出现预览 url |

`get` / `query` / `set` 等短命令照常透传（与槽位 watch 进程同容器 IPC 直达）；`get-pos` 即桥内改写的 `get … selected --json`。

## 预览链路（为什么 watch 必须待在本容器）

刷新信号 = officecli watch 进程内的 IPC，所以 watch 只能与 officecli 同容器；
槽位进程由shim（容器 PID1）托管才能跨 MCP 调用存活。浏览器不直连本容器，
必须经 agent-core 的通用预览反代（登录 cookie 即门禁，对外依旧只开 core 一个端口）：

```
用户浏览器（已登录 agent）
   │  https://<core 公网地址>/preview/<会话id>/<文档相对路径>/...
   ▼
agent-core  routes/preview-proxy.js（注册表驱动，信任模型同 data-page）
   │  头白名单转发（Referer 兜底 vendor 页面的根绝对 /api/*、/events）
   ▼
mcp_officecli:3100  gateway.js ——按路径找槽位、改写 Host/Origin 回环自源──► 127.0.0.1:26315+N  officecli watch
```

- url 按任务组织：文档必须在会话目录下（`<WORKSPACE>/<会话id>/…`，任务根下不可预览）；重启换槽不影响链接含义。
- 预览 url 不由本服务下发：链接按固定格式 `<公网前缀>/preview/<会话id>/<文档相对路径>/` 由前端自拼；`X-Public-Base` 仅供桥内 watch 状态/日志用，对 AI 的回包里 `url`/`path` 字段已被剥掉。
- 槽位数 `OFFICE_SLOTS`（默认 4）；满了优先踢「无活动连接且最久未用」；闲置超 `OFFICE_IDLE_MS`（默认 6h）回收，挂着活动连接的槽不回收；预览每一帧回传与 AI 命令都会续命。
- 槽位是缓存不是承诺：预览链接按任务路径寻址，被回收/挤占后页面再访问由网关就地复活（一次冷启动）。
- AI 面不公示 watch/unwatch（也没有 watch ls / --all 这类跨会话动作）：预览完全由前端拼链接、网关按需复活槽位 + LRU 管理；core 删会话时经校验的 `unwatch --session <id> --purge` 清槽并删工作区目录副本（不等 scratch TTL）。
- 同一文件同时只允许一个 watch（vendor 限制；同文件并发 watch 已合并为一次启动）。

## 两份盘与同步（push / download url）

容器工作区与 `agent/tasks/<会话id>/` 是两份盘；桥负责在响应里教会 AI 换盘动线（拦截即教学，不设协议）：

| 方向 | 动线 | 执行者 |
| --- | --- | --- |
| 任务目录 → 工作区 | `mint_public_link` 签发外链 → `officecli push <url> <file>` | 桥拉入（护栏：WORKSPACE 内、白名单扩展名（office/图片/常见数据）、100MB、非覆盖需 --force） |
| 工作区 → 任务目录 | `save <file>` / `close <file>` 回包尾附 `download url` → AI 在自己终端下载 | AI（executor 的会话 jail 天然框住写路径，core 零改动零新 API） |

- 每次改动命令返回前落盘（compose 置 `OFFICECLI_RESIDENT_FLUSH=each`）：编辑即自动保存，save/close 的主要作用只是签发取件链。
- 成功/失败文案只带相对文件名，不出现工作区绝对路径：工作区与任务目录同名不同盘，全路径极易让 AI 误判文件落点。

- 取件链 `GET /f/<随机id>`：与 core `/p/` 同款能力链（随机不可猜 + TTL + 只吐 guard 过的路径），只在内部网络可达（core 反代只转 `/preview`，公网够不着）。同一文件重复 save/close 复用原 token（滑动 TTL，链接永远指向盘上最新内容）。过期 404 文案提示重新 save。
- vendor 命令报"文件不存在"且引用路径确实缺失时，桥在错误尾附 push/交付动线提示；`X-Session-Dir` 首次出现时桥顺手 mkdir 会话目录。
- core 会话删除时 `engine.deleteSession` 尽力打一发 `unwatch --session <会话id> --purge`（`mcp.notifyTool`，失败只记日志）：桥端杀预览槽 + 删 `tasks/<会话id>` 工作区副本，幂等。

## 请求头契约（调用方 → 本服务）

| 头 | 说明 |
| --- | --- |
| `X-Public-Base` | core 公网前缀（已归一），仅供桥内 watch 状态展示；预览 url 不再下发给 AI，缺省也无影响 |
| `X-Session-Dir` | 本次调用的会话工作目录，用于裸文件名/相对路径补全；core 的 mcp.js 从工具执行 ctx 自动注入，其它 MCP 服务忽略即可 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OFFICE_WORKSPACE` | `/workspace/tasks` | 容器内工作区根（独立 scratch 卷，布局同构 `/<会话id>/...`；与 core 的 tasks 不同盘，数据交换只走 push / save 交付链） |
| `OFFICE_SLOTS` | `4` | 预览槽位数（内部端口段宽度） |
| `OFFICE_IDLE_MS` | `21600000`（6h） | 槽位闲置回收阈值；有活动预览连接的槽不回收，链接再访问自动复活 |
| `OFFICE_PREVIEW_PORT` | `3100` | 预览网关端口（与 core 注册表对齐） |
| `OFFICE_PREVIEW_PREFIX` | `/preview` | 预览 url 的路径前缀（与 core 注册表 prefix 一致） |
| `OFFICECLI_TIMEOUT_MS` | `120000` | 单次 MCP 请求等 officecli 回包的上限，超时 换子进程 |
| `OFFICE_DL_BASE` | `http://mcp_officecli:3100` | download url 的前缀（executor 可达的内网地址；改服务名时覆盖） |
| `OFFICE_DL_TTL_MS` | `1800000`（30min） | 取件链有效期，过期 404 并提示重新 save |
| `OFFICE_SCRATCH_TTL_MS` | `604800000`（7d） | scratch 会话目录闲置清理阈值（每小时一次 + 启动后 10s 首扫；槽位占用的目录不碰；0=关） |
| `OFFICE_SCRATCH_MAX_BYTES` | `2147483648`（2G） | scratch 容量水位：总量超限时按目录 mtime 从旧到新删非 busy 目录，删到 80% 为止（0=关） |
| `OFFICECLI_NO_AUTO_RESIDENT` | compose 置 `1` | 关 vendor 自动 resident：实测时延零增益，消掉 file_locked 冲突与常驻进程堆积（vendor 未公开变量，help 只写 `OFFICECLI_RESIDENT_FLUSH`） |
| `OFFICECLI_RESIDENT_FLUSH` | compose 置 `each` | 每次改动命令返回前落盘（含 open 起的 resident）：编辑即自动保存，save/close 只为签发取件链 |

## 部署与调试

`docker-compose.yml` 中的 `mcp_officecli` 服务构建本目录；工作区用独立命名卷 `office-scratch`，
**刻意不挂 `../agent/tasks`**：容器对会话数据盲视，泄漏面归零；容器内路径仍同构 `/workspace/tasks/<会话id>/...`，AI 无感。

二进制不进库也不进镜像：首次启动 entrypoint 自动拉取到命名卷 `officecli-bin`（容器重建不重拉；每次启动 sha256 秒级校验；版本 pin 在 `scripts/entrypoint.sh`，改版本=改文件重新 build）。GitHub 不通自动落 gh-proxy 备源；都失败则启动 fail fast（日志教手动动作，`unless-stopped` 重启即重试）；`down -v` 清卷后下次启动自动重拉。

**离线放置**：GitHub 与备源都不可达的机器，把同名二进制放进挂载目录即可（sha256 对上就认）：`docker cp <file> mcp_officecli:/opt/officecli/officecli` 后 restart，或把 compose 里 `officecli-bin` 卷换成 bind 挂载。

```bash
docker compose up -d --build mcp_officecli   # clone 后即可直接起；首启多一次二进制下载（仅首次）
# MCP 健康检查（含预览槽位列表）
docker exec mcp_officecli node -e "fetch('http://localhost:3000/').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))"
#预览网关健康检查
docker exec mcp_officecli node -e "fetch('http://localhost:3100/gateway-healthz').then(r=>r.text()).then(console.log)"
```

agent 侧两处登记（缺一不可）：`config.yml` 的 `mcp_servers: [{name: officecli, url: "http://mcp_officecli:3000/"}]`；
core 预览注册表默认已含 officecli（`routes/preview-proxy.js`，改 config.yml 后重启 core 生效）。
