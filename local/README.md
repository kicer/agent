# 本地端（local 模式）

把同一个 `agent-core` 直接跑在本机（macOS / Linux），不装 Docker、不起 executor。

它和服务器版是**同一份代码**，差别只在三件事，全部由 `local/start.sh` 注入：

| 差异 | 服务器 | 本地 |
|---|---|---|
| 命令在哪跑 | `agent-executor` 容器（mount/pid namespace 隔离） | 直接在本机 `spawn`（无沙箱） |
| 文件工具的根 | 会话目录 `tasks/<会话id>/` | 你选的工作目录下的 `tasks/` |
| 监听地址 | `0.0.0.0`（靠宿主机端口映射对外） | `127.0.0.1`（只有本机能访问） |

后两项分别由环境变量 `AGENT_FILE_SCOPE=workspace` 和 `HOST=127.0.0.1` 控制，容器部署不设置，
行为与以前完全一致。

## 快速开始

```bash
cd agent
./local/start.sh     # 后台启动，命令 1 秒就返回，可以关掉终端窗口
./local/stop.sh      # 停止
```

首次运行会：

1. 自检环境（Node 20+ 必需；ffmpeg / python3 可选），并打开一个**启动状态页**
2. 弹窗让你选一个**工作目录**，在里面建 `data/`、`skills/`、`tasks/` 三个子目录
3. 把仓库 `skills/` 里的内置技能复制到 `<工作目录>/skills/`
4. 生成 `local/config.local.yml`
5. 装一次 Node 依赖（`app/` 与带依赖的 MCP，需要联网）
6. 起 core + MCP 子进程（没 ffmpeg 时 asr 不启动）
7. 停在那儿守护：core 退出就自动拉起

工作目录是你的：数据库、会话、技能都在里面，仓库里不存任何运行数据。

浏览器里首次使用：**左下角「用户区」→ 设置 → 模型池**，添加平台和 API Key，然后点「重启」。

新建会话时，欢迎页「随时开始吧」下方可以**手选一个工作目录**：选了之后这个会话的 AI 一切操作
都在那个目录里（不再建 `task-*` 子目录）；不选就沿用默认（`<工作目录>/tasks/<会话id>`）。
删会话不会删你选的目录。

没有 Node 20+ 时不会让你白选目录：脚本在入口就停下，终端打出安装方式，自检结果（哪项缺、怎么装）写到状态页。

> 「重启」能用是因为启动器在守护。`routes/system.js` 的重启实现是 `process.exit(0)`，
> 原本靠 Docker 的 restart 策略拉起；本地没有 Docker，没有守护的话点一次服务就回不来了。

启动器在后台常驻，所以：

- 关掉终端窗口**不会**停服务；要停就 `./local/stop.sh`
- 重复跑 `./local/start.sh` 是安全的：检测到已在运行就只打印地址和停止方式
- 想在终端里看实时日志、用 `Ctrl-C` 停：`AGENT_LOCAL_DETACH=0 ./local/start.sh`

## 启动状态页

启动时会在浏览器打开 `local/.runtime/status.html`（macOS 默认自动弹，Linux 要 `AGENT_LOCAL_UI=1`）：

- 启动过程中每秒自动刷新，依次列出环境自检、工作目录、依赖安装、MCP、core 就绪
- 长步骤（装依赖、等 core 起来）会显示已用时间，并把 npm / core 日志的尾巴实时刷出来
- **首次安装**（配置刚生成）不自动跳转：就停在这一页，点「打开应用」自己进去
- **后续启动**：就绪后 2 秒自动进应用（同一个标签页）
- **失败时就在页面上给出原因和日志**，不用回头翻终端

这个页面是纯静态文件（不用起服务），所以“node 都没装”的时候也能打开。重跑脚本会重新生成；
即使没自动弹出，文件也一直在那个路径。

## 可选能力

| 能力 | 需要 | 没有时的表现 |
|---|---|---|
| 语音输入 | `ffmpeg` + 设置页给 `asr` 填上游（`X-ASR-Base-Url` / `X-ASR-Model`） | 麦克风入口自动隐藏（`/api/asr/status` 返回 `enabled:false`），`mcp_asr` 子进程也不启动 |
| 技能 | `python3`（仅 Python 类技能需要） | 技能清单照常显示；调 `run.py` 类技能报「入口启动失败」，`office` 这类非 Python 技能不受影响 |
| Office 文档（docx/xlsx/pptx） | 首次用到时下载一次 officecli 二进制（约 34MB） | `office` 报 `binary missing` 并给出该技能 `AGENTS.md` 的路径，按它下载即可（不需 root、不需重启）；预览面板里直接显示同一份安装说明 |
| 网页搜索 | 无 | 装了 Node 就有（内置免费后端） |
| 图片 / 视频生成 | 设置页给对应 MCP 填上游 key | 调用时报明确的缺参错误 |

装完 `ffmpeg` 之后**重跑一次 `./local/start.sh`** 即可生效。`python3` 稍特殊：技能清单本来就在，
只要新装的解释器落在 core 启动时 `PATH` 已包含的目录里（如 brew 的 `/opt/homebrew/bin`）就无需重启；
换了目录就重跑脚本。这三项都不写进配置，靠「起不起子进程 / 注入什么环境变量」切换。

## 配置放哪

你选的工作目录下：

| 路径 | 内容 |
|---|---|
| `<工作目录>/data/` | SQLite（`.agent.db`）、启动时的 prompt dump |
| `<工作目录>/tasks/` | 会话工作区，一个会话一个 `task-YYYYMMDD-NNN/` |
| `<工作目录>/skills/` | 技能；内置技能首次启动时复制过来，以后只补缺不覆盖。依赖装在 `skills/deps/` |

仓库里只有：

- 生成的配置：`local/config.local.yml`（**首次生成，之后永不覆盖**，避免冲掉你在网页里配的模型与密钥）
- 运行期产物：`local/.runtime/`（`status.html` 状态页、`core.log`、`npm-install.log`、`mcp-*.log`、`preview.log` + `watch-<端口>.log`）

想彻底重来：删掉 `local/config.local.yml` 再启动（工作目录里的数据不会动，重选一个目录就换一套）。
技能要跟着仓库更新：删掉 `<工作目录>/skills/<技能名>` 再启动，脚本会把新版补回来（你自建的技能不受影响）。

## 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8090` | core 端口（别撞下面的 MCP 端口） |
| `NPM_REGISTRY` | 空 | 手动指定 npm 源（默认自动探测；指定后不再自动换源） |
| `MCP_WEB_PORT` / `MCP_IMAGE_PORT` / `MCP_VIDEO_PORT` / `MCP_ASR_PORT` | 8091~8094 | 四个 MCP 的端口（同机跑必须各占一个；改这里还要同步改配置里的 url） |
| `PREVIEW_PORT` | `3100` | office 文档预览网关的端口（被占时自动往后找）；watch 自己的端口从 26315 起 |
| `AGENT_LOCAL_UI` | `auto` | 是否自动打开状态页：`auto` = 仅 macOS，`1` 强制，`0` 关闭（页面无论如何都会生成） |
| `AGENT_LOCAL_DETACH` | `1` | `1` = 后台启动后立即返回（用 `stop.sh` 停）；`0` = 前台阻塞（看实时日志、`Ctrl-C` 停） |
| `AGENT_LOCAL_CACHE` | `~/.cache/agent-local` | 依赖缓存的存放位置（多个 clone 共享） |
| `AGENT_LOCAL_NPM_TIMEOUT` | `240` | 单次 `npm install` 的超时秒数，超过就换源重试 |

## 依赖安装与网络（国内环境）

首次启动要装一次 Node 依赖，启动器会自己处理环境问题，不需要你操心：

- **自动选源**：并行探 `registry.npmmirror.com` 与官方源，用最快的那个（国内基本会选 npmmirror）。
  结果缓存一天；不写你本机的 `~/.npmrc`，也不改全局配置。
- **失败自动换源重试**：一个源不行就换下一个；换源成功会记住它。
- **卡住有看门狗**：npm 在断网时可能既不报错也不退出，超过 `AGENT_LOCAL_NPM_TIMEOUT` 就结束它并换源。
- **装完存缓存**：打成一张 tarball 放到 `~/.cache/agent-local/`。之后重启、删掉 `node_modules`、
  再 clone 一份，都是解压恢复（秒级、零网络）。
- **失败说人话**：状态页会直接告诉你「网络没通 / 缺编译工具链（`xcode-select --install`）/ 没有写权限」，
  不需要读 npm 日志。

要清缓存就删那个目录：`rm -rf ~/.cache/agent-local`（下次启动会重新装一次）。

## 更新

```bash
git pull
./local/stop.sh && ./local/start.sh   # package.json 变了会自动重装依赖
```

`app/server` 是直接跑源码，前端也是免构建的，所以改完代码重启（或在网页点「重启」）即生效。

## 安全边界（务必知情）

本地模式**没有沙箱**：AI 的 `terminal` 就是本机 shell，能读写你账号有权限的任何文件，
包括 `~/.ssh`、浏览器数据、其它项目。这不是配置疏漏，而是「给它一个目录就放开手脚」的代价。

两条低成本保险：

1. 工作目录选一个**专用**目录，别直接选 `$HOME` 或整个代码仓库根
2. 那个目录先 `git init` 一下，改坏了能回滚

另外，`core` 只监听 `127.0.0.1`，同一局域网的人访问不到。

## 已知限制

- **没 ffmpeg 时 core 日志会有一条 `asr 工具发现失败`**：此时 `mcp_asr` 不启动（它转码要靠
  ffmpeg），但配置里的 asr 条目仍保留（配置不被覆盖）。重试几次后放弃，不影响其它功能。
- **`mcp_asr` 启动后监听 `0.0.0.0`**：它只认 `PORT` 环境变量，没有 `--host` 参数
  （另外三个服务都传了 `--host 127.0.0.1`）。它不存任何密钥（上游参数随请求带入），
  暴露面有限，但严格起见可以给 `mcp/asr` 补一个 `--host` 支持。
- **Windows 暂不支持**：本机执行走 `spawn('/bin/sh')` 与 `process.kill(-pid)`，都是 POSIX 语义。
- **链接只在本机可达**：没有公网前缀时，`mint_public_link` 与页面访问地址都会签成
  `http://127.0.0.1:<PORT>/...`，在这台机器上点得开，发给别人打不开。要对外暴露再填
  `public_link.base_url`（设置页）。本地监听回环地址，模型厂商也拉不到，所以读图回传改走内联
  base64（`AGENT_IMAGE_INLINE=1`，启动器已注入）。
- **`office` 预览依赖 `officecli`**：网关按需起 `officecli watch`（最多 4 个，闲置 6 小时回收）。
  没装二进制时预览面板会直接显示安装说明，不会无限转圈。watch 只能监听 `0.0.0.0`（它没有
  `--host` 参数），同机其它用户理论上能访问那几个端口。
- **技能依赖不预装**：本地没有 `agent-executor-init`，技能自带的 `requirements.txt` 不会在启动时
  自动安装。缺包时会报 `ModuleNotFoundError`，模型会把缺的包装进 `<工作目录>/skills/deps`
  （`AGENT_SKILLS_DEPS` 指向它，且已在该进程的 `PYTHONPATH` 里，装完下次运行即生效）。
  连 `python3` 都没有时技能清单依旧完整，模型会自己把它装上再继续。
  需要系统库的包（如 `weasyprint` 依赖 pango/cairo）pip 装不了，得自己 `brew install`。
- **首个 `npm install` 要联网**：启动器会自动选源、换源重试、并把装好的依赖缓存到
  `~/.cache/agent-local/`；之后重启 / 换 clone 都是本地解压，不需要网络。真要手动指定源：
  `NPM_REGISTRY=https://registry.npmmirror.com ./local/start.sh`。中途失败留下的半成品
  `node_modules` 不用手删（换源重试前会自动清）。

## 排查

```bash
open local/.runtime/status.html        # 启动状态页：步骤、失败原因、日志尾巴
tail -f local/.runtime/core.log        # core 日志（含 prompt dump 路径、MCP 发现结果）
tail -f local/.runtime/npm-install.log # 装依赖的输出
tail -f local/.runtime/mcp-asr.log     # 单个 MCP 的日志
tail -f local/.runtime/preview.log     # office 预览网关（watch 启动失败的原因也在这）
```

启动失败时状态页会自己弹出（带错误说明和日志尾部）；它是个静态页，所以改完环境要自己重跑脚本
（它不会自动重试）。

进程表 / 端口对不上时：

```bash
lsof -nP -iTCP:8090-8094 -sTCP:LISTEN   # core + 四个 MCP 的监听情况
lsof -nP -iTCP:3100 -sTCP:LISTEN        # 预览网关（没用 office 时不存在）
```
