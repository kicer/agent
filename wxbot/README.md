# wxbot

Agent 栈的微信「调制解调器」：基于官方 iLink 协议的 Node SDK
[`@wechatbot/wechatbot`](https://www.wechatbot.dev/zh/nodejs)，同进程多实例，
一个实例对应 agent-core 的一个用户绑定（扫码登录后，该微信里出现 bot 好友，
发给它的消息即进入你的 Agent 会话，回复实时推回）。

**本服务不保存业务状态、不对外服务**：绑定关系（core 用户 ↔ bot 账号）的权威在
agent-core 的 `wechat_bindings` 表；扫码二维码呈现在 agent-core 的 Web 设置页
（账户 → 微信绑定）。本服务已并入根 `docker-compose.yml`（`wxbot` 服务），目录代码已入 git 库；
零配置文件运行，接线全靠 compose 注入的 env（见下）。

## 架构与数据流

```
微信用户 ⇄ [iLink] ⇄ wxbot(本服务, :8093, 仅内网 agent-mcp-net)
                        │  收信转发  POST core:/wxhook/inbox {id, from, text}
                        │  状态回调  POST core:/wxhook/hook  {id, event, accountId?}
                        │  接收投递  POST self:/api/deliver  ← core 推最终回复
   agent-core ⇄ 浏览器 ⇄ core:/api/wechat（cookie 鉴权，绑定管理 + QR SVG 代理）
                        │  实例控制  POST/DELETE wxbot:/api/instances*
                        └ 总线监听   assistant 消息 → 分段投递（游标落库不重发）
```

- 收信 → core `/wxhook/inbox` 复用 **channel 命令层**（`/new /stop /compact /clear /status /help`），
  命令回执同步回文本；普通消息（AI 回复）异步由 core 经 `/api/deliver` 推送（`bot.send`）。
  图片/视频/文件消息经 SDK `download` 取字节随 inbox 转发（限 20MB），core 落会话任务目录；带说明文字的
  拼「用户上传了文件」告知行一起触发回合，**单发媒体只静默留痕不唤醒 AI**（下次提及自然能指代到该文件）。
- **单线对话**：iLink 扫码登录后只有绑定者本人能与 bot 会话，无陌生人入口，故无联系人授权面。
- 实例凭证按绑定隔离在 `./data/bots/<binding_id>/`，容器重启自动恢复登录免扫码；
  启动时扫描该目录逐个拉起实例（core 不在线也照常上线，状态回调失败不影响，首条消息会纠偏）。
- **一个微信账号全集群只允许一个实例在轮询**（SDK 硬约束）：绑定表 + wxbot 实例 Map 双重防重。

## 配置：零文件（同 executor 模式）

接线全靠根 compose 注入的环境变量，**不需要 wxbot/.env，也不需要 config.yml**：

| env | 来源 | 用途 |
| --- | --- | --- |
| `WXBOT_TOKEN` | 根 `.env`（`scripts/init.sh` 生成/复用） | 本服务 `/api/*` 鉴权白名单（自动并入）+ 回调 core `/wxhook/*` 的凭据，与 core 侧同一值双向互信 |
| `CORE_URL` | compose 静态注 `http://agent-core:8090` | 转发目标 |
| `WXBOT_LOG_LEVEL` | compose 静态注 `info` | 日志等级（debug 原样打印收信消息结构；none/off→silent） |
| `WXBOT_STRIP_MARKDOWN` | 根 `.env` 可选（默认空） | 出口 markdown 纯文化开关：空/0 = 原样透传（微信已支持渲染）；1 = 恢复 stripMarkdown 降级 |

端口、非文本消息占位文案等次要旋钮走 `src/server.js` 内置 DEFAULTS；日志等级由 env `WXBOT_LOG_LEVEL`
决定（compose 注入，同 executor 的 `EXECUTOR_LOG_LEVEL` 约定；`debug` 原样打印收信消息结构，
长文本截断、Buffer 只记大小，便于观察新消息类型字段）。
本服务**不挂不读 core 的 `config.yml`**（内含平台密钥/登录 secret，只给 core 进程）。

## 部署

```sh
./scripts/init.sh --env-only          # 生成/复用根 .env 的 WXBOT_TOKEN（幂等，不碰 config.yml）
docker compose up -d --build wxbot    # 首次构建镜像（npm 源可 --build-arg NPM_REGISTRY= 换）
docker compose up -d agent-core       # core 带 WXBOT_URL/WXBOT_TOKEN 重建（compose 检测到 env 变化自动 recreate）
```

之后绑定在 **agent-core 的 Web 设置页 → 账户 → 微信绑定** 完成：生成二维码 → 扫一扫 →
手机确认 → 上线；换微信号先解绑再重绑。core 侧关闭微信入口：根 `.env` 置 `WXBOT_URL=`
（设置页自动隐藏，服务零报错）。

## 接口（仅内网可达；除 /health 外需 Bearer WXBOT_TOKEN）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ok, instances:[{id,state}]}`，免鉴权 |
| GET | `/api/instances` | 实例列表（core 启动对账用） |
| POST | `/api/instances {id}` | 幂等确保实例存在（新建绑定/重启恢复） |
| POST | `/api/instances/:id/refresh` | 重发登录流程（二维码过期/失败后；保留凭证） |
| DELETE | `/api/instances/:id` | 销毁实例并删登录凭证（解绑） |
| GET | `/api/instances/:id/qr.svg` | 当前登录二维码（core 设置页代理渲染） |
| POST | `/api/deliver {id,to,text}` | 文本投递（core 已分段；markdown 默认透传，微信已支持渲染，`WXBOT_STRIP_MARKDOWN=1` 时出口纯文化） |
| POST | `/api/typing {id,to}` | 「正在输入」心跳（core 在工具调用/结果时触发，每绑定 2s 冷却；typing 自然过期无需 stopTyping） |
| POST | `/api/deliver_media {id,to,filename,b64}` | 附件投递（core 已把正文里的 /p/ 链接换成本地字节并做归属/大小校验；SDK 按扩展名自动路由 image/video/file 卡片） |

## 本地调试

```sh
set -a && . ./.env && set +a    # 仓库根的 .env（WXBOT_TOKEN）
npm --prefix wxbot/app install
WXBOT_TOKEN=$WXBOT_TOKEN CORE_URL=http://127.0.0.1:8090 \
  node wxbot/app/src/server.js
```

## 已知边界 / 后续扩展

- 语音消息已接入：iLink 服务端自动转写（`msg.text` 即识别文字），按普通文本转发进会话——
  语音说 `/new` 这类命令也能用；转写为空（环境噪音等）时回 `bot.empty_hint` 占位提示。
  原始 silk 音频不下载，无需本地 ASR。
- 出站文件/图片已实现「链接→卡片」：AI 在回复正文里给 mint 链接，core 自动换成微信文件卡片
  （链接文字保留兜底）；AI 侧约定见 core 注入的 channel_note。
- core 未配 `WXBOT_URL` 时微信功能整体静默关闭（设置页不出现入口，服务零报错）。
