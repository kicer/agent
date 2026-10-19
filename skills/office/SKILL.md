---
name: office
description: Office 文档(docx/xlsx/pptx)创建、精确编辑、结构检视与聊天实时预览
---

## 功能

Word / Excel / PPT(.docx/.xlsx/.pptx)的创建、读取、精确修改与结构检视。文档直接读写当前任务目录的文件，无需任何同步动作。

## 调用方式

所有操作通过 terminal 工具执行同一个入口脚本（cwd 已是任务目录，直接用相对文件名）：

```
office <command> [args...]
```

先用 `office help` 看命令清单，用 `office help <主题>`（如 `office help docx paragraph`）查具体元素的属性 schema——参数与属性以 help 为准，不要凭记忆猜。

常用动线：

- `office create <file>` 新建文档（成功后聊天流出现预览卡片，用户点击即可实时预览）
- `office open <file>` 打开已有文档（同样出预览卡片）
- `office set / get / query <file> ...` 按 schema 精确改动与读取；每次改动自动落盘
- `office view <file> outline|stats|issues|text` 结构/语义自检（交付前建议跑一遍 issues）
- `office save / close <file>` 收尾（改动已自动落盘，save 只是显式冲刷）
- `office get-pos <file>` 回读用户在预览里选中的内容（返回 JSON，path 里的 @id 可稳定用于后续 set/get 定位）

## 预览协作

create/open 成功后无需拼链接、无需等待：聊天流自动出可点击的预览卡片，用户点开即是该文档的实时预览（预览页上的选区、标注类交互之后都能被 get-pos 读到）。用户反馈"看第几段/选中了哪里"时，用 get-pos 读回再针对性改。

## 注意

- 文档就在任务目录里：文件面板、预览、下载指向同一份文件；不要用 curl 或中转链搬运待编辑的文档。
- `view` 的渲染族（html/screenshot/pdf 等）本环境不可用；要 PDF 用 x2pdf 技能。
- 命令报"文件不存在"时先确认文件是否已在任务目录（`ls`），不要猜路径。
