# AGENTS.md — agent-core (`app/`)

`agent` 仓库的 core 服务：Express + better-sqlite3 + 免构建 H5 前端，负责会话、模型调度、
Agent 主循环、工具执行、上下文管理、微信接入与定时任务。仓库级拓扑与部署见
[../AGENTS.md](../AGENTS.md)，用户视角说明见 [../README.md](../README.md)。

**运行形态**：Node 20，单进程，单实例；SQLite 同步 API（`better-sqlite3`），WAL 模式。
所有运行时状态（正在跑的回合、标题生成中、自动压缩提议额度、微信回合投递状态与实例缓存）都在进程内存里，
重启即清空——这是有意的设计，不要引入需要跨进程一致性的机制（微信投递游标 `last_msg_id` 是落库的）。

```bash
cd app && npm install
cp config.example.yml config.yml      # 本地调试记得把 workspace_root / data_root 改成仓库内可写目录
AGENT_CONFIG=./config.yml node server/server.js
```

## 启动顺序（`server/server.js`，顺序是刻意的）

1. `loadConfig(AGENT_CONFIG)` → 校验 + 默认值合并；`log.setLevel`；`llm.setPayloadTrim`。
2. `initDb(cfg.db_path)`：建表 + 幂等迁移（见「数据层」）。
3. `createBus()`：SSE 事件总线（同时支持内部订阅者，微信投递靠它）。
4. `engine.setModelPool(cfg, db, bus)` + `engine.init()`（`syncModelPool`）：注册 profile prompt、
   按配置重建 `model_pool` 槽位、清掉已删除的槽位、把 `active`/遗留 `queued` 统一归位为 `held`、
   启动空闲收口扫描器。**必须先于 scheduler 启动**，否则首轮 tick 会看到脏状态。
5. `scheduler.start(engine, p => wechat.notifyTask(p))`：注入 engine 与通知面，避免反向 require 成环。
6. `memory.prune(db, cfg)`：长期记忆保留窗兜底裁剪。
7. `wechat.init(cfg, db, bus)`：微信能力，`WXBOT_URL`/`WXBOT_TOKEN` 缺失时整体静默关闭。
8. Express 装配（顺序见「HTTP 层」）。
9. `mcp.init(cfg)`（发现 MCP 工具，失败按 2s/20s/1min 重试）→ 技能清单快照
   `llm.setSkillListText(...)` → `server.listen(PORT)` → `wechat.restore()` → `dumpPromptBundle()`
   （把实际下发的 system prompt / tools 写进 `data/prompt.txt`，供人工核对）。

`SIGTERM`/`SIGINT` 走 `shutdown()`：先 `bus.closeAllSessions()`（给 SSE 干净的流结束），再
`server.close()`，3s 后兜底硬退。容器里 node 是 PID 1，不注册信号会白等 `stop_grace_period`。

## 模块地图

| 文件 | 职责 |
|---|---|
| `server/server.js` | 装配、路由挂载、`/api/models`、`/api/health`、prompt dump、优雅退出 |
| `server/config.js` | YAML 加载/校验/默认值；`platforms` 展开成 `cfg.models`；配置文本改写（设置页） |
| `server/db.js` | 建表、索引、幂等迁移；纯 SQL 数据层，不放业务 |
| `server/engine.js` | **核心**：会话状态机、模型池调度、Agent 主循环、压缩、标题、日记收口、消息增删 |
| `server/llm.js` | 消息组装、system prompt 拼接、上游流式调用、占位裁剪、多模态块编解码 |
| `server/tools/executor.js` | 14 个内置工具实现、路径沙箱、`@会话` 跨会话只读、fetch SSRF、SQLite 工具 |
| `server/tools/definitions.json` | 内置工具 schema（发给模型的 `tools` 事实源） |
| `server/tools/skills.js` | 技能发现、`SKILL.md` 解析、参数校验与执行（远端 executor 或本地 spawn） |
| `server/mcp.js` | 极简 MCP 客户端：启动发现、工具名重名加前缀、`tools/call` 转发、`ui_card` 剥离 |
| `server/scheduler.js` | 定时任务 CRUD 校验、30s tick、存档后投递、完成通知组装 |
| `server/wechat.js` | 微信绑定、媒体落盘、上下文注入、SSE→微信分段投递、任务通知 |
| `server/routes/channel.js` | 文本命令层（`/new` `/switch` `/think` …），微信与外部接入端共用 |
| `server/routes/*.js` | HTTP API，按资源分文件 |
| `server/sse.js` | 按会话分组的 SSE 总线（`addClient`/`emit`/`onInternal`） |
| `server/auth.js` | HMAC cookie 登录、Basic 兜底、`requireAdmin`、免认证路径 |
| `server/memory.js` | 长期记忆（日记碎片）读写与检索，仅依赖 `time.js` |
| `server/time.js` | 业务时区单一入口：`TZ`、`dayString`、`stampString`、`fmtTime`、`fmtIso` |
| `server/user-profile.js` | 用户画像读写、会话快照冻结 |
| `server/public-files.js` | `mint_public_link` 的短链签发与解析（进程内 Map） |
| `server/download-token.js` | 浏览器下载链接的 HMAC 签名（密钥进程内随机） |
| `server/remote-exec.js` | 调 `agent-executor` 的 `/exec`（SSE）与预览槽清理 |
| `server/log.js` | 分级日志 `log.debug/info/warn/error(category, ...)` |
| `server/balance.js` | 平台余额查询适配器（按 `platform.type` 分发） |
| `server/version.js` | git commit/date：优先读 `version.json`（post-commit 钩子生成），宿主机有 git 时兜底 `git rev-parse`；页面版本号另外由 `routes/system.js` 的 `VERSION` 字面量决定 |
| `server/templates/` | system prompt 模板、压缩/标题指令、profile prompt |

## 一次用户消息的生命周期

```
POST /api/sessions/:id/messages
  → engine.postUserMessage
      saveMessage(user)                          // 先落库，保证不丢
      已有 looping 回合 → 返回 delivered:'live'（下一轮迭代自动带上这条）
      否则 ensureBinding → status=active → emitStatus → runLoop()（不 await）
  → runLoop → runLoopInner（最多 agent.max_tool_iterations 轮）
      loadHistory → buildMessages / compressMessages → effectiveTools(profile)
      模型调用（失败按 429/5xx 重试 agent.max_retries 次）
      unwrapToolArgs（弱模型多包一层外层时解包）+ schedule 缺 op 推断
      checkToolArgs：JSON 非法/缺必填 → 整条 assistant 标 type='errAck'
      saveMessage(assistant) + recordModelUsage
      压缩回合的收尾答复 → type='summary'，之前全部消息 → type='archived'
      无 tool_calls → 若期间又有新 user 消息则继续，否则收尾
      有 tool_calls → 逐个 executeTool → saveMessage(tool) → emit tool_result
  → finalize
      cancelled → status=cancelled
      正常     → status=held，emit done，maybeGenerateTitle，run.taskWrap → taskClockOut
  → maybeAutoCompress（回合彻底结束后才检查）
```

**给前端的是 SSE 事件，不是响应体**。前端在 `GET /api/sessions/:id/stream` 上听：
`status`、`assistant_delta`、`reasoning_delta`、`tool_call_start`、`tool_call_args`、
`tool_call`、`tool_result`、`assistant_message`、`done`、`error`、`title`、`auto_compress`、
`ui_card`，以及每 15s 的具名心跳 `ping`（注释帧不触发 JS 事件，所以用具名事件做前端看门狗）。

## 会话状态机

| 状态 | 含义 | 进入方式 | 离开方式 |
|---|---|---|---|
| `active` | 回合执行中 | `postUserMessage` / `summarizeContext` / `bindToSession`（有待答消息） | `finalize` → `held`；`stop` → `cancelled` |
| `held` | 回合结束，可继续追问 | `finalize` 正常收尾 | 超 `agent.auto_complete_ms` → `completed`；手动断开 → `completed` |
| `completed` | 已收口（纯状态，历史与绑定不动） | 断开、超时收口、清空 | 再发言直接回 `active` 续跑 |
| `cancelled` | 用户终止 | `stop` | 再发言回 `active` |
| `queued` | 旧版排队语义 | 已废弃 | 启动时归位为 `held` |

要点：`held` **不占任何资源**（没有租约、没有独占 key）；`completed` 也只是视觉收口。绑定
（`model_id` / `model_slot`）在断开、收口、重启后都保持。

## 模型池与绑定

- 配置加载时 `platforms[].models` × `platforms[].keys` 展开成 `cfg.models`：
  `id = "<平台名>/<模型id>"`（内部唯一键），`mid` 是发给上游的原始模型名。
- `model_pool` 一行一个**物理 key 槽位**，`id = "<平台名>#<key下标>"`。key 是**共享并发资源**：
  同一 key 可同时服务多个会话，没有排队、没有独占。
- `chooseKey(preferPlatform, strict)` 排序：**回合中会话数（内存 `runs`）→ 在用会话数（active/held）
  → 最久未用（`last_used_at`）→ id**。`strict` 只用于手动绑定「就要这个平台」。
- `chooseModel(platform, preferred)`：优先会话上次用过的同平台模型，否则选该平台绑定会话数最少的。
- `ensureBinding`：开回合前校验槽位在池中 + 模型仍启用；失效则自动改选（优先原平台），
  用户无感；池完全为空才报 503。
- `applyBinding` 写 `sessions.model_id` / `model_slot` / `last_model_id`，并刷新槽位 `last_used_at`。
- `bindToSession`：正在输出时拒绝（409）；换绑后有未回应消息就直接开跑。
- `vision` 决定 `read_file` 读图是否回传像素。

## 消息表与上下文组装（`llm.js`）

`buildMessages(session, language, mintUrl, profile)` 的输出顺序固定：

1. `system`：模板（`profile-default.txt` 或 profile 自定义 prompt）+ 技能清单段 + 语言指令；
   进程内按 `(profile, language)` 缓存，保证前缀缓存稳定。
2. 画像快照（`sessions.profile_snapshot`，建会话/清空时冻结）：作为首条 `user`。**不在 messages 表里**，
   压缩与归档碰不到它。
3. 历史行（见下）。

历史行规则：

- `type='archived'`：**不发模型**，UI 照常展示（压缩的核心语义）。
- `type='errAck'`：整轮移除，关联 `tool` 回执按 `tool_call_id` 一并丢弃；改以一条 `user` 错误提示
  替代（回显上轮参数形 + 真实错误），避免模型模仿自己的坏样本死循环。
- `type='summary'`：保留，作为压缩后的上下文起点。
- 含图消息：DB 里存 `{"__blocks__":[...]}` 哨兵 JSON（`encodeBlocks`/`decodeBlocks`）；
  发请求时 `image_ref` 现签公网短链（`mintUrl`，每次请求重签、不会中途过期）。
  `tool` 回执里的未消费图片会**挪出回执**，合并成该批回执之后的一条 `user` 消息
  （`tool` 角色带图是非标准形态，很多上游会吞图）；已消费的图只省略像素块，回执原样保留。
- `read_file` 读图的回执是**结构化 JSON**（`tools/executor.js` 的 `imageReceipt`：`ok` /
  `image_attached` / `reason` / `width` / `height` …），不是散文。发送侧改写只限两种真事件
  （engine 同回合/同批去重、`buildMessages` 签外链失败），一律走 `patchImageReceipt` **只改字段**。
- **已消费的图重放时只省略像素块，不改写回执**：回执是「那次读取」的历史事实，把当时成功的
  读图改写成 `image_attached:false` 会让模型以为当时就没拿到画面 → 反复重读同一条（实测循环）。
- 图片注入消息的两条硬约束（踩过循环）：①**消费判据是「最后一条写过文本的 assistant」**
  （不要求无 `tool_calls`）——旧判据只认收尾回复，多步任务里图永远「未消费」；②**只有本批新增的图
  带「一句话说明」的祈使句**，早前批次静默携带。两者合起来才断得掉「每轮要求描述 → 模型描述并继续
  调工具 → 图仍算未消费」的自维持重复循环。
- 重读去重（engine `run.imgDelivered`）**只拦同一批 tool call 内的重复读**（一次请求里塞两份同样的图
  没意义）；跨批次重读一律放行。不要写成「一回合只投递一次」，也不要靠推测「图还在不在上下文里」——
  模型说拿不到就得给，而且文件可能已重新生成（路径相同、内容不同）；拦掉只会把新像素挡在门外。
- 占位裁剪（`agent.trim_write_rounds` / `trim_result_rounds`）：距尾 ≥N 个 assistant 轮的
  `write_file.content`、`fetch`/`read_file` 回执换成单行占位。**只改发给上游的副本**，DB 与 UI 不动。
- `compressMessages` = `buildMessages` + 末尾一条压缩指令 `user`。**铁律**：压缩请求必须与上一次
  常规请求字节同构、只在尾部追加；不要为了省 token 在压缩回合抽掉快照或裁剪历史，断前缀缓存等于全价重读。
- `titleMessages`：不带 system prompt，只取 user/assistant 纯文本行（白名单 `null`/`summary`/`task_brief`）
  + 末尾标题指令。

`callModel`：`body.model` 用 `mid`；固定 `stream:true` + `stream_options.include_usage`；
`extra_params` 合并进 body；`deepThink` 时再合并 `thinking_params`；`reasoning_ack_field` 非空时把
内部键 `__reasoning` 改名为该字段回传（否则剥除，内部键不出仓库）。返回
`{content, reasoning, tool_calls, finish_reason, usage, aborted, sseFrames}`；正文开头混入的
`<think>` 块会被 `splitInlineThinking` 剥离到 reasoning。

## 工具层

- 工具全集 = `definitions.json`（14 个内置）+ MCP 发现结果；再依次叠 profile 的 `tools_allow`
  白名单、`tools_deny` 黑名单（**deny 赢**；profile 不配 deny 时继承全局 `tools_deny`）。
  `tools_allow: []` = 零工具（纯文本组合）。过滤只影响"模型看得到什么"，名单外工具若真被调用，
  `executeTool` 仍会执行（不误杀）。
- MCP 服务按 `mcp_servers[].mode` 参与：`advertise`（默认）进 `toolDefs` 下发；`skill` 只进
  `toolIndex`（`mcp.hasTool` 为真，`lab` 可调），且由 `skills.js` 自动
  包装成技能（`mcp.skillTools()` / `getSkillTool()`，get 返回注册表里的原始 inputSchema）；
  `disable` 连 `tools/list` 都不发。旧字段 `enable` 已废弃，`mode: silent` 已移除，
  出现即报配置错（不静默忽略）。
- `executeTool(baseCtx, name, args)`：先查 `HANDLERS` 表，未命中再交给 MCP 注册表。
  `ctx = {sessionId, taskDir, run, cfg, db, vision}`；工具返回字符串，`read_file` 读图时返回
  `{text, image_rel}`（`text` 是结构化 JSON 回执，由 engine 转成 `image_ref` 块）。
- **路径沙箱**：所有路径经 `resolveInTask` 解析到 `taskDir` 内；`/tmp` 会被映射到
  `<taskDir>/.tmp`（与 executor 容器里 `/tmp` 的 bind 对齐）。符号链接越界一律拒绝。
- **跨会话只读**：`@<session-id>/<rel>` 只允许 `list_directory`、`read_file`、`copy_path` 的
  `source_path`，且只限同一用户的会话。写侧显式拒绝——否则会造出字面 `@task-x` 目录。
- `checkToolArgs` + `unwrapToolArgs`：前者做结构性预检并生成 `errAck`，后者按 schema 逐层剥掉
  弱模型多包的信封。两者都是纯函数并已导出，便于回归验证。
- 技能（`tools/skills.js`）：`SKILL.md` front matter 提供 `description`/`input_schema`。
  front matter 的 `thinking: true` 会在 `get` 时把 `run.deepThink` 置真（不影响脚本本身）；
  每回合只触发一次，engine 经 SSE `think_auto` 同步前端，开启后保持到用户手动关闭。
  工具参数是扁平的 `{op, name, args}`：`op` 必填且三选一（`list`/`get`/`run`），`name` 供
  get/run 指认技能，`args` 仅 run 用；条件必填写不进 schema，由 `toolSkill` 校验并点名。
  `toolSkill` 在入口把旧字段名 `input_args` 归一化成 `args`，之后只走一条分派路径
  （曾有两条路径，其中一条只读 `input_args`，会静默丢参）。
  `input_schema.required` 在 `run` 前校验；相对路径参数按会话目录转绝对路径；入口一律用绝对路径
  （远端 cwd 是会话目录）。配了 executor 就走 `remote-exec`，否则本地 `spawn`。
  模型可见的技能清单是 `listCallableSkills`（目录技能 + `mode=skill` 的 MCP 工具，同名时目录胜出）；
  设置页的技能 API 仍只用 `listSkills`（按目录增删改），两者不要混用。
  mode=skill 的 MCP 技能在 `runSkill` 里位于 `absolutizeArgs` **之前**：直接 `mcp.callTool` 转发
  （不落沙箱，也不需要密钥），因此 URL 与含 `/` 的 prompt 不会被当路径改写；同样不跑
  `input_schema.required` 校验（参数与 MCP 工具自己的 `op` 相关，交给服务管）。
- MCP（`mcp.js`）：启动时 `initialize` → `notifications/initialized` → `tools/list`；与内置或已有
  MCP 工具重名时加 `<服务名>__` 前缀；请求随带 `X-Session-Dir`、`X-Public-Base`；
  `content` 里的 `ui_card` 块不进模型上下文，转成 SSE `ui_card` 事件。

## 数据层（`db.js`）

表：`sessions`、`messages`、`files`、`model_pool`、`meta`、`scheduled_tasks`、`channel_sessions`、
`memory_fragments`、`wechat_bindings`、`model_usage`、`user_profiles`；`wait_queue` 是废表。

- 时间戳统一 **毫秒整数**；`memory_fragments.day` 是 `Asia/Shanghai` 的 `YYYY-MM-DD` 字符串。
- `messages` 的 `type` 取值：`NULL`（普通）、`archived`（不进模型）、`summary`（压缩摘要）、
  `errAck`（参数错误轮，整轮不进模型）、`channel_note`（微信渠道上下文）、`memory_note`（开场日记）、
  `scheduler_note`（定时任务通知行）；`summarize_request` / `task_brief` 是历史遗留类型。
- 外键：只有 `scheduled_tasks` 有 `ON DELETE CASCADE`；删会话时 `messages`/`files`/日记碎片/通道绑定
  由 `engine.deleteSession` 显式清理，`model_usage` **故意保留**（用量统计不清账）。
- **迁移方式**：`initDb` 里用 `try { ALTER TABLE ... } catch {}` 幂等补列，没有 down migration、
  没有迁移版本号。新增列时：① 写进 `CREATE TABLE`；② 同时加一条 `PRAGMA table_info` + `ALTER`
  （老库升级用）。删除列改用"保留但代码不再读写"（SQLite 删列不值得）。
- WAL 模式下备份 `data/` 时要连同 `-wal`/`-shm` 一起。

## 后台生命周期任务（都在 `engine.js`）

| 机制 | 触发 | 关键约束 |
|---|---|---|
| 自动标题 | `finalize` 正常收尾 | 有标题即跳过；本轮真执行过工具才立题，否则要求非注入 user 行 ≥3 条且 ≥30 字；最多 60 字 |
| 收口补题 | 两个 sweep 各补一次 | `force` 跳过字数门槛（收口是最后一站）；其余守卫不变 |
| 自动压缩提议 | `runLoop` finally | 回合 In token 峰值 ≥ `agent.auto_compress_tokens`；延迟 1.5s；每会话至多一次；只发提议，由用户确认 |
| held 超时收口 | 定时扫描 | `agent.auto_complete_ms`；纯状态动作，历史/绑定不动 |
| 日记收口 | 空闲扫描 | `memory.wrap_idle_ms`；`journaled_at` 占坑防重复；候选模型链最多 3 个；删会话连带删碎片 |
| 定时即下班 | 回合内创建过定时任务 | `run.taskWrap` → `finalize` 后 `taskClockOut`：用 brief 落碎片、归档、解绑通道 |
| 记忆裁剪 | 启动 + 每次追加 | `memory.retain_days`（0 = 永久保留） |

所有扫描定时器都 `unref()`；后台任务 fire-and-forget，异常只记日志，**绝不阻塞消息主路径**。

## 定时任务（`scheduler.js`）

- 每会话至多一个任务（表主键就是 `session_id`），最小间隔 1 小时，时区固定 `Asia/Shanghai`。
- 每 30s tick。投递前**先** `archiveHistory`（全部消息 `type='archived'`）**再** `postUserMessage`，
  顺序不能反：投递会同步起回合，存档晚一步模型就会带着旧上下文开跑。
- 状态：`running` → 下一轮 tick 发现会话已非 `active` → `ok`（异常结束也会记 ok，已知局限）；
  会话仍 active → 跳过本次记 `skipped`；投递抛错记 `error` 并通知。
- 完成通知由 `server.js` 注入的 `wechat.notifyTask` 送出；`scheduler` 不反向 require `wechat`。

## 微信与命令层

- `wechat.js` 负责绑定表、扫码实例、媒体落盘（`MEDIA_MAX_BYTES=20MB`）、渠道上下文
  （`channel_note`）、开场日记（`memory_note`）、SSE→微信投递（配额、分段、附件、工具台账、UI 卡片）。
- `routes/wechat.js` 有两个导出：
  - `router`：Web 设置页用，挂 `auth.middleware` 之后，按 `req.user` 隔离；
  - `hookRouter`：wxbot 回调（`/wxhook/inbox|hook`），挂**全局 `express.json(2mb)` 之前**，
    自带 32mb 解析器（媒体 base64 超 2mb），用共享 Bearer token 常量时间比较把门。
- `routes/channel.js` 是"无 UI 端的按钮替代品"：命令只在 `/api/channel/send` 解析，Web 上以 `/`
  开头的文本照常发给模型。数据面零特殊，全部走 `engine` 既有函数。

## HTTP 层

挂载顺序（`server.js`，顺序即语义）：

```
/wxhook            ← 内部回调，早于 body 解析（大 body）
express.json(2mb)
auth.router        ← /login /logout /api/login /api/login_restore /api/password /api/me
/p                 ← 公网临时文件，匿名可达（22 字符随机 ID + 服务端过期）
auth.middleware    ← 其余请求需登录（cookie 优先，Basic 兜底）
preview-proxy.earlyGuard
express.static(public)
/api/sessions ×3   ← sessions / messages / files
/api/skills
/api/config        ← requireAdmin
/api/platforms
/api/system        ← /restart 需 admin，其余登录即可
/api/users         ← 管理员；写盘后热更新
/api/profile
/api/memory
/api/wechat
/api/channel
data-page          ← GET /app/:task_id/*、POST /api/db/:task_id/query
preview-proxy.mount（末尾兜底）
```

- 错误形状统一 `{ error: string }`，`err.status_code` 决定 HTTP 码。
- 认证：HMAC 签名 HttpOnly cookie（`agent_token`），`Authorization: Basic` 兜底，
  `Authorization: Bearer` 仅用于 `/api/login_restore`。`auth.users` 为空 = 完全关闭认证。
- **单租户警告**：除管理员接口外不做资源级授权；按用户的会话列表隔离在查询层（`sessions.user`）。
- 公网短链 `/p/<id>` 的信任模型：随机 ID + 服务端 TTL + 签发时 `realpath` 校验，不靠登录态。

## 前端（`server/public/`）

- **无构建**：`index.html` 按顺序加载经典脚本，共享全局作用域：
  `core.js → chat.js → sessions.js → stream.js → files.js → preview.js → settings.js`
  （`settings.js` 必须最后，尾部有全局初始化）；`marked.min.js` 走 `vendor/`。
- 新增 JS 文件必须同时改 `index.html` 的 `<script>` 顺序——没有 import/export，顺序就是依赖。
- `sw.js`：HTML/JS/CSS 网络优先，图片/JSON 缓存优先。**改图片或 JSON 才需要升 `CACHE_VERSION`**；
  JS/CSS 改动不需要。
- 另有 `login.html`、`memory.html`（日记调试页）。
- API 调用统一走 `core.js` 的 `req()`；SSE 用 `EventSource` + 前端看门狗。

## 扩展指南

**新增内置工具**

1. `tools/definitions.json` 加 schema（遵循 `../docs/tool-design.md`：共享标识空间/生命周期就用 `op` 合并）。
2. `tools/executor.js` 写 `toolXxx(ctx, args)` 并注册进 `HANDLERS`。
3. 若返回图片，返回 `{text, image_rel}`（且 `read_file` 之外的语义要想清楚）。
4. 更新 `../docs/tool-design.md` 相关说明、README 工具表。
5. 注意：tools 数组每轮全量重发，能并进已有 `op` 就不要新开工具。

**新增 HTTP 路由**

1. `routes/<name>.js` 用 `express.Router()`，错误用 `err.status_code` + `{error}`。
2. 在 `server.js` 按"鉴权边界"选择挂载位置（是否需要 admin、是否需要匿名）。
3. 若放在 `auth.middleware` 之后，`req.user` 可用（未启用认证时为空串）。

**新增 DB 列**

1. 写进 `db.js` 的 `CREATE TABLE`；2. 加 `PRAGMA table_info` + `ALTER TABLE` 幂等迁移；
3. 想清楚旧值语义（默认值、回填语句）与删会话时的清理归属。

**新增 SSE 事件**

1. `engine`/`wechat` 里 `bus.emit(sessionId, '<event>', data)`；
2. 前端 `stream.js`/`sessions.js` 监听并处理重连后的幂等（事件可能重放，DB 才是真相）。

**新增配置项**

1. `config.js` 的 `DEFAULTS`；2. `config.example.yml` 同步；3. 若需重启才生效，不要假装热加载。

**改 prompt / profile**

- 默认 prompt：`templates/profile-default.txt`（`{APP_SKILLS_SECTION}` 占位技能清单）。
- 压缩/标题指令：`templates/prompt-compress.txt` / `prompt-title.txt`。
- 自定义组合：`config.yml` 的 `model_profiles` + 模型的 `profile: <名>`；改完重启。

## 陷阱清单（都是踩过的）

- **循环依赖**：`engine` 绝不 `require('./wechat')` 或 `require('./scheduler')`，否则拿到半成品
  exports。通知面/engine 引用一律由 `server.js` 注入。`executor → scheduler` 是单向的，安全。
- **tool_call 配对**：删 assistant 必须连带删该轮的 `tool` 回执；删单条 `tool` 回执必须从父
  assistant 的 `tool_calls` 里摘除，纯工具轮且无文本时整行删掉。否则上游拒收整个请求。
- **errAck 必须整轮排除**：只丢 assistant 不丢 tool 回执会留下孤儿 `tool` 行。
- **`archived` ≠ 删除**：UI 仍展示，只是不进模型；不要用删除来实现压缩。
- **清空会话**（`clearSessionMessages`）要一并：删消息、清 `.tmp`、删日记碎片、复位标题与
  `journaled_at`、重新冻结画像快照；但定时任务"专柜"会话例外（碎片与 `journaled_at` 保留）。
- **微信 `deep_think` 默认值**：历史库曾按默认 1 补列，`db.js` 里有重建表把默认改回 0 的逻辑，
  别删。
- **`/wxhook` 必须在全局 `express.json` 之前**，否则 2mb 限制会拒掉媒体 base64。
- **`/p/<id>` 必须在 `auth.middleware` 之前**（外部服务不带 cookie）。
- **preview-proxy 的 `earlyGuard`** 必须在 `express.static` 之前，否则 vendor 预览页的根路径请求
  会被静态首页吃掉。
- **短链签发要复核 `realpath`**：任务目录里可能有权向外部的符号链接。
- **`agent.max_tool_iterations` 是硬闸**：打满会追加一条停止提示，不要让循环无上限。
- **不要给 tick / sweep 加同步重活**：它们跑在主线程，会直接卡住所有会话。
- **改动 `package.json` 必须重建镜像**（`node_modules` 在镜像层，只有 `app/server` 是挂载的）。
