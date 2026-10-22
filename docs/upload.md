# 文件上传（选择器 / 拖拽）

前端上传只有一个落点：`app/server/public/js/files.js` 的 `uploadFilesNow(files)`。
文件选择器和拖拽 drop 都只负责凑出 `File[]`，之后的大图压缩询问、大文件确认、
自动建档、逐卡进度、上传与刷新文件面板全部共用同一条链路。

## 入口

| 入口 | 位置 | 说明 |
|---|---|---|
| 回形针按钮 / 面板上传图标 | `#file-input` 的 `change` | 选中后快照 `input.files` → `uploadFilesNow` |
| 拖拽文件到页面任意位置 | `window` 的 `drop` | 从 `dataTransfer` 同步取 `File[]` → `uploadFilesNow` |

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
- 每个文件一个 XHR 请求，所以 `upload.array('files', 10)` 的上限不构成瓶颈。
- 落盘名经 `sanitizeName` 清洗，重名自动追加序号；前端把响应里的真实文件名回写到卡片，
  避免告知行指向同名的旧文件。

## 已知限制

- 一次拖入多张大图时，`prepareUploadFile` 会逐张弹压缩确认（串行，不做批量合并）。
- 拖拽期间会立刻 `ensureSession()` 建档（与回形针一致），即使用户随后放弃上传；
  全部文件被放弃时不会建档。

## 未实现：长文本粘贴转文件

设计结论留档，便于后续接上同一条链路：

- 只监听 `#msg-input` 的 `paste`，不挂 `document`（避免劫持搜索框等输入）。
- 文本超过阈值（字符数，建议默认 2000）时 `preventDefault()`，用
  `new File([原始文本], 'pasted-text-<时间戳>.txt', { type: 'text/plain' })` 构造附件。
  阈值判断用 trim 后长度，写入必须用原始文本（保留首尾空白与行尾）。
- 剪贴板同时有文件与文本时，文本超阈值优先转 txt（保留内容），非图片文件一并上传；
  文本很短且仅有截图时，文本走默认粘贴、图片作为附件上传。
- 建议延迟到发送时上传（存进 `state.attachments`，不提前建会话），需要同步放宽
  `stream.js` 的 `send()`：允许只有附件时发送、告知行合并挂起附件、标题取原文前缀。
- 上传失败必须把原始文本回填输入框（追加而非覆盖）。
