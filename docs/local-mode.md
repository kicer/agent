# 本地端（local 模式）：设计与交接

> 本文是 `local/` 的设计说明 + 交接单。
> **状态：已在 macOS 真机（12.7.6 / x86_64 / Node 22.21 / python3 3.10，本机无 ffmpeg）按第 6 节
> 清单逐项跑过，结果见第 5 节。** 只剩三件依赖人工交互或外部环境的事没覆盖（真实选目录弹窗、
> 真浏览器打开、装 ffmpeg 之后的链路），见第 6 节。

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
| `start.sh` | 主入口：探测 → 首次生成配置 → 装依赖 → 起 core + MCP → 守护重启。**后台化**：拉起真正的启动器就返回 |
| `stop.sh` | 停止启动器（按 `supervisor.pid` → core 的父进程 → 占端口的进程，三级兜底），幂等 |
| `config.example.yml` | **仅作参考，不被读取**；实际配置由 `start.sh` 生成到 `config.local.yml` |
| `README.md` | 给使用者的说明（含安全边界、已知限制） |

`.gitignore` 增加 `local/.runtime/`、`local/config.local.yml`。

> 曾经有一个 `start.command`（macOS 双击入口），已删除：Finder 里双击 `.command` 常被系统当文本
> 预览打开、不执行，而且它补的 PATH 探测和 `start.sh` 重复。现在唯一入口就是 `./local/start.sh`。

### 3.1 真机验证阶段补的修改

首次在 mac 上跑，暴露了下面这些；都不是设计变更，是实现跟设计对不上或漏了边界：

| 文件 | 改动 | 为的什么 |
|---|---|---|
| `local/start.sh` | 新增启动即弹出的**状态页**（`local/.runtime/status.html`，每秒自刷新） | 启动时终端看不到进度；失败页既没有应用名也没有日志，用户无从判断 |
| `local/start.sh` | 依赖检测从「node_modules 在不在」改成**逐包实测 + `.agent-installed` 时间戳** | `npm install` 中途失败会留下半成品目录（目录在、包不全），原逻辑会永远跳过安装，core 起来就 require 失败 |
| `local/start.sh` | `npm install` 输出 `tee` 到 `local/.runtime/npm-install.log`，并嵌进状态页 | 失败时只有终端能看到，滚过去就没了 |
| `local/start.sh` | MCP 默认端口 3101~3104 → **8091~8094**；新增「PORT 撞 MCP 端口就拒绝启动」检查 | 跟 core 的 8090 连号，同时堵掉「换端口时不小心占用 MCP 端口」→ 子进程 bind 失败、静默降级 |
| `local/start.sh` | 已有配置里的 MCP 端口与本次启动不一致时**告警** | 配置永不覆盖，改了默认值/用了 `MCP_*_PORT` 时，旧配置会让 core 静默发现不到工具 |
| `local/start.sh` | 生成的 YAML 里路径**加引号** | 用户选的目录带空格/`:`/`#` 时会被 YAML 解析坏 |
| `local/start.sh` | 没 ffmpeg 时**不再启动** `mcp_asr`（原实现无条件启动，与 4.3 的设计说明不符） | 否则模型拿到一个必然失败的 `transcribe_audio` 工具；同时少一个 `0.0.0.0` 监听 |
| `local/start.sh` | 默认**后台化**（`AGENT_LOCAL_DETACH=1`），拉起启动器后 1 秒返回；新增 `local/stop.sh` | 用户不想让一个终端窗口永远挂着；Finder 里关窗口很容易误杀服务，后台 + 显式 `stop.sh` 更可控 |
| `local/start.sh` | 没 node 时在入口就拦下（生成配置之前），并在终端打出安装方式 | 原来先进「选工作目录」、写好配置才报「后台进程立刻退出了」，用户白选一次，而且日志里只有两行启动横幅，看不出原因 |
| `local/start.sh` | 同一轮只开一个状态页标签（`UI_OPENED`） | `ui_init` 已经开过一次，失败时 `ui_fail` 又开一个，同一个页面两个标签 |
| `local/start.sh` | 「已在运行」改看 `supervisor.pid`（pid 存活且命令行是本脚本），health 只做兜底 | 只看 health 时 core 还没起来的几秒内连跑两次，会拉起两个启动器抢同一端口（实测：互相 `EADDRINUSE` 重启，`stop.sh` 只能停一个） |
| `local/start.sh` | 首次安装**不自动跳转**，停在状态页给「打开应用」按钮；后续启动才 2 秒自动跳 | 首次装完先让用户看完「怎么配模型」再进去，别一上来就甩进空界面 |
| `app/server/tools/executor.js` | 新增 `dispPath()`：会话目录外用绝对路径回显 | 宽根模式下写 `/tmp/x` 会回 `../../../../tmp/x`，模型容易当会话内路径二次拼接 |
| `app/package-lock.json` | `resolved` 从腾讯云**内网镜像**改为公共 registry | 原 lockfile 把 tarball 钉在 `mirrors.tencentyun.com`（只有腾讯云 VPC 内能解析），外部机器 `npm install` 必失败，且换 `NPM_REGISTRY` 也无效 |

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

容器里它们是四个独立容器、都监听 3000；本地同机必须错开（默认 **8091~8094**，紧跟 core 的 8090）。
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

### 4.9 状态页：静态文件 + `meta refresh`，不起 HTTP 服务

启动时终端窗口不一定在前台，失败时也可能已经滚过去。所以启动就打开
`local/.runtime/status.html`，并让它能自己更新：

- 脚本把状态写进 `local/.runtime/ui/` 下的几个小文件（`title` / `steps` / `busy` / `logpath` /
  `error` / `redirect`），`ui_render` 把它们拼成整页；页面用 `<meta http-equiv="refresh" content="1">`
  每秒重读一次。不需要常驻服务，所以「连 node 都没装」的环境也能打开。
- 长步骤（`npm install`、等 core 健康检查）另起一个**心跳子进程**每秒重绘，页面上就能看到
  已经过了多少秒 + 当前日志的尾巴（npm 输出、core 启动报错）。
- 状态全部落文件而不是留 shell 变量：心跳子进程拿到的是 fork 时的快照，用变量会越刷越旧。
- 成功时：**首次安装**（配置是本次刚生成的）页面停在「已启动」，只给一个「打开应用」按钮，
  用户自己点（先看完下面的首次使用提示）；**后续启动**写入 `redirect`，2 秒后自动进应用
  （同一个标签页，不多开窗）。
- 失败时页面保留错误说明和日志尾部，并把完整日志路径写在页面上。
- 默认只在 macOS 自动弹出（`AGENT_LOCAL_UI=auto`），Linux 服务器上要显式 `AGENT_LOCAL_UI=1`；
  无论弹不弹，页面都会生成。
- 渲染先写临时文件再 `mv`：浏览器随时可能在刷新，不能让它读到半截 HTML；临时名用 `mktemp`
  而不是 `$$`——`$$` 在子 shell 里仍是主 shell 的 PID，心跳与主流程同时渲染会撞车。

### 4.10 依赖检测为什么不能只看 `node_modules` 目录

`npm install` 失败（断网、源不对）会留下一堆**空目录**：`app/node_modules` 在、`express` 目录
也在，但里面没东西。原逻辑「目录存在且不比 `package.json` 旧」会判定为已安装，以后每次启动
都跳过安装，core 起来立刻 `require` 失败——用户看到的是「装依赖那步过了，但服务起不来」。

现在的判定：

1. 逐个直接依赖检查 `node_modules/<dep>/package.json` 是否存在（比 `require.resolve` 可靠：
   `@modelcontextprotocol/sdk` 这类纯 ESM 包的 `exports.require` 指向的文件根本不存在，
   `require.resolve` 会误判成「没装」）；
2. 装成功后 `touch node_modules/.agent-installed`，只有 `package.json` 比它新才重装
   （npm 在「已经是最新」时不会更新 `node_modules` 的 mtime，只比目录 mtime 会每启动都白跑一次）。

### 4.11 后台化 + 显式 `stop.sh`，以及「已在运行」怎么判

用户不想为了跑一个本地服务永久占着一个终端窗口（而且关窗口可能连带杀掉进程）。所以：

- `start.sh` 自己**只做入口**：首次配置生成（要 tty 弹窗）→ `nohup` 拉起真正的启动器 → 1 秒后
  打印地址/状态页/停止命令并 `exit 0`。`AGENT_LOCAL_DETACHED=1` 是子进程标记，防无限重入。
- 停止统一走 `local/stop.sh`。它按「`supervisor.pid` → core 的父进程 → 占端口的进程」三级兜底：
  只杀 core 会被守护循环重新拉起，所以必须能认出**启动器**。命令行是相对路径（`sh ./local/start.sh`），
  `pgrep -f` 匹配不到绝对路径，所以第一选择是 pid 文件。
- 前台模式保留：`AGENT_LOCAL_DETACH=0 ./local/start.sh`（看实时日志、`Ctrl-C` 停）。

「已在运行」的判定不能只看 `/api/health`：core 起来要几秒（先起 MCP，首次还要装依赖），
这期间再跟一次 `start.sh` 就会拉起第二个启动器，两个 core 抢同一个端口——一个被守护循环
反复 `EADDRINUSE` 重启，而 `stop.sh` 只认 pid 文件里那一个，等于停不干净（已实测复现）。
改成先看 `supervisor.pid`（子进程一启动就写，秒级就绪；`kill -0` + 命令行含 `start.sh` 防 pid 被回收），
health 只作为「端口上有服务但不是本启动器拉起的」兜底提示。

## 5. 验证结果（macOS 12.7.6 / x86_64 / Node 22.21 / python3 3.10 / 本机无 ffmpeg）

静态检查：`sh -n local/start.sh`、`sh -n local/stop.sh`、`node --check` 均通过。

| 项 | 结果 |
|---|---|
| 首次启动：生成配置 → 装依赖（app 134 包，image_task / video_task 各 127 包）→ 起 MCP + core → 打开状态页（停在「已启动」，等点击） | 通过 |
| 配置内容：`workspace_root` 是选的目录、`data_root` 指仓库 `data/`、`skills_root` 指 `local/.runtime/skills`、`platforms: []`、MCP 端口 8091~8094 | 通过 |
| 绑定地址：`lsof` 只有 `127.0.0.1:8090` | 通过 |
| 设置页「重启」→ 守护拉起：PID 变化，2 秒内 `/api/health` 恢复 | 通过 |
| 文件工具越出会话目录：工作目录根的 `probe.txt` 可读 | 通过 |
| 越界保护：`read_file ~/.ssh/config`、`terminal cd /etc` 均报「路径越界」 | 通过 |
| `/tmp` 一致性：`write_file /tmp/x` → `terminal cat /tmp/x` 与 `read_file /tmp/x` 内容一致 | 通过 |
| 无 ffmpeg：`/api/asr/status` = `enabled:false`（麦克风隐藏），asr 子进程不启动，8094 不监听 | 通过 |
| 有 python3：技能列表有内容；桩掉 python3 后 `/api/skills` 返回 `[]`、状态页显示「技能：已关闭」 | 通过 |
| 四个 MCP 在具备条件时均能发现工具（`[mcp] web_search / image_task / video_task / asr: 发现 1 个工具`） | 通过 |
| 前台模式 `Ctrl-C` 与 `TERM`：8090 与 8091~8094 全部释放，无残留进程 | 通过 |
| 二次启动：沿用配置、跳过依赖安装（时间戳生效） | 通过 |
| 后台模式：`start.sh` 1 秒返回、启动器 PPID=1、`supervisor.pid` 是子进程 pid | 通过 |
| `stop.sh`：命中 pid 文件分支；pid 文件丢失时按 core 父进程/端口也能停；未运行时幂等返回 | 通过 |
| 重复执行 `start.sh`：打印「已在运行（启动器 pid N）」+ 停止命令，exit 0，不起第二个进程 | 通过 |
| 启动器被 `kill -9` 后的恢复：残留 pid 文件被清理，端口仍被占时明确提示先 `stop.sh` | 通过 |
| 前台模式 `AGENT_LOCAL_DETACH=0`：阻塞运行，`TERM` 后端口全部释放 | 通过 |
| 无 node（PATH 里剥掉 node/npm）：入口直接拦下，**不** 先让选目录、不生成配置；终端打出安装方式；状态页列出自检项（X Node.js / X npm） | 通过 |
| 失败时只开一个状态页标签（不再两个） | 通过 |
| 状态页：启动即弹出、每秒刷新、显示步骤/计时/日志尾巴；失败时保留错误与日志 | 通过 |
| `osascript` 真实选目录弹窗 | 未验证（用桩跑的「没选→回落 `~/AgentWork`」分支） |
| 真浏览器打开（`open`） | 未验证（用桩记录了被打开的 URL） |
| 装 ffmpeg 之后：`ASR_URL` 注入、asr 子进程与麦克风一起出现 | 未验证（本机未装 ffmpeg） |

验证过程中发现并修掉的问题见 3.1（依赖检测、lockfile 内网源、`asr` 无条件启动、端口冲突、
状态页日志缺失、全角字符紧贴变量名导致的 `unbound variable`）。

## 6. 还没覆盖的三项（需要人工交互或外部环境）

其余清单已在 mac 上跑完（结果见第 5 节）。剩下这三项要在真实场景里补：

1. **真实选目录弹窗**：删掉 `local/config.local.yml` 后跑 `./local/start.sh`，确认弹出的是 macOS 原生
   选目录窗、选完的路径写进 `workspace_root`（带空格的目录名要顺手验一下，配置里已加引号）。
2. **真浏览器打开**：跑 `./local/start.sh`（或前台模式），确认（a）状态页在启动过程中每秒刷新；
   （b）首次安装停在页面上等你点「打开应用」；（c）后续启动 2 秒自动进应用。
3. **装 ffmpeg 之后**：`brew install ffmpeg` → 重跑脚本，预期：状态页显示 `ffmpeg` 为 OK、
   终端打「语音：可用」、8094 开始监听、`/api/asr/status` 变成需要填上游（不再是「未设置 ASR_URL」）。

手工复验用的命令：

```bash
./local/start.sh                            # 后台启动（1 秒返回）
./local/stop.sh                             # 停止（幂等）
./local/start.sh                            # 已在运行时只打印地址与停止方式
lsof -nP -iTCP:8090 -sTCP:LISTEN            # 应只有 127.0.0.1
lsof -nP -iTCP:8091-8094 -sTCP:LISTEN       # 3 或 4 个 MCP（没 ffmpeg 时没有 8094）
curl -s http://127.0.0.1:8090/api/asr/status
curl -s -X POST http://127.0.0.1:8090/api/system/restart   # 应由守护拉起
tail -f local/.runtime/core.log             # 以及 npm-install.log / mcp-*.log
```

## 7. 已知限制（都不打算在本次解决）

| 限制 | 说明 |
|---|---|
| **无沙箱** | AI 的 `terminal` 就是本机 shell，能读 `~/.ssh` 等一切。这是「给它一个目录就放开手脚」的代价；README 已提示「专用目录 + `git init`」 |
| 没 ffmpeg 时 asr 会报「工具发现失败」 | 此时 `mcp_asr` 不启动（它转码依赖 ffmpeg），但配置里的 asr 条目仍在（配置不覆盖），所以 core 启动会 warn 一次并重试，属预期 |
| `mcp_asr` 监听 `0.0.0.0` | 它只认 `PORT` 环境变量、`listen` 不带 host（已启动时才是问题）。不存密钥（上游参数随请求带入），暴露面有限；要收紧需给 `mcp/asr` 加 `--host` 支持 |
| Windows 不支持 | `spawn('/bin/sh')`、`process.kill(-pid)`、模型写的 bash 语法都是 POSIX 语义 |
| `mint_public_link` 不可用 | 本地 `public_link.base_url` 为空，工具会回明确的「未配置」错误 |
| 技能依赖 | 有 `requirements.txt` 的技能需手工装进 `skills/deps`（服务器上由 `agent-executor-init` 在构建期做）。默认只保证纯标准库技能 |
| 首个 `npm install` 要联网 | 支持 `NPM_REGISTRY` 覆盖源；`app/package-lock.json` 的 `resolved` 已改指向公共 registry（原来钉在内网镜像，外部机器必失败） |

## 8. 回滚

本地模式的所有开关默认关闭，服务器行为不变。真要整体撤掉：

```bash
git revert <本次提交>
rm -rf local/   # 或保留脚本、只是不用
```

`v2.5.0` 是这批改动之前的基线，可随时对照。

## 9. 记录：测试残留（都不入库）

跑过启动器之后本机会多出：`local/.runtime/`（日志、状态页、技能软链）、
`local/config.local.yml`、`~/AgentWork/`、`app/node_modules/`、`mcp/image_task|video_task/node_modules/`。
全部在 gitignore 内，不影响仓库；想彻底重来就把它们删掉再跑脚本（会话产出在 `data/` 与
工作目录下的 `task-*` 里，不会被清）。
