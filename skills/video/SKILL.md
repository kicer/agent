---
name: video
description: AI 生成视频（CogVideo）。op=create 给 prompt（可加 image_url）拿 task_id，op=get 取视频 URL
mcp_tool: video_task
---

## 功能

文生视频 / 图生视频。异步任务语义：提交立即返回 `task_id`，生成在服务端进行，本技能不内部轮询。

## 参数

`args` 原样透传给底层服务：

- `op=create`：`prompt` 与 `image_url` **至少给一个**。
  - 文生视频：只给 `prompt`（≤512 字符）。
  - 图生视频：再给 `image_url`——必须是公网可访问的 png / jpeg / jpg、≤5MB。本地图片先用
    `mint_public_link` 签发临时 URL，**不要**自己拼内网地址。
  - `with_audio`：可选，是否生成 AI 音频，默认 `false`。
- `op=get`：`task_id` 必填；`SUCCESS` 时返回 Video URL（有封面时一并返回）。

## 用法

1. 提交

   ```
   skill {"run":"video","args":{"op":"create","prompt":"镜头缓慢推进，海浪拍打礁石","with_audio":true}}
   ```

   → 返回 `task_id`

2. 查询

   ```
   skill {"run":"video","args":{"op":"get","task_id":"<上一步返回的 id>"}}
   ```

   → `SUCCESS` 时返回 `Video URL: <url>`

## 注意

- 生成通常 1~5 分钟。`PROCESSING` 时不要高频轮询：可以先把其它事做完，再回来查。
- 结果只有 URL，不落盘；需要本地文件时用 `terminal` 的 `curl -fsSL -o out.mp4 "<url>"`。
- 图生视频的参考图必须公网可达：本地文件先 `mint_public_link`，再把它返回的地址填进 `image_url`。
- 模型名、分辨率、帧率、水印等由服务端配置决定，调用时不需要传。
