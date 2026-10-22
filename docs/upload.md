# 文件上传（选择器 / 拖拽 / 粘贴）

前端上传只有一个落点：`app/server/public/js/files.js` 的 `uploadFilesNow(files)`。
文件选择器和拖拽 drop 都只负责凑出 `File[]`，之后的大图压缩询问、大文件确认、
自动建档、逐卡进度、上传与刷新文件面板全部共用同一条链路。

## 入口

| 入口 | 位置 | 说明 |
|---|---|---|
| 回形针按钮 / 面板上传图标 | `#file-input` 的 `change` | 选中后快照 `input.files` → `uploadFilesNow` |
| 拖拽文件到页面任意位置 | `window` 的 `drop` | 从 `dataTransfer` 同步取 `File[]` → `uploadFilesNow` |
| 粘贴超长文本 | `#msg-input` 的 `paste` | 包成 `File` 放进 `state.attachments`，发送时随消息上传 |

发布时 `send()` 会把已成功卡片的 `dataset.name` 拼成「用户上传了文件：…」告知行；
卡片名以服务端返回的 `uploaded[].filename` 为准（重名时后端会加 `-1`/`-2`）。

## 拖拽实现要点

- **监听在 `window` 上**，不是某个 dropZone。文件落到输入框、文件面板、抽屉上时，
  没有处理的 `drop` 会让浏览器导航去打开该文件，当前草稿和正在流式的回合都会丢。
- **只认带 `Files` 的拖拽**：拖动页面内选中的文字同样触发 `dragenter`，不判断会误弹遮罩。
- `dragover` 必须 `preventDefault()`，否则 `drop` 不触发；同时设 `dropEffect = 'copy'`。
- 遮罩 `#drop-overlay` 是 `pointer-events: none` 的固定层，不参与命中测试，drop 仍由 window 接管。
- `dragenter` / `dragleave` 在子元素间移动会成对冒泡到 window，用 150ms 兜底定时器收尾；
  `relatedTarget === null`（拖出窗口）直接收干净。
- **不支持拖入目录**：目录在 `dataTransfer.files` 里是 0 字节条目，直接传会落一个空文件。
  实现用 `webkitGetAsEntry().isDirectory` 识别并跳过，有文件时提示「暂不支持拖入文件夹，已忽略」。
- 触屏设备没有 drag 事件，遮罩只在真实拖拽时出现，不影响移动端布局。
- 并发批次（上一次还在传又拖入一批）共用一个总进度条：各批登记 `{loaded,total}`，
  绘制时求和，最后一批结束后才收起。

## 后端约束（前端已对齐）

- 单文件硬限 50MB（`routes/files.js` 的 `multer.limits.filesize`），超限在预处理阶段直接拒掉。
- 大于 `upload.confirm_size_mb`（默认 10MB）先二次确认；大图大于
  `upload.image_compress_threshold_kb`（默认 1536KB）走本地 canvas 压缩询问。
- 每个文件一个 XHR 请求，所以即时上传路径不会撞上 `upload.array('files', 10)` 的上限；
  发送时随消息上传的附件是「一个请求带多个文件」，`uploadFiles()` 会按 10 个一批切分。
- 落盘名经 `sanitizeName` 清洗，重名自动追加序号；前端把响应里的真实文件名回写到卡片，
  避免告知行指向同名的旧文件。

## 已知限制

- 一次拖入多张大图时，`prepareUploadFile` 会逐张弹压缩确认（串行，不做批量合并）。
- 拖拽期间会立刻 `ensureSession()` 建档（与回形针一致），即使用户随后放弃上传；
  全部文件被放弃时不会建档。

## 长文本粘贴转文件

在 `#msg-input` 上监听 `paste`（不挂 `document`，避免劫持搜索框等输入）：

- 剪贴板文本 trim 后超过 `upload.paste_to_file_threshold_chars`（默认 2000 字符，`0` 关闭）时
  `preventDefault()`，用 `new File([原始文本], 'pasted-text-<时间戳>.txt')` 构造附件。
  阈值判断用 trim 后的长度，写入必须用原始文本（保留首尾空白与行尾）。
- 附件进入 `state.attachments`，**不提前建档、不落盘**，chip 可随时撤掉；发送时才随消息上传。
- 剪贴板同时有文件时：文本超阈值则文本转 txt（保住内容），另外只补非图片文件；
  文本很短时保持默认粘贴，剪贴板里的截图/文件另行挂成附件；纯文件则拦掉文件名插入。
- 发送约束：`send()` 允许「只有附件」的消息，告知行合并已上传卡片与本条附件（用服务端返回的
  真实文件名）；纯附件发送时标题退回粘贴文本的前 24 字。
- 上传/发送失败时附件会被还原回 chip（`send()` 的失败分支），内容不丢。
