---
name: image
description: AI 生成图片（CogView）。op=create 传 prompt 拿 task_id，再 op=get 取图片 URL
mcp_tool: image_task
---

## 功能

调用智谱 CogView 生成图片。异步任务语义：提交立即返回 `task_id`，生成在服务端后台进行。

## 参数

`args` 原样透传给底层服务：

- `op=create`：`prompt` 必填。描述越具体越好（主体、风格、构图、光线、画面里的文字要求）。
- `op=get`：`task_id` 必填，取回任务状态；`SUCCESS` 时返回图片 URL。

## 用法

1. 提交

   ```
   skill {"run":"image","args":{"op":"create","prompt":"一只橘猫趴在窗台上晒太阳，水彩风格"}}
   ```

   → 返回 `task_id` 与 `task_status: PROCESSING`

2. 查询

   ```
   skill {"run":"image","args":{"op":"get","task_id":"<上一步返回的 id>"}}
   ```

   → `SUCCESS` 时返回 `Image N: <url>`

## 注意

- 生成通常 10~60 秒。看到 `PROCESSING` 就过几秒再查，不要连续轮询。
- 结果只有 URL，不落盘。要在会话里使用图片，用 `terminal` 下载：
  `curl -fsSL -o out.png "<url>"`，之后 `read_file` 可以直接看图。
- 要让外部服务取这张图，先下载成本地文件，再用 `mint_public_link` 签发链接。
- 模型名与出图参数由服务端配置决定，调用时不需要也不该传。
