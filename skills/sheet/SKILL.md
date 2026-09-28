---
name: sheet
description: 表格文件（xls/xlsx/csv/ods）的读取与安全修改。inspect 看结构/公式/表头定位；apply 按「列名+值」或 cells 地址最小改动，自带 old 校验、全簿逐格自检、公式引用调整与自动重算。不用于新建工作簿、图表生成。
required: true
---

# sheet

## 调用形式（重要）

本技能通过 `skill` 工具执行，完整调用是：

```json
{"op": "run", "name": "sheet", "input_args": {"action": "inspect", "file": "预算表.xlsx"}}
```

外层 `op`（固定为 run）属于 skill 工具；**下文所有 JSON 示例都是 `input_args` 的内容**，其动作键是 `action`，不要与外层 `op` 混淆。

## 何时使用

- 修改表格文件中的单元格值或公式
- 插入、删除行或列
- 按内容定位目标行/列

支持格式：`.xls`、`.xlsx`、`.csv`、`.ods`。

不适用：新建工作簿、生成图表、执行宏。

## 工作流程

1. `action=inspect` 查看表结构与公式（注意采用返回里的 `suggested_header_row`；若 `multi_level_header` 非 null，列名模式不可用，直接走 `cells` 地址模式）
2. 按需求选择 `action=apply` / `insert_rows` / `delete_rows` / `insert_cols` / `delete_cols`

## inspect

读取表结构、单元格值、公式。

```json
{"action": "inspect", "file": "预算表.xlsx"}
```

参数：
- `file`（必填）：相对任务目录的路径
- `sheet`（可选）：只查指定 sheet
- `limit`（可选）：每个 sheet 预览行数，默认 50
- `header_row`（可选）：表头行号，默认 1

返回示例：

```json
{
  "ok": true,
  "sheets": [
    {
      "name": "明细",
      "rows": 10,
      "cols": 7,
      "header_row": 1,
      "suggested_header_row": 1,
      "multi_level_header": null,
      "headers": ["序号", "项目", "单位", "数量", "单价", "金额", "备注"],
      "preview": [
        [1, "管道", "米", 100, 18, {"formula": "=D3*E3"}, ""],
        [2, "顶管", "米", 50, 157, {"formula": "=D4*E4"}, ""]
      ],
      "formulas": [
        {"cell": "F3", "formula": "=D3*E3"},
        {"cell": "F4", "formula": "=D4*E4"}
      ],
      "truncated": false
    }
  ]
}
```

要点：
- `headers` 是表头行；合并单元格只有首个有值，其余为 `null`
- `suggested_header_row` 是自动检测的表头行（中文表格常见「第 1 行合并标题 + 第 2 行真表头」）；与你的 `header_row` 不一致时直接采用它继续后续调用，不用自己推断
- `multi_level_header` 非 null（如 `{"group_row": 2, "column_row": 3}`）= 多级表头（分组行 + 重复子列名行）：列名定位必死，改用 `cells` 地址模式，别反复换 `header_row` 重试
- 公式以 `{"formula": "=..."}` 表示
- `preview` 可能被 `limit` 截断；`formulas` 最多列 500 条（超出时 `formulas_truncated: true`）
- `merged` 是合并区域列表（如 `["A1:G1"]`）
- `truncated` 为 `true` 时预览被截断，改动仍可命中整张表

## apply（改值/改公式）

```json
{
  "action": "apply",
  "file": "预算表.xlsx",
  "changes": [
    {
      "sheet": "明细",
      "match": {"项目": "顶管"},
      "set": {"单价": {"old": 157, "new": 180}}
    }
  ]
}
```

参数：
- `file`（必填）
- `changes`（必填）：改动清单；每项可用 `match+set`（列名定位）或 `cells`（地址定位），二选一
- `header_row`（可选，默认 1）；各 change 可单独带 `header_row` 字段覆盖（多 sheet 表头位置不同时用）
- `output`（可选）：输出文件名（放原文件同目录；平台预处理成会话目录下的绝对路径也接受），默认原文件名加「（已改）」

### cells 地址定位（多级表头 / 分组汇总表的正经出口）

```json
{
  "action": "apply",
  "file": "预算表.xlsx",
  "changes": [
    {"sheet": "总表", "cells": {
      "D4": {"old": 157, "new": 190},
      "H4": {"new": "=D4*0.9"}
    }}
  ]
}
```

- 地址从 inspect 的 `preview`（含列坐标提示）/`formulas` 里数出来；允许可选 `$`（`$D$4` 同 `D4`）
- 每个地址的 `old` 同样可选（省略 = 空格断言），与 `set` 语义一致
- old 校验、合并区防护、全簿逐格自检、LO 重算与列名模式**完全同源**，不是降级通道

### 定位

`match` 用列名 + 值定位目标行，可多列组合：

```json
{"match": {"项目": "顶管", "单位": "米"}}
```

`set` 指定要改的列和新旧值：

```json
{"set": {"单价": {"old": 157, "new": 180}}}
```

`old` 可省：**省略 = 断言目标格当前为空再写入**（填空/补列/补公式场景）；改已有值必须给 `old`，不一致则整体报错、不做任何改动。

### 改公式

`new` 以 `=` 开头即为公式；`old` 用字符串精确匹配：

```json
{"set": {"金额": {"old": "=D3*E3", "new": "=D3*E3*1.1"}}}
```

### 一次改多处

`changes` 可包含多项，跨 sheet 也可以。

## insert_rows / delete_rows

**insert_rows**：

```json
{
  "action": "insert_rows",
  "file": "预算表.xlsx",
  "sheet": "明细",
  "after_match": {"项目": "顶管"},
  "count": 1,
  "fill": {"序号": 3, "项目": "新增项", "单位": "米", "数量": 20, "单价": 100, "金额": "=D4*E4"}
}
```

- `after_match`：在此行之后插入（用列名 + 值定位）
- `count`：插入行数，默认 1
- `fill`：可选，为新行填充值（公式按新行实际行号自己写好）；以 `=` 开头视为公式

**delete_rows**：

```json
{
  "action": "delete_rows",
  "file": "预算表.xlsx",
  "sheet": "明细",
  "match": {"项目": "顶管"},
  "count": 1
}
```

- `match`：要删除的行
- `count`：删除行数，默认 1

行插入/删除会**自动调整公式引用**（含其他工作表中引用本表的跨表公式，同 Excel）；合并单元格同步移动，区域内插行会自动扩大区域。

## insert_cols / delete_cols

**insert_cols**：

```json
{
  "action": "insert_cols",
  "file": "预算表.xlsx",
  "sheet": "明细",
  "after": "单价",
  "count": 1,
  "fill_header": "折扣"
}
```

- `after`：在此列之后插入（用列名定位）
- `fill_header`：可选，新列的表头

**delete_cols**：

```json
{
  "action": "delete_cols",
  "file": "预算表.xlsx",
  "sheet": "明细",
  "col": "备注",
  "count": 1
}
```

列插入/删除同样会**自动调整公式引用**。

## 硬约束

- 只改清单里指定的位置
- 改动前校验 `old`（set）或 `match` 唯一性
- 改动后自检：目标改动生效、其他内容未变（含公式原文）、文件可打开
- 任一项失败 → 产物自动删除、不交付
- 遇不支持的引用形态（数组公式、外部簿引用、结构化引用）直接报错，绝不半改交付
- 超出能力的表（多级表头等）用 `cells` 地址模式处理；**禁止绕开本技能用 terminal/脚本手改交付物**——手改没有 old 校验、逐格自检、跨表引用检查与重算门禁，错了没人兜底

## 边界

- 公式调整范围：目标表内引用、他表→目标表的跨表引用都会改；目标表→他表的引用不动（同 Excel）。
  被删区域端点的区间按 Excel 语义收缩；命名范围（Tax2023 之类）不改写，引用它们的结果可能错位，需人工核对。
- 删除跨越合并区域边界的行/列会被拒绝（行为无法推断），改为整块删或先拆合并。
- 产物交付前已自动重算：LibreOffice 对 xlsx/xls/ods 求值并把结果写入公式缓存，可直接进预览/转 PDF/脚本读取；
  重算失败时自动回退交付「未重算版」并在结果 `recalc` 字段标注 `failed:...`（未重算版仍带「打开时全量重算」标记，
  Excel/WPS 打开结果一样正确）；结果里看到 recalc=failed 时简短告知用户一句即可，不要重试。
- CSV 单元格一律按文本保留（「007」「1.10」不会变成 7/1.1）；数字与数字文本在定位比较时互认。
- 多级表头（分组行 + 重复子列名，如「新建顶管｜数量·单价」）：`match/set` 列名定位不支持（子列名不唯一，任何 `header_row` 都无解）；`inspect` 会标 `multi_level_header`，请用 `cells` 地址模式 + 从 preview 确认坐标。更深层级（≥3 行表头）同样走 `cells`。

## 常见错误

1. **match 不唯一**：多行满足条件，补充更多列条件
2. **old 不匹配**：定位错了或数据已变，重新 inspect
3. **表头不在第 1 行（标题行+表头行结构极常见）**：看 inspect 的 `suggested_header_row`；apply/insert/delete 若把标题行误当表头，报错信息里会直接给出建议行号，按其重试即可
4. **列名不存在**：报错会列出可用列名
5. **sheet 不存在**：报错会列出可用 sheet 名
6. **写入合并区域非锚点格**：报错提示改用区域左上角锚点
7. **报「不支持数组公式/外部簿引用」**：该表需人工处理，不要反复重试
8. **报「重复列名 / 检测到多级表头」**：换 `header_row` 重试没有用（子列名天然不唯一），改用 `cells` 地址模式；也不要因此绕开技能去手改文件
