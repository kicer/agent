# Agent 任务台

自托管的通用 Agent 系统。浏览器或微信发来任务，服务端调度模型、调用工具，在独立工作目录里生成文件并回传结果。

它不是聊天壳子：每个会话对应一个真实的 Linux 工作目录，模型可以读写文件、执行命令、抓网页、操作 SQLite、调用技能和 MCP 服务；命令在隔离容器中运行，文件可以直接下载或生成公网临时链接。

- 面向个人或小团队自用，单实例部署。
- 模型层兼容任何 OpenAI `/chat/completions` 接口。
- 前端是免构建的移动优先 H5，HTTPS 下可安装为 PWA。

---

## 能力

| 能力 | 说明 |
|---|---|
| 任务会话 | 每个会话一个独立目录 `tasks/<会话 id>/`，历史、文件、模型绑定都随会话保存 |
| 模型池 | 多平台、每平台多 key、每平台多模型；key 共享并发，不独占、不排队 |
| 工具调用 | 文件读写编辑、目录列举、复制、命令执行、网页抓取、SQLite、定时任务、技能、长期记忆等 14 个内置工具 |
| 隔离执行 | `terminal` 和技能在 `agent-executor` 容器中运行，只看到当前会话目录，根文件系统只读 |
| 大文件交付 | 文件面板上传/下载/打包 zip；外部服务取图走带过期时间的公网短链 |
| 上下文管理 | 手动压缩、按 token 阈值提示压缩、历史重放自动裁剪、会话标题自动生成 |
| 回合中投递 | 运行中发的消息先进输入框上方的待发送条幅：默认等本轮结束自动发出；可「干预」（当前工具跑完就插话）或「立即发送」（终止本轮并立刻发）。队列在服务端，关页面不丢 |
| 定时任务 | 每会话最多一个 cron 任务；触发前清空模型可见历史，按计划执行并推送结果 |
| 微信接入 | 扫码绑定个人微信，文本/图片/视频/文件进入同一套会话与命令体系 |
| 语音输入 | 输入框为空时发送键变麦克风：点一下进入语音模式，输入框位置变成「按住 说话」，松开即转写并直接发送；发送键位置变键盘按钮可切回打字。套壳 App 走原生录音（http 页面也能用），浏览器走 MediaRecorder（需 HTTPS）；识别在 `mcp_asr`，不经过模型、不消耗 token |
| 长期记忆 | 会话收口时生成第一人称工作日记；微信新会话注入最近几条，`recall` 可检索全部 |
| 用户画像 | 记录称谓、行业、偏好，会话创建时冻结注入，跨会话生效 |
| 技能 | 目录式技能（`SKILL.md` + `run.py`/`run.sh`），可在设置页管理 |
| MCP | 启动时发现 MCP 服务的工具；仓库内自带 `web_search` / `image_task` / `video_task` 三个 |
| 多用户 | 登录账号、管理员角色、按用户隔离的会话列表与画像 |

---

## 快速开始

### 前置条件

- Linux 服务器，Docker 与 Docker Compose v2。
- 至少一个 OpenAI 兼容模型平台的 API Key。
- 一个可用端口，默认 `8090`。

Debian 12 裸机可以先跑 `scripts/init_host.sh`（幂等，可重复执行，也可单独拷到服务器上跑）：它会配好 Swap、Docker、国内镜像加速与基础 shell 环境；`REGION=oversea` 切海外源。跑完会打印后续的 `init.sh` 与部署步骤。

### 1. 初始化（只做部署接线）

在仓库根目录执行：

```bash
./scripts/init.sh
```

它只做三件事，**幂等**，随便重跑：

1. 生成 `.env` 里的 `EXECUTOR_TOKEN` / `WXBOT_TOKEN` / `AUTH_SECRET`（已有值原样复用，重跑不会掉登录态，也不会换掉 executor 的 token）。
2. 探测公网 IP 并写成 `PUBLIC_BASE_URL`（外部服务靠它回取会话文件，图生视频需要）。知道地址就直接给：
   ```bash
   PUBLIC_IP=1.2.3.4 ./scripts/init.sh
   ```
3. 确保 `config.yml` 存在：**不存在时**才创建，内容只有初始管理员 `admin` / `admin`。已有文件**绝不改写**。

脚本不再生成模型平台 / MCP / 语音这些配置——它们全部在前端「设置」里完成，写的就是同一个 `config.yml`。所以重跑脚本永远不会清掉你配好的东西（旧版脚本会覆盖，这是本次的行为变化）。

- 想换初始管理员：仅在**首次创建**时生效，`AUTH_USER=me AUTH_PASSWORD='强密码' ./scripts/init.sh`。
- `config.yml` 被 Docker 误建成了空目录（源文件缺失时才会这样）：脚本会自动删掉并重建；目录非空则报错让你手工处理。

没有 `config.yml` 也能启动：`platforms` 为空、`auth` 为空即“无模型 + 不启用登录”，登录后从设置页补齐即可（保存后点「重启服务」生效）。

### 2. 启动

```bash
# 迁移：把旧版根目录的 config.yml 原样留着即可，init.sh 不会动它
docker compose up -d --build
docker compose logs -f agent-core
```

看到 `Agent server listening on 8090` 即启动完成。

首次启动还会运行一次性的 `agent-executor-init`，把技能依赖安装到 `./skills/deps`，随后自动退出，属正常现象。

### 3. 访问与首次配置

浏览器打开：

```text
http://<服务器 IP>:<AGENT_PORT>
```

首次用 `admin` / `admin` 登录（**登录后立刻在「设置 → 账户」改密码**）。默认端口 `8090`，可用 `.env` 的 `AGENT_PORT` 修改。

登录后去「设置」补齐三块，保存后点页面顶部的「重启服务」：

| 设置页 | 配什么 |
|---|---|
| 模型 | 平台地址 + API Key + 模型 id（`extra_params` / `thinking_params` / profile 等在「高级」里） |
| MCP | `image_task` / `video_task` / `asr` 需上游 key；`web_search` 免费，地址 `http://mcp_web_search:3000/` |
| 用户 | 其余账号、角色、默认模型；改密码在「账户」 |

对外只需要放行 core 这一个端口。`agent-executor`、`wxbot` 和 MCP 服务都只在 Docker 内网，不映射到宿主机。

### 4. 同栈 MCP 服务

初始 `config.yml` 不包含任何 MCP 服务。设置页「MCP」会把四个同栈服务作为**内置服务卡片**列出来，
点卡片 → 填表 → 保存即可（url 与 header 名由 `app/server/presets.json` 提供，不用记）。
`web_search` 免费、无需 key；另外三个要填上游 key。手工写 YAML 的形状如下（容器不存密钥）：

```yaml
mcp_servers:
  - name: web_search
    url: "http://mcp_web_search:3000/"

  # - name: image_task
  #   url: "http://mcp_image_task:3000/mcp"
  #   headers:
  #     Authorization: Bearer <upstream-api-key>
  #     X-Image-Task-Base-Url: "https://open.bigmodel.cn/api/paas/v4"   # 任意 OpenAI 兼容的 images 上游（生成 /images/generations、编辑 /images/edits）
  #     X-Image-Task-Model: "CogView-4"
  #   mode: skill
  # - name: video_task
  #   url: "http://mcp_video_task:3000/mcp"
  #   headers:
  #     Authorization: Bearer <zhipu-api-key>
  #   mode: skill
  # - name: asr
  #   url: "http://mcp_asr:3000/mcp"
  #   headers:
  #     Authorization: Bearer <key>           # 免鉴权的自建服务可省
  #     X-ASR-Base-Url: "https://<host>/v1"
  #     X-ASR-Model: "whisper-1"
  #   mode: skill
```

`web_search` / `image_task` / `video_task` / `asr` 四个容器与 core 由同一个根 `docker-compose.yml` 启动（与是否写进配置无关），没有先后顺序，也不占宿主机端口。工具说明、header 覆盖项与调试方式见 [mcp/README.md](mcp/README.md)。

`ASR_URL`（`docker-compose.yml` 里固定为 `http://mcp_asr:3000`）是 core 调用语音转写的基地址；把 `mcp_asr` 放到另一台机器时改这一行即可（那台要能接受 `Authorization` / `X-ASR-Base-Url` / `X-ASR-Model` 三个 header）。

语音输入（H5 输入框里说话）走的是另一条路：客户端录音 → `POST /api/asr/transcribe` → `mcp_asr` 的 `/transcribe`，**不经过模型、不消耗 token**，结果插入输入框可编辑。客户端录音契约（Android 套壳原生桥 / 浏览器 MediaRecorder）见 [docs/voice-input.md](docs/voice-input.md)；删掉 `config.yml` 里的 `asr` 段即整体关闭。

`mcp_asr` 自己**不存任何平台密钥**：上游 key / base_url / model 都由 core 从这里那段 `asr.headers` 随请求带进去，换平台只改 YAML（不用重建镜像、不用动 `.env`），也不预设任何厂商。

接入栈外的 MCP 服务：在设置页添加 `url` / `headers`，或在 `config.yml` 的 `mcp_servers` 追加一项。服务不可达时 core 只在启动日志里告警，不影响 Web 主流程，但对应工具不会下发给模型。

每个服务可用 `mode` 控制「工具是否下发给模型」：

| `mode` | 连接/发现 | 进 tools 数组 | 进技能清单 | 谁可以调用 |
|---|---|---|---|---|
| `advertise`（默认） | ✓ | ✓ | ✗ | 模型与技能 |
| `skill` | ✓ | ✗ | ✓ | `skill` 工具与 `lab` |
| `disable` | ✗ | ✗ | ✗ | 无人 |

`skill` 用于「能力包在技能后面」的场景：工具照常发现并注册，只是不进模型的 tools 数组，改为以技能形式暴露——`{"op":"list"}` 能看到它，`{"op":"get","name":"<名>"}` 直接返回 MCP 原始的 `description` + `input_schema`，`{"op":"run","name":"<名>","args":{…}}` 转发给服务。不用在 `skills/` 里建目录。旧字段 `enable` 已废弃，`mode: silent` 已移除（启动会报错并提示改用 `skill`）。

工具发现只在启动时做一次，因此发现失败后会自动按 **2s / 20s / 1min 重试 3 次**（覆盖 compose 并行拉起与宿主机重启后的容器乱序）；成功后工具在下一轮请求即可用，三次都失败则需重启 core。四个 MCP 服务都配了 `/health` 健康检查，`docker ps` 可直接看状态。

---

## 使用

### 会话与模型

- 新建会话时自动绑定一个模型；不选则按平台轮转选择。
- 会话创建后模型绑定保持，重启、追问都不会丢。
- 模型被删除或禁用后，下一条消息会自动改选原平台的可用模型。
- 管理员可在「设置 → 用户」给某个用户锁定默认模型。
- 顶部「切换模型」只在该会话空闲时可用；正在输出时会拒绝换绑。

会话状态：

| 状态 | 含义 |
|---|---|
| 保持中 | 回合已结束，可以直接继续追问 |
| 活跃中 | 正在执行模型回合 |
| 已完成 | 已手动断开或空闲超时收口，仍可继续发消息 |
| 已终止 | 用户主动停止 |

### 文件

- 输入框附件、微信附件都落在 `tasks/<会话 id>/`。
- 右侧「任务文件」面板支持上传、下载、批量打包、删除、子目录浏览。
- 模型生成的文件与用户上传的文件在同一目录，AI 可直接继续处理。
- 超过 50 MB 的单文件上传会被拒绝；移动端大图上传前会在浏览器端压缩。

### 上下文压缩

- 顶部「压缩」可手动触发：模型基于完整历史生成摘要，摘要之前的消息标记为已存档，UI 仍可见，但不再发给模型。
- 当单回合输入 token 超过 `agent.auto_compress_tokens` 时，前端会弹一次确认框，询问是否压缩。
- 历史重放还会自动把较旧的 `write_file` 参数正文、`fetch` / `read_file` 回执替换为单行占位，数据库与 UI 不受影响。

### 定时任务

对 AI 说「每天早上九点汇总……」，它会在当前会话创建 cron 任务：

- 每会话最多一个任务，最小间隔 1 小时，时区固定 `Asia/Shanghai`。
- 每次触发前，会话历史整体标记为已存档，模型只看到任务提示词，等价一次全新会话。
- 执行结果留在会话里，同时可通过微信推送。
- 创建任务后，当前会话会收口为该任务的「专柜」，用户下一条消息自动进入新会话。

### 微信

在「设置 → 账户 → 微信绑定」生成二维码，扫码后即可单线对话：

- 微信消息复用同一套会话和命令层，支持 `/new`、`/list`、`/switch`、`/delete`、`/rename`、`/models`、`/think`、`/stop`、`/compact`、`/clear`、`/status`、`/help`。
- 回合进行中发消息＝自动干预：当前工具调用跑完就插话（同批剩余调用标记为「因你介入未执行」），不会等本轮结束，也不会打断正在执行的命令。要立刻中止用 `/stop`。
- 图片、视频、文件会落到当前会话目录；单发媒体只留痕，不唤醒 AI。
- AI 最终回复会推回微信；较长回复自动分段，超长时落成 `.md` 文件卡片。
- 定时任务完成或失败也会通知微信。

### 长期记忆

- 会话空闲超过 `memory.wrap_idle_ms`（默认 4 小时）后，后台生成一条工作日记碎片，并归档、解绑通道。
- 微信新会话开场注入最近 `memory.inject_max` 条碎片。
- AI 可用 `recall` 工具按关键词、日期索引、具体某天检索全部日记。
- 删除会话会连带删除它的日记碎片；清空会话在普通情况下也会删除，但定时任务「专柜」例外。
- 日记调试页：`/memory.html`。

---

## 配置

`config.yml` 只给 `agent-core` 读取，包含平台密钥和登录密钥。`agent-executor`、`wxbot` 不挂载、不读取它。

主要配置段：

| 段 | 作用 |
|---|---|
| `platforms` | 模型平台池：`name`、`url`、`type`、`models`、`keys` |
| `model_profiles` | prompt + 工具名单组合；模型用 `profile: <名>` 引用 |
| `tools_deny` | 全局工具黑名单，默认屏蔽元工具 `lab` |
| `auth` | 登录账号、`secret`、有效期；留空则不启用认证 |
| `mcp_servers` | 外部 MCP 服务：`url`、`headers`、`mode`（advertise / skill / disable）、`timeout_ms`、工具名单 |
| `public_link` | 公网临时链接前缀与有效期 |
| `agent` | 温度、最大工具迭代、重试、语言、压缩阈值、空闲收口、历史裁剪 |
| `memory` | 日记注入条数、保留期、空闲收口阈值 |
| `terminal` / `fetch` | 命令超时与输出上限、抓取超时、字节数、SSRF 开关 |
| `skills` | 技能目录与单次执行超时 |
| `upload` | 前端大图压缩阈值与参数 |
| `workspace_root` / `data_root` | 任务目录与 SQLite / 调试产物目录 |

平台结构示例：

```yaml
platforms:
  - name: bigmodel
    url: https://open.bigmodel.cn/api/paas/v4
    type: bigmodel          # 决定余额查询适配器
    models:
      - id: glm-5.3-flash
        vision: true
        extra_params: { reasoning_effort: "low", tool_stream: true }
        thinking_params: { reasoning_effort: "max" }
    keys:
      - api_key: "sk-..."
```

通用模型字段：

- `enable: false`：模型不进池，不参与分配。
- `vision: false`：读图时不回传像素，回执只给结构化说明（`reason: no_vision`）。
- `profile: <名>`：引用 `model_profiles`，不配则使用默认全量 prompt 与工具。
- `reasoning_ack_field`：需要把思考链回传给上游时填写，例如 DeepSeek 系的 `reasoning_content`。

日常修改配置建议使用设置页；改完需重启生效。设置页写入前会先校验，非法配置不会覆盖原文件。

### 环境变量

| 变量 | 作用 |
|---|---|
| `AGENT_CONFIG` | core 配置文件路径，容器内固定 `/app/config.yml` |
| `PORT` | core 监听端口，容器内 `8090` |
| `EXECUTOR_URL` | `agent-executor` 地址；空则命令在 core 进程内本地执行，仅适合开发 |
| `EXECUTOR_TOKEN` | core ↔ executor 的 Bearer token，两侧同值 |
| `ASR_URL` | core 拼接 `/transcribe` 的基地址，compose 里固定 `http://mcp_asr:3000`（把 `mcp_asr` 放别处时改那一行） |
| `ASR_LOG_LEVEL` | `mcp_asr` 日志等级 |
| `WXBOT_URL` | wxbot 地址；置空则微信功能整体关闭 |
| `WXBOT_TOKEN` | core ↔ wxbot 的共享 token |
| `PUBLIC_BASE_URL` | 对外的完整地址（如 `http://1.2.3.4:8090`），作为 `public_link` 的默认值；设置页填过则以设置页为准 |
| `PREVIEW_PROXIES` | 覆盖内置预览反代注册表（JSON 数组） |
| `EXECUTOR_LOG_LEVEL` / `WXBOT_LOG_LEVEL` | 两个附属服务的日志等级 |

`config.yml` 与 `.env` 都含密钥，已在 `.gitignore` 中。不要提交，也不要挂给不需要它的容器。

---

## 内置工具

模型实际收到的工具是内置工具加 MCP 工具，再经 `tools_deny` 与模型 `profile` 过滤。

| 工具 | 用途 |
|---|---|
| `read_file` | 读文本或图片；大文件返回符号大纲；支持 `@<会话 id>/<路径>` 只读查看历史会话文件 |
| `write_file` | 新建或覆盖文本文件 |
| `edit_file` | 按 `old_text` / `new_text` 做精确或容错编辑 |
| `list_directory` | 单层列目录；支持 `@<会话 id>/<路径>` |
| `copy_path` | 复制文件或目录；可从历史会话导入文件 |
| `terminal` | 执行 shell 命令；默认在会话目录，超时可终止 |
| `fetch` | 抓取 HTTP/HTTPS 并转 Markdown；带 SSRF 防护与分段续读 |
| `mint_public_link` | 为会话内文件签发短期公网链接 |
| `skill` | 技能：`op` = `list` / `get` / `run`；`name` 指技能，`args` 传参数 |
| `db` | 操作会话本地 `data.db`：`exec`、`query`、`insert`、`tables`、`schema` |
| `schedule` | 定时任务 `get` / `list` / `create` / `update` / `delete` |
| `profile` | 用户画像 `list` / `set` / `add` / `remove` |
| `recall` | 长期记忆 `search` / `days` / `day` |
| `lab` | 元工具：按名字调用任意工具，`help` 可列出全部工具；默认被全局黑名单屏蔽 |

跨会话路径只读：`@` 形式只用于 `read_file`、`list_directory` 和 `copy_path` 的源路径，且只能访问同一用户自己的会话。要真正处理旧文件，先用 `copy_path` 导入当前会话。

---

## 技能

技能是 `skills/<名字>/` 目录：

```text
skills/my-skill/
├── SKILL.md          # 必需：描述、input_schema、可选 required / visit_url
├── run.py | run.sh   # 入口，唯一命令行参数是 JSON 字符串
├── requirements.txt  # 可选：Python 依赖
└── install.sh        # 可选：系统层安装脚本，镜像构建期执行
```

- `SKILL.md` 的 `description` 会进入 system prompt，模型启动时就知道有哪些技能。
- `input_schema.required` 在 `op=run` 前校验。
- MCP 工具不用建目录：给该服务配 `mode: skill`，平台会自动把它暴露成技能（`get` 返回 MCP 原始的
  `input_schema`，`run` 转发），见上文「同栈 MCP 服务」。
- 入口脚本以绝对路径启动；远端执行时 cwd 是会话目录，本地开发时是技能目录。相对路径参数会先按会话目录转成绝对路径。
- `requirements.txt` 的依赖由 `agent-executor-init` 安装到 `skills/deps`；技能容器通过 `PYTHONPATH` 可见。
- `install.sh` 在镜像构建期以 root 执行，用于必须落在系统层的依赖。改完需要重建 executor 镜像。
- 技能目录在 executor 中只读，运行期不能修改技能本身。

设置页支持创建、重命名、删除技能和在线编辑文本文件；技能列表变更后会实时刷新 system prompt 中的清单，无需重启。

---

## 安全模型

### 部署边界

- 对外只暴露 `agent-core` 端口。
- `agent-executor` 使用独立的 mount / PID / IPC namespace，只 bind 当前会话目录；根文件系统只读，丢弃全部 capability 后仅保留 `SYS_ADMIN`。
- 命令容器没有独立网络 namespace，所以 executor 会拒绝来自自身容器网卡的 `/exec` 请求，避免 token 泄漏后被借用。
- `wxbot` 只挂内网；微信登录凭证在 `./wxbot/data`，等同微信账号权限，不要外泄。
- 配置文件、`.env`、微信凭证、任务目录、SQLite 都属于敏感数据。

### 认证与授权

- 登录使用 HMAC 签名的 HttpOnly Cookie，支持 `Authorization: Basic` 作为脚本 / curl 的兜底。
- `auth.users` 留空则完全关闭认证，只适合本机或完全可信网络。
- 管理员接口：配置读写、用户管理、进程重启。
- 删除用户会连带清理其微信绑定（含 wxbot 实例与凭证）、会话（含任务目录）、画像、长期记忆与通道绑定；`model_usage` 的用量统计保留（与删会话一致，不清账）。
- **重要**：系统按单租户设计。除上述管理员接口外，会话、消息、文件、技能等 API 只校验「已登录」，不按用户做资源级授权；按用户的会话列表隔离发生在前端查询层。不要把实例开放给互不信任的用户。

### 公网临时链接

`mint_public_link` 生成 22 字符随机 ID，链接形如：

```text
http://<host>/p/<id>
```

- 只由 core 进程内的工具签发，签发前校验文件在任务目录内且 `realpath` 未越界。
- 默认 30 分钟过期，可配置 1 分钟到 24 小时。
- 链接可重复使用，直到过期；服务重启后全部失效。
- 任何人拿到链接即可匿名访问，不要对含密钥的文件签发。

### HTTPS

仓库不内置 TLS 反向代理。直接 `http://IP:端口` 使用时：

- PWA / Service Worker 不会注册。
- 复制按钮会回退到旧 API。
- 登录 Cookie 不带 `Secure` 标志，HTTP 下正常工作。

如果前面加 nginx 等反向代理，SSE 必须关闭缓冲：

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_read_timeout 3600s;
```

公网链接前缀取 `config.yml` 的 `public_link.base_url`（设置页「服务 → 公网地址」）；没填时用 `.env` 的 `PUBLIC_BASE_URL`（`init.sh` 会自动探测写入）。前置了反向代理 + HTTPS 的部署，直接把它填成域名即可。

---

## 运维

### 数据位置

| 宿主机路径 | 容器内 | 内容 |
|---|---|---|
| `./tasks/` | `/workspace/tasks` | 每个会话的工作目录 |
| `./data/` | `/workspace/data` | SQLite `.agent.db`、`prompt.txt` 调试产物 |
| `./skills/` | `/workspace/skills` | 技能与共享依赖 |
| `./config.yml` | `/app/config.yml` | core 配置 |
| `./wxbot/data/` | `/data` | 微信登录凭证 |

备份至少覆盖 `data/`、`tasks/`、`config.yml`；需要保留微信登录态时再备份 `wxbot/data/`。

### 升级

```bash
git pull
docker compose up -d --build
```

数据库与任务目录都在 bind mount 中，升级不丢数据。进程重启时，执行中的回合会被打断；`active` 会话会归位为保持中，用户再发消息即可继续。

> 从旧的「agent + mcp 双仓库」部署升级：旧 mcp 容器占着 `agent-mcp-net` 和同名 `container_name`，需先停旧栈再 `up` 本栈，否则会报 `network agent-mcp-net has active endpoints` 或 `container name ... is already in use`。旧仓库的 `down` 只需执行一次：
>
> ```bash
> cd /root/workspace/tools/mcp && docker compose down
> cd /root/workspace/tools/agent && docker compose up -d --build
> ```
>
> 微信服务已改名为 `agent-wxbot`（原容器名 `wxbot`）。旧容器不受新 compose 管理，升级后需手动清理，否则两个实例会同时轮询同一个微信号：`docker rm -f wxbot`。

### 日志与健康检查

```bash
docker compose logs -f agent-core
docker compose logs -f agent-executor
docker compose logs -f agent-wxbot
curl -s http://127.0.0.1:8090/api/health
# {"ok":true,"service":"agent-core","api":1,"time":...,"auth_required":true}
```

- `GET /api/health` 是**唯一免登录接口**，供运维探活，也供套壳 App 校验用户手填的服务器地址。
  客户端判定条件：HTTP 200 且 `ok === true` 且 `service === 'agent-core'`——**不要只看状态码**，
  填错到别的站点或反代首页同样可能回 200。地址末尾的 `/` 可带可不带。
  `auth_required` 用于区分「地址对了但没登录」与「地址错了」。

- core 日志等级由 `config.yml` 的 `log_level` 控制，改完重启生效。
- executor / wxbot 的日志等级由各自环境变量控制，`debug` 会打印完整交互。
- 启动时会在 `data/prompt.txt` 写入实际下发的 system prompt 与各 profile 的工具清单，便于核对。

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 启动时报 `network agent-mcp-net has active endpoints` | 旧的双仓库部署残留：先停旧的 mcp 仓库（`docker compose down`），再 `up` 本栈 |
| 套壳 App 填了服务器地址仍连不上 | 先 `curl <地址>/api/health` 看是否返回 `service:agent-core`；再查 Android 9+ 默认禁止明文 HTTP（需 `usesCleartextTraffic`）与 https 自签证书 |
| 麦克风按钮不显示 | `config.yml` 的 `mcp_servers` 里没有启用的 `asr` 段 / 该段缺 `X-ASR-Base-Url`（`GET /api/asr/status` 会返回 `reason`）；或浏览器以 `http://<IP>` 访问且没有原生录音桥（非安全上下文开不了麦，见 `docs/voice-input.md`） |
| 点麦克风提示「语音识别服务不可用」 | `mcp_asr` 未起来（`docker compose logs --tail=50 mcp_asr`）；或 `config.yml` 的 `asr.headers` 缺 `X-ASR-Base-Url` / `X-ASR-Model` |
| `config.yml` 变成目录 | 启动前文件不存在，Docker 自动建了同名目录；重跑 `./scripts/init.sh` 会自动删除空目录并重建（非空目录需先备份再手工删除） |
| 没有可用模型 | `platforms` 为空或模型全部禁用；在设置页添加后重启 |
| 创建会话报「无可用模型」 | 模型池为空，或指定模型所在平台没有 key |
| 技能依赖缺失 | 重新 `docker compose up -d --build agent-executor`；或检查 `skills/deps` |
| 微信设置页显示未连接 | wxbot 未启动，或 `WXBOT_TOKEN` 两侧不一致 |
| 图生视频拉不到参考图 | `public_link.base_url` 未配置，或公网不可达 |
| 启动日志出现 `xxx 工具发现失败` | 当时服务未就绪，core 会按 2s/20s/1min 重试 3 次；仍失败则重启 `agent-core` |

---

## 目录

```text
agent/
├── app/                  agent-core：Express + SQLite + 前端静态资源
├── executor/             agent-executor：隔离命令执行与 Office 预览网关
├── wxbot/                微信 iLink 协议调制解调器
├── mcp/                  同栈 MCP 服务：web_search / image_task / video_task
├── skills/               技能目录
├── tasks/                会话工作目录（运行时生成）
├── data/                 SQLite 与调试产物（运行时生成）
├── docs/                 专题文档
├── docker-compose.yml
└── scripts/init.sh
```

进一步阅读：

- [mcp/README.md](mcp/README.md)：同栈 MCP 服务（搜索 / 生图 / 生视频）。
- [docs/OFFICE.md](docs/OFFICE.md)：Office 文档技能与预览链路。
- [docs/tool-design.md](docs/tool-design.md)：工具接口设计规范。

## 开发

```bash
cd app
npm install
node server/server.js
```
