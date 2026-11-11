# 本地端（local 模式）：设计与交接

> 本文是 `local/` 的设计说明 + 交接单。
> **状态：已在 macOS 真机（12.7.6 / x86_64 / Node 22.21 / python3 3.10，本机无 ffmpeg）按第 6 节
> 清单逐项跑过，结果见第 5 节。** 只剩三件依赖人工交互或外部环境的事没覆盖（真实选目录弹窗、
> 真浏览器打开、装 ffmpeg 之后的链路），见第 6 节。

## 1. 目标

把同一个 `agent-core` 直接跑在本机（macOS / Linux），**不装 Docker、不起 executor**，形态类似
桌面 agent：给它一个工作目录，它在这个目录下的 `tasks/` 里放开手脚干活（`data/`、`skills/` 是兄弟目录，
归启动器和技能自己管）。

明确的设计约束（都来自讨论）：

- **和服务器端同一份代码**，不 fork 新仓库、不长期开 branch；靠运行时开关分叉
- **`app/` 最小化改动**（最终只有 2 个后端文件，前端 0 改动）
- **组件按需**：node 必需；ffmpeg 决定语音；python3 决定 Python 类技能能否执行（非 Python 技能如 `office` 不受影响）
- **Windows 暂时不做**（本机执行依赖 POSIX 语义，见第 7 节）
- 不用 Docker（用户明确否决）

基线版本：`v2.5.0`（服务器端最后一个纯容器部署版本）。

## 2. 与服务器形态的差异（只有六处）

| 差异 | 服务器 | 本地 | 由谁注入 |
|---|---|---|---|
| 命令在哪跑 | `agent-executor` 容器（mount/pid namespace 隔离） | 本机 `spawn`（**无沙箱**） | `EXECUTOR_URL` 留空 → 现成分支，未改代码 |
| 文件工具的根 | 会话目录 `tasks/<会话id>/` | 工作目录下的 `tasks/`（`data/`、`skills/` 是兄弟目录，越界） | `AGENT_FILE_SCOPE=workspace` |
| 监听地址 | `0.0.0.0` | `127.0.0.1` | `HOST=127.0.0.1` |
| 对外链接（`mint_public_link` / `visit_url`） | `public_link.base_url` 拼公网短链 | 没有公网前缀时改拼 `http://127.0.0.1:<PORT>/p/<id>` | 复用 `localOrigin()`，靠 `HOST` 判断形态，不写配置 |
| 读图回传给模型 | 签公网短链，上游服务器来拉 | 上游拉不到回环地址，改为内联 base64 `data:` URL | `AGENT_IMAGE_INLINE=1` |
| office 预览的后端 | executor 的 `:3100` 网关（mount/pid 牢笼） | `local/preview-gateway.js`（同机、无牢笼） | `PREVIEW_PROXIES` 注入 core 的反代注册表 |

后五项都由本地启动器注入。**都不注入时，行为与 v2.5.0 完全一致**（容器部署不受影响）。

## 3. 本次改动清单

### 后端（`app/`）

| 文件 | 改动 |
|---|---|
| `app/server/server.js` | 读 `HOST` 环境变量；有值则 `server.listen(PORT, HOST, cb)`，无值维持 `listen(PORT, cb)`（= `0.0.0.0`）。启动日志带上 host |
| `app/server/tools/executor.js` | 新增 `WIDE_SCOPE`（由 `AGENT_FILE_SCOPE=workspace` 打开）与 `fsRoot(ctx)`；`resolveInTask()` 增加可选第三参 `rootDir`；6 个业务工具的调用点改为传 `fsRoot(ctx)`；`recordFile()` 跳过会话目录之外的文件；`mint_public_link` 在没有 `public_link.base_url` 时改用 `localOrigin()`（回环地址） |
| `app/server/engine.js` | `mintImageUrl` 在没有 `public_link.base_url` 且 `AGENT_IMAGE_INLINE=1` 时，把待回传的图内联成 `data:` URL（先做同样的 realpath 越界复核；>1.5MB 仍降级） |
| `app/server/routes/files.js` | 新增 `GET /:id/tree`（桌面端左栏文件树用：单层懒加载、忽略大目录、上限 500、越界双重校验） |

`resolveInTask` 的两个分叉点：

1. **根**：`rootDir` 给了就按它校验（workspace 形态 = `workspace_root`），否则仍按会话目录
2. **`/tmp`**：`session` 形态保持「重定向到 `<会话>/.tmp`」；`workspace` 形态**不重定向**，并把真实
   `/tmp` 纳入允许范围

### 刻意没有动的（重要）

- `resolvePastPath()`（`@<会话id>/...` 跨会话只读）—— 仍锁在对方会话目录
- `routes/public-files.js`、`routes/data-page.js` —— 公网短链与 data-page 仍按会话目录校验
- `mint_public_link` —— 路径校验仍是会话目录语义；只是没有公网前缀时改用回环地址签发（见 §2）
- 前端 —— 本地模式没有专属前端代码；左栏文件树是桌面端共用的（见下）

> 追加：文件树最初只给 local 用，后来上收为桌面端通用能力 —— `/tree` 移到 `routes/files.js`，
> 服务器形态的桌面端也用它取代「输入行右侧的旧文件面板」（含下载/删除）；`reveal`、`terminal`、
> `pick-dir` 仍只在 `AGENT_LOCAL_PICK=1` 下挂载（它们开的是跑 core 那台机器的窗口）。

### 新增 `local/`

| 文件 | 作用 |
|---|---|
| `start.sh` | 主入口：探测 → 首次生成配置 → 装依赖 → 起 core + MCP → 守护重启。**后台化**：拉起真正的启动器就返回 |
| `stop.sh` | 停止启动器（按 `supervisor.pid` → core 的父进程 → 占端口的进程，三级兜底），幂等 |
| `config.example.yml` | **仅作参考，不被读取**；实际配置由 `start.sh` 生成到 `config.local.yml` |
| `preview-gateway.js` | 本地 office 预览网关（对位 executor 的 `:3100`，见 §4.15） |
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

推论：**能力变化不能靠改配置实现**，只能靠 env / 起不起子进程 / 首次复制（见 4.3、4.4）。

### 4.3 ffmpeg 是运行时能力，与配置解耦

`routes/asr.js` 直接读 `process.env.ASR_URL`，`/api/asr/status` 在 `ASR_URL` 为空时返回
`enabled:false`，前端 `voice.js` 据此**自动隐藏麦克风**。所以：

- 有 ffmpeg → 启动器起 `mcp_asr` + 注入 `ASR_URL`
- 没 ffmpeg → 不起、不注入 → 麦克风自动消失

装完 ffmpeg 后**重跑脚本**即生效，配置文件一个字不用改。

### 4.4 技能是工作目录里的副本，不再软链仓库并随 python3 有无切换

用户选的工作目录被拆成三个兄弟目录：

```
<工作目录>/tasks/    会话工作区（AI 的文件根）
<工作目录>/data/     SQLite、prompt dump
<工作目录>/skills/   技能 + deps/
```

`skills_root` 写死 `<工作目录>/skills`（首次生成后不覆盖）。首次启动时把仓库 `skills/` 里的
**内置技能逐个复制**过去，之后每次启动**只补缺、不覆盖**：

- 只复制目录，`deps` 不复制（仓库那份是服务器构建期产物，平台/版本都不该跟着走）
- 目标已存在就跳过——用户改过的、AI 自己新建的技能都靠这条保住
- 要拿仓库里的新版：删掉对应子目录再跑一次脚本

这样三个东西同时在位：仓库永远干净（`git status` 无未跟踪用户数据）；用户数据一目录备份、
一目录卸载；AI 真能“自己长技能”（新增目录即被发现，`skill list` 实时可见）。

早期版本把 `.runtime/skills` 软链到仓库，导致技能只能写回版本库（与仓库更新抢地盘）。
更早还按 python3 有无切到空目录，想“别让模型看到跑不了的工具”——但技能不一定是 Python 的
（`office` 只要 Node + 二进制），一刀切会把它们一并藏掉；而且 `skills.js` 的 `runEntry` 对
`spawn` 的 `error` 有处理，缺解释器时模型拿到的是「技能入口启动失败：spawn python3 ENOENT」，
干净可读，自己装完继续跑即可。

**没有改 `skills.js` 一行代码。**

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

### 4.8 `skills_root` 的默认值

`skills.skills_root` 留空时默认取 `workspace_root` 的**同级** `skills` 目录。新的目录布局正好也是
`tasks/` 与 `skills/` 同级，所以留空也能算对；但生成的配置仍然显式写死它——一个字段就能看出
技能到底在哪，不依赖目录推导。

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

### 4.12 依赖安装：源探测 + 换源重试 + 本地缓存（只在 `local/` 里做）

首装联网是逃不掉的，但「哪个源能用、卡住了怎么办」不该让用户想。启动器的策略：

1. **已装齐 → 不联网**（逐包检查 + `.agent-installed` 时间戳，见 4.10）；
2. **缓存命中 → 解压**：装成功后把 `node_modules` 打成
   `<平台>-<架构>-abi<ABI>-<依赖哈希>.tgz` 放 `~/.cache/agent-local/`；原生模块与 ABI 绑定，
   所以文件名必须含 ABI（`process.versions.modules`）。换 clone / 删 `node_modules` 都走这里，
   秒级且零网络；只留最近 3 份。
3. **缓存未命中 → 选源安装**：并行探 `npmmirror` 与官方源（各 3 秒超时），取最快的；
   结果缓存一天。**只用命令行参数传源，绝不写 `~/.npmrc`**。
4. **失败换源**：仅当用的是公共源（npmmirror / 官方）时换下一个重试，换源成功就记住；
   用户显式指定或公司私有源不兜底（乱兜底可能装错东西）。重试前先删半成品 `node_modules`。
5. **看门狗**：npm 10 + Node 22 在断网时既不报错也不退出（已知的
   `Exit handler never called`，实测卡死超过 2 分钟），所以每次 `npm install` 都带超时，
   超时就 `SIGKILL` 整棵树再换源。
6. **报错翻译**：把 npm 原文归成「网络没通 / 缺编译工具链（`xcode-select --install`）/
   没有写权限 / 源没响应」，状态页只显示这一句，原文仍完整落在 `npm-install.log`。

两个容易踩的实现细节（都踩过）：

- `kill_tree` 不能把参数先赋给变量再递归：POSIX sh 没有局部变量，递归会覆盖它，回到外层
  kill 的是子进程而不是原本那个。
- 看门狗只用 `SIGKILL`：先 `TERM` 会先干掉外壳让 npm 变成孤儿（`PPID=1`），`kill -0` 判不到，
  再想硬杀就找不到它了。

### 4.13 Python 包：不预装，交给模型按提示词装进 `skills/deps`

服务器上技能依赖由 `agent-executor-init` 一次性装进 `skills/deps`（compose 再把它放进
`PYTHONPATH`）。本地没有这套东西，`start.sh` 也不去跑 pip——安装时机、镜像源、半成品清理
是另一整套逻辑，收益不抵成本。做法改成「缺了再装」：

- `start.sh` 起 core 时注入 `PYTHONPATH=<工作目录>/skills/deps` 与
  `AGENT_SKILLS_DEPS=<工作目录>/skills/deps`（后者只为把路径交给模型）。
  `terminal` 与技能子进程都继承 core 的 env，所以装进去的东西**下次运行就能 import**，不用重启。
- `templates/env-local.txt` 把原来的「永远不要自己装任何东西」改成「缺模块就装进
  `$AGENT_SKILLS_DEPS` 再重试」——**只给路径，不给命令**，怎么装由模型自己决定。
  技能失败时 stdout+stderr 是合并回给模型的，它能看到 `ModuleNotFoundError` 自己判断。
- 为什么给一个目录而不是让模型自己选：那个目录已经在 `PYTHONPATH` 里，装进去下次运行就能
  import；而不指定位置的话，它很可能装到别处（或去改系统 Python）。pip 对 `--target` 的
  PEP 668 拦截明确豁免（`pip/_internal/commands/install.py`），所以这条路在 Homebrew 那种
  externally-managed 解释器上也走得通——但这话不写进提示词，交给模型自己判断。
- 缺 `python3` 本体时也放给模型自己处理：本地形态是「用户自己的机器 + 用户自己的 agent」，
  目标是把事做成，而不是把它当生产环境保护。提示词只告诉它**装到哪**（Python 包进
  `$AGENT_SKILLS_DEPS`），不写条件也不写禁令——要不要先知会用户，交给模型按场合自己判断。
- 技能自己的 `requirements.txt` 一律**不写版本号**：服务端 init 用
  `pip install --no-index --dry-run` 探测，pin 到与镜像不同的版本会让探测失败 → 真的往
  `skills/deps` 装一份旧的，而 `PYTHONPATH` 优先于系统 site-packages，等于反向遮蔽镜像包。

需要系统库的包（`weasyprint` → pango/cairo）pip 装不了，仍需用户 `brew install`；这类不在
自动修复范围内，模型只报结论。

### 4.14 技能自洽：本机环境写在技能目录的 `AGENTS.md`

`install.sh` / `requirements.txt` 是服务器工件（镜像构建与 `agent-executor-init` 读它们），本机不跑、
不改。启动器也不认识任何具体技能：不注入 PATH、不预装、不做特判。新增技能不需要动 `local/`。

本机缺东西时只有一条入口：技能自己目录下的 `AGENTS.md`。它是**排错清单**，只写「现象 → 命令」
（报什么错、敲什么），不写背景、不提服务器。起点是 `env-local` 提示词的一句话：技能失败就读
`"$(dirname "$AGENT_SKILLS_DEPS")/<技能>/AGENTS.md"`。装完不需要重启，旧进程不影响。

分两层，各管各的：**技能目录的 `AGENTS.md` 只写该技能特有的**（缺哪个包、缺什么系统库）；
**网络换源与长任务这类通用规则不进技能文档**，直接写在 `env-local.txt` 提示词里——
它们必须常驻上下文，靠「出错时去翻文件」是拉不动的（尤其长任务：AI 决定跑 `brew install` 的
那一刻没有任何报错信号触发它去查文档）。

代价明写：`office` 的命令入口在本地不在 PATH 上，按次 `PATH="$SK/scripts:$PATH" office ...` 即可
（这是它 `AGENTS.md` 的第一条）。

报错指向各自文档，不在 core 里做全局特征匹配（那种正则既脆又不可移植）：

| 位置 | 报错附带 |
|---|---|
| `office` 封装层 ENOENT | 本技能 `AGENTS.md` 绝对路径 |
| `x2pdf` 缺包 / 无渲染后端 | 同上 |
| `image-process` 缺中文字体 | 同上（并提示传 `font`） |
| 网络类 / 长任务 | 不进技能文档：写在 `env-local.txt`，常驻上下文 |

唯一保留的环境相关代码是 `x2pdf` 的 `find_soffice()`：`brew install --cask libreoffice` 后
`soffice` 不在 PATH（在 app bundle 内），不探这几个默认位置，“装 LibreOffice 即可”就是假的。
另保留了 WeasyPrint 不可用时回落 LibreOffice，让本地只需一个后端而不是 pango + WeasyPrint 两套链。

没做的是预览：预览卡片要 executor 的 `:3100` 网关，本地没有——这一项后来补了，见 §4.15。

### 4.15 office 文档预览：本地自建一个薄网关

服务器上「点开 docx」是 core → 反代 `/preview` → executor 的 `:3100` 网关 → 网关按需 spawn
`officecli watch`。本地没有 executor，链路断在中间。补法不是改 core，而是在 `local/` 里放一个
零依赖网关，用 `PREVIEW_PROXIES` 把它登记进 core 的反代注册表（`app/` 一行没改）。

**不复用 `executor/preview.js`**：那套 `unshare --mount --pid` + `nsenter` + `mount --bind` 是为
「让沙箱内的命令和 watch 看见同一个世界」造的（vendor 靠 `TMPDIR` 下的句柄文件 + 回环 TCP 相互
发现）。本地没有沙箱，命令和 watch 本来就同机同盘，那些系统调用不但用不上，有些平台根本没有。
于是本地网关只剩数据面：

- `/preview/<会话id>/<相对路径>` → 解析真实文件 → 确保有 watch → 剥前缀转发
- `/events`（SSE）与 `/api/*`（选区回读、切换、发送）→ 按 `Referer` 认领槽位再转发
- 4 个槽位，LRU 挤占 + 闲置回收；watch 端口从 26315 起按代轮转，跳过已被占用的
- 槽位带活性校验：watch 自己退了（vendor 崩溃/被外部 kill）就丢掉槽位重起，转发出错也立即丢；
  否则那份 dead port 会一直转到下次闲置回收，面板上只有一句「预览服务不可达」
- 缺 `officecli` 时给「安装说明页」，而不是无限转圈：服务器那份二进制是构建期必装的，
  `preview.js` 从没为「没装」设计；本地全新 clone 一定没有，这是常态不是异常

于是本地 `office` 的体验与服务器一致：`create`/`open` 后聊天里出预览卡片，点开即右侧预览，
`get-pos` 能读到选区。技能侧因此不需要任何本地分支（`skills/office` 与服务器同源）。

平台差异都收在两处：进程回收（POSIX 杀进程组 / Windows `taskkill /T`）、二进制解析（`.exe`、
POSIX 补 `chmod +x`、`officecli-*` 资产名也认）。其余只用 Node 内置能力。

已知：watch 没有 `--host` 参数，只能绑 `0.0.0.0`（与 `mcp_asr` 同类）；网关与 core 只在回环上。

## 5. 验证结果（macOS 12.7.6 / x86_64 / Node 22.21 / python3 3.10 / 本机无 ffmpeg）

静态检查：`sh -n local/start.sh`、`sh -n local/stop.sh`、`node --check` 均通过。

| 项 | 结果 |
|---|---|
| 首次启动：生成配置 → 装依赖（app 134 包，image_task / video_task 各 127 包）→ 起 MCP + core → 打开状态页（停在「已启动」，等点击） | 通过 |
| 配置内容：`workspace_root` = `<选定目录>/tasks`、`data_root` = `<选定目录>/data`、`skills_root` = `<选定目录>/skills`（内置技能已复制）、`platforms: []`、MCP 端口 8091~8094 | 通过 |
| 绑定地址：`lsof` 只有 `127.0.0.1:8090` | 通过 |
| 设置页「重启」→ 守护拉起：PID 变化，2 秒内 `/api/health` 恢复 | 通过 |
| 文件工具限定在 `<工作目录>/tasks/` 下：放进 `tasks/` 的 `probe.txt` 可读，`<工作目录>/data/` 报路径越界 | 待复测 |
| 越界保护：`read_file ~/.ssh/config`、`terminal cd /etc` 均报「路径越界」 | 通过 |
| `/tmp` 一致性：`write_file /tmp/x` → `terminal cat /tmp/x` 与 `read_file /tmp/x` 内容一致 | 通过 |
| 无 ffmpeg：`/api/asr/status` = `enabled:false`（麦克风隐藏），asr 子进程不启动，8094 不监听 | 通过 |
| 有 python3：Python 技能可执行；桩掉 python3 后技能清单不变（`/api/skills` 照常返回），执行 `run.py` 类技能报「技能入口启动失败：spawn python3 ENOENT」，`office` 这类非 Python 技能不受影响 | 待复测 |
| 四个 MCP 在具备条件时均能发现工具（`[mcp] web_search / image_task / video_task / asr: 发现 1 个工具`） | 通过 |
| 前台模式 `Ctrl-C` 与 `TERM`：8090 与 8091~8094 全部释放，无残留进程 | 通过 |
| 二次启动：沿用配置、跳过依赖安装（时间戳生效） | 通过 |
| 后台模式：`start.sh` 1 秒返回、启动器 PPID=1、`supervisor.pid` 是子进程 pid | 通过 |
| `stop.sh`：命中 pid 文件分支；pid 文件丢失时按 core 父进程/端口也能停；未运行时幂等返回 | 通过 |
| 重复执行 `start.sh`：打印「已在运行（启动器 pid N）」+ 停止命令，exit 0，不起第二个进程 | 通过 |
| 启动器被 `kill -9` 后的恢复：残留 pid 文件被清理，端口仍被占时明确提示先 `stop.sh` | 通过 |
| 依赖源自动探测：删依赖后启动，自动选中 `registry.npmmirror.com`（本机 npm 全局源也是它），状态页显示「依赖源」 | 通过 |
| 依赖缓存：装成功后生成 `~/.cache/agent-local/deps-...tgz`；删掉 `node_modules` 重启，日志为「使用本地依赖缓存」、`npm-install.log` 为空（零网络） | 通过 |
| 换源自愈：把缓存里的源改成不可达地址 → 看门狗超时 → 自动换到 npmmirror 装完，缓存里的源被改回可用值 | 通过 |
| 失败翻译：源不可用 + 冷 npm 缓存 → 状态页标题「依赖安装失败」、提示「源没有响应…（已自动换源重试）」，无 npm 残留进程 | 通过 |
| 前台模式 `AGENT_LOCAL_DETACH=0`：阻塞运行，`TERM` 后端口全部释放 | 通过 |
| 无 node（PATH 里剥掉 node/npm）：入口直接拦下，**不** 先让选目录、不生成配置；终端打出安装方式；状态页列出自检项（X Node.js / X npm） | 通过 |
| 失败时只开一个状态页标签（不再两个） | 通过 |
| 状态页：启动即弹出、每秒刷新、显示步骤/计时/日志尾巴；失败时保留错误与日志 | 通过 |
| 预览网关（直接打网关，临时 tasks 根）：HEAD 探针 200、GET 200、自动起 watch @26315 | 通过 |
| 预览数据面：`/events` 是真 SSE、`/api/selection` 204、`/api/send` 200；无 `Referer` 404 | 通过 |
| 缺 `officecli`：给安装说明页，HEAD 仍 200（面板不闪死链） | 通过 |
| 网关退出：watch 端口释放，无残留进程 | 通过 |
| 槽位自愈：`kill -9` 掉 watch 后再请求，自动在下一代端口重起（26315 → 26316），页面照常返回 | 通过 |
| 经 core 的 `/preview` 端到端（含手选工作目录、`work_dir` 在 `tasks/` 外的会话） | 待复验 |
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
| 链接只在本机可达 | 本地没有公网前缀：`mint_public_link` / 页面访问地址都签成 `http://127.0.0.1:<PORT>/...`，只能在这台机器上打开（这正是本地形态的预期）。要真正对外暴露才需在设置页填 `public_link.base_url` |
| 技能依赖 | 本地不预装：缺包时模型会把包装进 `<工作目录>/skills/deps`（`$AGENT_SKILLS_DEPS`，已在该进程 `PYTHONPATH` 里，装完下次运行即生效）；连 `python3` 都没有时也由它自己装。怎么装由模型自己决定。需要系统库的包（`weasyprint`→pango/cairo）pip 装不了，仍需手工 `brew install`。服务器上由 `agent-executor-init` 处理 |
| `office` 二进制 | 不入库、也不预装：首次用到时报 `binary missing` 并给出该技能 `AGENTS.md` 的绝对路径，模型按它自己下载（`releases/latest`，~34MB，GitHub 慢就用 gh-proxy）。不需要 root、不需重启。officecli 会自更新到 latest，版本比服务器 pin 的新属正常 |
| `office` 预览 | 本地网关按需起 `officecli watch`，体验与服务器一致；但 watch 没有 `--host`，只能绑 `0.0.0.0`，且预览进程闲置 6h 回收（槽位 4 个） |
| 首个 `npm install` 要联网 | 支持 `NPM_REGISTRY` 覆盖源；`app/package-lock.json` 的 `resolved` 已改指向公共 registry（原来钉在内网镜像，外部机器必失败） |

## 8. 回滚

本地模式的所有开关默认关闭，服务器行为不变。真要整体撤掉：

```bash
git revert <本次提交>
rm -rf local/   # 或保留脚本、只是不用
```

`v2.5.0` 是这批改动之前的基线，可随时对照。

## 9. 记录：测试残留（都不入库）

跑过启动器之后本机会多出：`local/.runtime/`（日志、状态页）、`local/config.local.yml`、
你选的工作目录（`data/` `skills/` `tasks/`）、`app/node_modules/`、`mcp/image_task|video_task/node_modules/`。
仓库里只有前两项，且都在 gitignore 内；用户数据全在工作目录里，删掉它等于彻底重置。

## 10. 新建会话手选工作目录（本地端）

默认每个会话落在 `workspace_root/<会话id>`（形如 `task-YYYYMMDD-NNN`）。本地端希望「给它一个
目录就放开手脚」，所以新建会话时可以手选一个真实目录，这个会话的 AI 一切操作都在那儿。

**后端只动 `taskDirOf` 一处**（`engine.js`）：

```js
taskDirOf(sessionId) = sessions.work_dir || path.join(workspace_root, sessionId)
```

全仓库的会话路径（文件 API、上传、`terminal` 的 cwd、`resolveInTask` 基准、data-page、
`@会话` 只读）都经由它，所以改这一处即全线生效，不必逐个路由改。

- 选择只存前端（`pendingWorkDir`），建档时随 `POST /api/sessions` 提交一次；不选 = 空串 = 老行为。
- **不建 `task-*` 子目录**，直接以所选目录为工作目录（隐藏产物 `.tmp`/`.imgcache`/`.app`/`data.db` 落在这里）。
- 允许多个会话选同一目录；**删会话绝不删该目录**（`deleteSession` 只在 `work_dir` 为空时才 `rmSync`）。
- `fsRoot` 优先返回 `ctx.workDir`；`@<会话>` 也按目标会话的 `work_dir` 解析（`resolvePastPath`）。
- 目录选择器：`routes/local.js` 用 `osascript`（mac）/ `zenity`/`kdialog`（Linux）弹原生窗口，
  **仅 `AGENT_LOCAL_PICK=1` 时挂载**（`server.js`），服务器形态 `/api/local/*` 一律 404，前端整条入口隐藏。
  必须 `execFile` 异步：同步会阻塞事件循环、卡住所有 SSE。
- 只接受已存在的目录（`normalizeWorkDir` 校验真实路径），并拒绝根目录 `/` 与平台数据目录。
- 服务器形态：前端从不传 `work_dir`，`work_dir` 列恒为空，行为与旧版完全一致。
