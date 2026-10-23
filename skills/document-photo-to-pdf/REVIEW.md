# 审核页内部协议（维护者文档）

> 本文件刻意不在 SKILL.md 里引用，避免模型顺着指针来读；只有维护者需要看。

`SKILL.md` 是给 AI 的调用契约；本文件记录审核页/重生成/数据表的实现细节。**AI 日常调用
不需要读这里**，`skill get` 也只返回 SKILL.md。

## 文件与目录

```
skills/document-photo-to-pdf/
  SKILL.md                 ← AI 契约（只有 images/output）
  REVIEW.md                ← 本文件
  run.py                   ← 入口
  doc_deskew/              ← 检测/几何/出页/检验
    review_store.py        ← data.db 的 doc_review_* 表
    review_page.py         ← 模板副本 + 缩略图发布
  web/index.html           ← 审核页模板的单一事实源

tasks/<session-id>/
  .app/doc-review/
    index.html             ← 每次发布覆盖的模板副本（不含数据注入）
    <batch_id>/p1.jpg ...  ← 本批缩略图（长边 1200，JPEG）
  data.db                  ← doc_review_batch / doc_review_page / doc_review_job
  <output>.pdf
  <output>.state.json      ← state v2，供恢复自动/调试
```

core 只托管会话 `.app/`，不托管 skill 目录，所以模板必须复制一份到会话；源仍只有
`web/index.html` 一份，副本不是第二份源码。

## 对 AI 隐藏的参数

`run.py` 仍接受以下参数，但不出现在 SKILL.md / input_schema 里；审核页和 apply 接口使用：

| 参数 | 用途 |
|---|---|
| `paper` | a4/letter/16k/b5/数字比例/auto |
| `orientation` | auto/none/portrait/landscape |
| `enhance` | original/normal/strong/bw |
| `dpi` | standard/high/72~600 |
| `review` | `always`（默认）/`auto`（仅有 needs 时发布）/`off`（自动化用） |
| `batch_id` | 重生成：从 data.db 读源图/输出/编辑，覆盖同名 PDF |
| `edits` | `review/1` 对象或 JSON 路径；优先级高于显式参数 |
| `state` | 上一份 state.json；仅用于恢复自动/调试 |

优先级：`edits.batch` > 显式参数 > 默认值。

## data.db 表

所有表以 `doc_review_` 前缀，避免和用户业务表混淆。技能自己 `CREATE TABLE IF NOT EXISTS`；
`busy_timeout=5000`，WAL 由 core 建库时设置，技能侧 best-effort。

### doc_review_batch

```sql
id TEXT PRIMARY KEY,        -- drYYYYMMDD-HHMMSS-xxxx，不含点/斜杠
output TEXT,                -- 相对会话目录的 PDF 路径
paper TEXT, enhance TEXT, dpi TEXT, orientation TEXT,
status TEXT,                -- running/ready/review/error
summary TEXT, warnings TEXT,-- warnings 是 JSON 数组
schema_version INTEGER,
created_at TEXT, updated_at TEXT
```

### doc_review_page

```sql
batch_id TEXT, idx INTEGER, -- idx 永远是原始 images 的 1-based 下标
source TEXT,                -- 相对会话目录的原图路径
source_w INTEGER, source_h INTEGER,
w INTEGER, h INTEGER,       -- 缩略图尺寸（页面画布用）
auto_corners TEXT,          -- 原图像素，自动基线
auto_corners_norm TEXT,     -- 归一化，页面“恢复自动”用
corners TEXT,               -- 归一化，当前角点（未旋转）
auto_rotate INTEGER,        -- 自动方向基线（0/90）
rotate INTEGER,             -- 当前应用旋转（用户覆盖后是绝对值）
deleted INTEGER, sort INTEGER,
status TEXT, reason TEXT, thumb TEXT, error TEXT,
PRIMARY KEY(batch_id, idx)
```

### doc_review_job

```sql
batch_id TEXT PRIMARY KEY,
edits TEXT,                 -- review/1 完整快照
status TEXT,                -- queued/running/done/error
message TEXT,
requested_at TEXT, started_at TEXT, finished_at TEXT
```

## 审核页如何工作

1. 页面从 `/app/<task_id>/doc-review/` 加载；无 `?b=` 时查 `doc_review_batch` 最新一行。
2. 通过 `POST /api/db/<task_id>/query` 读 `doc_review_batch` / `doc_review_page`。
3. 用户拖角/旋转/删页/排序/改四项参数，只改浏览器内状态并写 localStorage 草稿。
4. 点「重新生成 PDF」：
   - `INSERT ... ON CONFLICT` 写 `doc_review_job`（`status=queued`，`edits` 是完整快照）；
   - 调通用执行接口
     `POST /api/sessions/<task_id>/skills/document-photo-to-pdf/run`，body `{args:{batch_id}}`；
   - 技能读 job → 应用 edits → 覆盖同名 PDF → 更新 batch/page/job；
   - 页面重新读 data.db，刷新警告、状态、PDF 链接。
5. 全程不经过模型，也不需要用户复制 JSON。

通用接口实现在 `app/server/routes/skill-run.js`：core 只做会话/并发/错误映射，执行仍走
`tools/skills.runSkill`，不感知技能名或参数语义。

## 页面交互约定

- 顶部标题条（白底，参考 H5 全屏预览）：左侧 PDF 名，右侧下载 PDF，最右 X 返回会话。
- 重新生成 PDF 不在顶栏：放在照片区底部（stage 与预览各一个，按当前视图显示；桌面只用
  stage），仅在存在未保存修改时出现。
- 底部只保留翻页和当前页名，不再放操作按钮。
- 页码不占顶栏：`1/n` 浮在图片右上角（裁切区、预览区各一个，按当前视图显示）；
  左上角常驻当前模式标签（裁切区「手动定位」、预览区「校正预览」）。
  移动端一次只显示一个面板，看到哪个标签就是当前模式；视图按钮固定叫「切换」。
  移动端顶栏按钮带文字而非只靠图标：视图按钮写“点下去会去哪”（当前在预览→手动定位，
  在当前裁切→校正预览），另三个是旋转 / 重置 / 设置。
- 裁切区/预览区支持左右滑动翻页：左滑下一页、右滑上一页；仅触摸/笔生效，拖角优先，
  按钮点击不触发。
- 是否 dirty 用 `collect()` 与加载时的基线 `S.savedEdits` 比较；拖角、旋转、删页/排序、
  改四项参数都会触发。
- 重新生成成功后重读 DB、清本地草稿、把新状态设为基线，按钮自动消失；失败则保留以便重试。
- X 返回 `/?s=<task_id>`；独立页面里也适用。
- 手机默认进校正预览，点左上角切到裁切。

## edits / 旋转语义

```json
{"schema":"review/1",
 "batch":{"paper":"a4","enhance":"normal","dpi":"standard","orientation":"auto"},
 "pages":[{"i":3,"c":[[0.03,0.05],[0.97,0.04],[0.96,0.95],[0.04,0.96]],"r":90}],
 "order":[1,2,3],"deleted":[]}
```

- `i` 是原始 images 下标，不随页序变化。
- `c` 是 exif_transpose 后原图的归一化坐标，顺序左上/右上/右下/左下。
- `r` 是该页最终顺时针旋转（0/90/180/270），覆盖自动方向；页面总会为“人工页”带上
  `r`（包括 0），服务端用 `user_r is not None` 判断是否覆盖。
- `pages` 只放与自动基线不同的页；未改的页由服务端重新检测/评级，避免把 fallback 页
  误升成 ready。
- `order` 缺省按 images 原序；`deleted` 的页不进出件。
- 人工旋转 90/270 时，`orientation=auto` 下该页画布按旋转后的有效方向走，避免把横向内容
  压进竖向画布；`portrait`/`landscape` 强制方向时仍按强制值。

## state v2

每次成功出件写 `<output>.state.json`：

```json
{"schema":"document-photo-to-pdf/2",
 "batch":{"doc_type":null,"paper":"auto","enhance":"normal","dpi":150,"orientation":"auto"},
 "pages":[{"index":1,"source":"p1.jpg","source_size":[1400,1700],
           "auto_corners":[[...]],"corners_norm":[[...]],
           "rotate":0,"rotate_source":"auto","status":"ready","reason":null}]}
```

`rotate` 是自动基线（不是用户覆盖值）；用户覆盖值在 data.db 的 `rotate` 列。state 只用于
恢复自动/调试，审核页不读它。

## 状态与失败

- `ready`：可直接用。
- `review`：建议看一眼（掩膜回退、覆盖率低、纸型存疑）。
- `needs_corners`：检测为空或校验不过，已用“画面内缩 3%”兜底框出件，需人工补角。
- `needs_orientation`：接近正方形，横竖判不出来，需人在页面旋转。
- `render_failed` / `failed`：出页失败/原图打不开；后者会被跳过。
- `deleted`：用户删除，不进出件。

单页检测/校验失败不再让整批失败；只有一页都出不了才 `ok:false`。检测到的无效四边形会
退回兜底框，并把 `auto_corners` 一起换成兜底框，避免“恢复自动”把无效角点拖回来。

## 清理

审核页发布只保留最近 5 个批次的缩略图目录；新批次完成后删除更早的目录和 DB 记录。
`batch_id` 重生成（apply）不会触发清理，避免把正在编辑的旧批次裁掉。
