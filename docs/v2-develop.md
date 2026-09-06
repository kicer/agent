## 1. 页面定位

- `v2.html` 是并行于 `index.html` 的另一套 H5 界面，主打**移动端单聊 + 历史抽屉**，不沿用 index 的底部多 Tab 结构。
- 直接访问 `/v2.html`；无入口链接（浏览器手动打开或自己加）。
- index.html 仍是功能最全的 1.x 界面（tasks.js 多 Tab / 工具卡片 / makrdown / 图片压缩 / 文件面板），v2 迭代时可随时回看参考实现。

## 2. 涉及文件

| 文件 | 说明 |
|---|---|
| `app/server/public/v2.html` | 页面结构 + 全部前端逻辑（内联 `<script>`，无构建步骤） |
| `app/server/public/css/v2.css` | v2 全部样式（已从 html 内联 `<style>` 抽出） |

- 后端只用了**既有 /api 接口**，上一轮未新增/改动任何后端代码。
- 样式与 `index.html` 体系（`css/style.css`）完全隔离，互不干扰。

## 3. 已接通的真实业务流

全部走 `v2.html` 内联脚本，核心请求函数为自带 `req()`（401 自动跳 `/login`）：

| 用户动作 | 实现方式 |
|---|---|
| 首页欢迎态 | 仅「文秘助理 / 识图专家」两个模式胶囊，纯前端状态 |
| 首条消息 | `ensureSession()` → 无会话时先 `POST /api/sessions {title:'', model_id:''}`，再发消息；创建后进入 chat 视图 |
| 发送文本+附件 | `send()` → `POST /:id/messages {content, attachments:[{name,size}]}` |
| 附件上传 | 选文件只进本地 `state.attachments`；发送时才 `POST /:id/files`（multipart，字段名 `files`），拿回文件名后再随消息体发 attachments |
| 历史列表（抽屉） | 打开抽屉 / 发送后 / done 后调 `loadSessionList()`：搜索词为空时并行拉 `status=active&limit=100` 与 `status=done&limit=50&with_total=1` 合并；搜索走 `?q=` |
| 打开历史会话 | `openSession()` → `GET /api/sessions/:id` 渲染全部消息 → `connectStream()` |
| 实时回复 | EventSource `GET /:id/stream`：`status` / `assistant_delta` / `assistant_message` / `tool_call` / `tool_result` / `done` |
| 复制 AI 文本 | 历史 AI 消息右下角按钮，内容以 `data-b64` 存放（防引号破坏属性） |
| 删除会话 | 消息操作栏垃圾桶 → `window.confirm` → `DELETE /:id?delete_dir=true`（连同任务目录文件，不可恢复） |
| 会话标题 | 后端会在首条用户消息时自动截取前 24 字；本地 header 同步乐观赋值 |

### 消息展示约定

- 用户消息：右侧浅灰气泡。附件由服务端拼成前缀 `【系统通知】用户上传了文件：xx（大小 N）…`，前端 `parseUploadNotice()` 拆出 📎 行后展示正文。
- AI 消息：左侧大段白底文本，无 markdown，`white-space: pre-wrap`。
- 工具调用：仅显示一行 `🔧 工具名`（有 tool_call 事件 / 历史 assistant 的 tool_calls 字段时）。历史中的 `role: tool` 消息不展示（看不到工具输出与图片）。
- 「思考中」打字占位：每次发送后出现，首个 SSE 事件到达时消失。

## 4. 明确纯前端、无后端支撑的能力（现状即如此）

这些概念在 mock 原型里能“表演”，接真实后端后**后端没有对应字段/参数**，目前只影响外观或文案：

1. **文秘助理 / 识图专家 模式**：后端无 `mode` 字段，也暂无「模式 → 模型」映射约定。现仅影响欢迎页 hint 与聊天 header 的模式文案。
2. **深度思考开关**：后端请求无 `reasoning`/`deep_think` 参数。开关纯本地视觉状态。
3. **思考过程折叠块（已思考 N 秒/思考步骤）**：后端不输出 reasoning 内容，此能力已随 mock 一起删除。
4. **按条删除消息**：后端只有会话级删除/清空，无消息级删除接口，故删除按钮 = 删除整个会话。

若让 1/2/4 真正生效，属于**后端新增能力或接口扩展**的范畴，需先定接口再实现（例如 `POST /:id/messages` 增加 `mode/deep_think` 参数；或前端把「识图专家」映射到某个带 vision 的 `model_id` 走现有 `POST /api/sessions` 建会话）。

## 5. 后端已有、v2 尚未接入 UI 的接口（下次可做清单）

| 接口 | 建议接入点 |
|---|---|
| `PATCH /api/sessions/:id {title}` | 会话重命名（header 标题点击 / 抽屉长按） |
| `POST /:id/stop`、`/release`、`/bind {model_id}` | 对话中终止 / 保持态断开 / 换模型，需先有会话状态与模型池 UI |
| `DELETE /:id/messages` | 一键清空会话（保留文件） |
| `GET /:id/files/download-token?path=` | 附件/文件下载（配合文件面板） |
| `GET /api/models` | 当前空闲/占用模型池，供新建会话选模型、模式映射 |
| `GET /api/system/status` | 版本信息、上传压缩配置 `upload`（参考 `tasks.js` 的大图压缩逻辑） |

## 6. 已知行为瑕疵 / 简化点（建议优先修）

1. **流式回复完成后没有操作行**：`assistant_message` 收尾时只留文本，不追加「时间 + 复制/删除」；而历史重开（`aiMsgHtml`）有。同一消息两种状态下观感不一致。
2. **排队场景无提示**：`send()` 无条件挂思考占位。若 `POST /messages` 返回 `delivered:'queued'`（在排队等模型），应像 index 那样提示「排队中/暂存」，避免用户以为卡死。SSE `status` 事件带 `queue_pos` 可展示第几位。
3. **抽屉列表无分页**：只拉 active 100 + done 50，会话多时看不到更早归档；搜索无 loading/竞态处理。
4. **无 markdown 渲染**：AI 回复为纯文本。index 用 marked CDN，若 v2 要渲染代码块/列表需引入同一方案。
5. **移动端大图上传无压缩**：index `tasks.js` 有 `maybeCompressImage` + `/api/system/status` 的 upload 配置，v2 直传原图，流量大且可能超服务端 50MB 限制。
6. **看不到工具输出与文件**：工具只显示一行名字；不做结果展开/图片查看下载。
7. **会话删除不可选「保留文件」**：v2 固定传 `delete_dir=true`；index 有二次弹窗让用户选是否连目录一起删。

## 7. 修改 v2 时的注意点

- 页面**自包含**：不加载 `core.js / tasks.js / marked`，全部工具函数（`$`/`esc`/`req`/`toast`/`copyText`/`fmtTime`）在页面内定义。若今后要共享代码先考虑重名冲突。
- 全局状态集中在 `state`（`view/mode/deepThink/sessionId/sessionTitle/status/sessions/attachments/es/streamText/streamEl/toolLines/typingEl/streaming`），别再散落游离变量。
- 切换会话/新建/删除前务必 `closeStream()` + `removeTyping()` + 重置流式相关字段，防旧会话 SSE 污染新会话。
- 消息内容一律 `esc()` 后再进模板；复制按钮用 base64 传内容。
- `v2.html` 顶部大注释维护着「接口参考/未接入清单」，改动的接口状态要同步更新那里。
- 页面入口 `/v2.html` 无防盗链，直接可访问，注意它同样受全局登录中间件保护。
