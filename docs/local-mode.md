# 本地端（local 模式）：设计与交接

> 本文是 `local/` 的设计说明 + 交接单。
> **状态：代码已写完，仅在 Linux 服务器上做过「能否启动」的粗测，尚未在 macOS 真机验证。**
> 下一轮的任务就是按第 6 节的清单在 mac 上逐项确认。

## 1. 目标

把同一个 `agent-core` 直接跑在本机（macOS / Linux），**不装 Docker、不起 executor**，形态类似
桌面 agent：给它一个工作目录，它在这个目录里放开手脚干活。

明确的设计约束（都来自讨论）：

- **和服务器端同一份代码**，不 fork 新仓库、不长期开 branch；靠运行时开关分叉
- **`app/` 最小化改动**（最终只有 2 个后端文件，前端 0 改动）
- **组件按需**：node 必需；ffmpeg 决定语音；python3 决定技能
- **Windows 暂时不做**（本机执行依赖 POSIX 语义，见第 7 节）
- 不用 Docker（用户明确否决）

基线版本：`v2.5.0`（服务器端最后一个纯容器部署版本）。

## 2. 与服务器形态的差异（只有三处）

| 差异 | 服务器 | 本地 | 由谁注入 |
|---|---|---|---|
| 命令在哪跑 | `agent-executor` 容器（mount/pid namespace 隔离） | 本机 `spawn`（**无沙箱**） | `EXECUTOR_URL` 留空 → 现成分支，未改代码 |
| 文件工具的根 | 会话目录 `tasks/<会话id>/` | 指定的工作目录 | `AGENT_FILE_SCOPE=workspace` |
| 监听地址 | `0.0.0.0` | `127.0.0.1` | `HOST=127.0.0.1` |

后两项是本次新增的开关。**两者都不设置时，行为与 v2.5.0 完全一致**（容器部署不受影响）。

## 3. 本次改动清单

### 后端（`app/`，只 2 个文件）

| 文件 | 改动 |
|---|---|
| `app/server/server.js` | 读 `HOST` 环境变量；有值则 `server.listen(PORT, HOST, cb)`，无值维持 `listen(PORT, cb)`（= `0.0.0.0`）。启动日志带上 host |
| `app/server/tools/executor.js` | 新增 `WIDE_SCOPE`（由 `AGENT_FILE_SCOPE=workspace` 打开）与 `fsRoot(ctx)`；`resolveInTask()` 增加可选第三参 `rootDir`；6 个业务工具的调用点改为传 `fsRoot(ctx)`；`recordFile()` 跳过会话目录之外的文件 |

`resolveInTask` 的两个分叉点：

1. **根**：`rootDir` 给了就按它校验（workspace 形态 = `workspace_root`），否则仍按会话目录
2. **`/tmp`**：`session` 形态保持「重定向到 `<会话>/.tmp`」；`workspace` 形态**不重定向**，并把真实
   `/tmp` 纳入允许范围

### 刻意没有动的（重要）

- `resolvePastPath()`（`@<会话id>/...` 跨会话只读）—— 仍锁在对方会话目录
- `routes/files.js`、`routes/public-files.js`、`routes/data-page.js` —— HTTP 文件 API 与公网短链
  仍按会话目录校验，前台不能借本地模式越权
- `mint_public_link` —— 仍会话目录语义（本地本来也没配 `public_link.base_url`）
- 前端 —— 一行没改；首次配置靠终端提示「用户区 → 设置 → 模型池」

### 新增 `local/`

| 文件 | 作用 |
|---|---|
| `start.sh` | 主入口：探测 → 首次生成配置 → 装依赖 → 起 core + 4 个 MCP → 开浏览器 → 守护重启 |
| `start.command` | macOS 双击入口（补 Homebrew 的 PATH，失败时留窗口） |
| `config.example.yml` | **仅作参考，不被读取**；实际配置由 `start.sh` 生成到 `config.local.yml` |
| `README.md` | 给使用者的说明（含安全边界、已知限制） |

`.gitignore` 增加 `local/.runtime/`、`local/config.local.yml`。

## 4. 关键设计决定（含「为什么」，别推翻）

### 4.1 开关用环境变量，不进 `config.yml`

`EXECUTOR_URL` / `ASR_URL` 已经是「部署接线走 env」的先例，本地模式属于同一类（部署形态），
不是平台配置。好处是 `app/` 只需改 2 个文件，不必动 `config.js` 的 `DEFAULTS` 和
`config.example.yml`（改配置项必须两处同步，是仓库的硬规则）。

### 4.2 配置**首次生成后永不覆盖**

`config.local.yml` 里既有启动器生成的字段（`workspace_root` / `skills_root`），也有用户在网页里
配的东西（`platforms`、API Key、MCP headers）。每次启动重写会直接冲掉后者。

推论：**能力变化不能靠改配置实现**，只能靠 env / 起不起子进程 / 软链（见 4.3、4.4）。

### 4.3 ffmpeg 是运行时能力，与配置解耦

`routes/asr.js` 直接读 `process.env.ASR_URL`，`/api/asr/status` 在 `ASR_URL` 为空时返回
`enabled:false`，前端 `voice.js` 据此**自动隐藏麦克风**。所以：

- 有 ffmpeg → 启动器起 `mcp_asr` + 注入 `ASR_URL`
- 没 ffmpeg → 不起、不注入 → 麦克风自动消失

装完 ffmpeg 后**重跑脚本**即生效，配置文件一个字不用改。

### 4.4 python3 用软链切换，与配置解耦

`skills.js` 对技能根目录不存在的行为是「warn + 返回空列表」，不报错不阻塞。于是配置里永远写
`skills_root: <仓库>/local/.runtime/skills`，启动器每次都重建这个软链：

- 有可用 python3 → 指向 `<仓库>/skills`
- 没有 → 指向 `.runtime/empty-skills`（空目录）

装完 python3 重跑脚本即生效。**没有改 `skills.js` 一行代码。**

### 4.5 启动器必须是守护进程

`routes/system.js` 的重启实现是「校验配置 → `process.exit(0)` → 等 Docker restart 策略拉起」，
注释里写明「非 docker 部署不会自动重启」。本地没有 Docker，如果启动器只是前台 `node`，
用户配完模型点一次「重启」，服务就再也回不来。

所以主循环是：起 core → 等健康 → `wait` → 非用户中断就 1 秒后重启；连续异常退出 5 次才停
（防配置写坏导致无限刷屏）。`exit 0` 视为用户主动重启。

### 4.6 四个 MCP 必须分端口

容器里它们是四个独立容器、都监听 3000；本地同机必须错开（默认 3101~3104）。
另外**它们的启动参数不统一**，这是个坑：

| 服务 | 启动方式 | 说明 |
|---|---|---|
| `web_search` | `node server.js --http --host --port` | 默认 host 已经是 `127.0.0.1` |
| `image_task` | `node src/mcp-server.js --http --host --port` | 默认 `0.0.0.0` |
| `video_task` | `node src/mcp-server.js --http --host --port` | 默认 `0.0.0.0` |
| `mcp_asr` | **只认 `PORT` 环境变量** | 不解析 argv，且 `listen` 没带 host（= `0.0.0.0`） |

所以 `start.sh` 拆成 `start_mcp_flags` / `start_mcp_env` 两个函数，别合并。

### 4.7 `/tmp` 语义为什么分叉

服务器端：executor 在 session 模式下执行 `mount --bind <会话>/.tmp /tmp`，容器内 `/tmp` 的物理
落点就是宿主 `<会话>/.tmp`。core 的文件工具必须去同一处找，否则 AI 用 terminal 写 `/tmp/x` 后
`read_file /tmp/x` 读不到。所以那份「重定向」是**必需的**，不是 bug。

本地端：`toolTerminal` 是真 `spawn('/bin/sh')`，`/tmp` 就是本机 `/tmp`。此时再重定向就会造成
「terminal 写真实 /tmp、file 工具读会话 .tmp」的错位——这正是 `AGENT_FILE_SCOPE=workspace`
要关掉重定向的原因。

### 4.8 `skills_root` 的默认值陷阱

`skills.skills_root` 留空时默认取 `workspace_root` 的**同级** `skills` 目录。本地把
`workspace_root` 指到用户选的目录后，默认值会变成不存在的 `<用户目录>/../skills`。
因此生成的配置必须显式写死 `skills_root`。

## 5. 已验证 / 未验证

### 已在 Linux 服务器上粗测（`PORT=18090`，避免碰线上 8090）

| 项 | 结果 |
|---|---|
| `sh -n` / `node --check` | 通过 |
| 首次运行生成 `config.local.yml` | 通过（无 tty 时回落 `~/AgentWork`） |
| core 启动 + `/api/health` | 通过，`auth_required:false` |
| `HOST=127.0.0.1` 生效 | 通过（`ss` 只看到 `127.0.0.1:18090`） |
| 端口占用检测 + 自检页 | 通过（线上 8090 被占时正确拒绝并生成 `setup.html`） |
| MCP 端口分配 / `start_mcp_env` 分离 | `web_search`、`asr` 起来了；`image_task`、`video_task` 因缺 npm 依赖未起 |
| 因此新增 `ensure_deps` 遍历 `app` 与 `mcp/*/` | **改完未复验**（用户要求停止测试） |

### 完全未验证（mac 上要逐项确认）

`osascript` 选目录、`start.command` 双击、`open` 打开浏览器、ffmpeg 语音链路、python3 软链切换、
重启按钮的守护拉起、`Ctrl-C` 清理子进程、`AGENT_FILE_SCOPE=workspace` 下文件工具的真实行为、
`/tmp` 读写一致性、`ensure_deps` 在 mac 上的实际效果。

## 6. macOS 验证清单（下一轮按这个做）

前置：全新 clone（不要带服务器上的测试残留）。**全程只用非默认端口的前提不再需要**——mac 上没有
常驻服务，用默认 8090 即可。

1. **首次启动**
   ```bash
   ./local/start.sh
   ```
   预期：弹出「选择工作目录」窗口 → 生成 `local/config.local.yml` → 装依赖（`app` +
   `mcp/image_task` + `mcp/video_task`）→ 起 4 个 MCP + core → 自动打开浏览器 → 终端打印访问地址与
   「首次使用」提示。

2. **配置文件内容**：检查 `workspace_root` 是你选的目录、`data_root` 指向仓库 `data/`、
   `skills_root` 指向 `local/.runtime/skills`、`platforms: []`。

3. **绑定地址**：`lsof -nP -iTCP:8090 -sTCP:LISTEN` 应只有 `127.0.0.1`（不是 `*`）。

4. **重启按钮（最关键）**：设置页加一个平台 + API Key → 点「重启」→ 页面应能在十几秒内自行恢复
   （`settings.js` 会轮询 `/api/health` 90 秒后 reload）。若页面一直转圈，说明守护循环没生效。

5. **文件工具越出会话目录**：在工作目录根（不是 `task-*` 子目录里）放一个 `probe.txt`，让 AI
   `read_file` 它的绝对路径。预期：能读到（`session` 形态下这里会报「路径越界」）。

6. **`/tmp` 一致性（本次修的 bug）**：让 AI 执行
   ```bash
   terminal: echo hello-tmp > /tmp/probe-local.txt
   read_file: /tmp/probe-local.txt
   ```
   预期：读得到。反过来也可验证 `ls /tmp` 与 `read_file` 指向同一处。

7. **语音（可选能力）**：没装 ffmpeg 时终端应打印「语音：不可用」，输入框**没有麦克风**；
   `brew install ffmpeg` 后重跑脚本 → 打印「语音：可用」+ 麦克风出现（还需在设置页给 `asr`
   填 `X-ASR-Base-Url` / `X-ASR-Model` 才真正能用）。

8. **技能（可选能力）**：有 python3 时打印「技能：已启用」；临时把 PATH 里的 python3 藏掉再跑，
   应打印「技能：已关闭」，且设置页技能列表为空、模型提示词里没有技能段。

9. **退出清理**：`Ctrl-C` 后确认没有残留进程。**按 PID 查，不要用 `pkill -f`**：
   ```bash
   lsof -nP -iTCP:8090 -sTCP:LISTEN
   lsof -nP -iTCP:3101-3104 -sTCP:LISTEN
   ```
   三个 MCP 端口都应释放。

10. **二次启动**：再跑一次 `./local/start.sh`，应跳过生成配置、跳过装依赖、直接起服务
    （验证「配置不覆盖」与依赖检测的 mtime 判断）。

## 7. 已知限制（都不打算在本次解决）

| 限制 | 说明 |
|---|---|
| **无沙箱** | AI 的 `terminal` 就是本机 shell，能读 `~/.ssh` 等一切。这是「给它一个目录就放开手脚」的代价；README 已提示「专用目录 + `git init`」 |
| `mcp_asr` 监听 `0.0.0.0` | 它只认 `PORT` 环境变量、`listen` 不带 host。不存密钥（上游参数随请求带入），暴露面有限；要收紧需给 `mcp/asr` 加 `--host` 支持 |
| Windows 不支持 | `spawn('/bin/sh')`、`process.kill(-pid)`、模型写的 bash 语法都是 POSIX 语义 |
| `mint_public_link` 不可用 | 本地 `public_link.base_url` 为空，工具会回明确的「未配置」错误 |
| 技能依赖 | 有 `requirements.txt` 的技能需手工装进 `skills/deps`（服务器上由 `agent-executor-init` 在构建期做）。默认只保证纯标准库技能 |
| 首个 `npm install` 要联网 | 支持 `NPM_REGISTRY` 覆盖源 |

## 8. 回滚

本地模式的所有开关默认关闭，服务器行为不变。真要整体撤掉：

```bash
git revert <本次提交>
rm -rf local/   # 或保留脚本、只是不用
```

`v2.5.0` 是这批改动之前的基线，可随时对照。

## 9. 记录：上一台机器上的测试残留（mac 全新 clone 不受影响）

在 Linux 服务器上试跑时产生过：`local/.runtime/`、`local/config.local.yml`、`~/AgentWork/`、
`mcp/image_task/node_modules/`、`mcp/video_task/node_modules/`（可能半成品）。全部在 gitignore 内，
不影响仓库；mac 上重新 clone 不会有这些。
