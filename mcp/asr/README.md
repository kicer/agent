# mcp/asr — 语音识别服务

一个容器，两个入口，共用同一套转写实现：

| 入口 | 谁在用 | 说明 |
|---|---|---|
| `POST /transcribe` | `agent-core` 的 `/api/asr/transcribe`（H5 输入框） | 普通 HTTP，音频二进制进、`{text}` 出。**不经过模型、不消耗 token、1~3s** |
| `POST /mcp` | 模型（MCP 工具 `transcribe_audio`） | 转写任务目录里已有的音频，参数是公网 URL（与 `video_task` 的 `image_url` 同构） |
| `GET /health` | compose healthcheck | `{ok, service}`（无状态服务，不反映上游配置） |

端口 `3000` **只在 `agent-mcp-net` 内网**，不映射宿主机——本服务自身没有鉴权，暴露即被白嫖。
对外唯一入口仍是 `agent-core`（`/api/asr` 走登录态鉴权）。

## 为什么不是「录音 → 上传附件 → 模型调工具」

那要额外一次完整模型往返（3~10s + token），识别结果落进聊天记录而不是输入框，用户还没法改错字。
输入法级别的功能必须绕开模型；`/mcp` 那个口只留给「转写一段已上传的录音」这种低频需求。

## 部署

```bash
# 1) 配上游：写进仓库根 config.yml 的 mcp_servers（与 image_task 同构），容器不存任何密钥
#    - name: asr
#      url: "http://mcp_asr:3000/mcp"
#      headers:
#        Authorization: Bearer <key>          # 免鉴权的自建服务可省
#        X-ASR-Base-Url: "https://<host>/v1"
#        X-ASR-Model: "whisper-1"
#      mode: skill
# 2) 起服务

docker compose up -d --build mcp_asr
docker compose restart agent-core      # core 要在启动时读到 config.yml 与 ASR_URL
curl -s http://127.0.0.1:8090/api/asr/status   # {"enabled":true,...}
```

`agent-core` 的环境变量 `ASR_URL`（compose 里固定为 `http://mcp_asr:3000`）是部署接线；
真正的开关是 config.yml 里那段 `asr`：置为 `mode: disable` 或删掉 = 不启用，`/api/asr/*` 回 503，
前端不显示麦克风按钮。

> 从旧版升级：以前上游 key 写在根 `.env` 的 `ASR_API_KEY`（并默认复用 `BIGMODEL_KEY`），
> 现在容器不再读它。把原来那三个值搬到 `config.yml` 的 `asr.headers` 即可，`.env` 里那行可以删掉；
> 不搬的话语音入口会自动关闭（`GET /api/asr/status` 会返回具体 `reason`）。

## 上游

任何 OpenAI 兼容的 `/audio/transcriptions` 都能用。**本服务不保存、也不预设任何平台**：
key / base_url / model 全部由调用方随每个请求用 header 带入（与 `image_task` 同构）。

| Header | 必填 | 说明 |
|---|---|---|
| `X-ASR-Base-Url` | 是 | 上游地址，如 `https://<host>/v1`（服务自己拼 `/audio/transcriptions`） |
| `X-ASR-Model` | 是 | 模型名，如 `glm-asr` / `whisper-1` |
| `Authorization` | 否 | `Bearer <key>`；写成裸 key 也会自动补 `Bearer `；免鉴权的自建服务可省 |

`agent-core` 从 `config.yml` 的 `mcp_servers[name=asr].headers` 取这三个头，两条入口（`/transcribe`
与 `/mcp`）共用同一处配置——所以换平台只改 YAML + 重启 core，不碰 `.env`、不重建镜像。
缺 `X-ASR-Base-Url` / `X-ASR-Model` 时回 503，并在错误文案里指出缺哪个。

常驻内存约 35~40MB，CPU 基本为 0。没有本地模型可选：2 vCPU / 2GB 的机器跑不动能用的
whisper（固定 30 秒窗口，`small` 单次要 15~30 秒），需要私有化就把这个容器放到另一台机器，
只改 core 的 `ASR_URL` 指向它。

## HTTP 接口

```bash
# 任意格式（webm / mp4 / mp3 / wav / ogg / aac / flac），服务端用 ffmpeg 归一化
curl -s -X POST http://mcp_asr:3000/transcribe \
  -H 'Content-Type: audio/webm' \
  -H 'X-ASR-Base-Url: https://<host>/v1' \
  -H 'X-ASR-Model: whisper-1' \
  -H 'Authorization: Bearer <key>' \
  --data-binary @voice.webm
# → {"text":"打开今天的日报","ms":842,"model":"whisper-1"}
```

- 上限 20MB；超过 `ASR_MAX_CHUNK_SEC`（默认 25s）的音频自动切片后逐段识别再拼接
  （多数云端 ASR 单次只吃 ~30s）。
- 同时最多 `ASR_MAX_CONCURRENT`（默认 2）个转写，超了回 429。

## MCP 工具

```yaml
# config.yml
mcp_servers:
  - name: asr
    url: "http://mcp_asr:3000/mcp"
    headers:                            # 上游参数随请求带入，同「上游」一节
      X-ASR-Base-Url: "https://<host>/v1"
      X-ASR-Model: "whisper-1"
      Authorization: Bearer <key>
    mode: skill        # 低频能力，别每轮都发 schema
```

`transcribe_audio({ url })`：本地文件先用内置工具 `mint_public_link` 换成公网短链，
再把链接传进来（和 `video_task` 要 `image_url` 是同一套路）。

## 环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `ASR_MAX_BYTES` | 20971520 | 单次上传上限 |
| `ASR_MAX_CHUNK_SEC` | `25` | 超长音频切片长度，`0` = 不切 |
| `ASR_MAX_CONCURRENT` | `2` | 并发转写数 |
| `ASR_LOG_LEVEL` | `info` | debug / info / warn / error / none |
| `FFMPEG_BIN` | `ffmpeg` | 归一化工具路径 |

上游参数（key / base_url / model）**不是环境变量**，见上面「上游」一节。

## 客户端怎么录音

浏览器侧只有 HTTPS 才允许开麦；**Android 套壳 App 用原生录音再把 base64 交给页面**，
http 页面也能用。桥的契约与 Kotlin 示例见 [docs/voice-input.md](../../docs/voice-input.md)。
