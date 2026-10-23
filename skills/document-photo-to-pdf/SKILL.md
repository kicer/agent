---
name: document-photo-to-pdf
description: 把手机拍摄的纸质文档照片逐页裁剪、拉正、判定方向，合并为一个 PDF；可选发布可拖拽角点的审核页
input_schema:
  type: object
  properties:
    images:
      type: array
      items: {type: string}
      description: 图片路径，按合并顺序；新批次必填，传 batch_id 时可省略
    output:
      type: string
      description: 输出 PDF 路径，默认 文档照片_校正.pdf；batch_id 模式忽略此参数，沿用批次原输出
    paper:
      type: string
      description: a4/letter/16k/b5/数字宽高比/auto；默认 auto
    orientation:
      type: string
      enum: [auto, none, portrait, landscape]
      description: 方向策略；默认 auto（逐页按纸张宽高比判横竖）
    enhance:
      type: string
      enum: [original, normal, strong, bw]
      description: 调色档；默认 normal
    dpi:
      type: [string, integer]
      description: 清晰度；standard(150)/high(300) 或 72~600 的数字
    review:
      type: string
      enum: [off, always, auto]
      description: 审核页策略；off（默认）不发布，always 总是发布，auto 只在有页需要人看时发布
    batch_id:
      type: string
      description: 重生成用；从 data.db 读源图/输出/编辑，覆盖同名 PDF。忽略 images/output
    edits:
      type: [string, object]
      description: review/1 修改对象或 JSON 路径；batch_id 模式不传时读 doc_review_job.edits
    state:
      type: string
      description: 上一份 state.json 路径；可选，仅用于恢复自动角点/调试
---

# 文档照片转 PDF

手机拍的纸质材料 → 一个版正字清的 PDF。自动检测纸张四角、自动拉正，不读图、不传坐标。
需要人工确认时，可以发布一个可拖拽角点的审核页，改完点「生成 PDF」直接覆盖重出。

## 两种用法

### 全自动（默认）

```json
{"images": ["图1.jpg", "图2.jpg"], "output": "合同_校正.pdf"}
```

只出 PDF，不写 `.app/`、不碰 `data.db`。适合“直接出件、不用看”的场景。

### 半自动（审核页）

```json
{"images": ["图1.jpg", "图2.jpg"], "review": "always"}
```

在出 PDF 的同时：

1. 把源图缩略图发布到会话 `.app/doc-review/<batch_id>/`；
2. 把批次/页面/任务记录写进会话 `data.db` 的 `doc_review_*` 表；
3. 返回 `review.url`（站内路径 `/app/<task_id>/doc-review/?b=<batch_id>`）。

用户拖角点、旋转、删页、调页序、改四项参数后，点页面右下角「生成 PDF」：
页面把修改写进 `doc_review_job`，再调用通用执行接口
`POST /api/sessions/<task_id>/skills/document-photo-to-pdf/run`（只传 `batch_id`），
服务端按同一份 `run.py` 覆盖同名 PDF，页面自动刷新。**不需要复制 JSON，也不经过模型。**

`review=auto` 是两者之间的桥：只有存在 `needs_attention` 的页（检测不到角点、方向存疑、
覆盖率低等）才发布审核页；全部就绪时不发布。

## 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `images` | 新批次必填 | 图片路径，按传入顺序合并；相对路径按会话目录解析 |
| `output` | 否 | 默认 `文档照片_校正.pdf`；`batch_id` 模式沿用批次原输出并覆盖 |
| `paper` | 否 | 默认 `auto`：按同批中位比例统一版式，填满 A4 内容区；偏差超过 20% 的页保持原比例。整批都是 A4 时可传 `a4`；票据/异形纸保持 `auto` 或传数字比例（宽/高） |
| `orientation` | 否 | 默认 `auto`：**逐页**按本页纸张宽高比定横竖，不看批次多数票。`none` 保持每页原方向；`portrait`/`landscape` 强制整批对齐 |
| `enhance` | 否 | 调色档，默认 `normal`。`original` 原样不提亮；`strong` 加强；`bw` 黑白（保留灰阶，不二值化） |
| `dpi` | 否 | `standard`(150) / `high`(300) / 72~600 的数字，默认 150 |
| `review` | 否 | `off`（默认）/`always`/`auto`；传 `batch_id` 且不传 review 时按 `always` |
| `batch_id` | 否 | 重生成：读 `data.db` 里的源图、输出、编辑，覆盖同名 PDF；忽略 `images`/`output` |
| `edits` | 否 | `review/1` 对象或路径；`batch_id` 模式不传时读 `doc_review_job.edits` |
| `state` | 否 | 上一份 `state.json` 路径；可选，只用于恢复自动角点/调试 |

优先级：`edits.batch` > 显式参数 > 默认值。`edits` 里的角点会跳过检测，直接用给定坐标。

## 看返回值

stdout 是一个 JSON 对象，**先看 `ok`**：

- `ok:true`：`output.path` 是 PDF；`summary` 可直接转述；`warnings` 非空时要一起告诉用户。
- `ok:false`：不要重试，把 `error.message` 和 `error.hint` 转述给用户。

**单页拍得不好不再等于失败**：检测不到角点、角点校验不过的页会用“画面内缩 3%”的兜底框
照常出件，该页 `status` 为 `needs_corners`；原图打不开的页标记 `failed` 并跳过。只有一页都
出不了时才返回 `ok:false`。

成功示例（半自动）：

```json
{"ok":true,"summary":"3 页已生成；1 页需人工确认",
 "output":{"path":"/.../合同_校正.pdf","pages":3},
 "review":{"batch_id":"dr20261023-120000-a1b2","published":true,
           "url":"/app/task-20261023-001/doc-review/?b=dr20261023-120000-a1b2",
           "ready":2,"needs_attention":[{"index":2,"status":"needs_corners","reason":"detect_failed"}]},
 "warnings":[]}
```

- `review.published=false` 时没有 `url`，不要给用户审核入口。
- `review.url` 是站内路径：Web 里直接输出成 Markdown 链接即可；微信/外部端需要拼上站点
  地址才能打开。审核页是拖拽页面，建议让用户在浏览器里用。
- `review.ready` 是 `status=ready` 的页数；`needs_attention` 含 `review`、`needs_corners`、
  `needs_orientation`、`render_failed`、`failed`。

`warnings` 里常见的是：某页已旋转 90°、某页用兜底框出件、某页透视校正失败已重试、
纸面短边偏低。这些表示“已出件但需确认”，按原话转述，不要自己判断“应该没事”。
`checks.pages` 是逐页数值指标，用户追问时再展开，不必主动倒给用户。

## 审核页与数据

- 页面模板的单一事实源：`skills/document-photo-to-pdf/web/index.html`。
- 运行时副本：会话 `.app/doc-review/index.html`（每次发布覆盖；不含任何数据注入）。
- 缩略图：会话 `.app/doc-review/<batch_id>/p<idx>.jpg`（长边 1200，JPEG）。
- 运行记录：会话 `data.db` 的 `doc_review_batch` / `doc_review_page` / `doc_review_job`。
  页面通过通用 `/api/db/<task_id>/query` 读，技能自己写；core 不认识这些表。

页面点「生成 PDF」的流程：

1. 把当前修改写成 `doc_review_job.edits`（完整快照，状态 `queued`）；
2. 调 `POST /api/sessions/<task_id>/skills/document-photo-to-pdf/run`，args 只传 `{"batch_id":"..."}`；
3. 技能读 job → 应用 edits → 覆盖同名 PDF → 更新 batch/page/job；
4. 页面重新读 `data.db`，刷新摘要、状态和 PDF 链接。

`edits` 的结构（`review/1`）：

```json
{"schema":"review/1",
 "batch":{"paper":"a4","enhance":"normal","dpi":"standard","orientation":"auto"},
 "pages":[{"i":3,"c":[[0.03,0.05],[0.97,0.04],[0.96,0.95],[0.04,0.96]],"r":90}],
 "order":[1,2,3],"deleted":[]}
```

- `i` 永远是**原始 images 的 1-based 下标**，不随页序变化；
- `c` 是归一化 0~1，相对 exif_transpose 后的原图，顺序左上、右上、右下、左下；
- `r` 是该页的**最终顺时针旋转**（0/90/180/270），覆盖自动方向判断；不传则用自动结果；
- `pages` 只需要放与自动基线不同的页（人工角点/旋转）；未改的页由服务端重新检测/评级；
- `order` 是出件页序，`deleted` 是删除的页；缺省按 images 原序。

技能每次出件会在 PDF 同目录写 `<名字>.state.json`（schema `document-photo-to-pdf/2`）：
`batch` 是本次四项参数，`pages[]` 记 `auto_corners`（原图像素）、`corners_norm`、
`rotate`（自动基线）、`rotate_source`、`status`、`reason`。坐标一律归一化，换预览分辨率不会错位。

审核页发布的旧批次只保留最近 5 个；更早的缩略图目录会随下一次新批次自动清理。

## 内容安全

只做纯几何透视变换 + 全局等比提亮，不调用生成式模型，文字像素不会被重绘。

## 拍摄要求（失败时这样建议用户）

- 一次只拍一张纸，整张纸完整入画，四边各留 3%~5% 背景；
- 桌面与纸张反差明显，避开强阴影和反光；
- 同批材料尽量同方向拍摄；横竖混拍不会自动翻转，需要人确认方向。

## 边界

- 纸张出画面的部分无法还原；角点可以外扩到画面外。
- 只保证页面拉正，不保证文字朝上；自动方向只判 90°，180° 需要人在审核页旋转。
- 检测不到角点的页用“画面内缩 3%”的兜底框出件，标 `needs_corners`，需人补角才是准确裁切。
- 默认 `paper=auto` 会把同批页面统一到中位比例（偏差 20% 以内），因此各页尺寸与留白一致；
  偏差更大的页按原比例出件。要严格 A4 用 `paper=a4`。
- 票据等窄纸建议单独成批，避免与 A4 混批时留白显得很宽。
- 低分辨率照片会被放大到统一版式，不会因原图像素少而变小；清晰度仍受原图限制。
- 数字比例只改纸面比例，PDF 画布仍是 A4；换画布请用 a4/letter/16k/b5。
- 支持 jpg/png/webp/bmp/tif；HEIC 需要额外依赖，当前不支持。
- 低分辨率、边缘背景残留、内容贴边只在 `warnings`/`checks` 里给指标，不会自动修正。
- 深色纸、彩色纸、纸张与桌面颜色接近时，自动检测可能不稳，建议换对比明显的背景重拍。
- 单次建议不超过 20 页；页数更多或原图很大时可能触发技能 120s 超时，可分批处理或调高
  `skills.timeout_ms`。
- 一图只处理一张纸；同框多张纸只取最大的一张。
