---
name: sheet-edit
description: 结构化修改表格文件。内容定位（列名 + 值），最小改动。支持改值、改公式、插入/删除行列，公式引用自动调整。
---

# sheet-edit

## 何时使用

- 修改表格文件中的单元格值或公式
- 插入、删除行或列
- 按内容定位目标行/列

支持格式：`.xls`、`.xlsx`、`.csv`、`.ods`。

不适用：新建工作簿、生成图表、执行宏。

## 工作流程

1. `op=inspect` 查看表结构与公式
2. 按需求选择 `op=apply` / `op=insert_rows` / `op=delete_rows` / `op=insert_cols` / `op=delete_cols`

## inspect

读取表结构、单元格值、公式。

```json
{"op": "inspect", "file": "预算表.xlsx"}
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
- 公式以 `{"formula": "=..."}` 表示
- `preview` 可能被 `limit` 截断；`formulas` 最多列 500 条（超出时 `formulas_truncated: true`）
- `merged` 是合并区域列表（如 `["A1:G1"]`）
- `truncated` 为 `true` 时预览被截断，改动仍可命中整张表

## apply（改值/改公式）

```json
{
  "op": "apply",
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
- `changes`（必填）：改动清单
- `header_row`（可选，默认 1）
- `output`（可选）：输出文件名（只能是文件名，不能含路径），默认原文件名加「（已改）」

### 定位

`match` 用列名 + 值定位目标行，可多列组合：

```json
{"match": {"项目": "顶管", "单位": "米"}}
```

`set` 指定要改的列和新旧值：

```json
{"set": {"单价": {"old": 157, "new": 180}}}
```

`old` 必须与实际值一致，否则整体报错，不做任何改动。

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
  "op": "insert_rows",
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
  "op": "delete_rows",
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
  "op": "insert_cols",
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
  "op": "delete_cols",
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

## 边界

- 公式调整范围：目标表内引用、他表→目标表的跨表引用都会改；目标表→他表的引用不动（同 Excel）。
  被删区域端点的区间按 Excel 语义收缩；命名范围（Tax2023 之类）不改写，引用它们的结果可能错位，需人工核对。
- 删除跨越合并区域边界的行/列会被拒绝（行为无法推断），改为整块删或先拆合并。
- 公式缓存值不由本工具计算：交付文件带「打开时全量重算」标记，Excel/WPS 打开会自动算；
  若产物要进纯预览链路（截图/转 PDF/脚本读数），先用 LibreOffice 打开另存一次。
- CSV 单元格一律按文本保留（「007」「1.10」不会变成 7/1.1）；数字与数字文本在定位比较时互认。
- 多级表头、复杂合并：可能定位失败，需手工处理。

## 常见错误

1. **match 不唯一**：多行满足条件，补充更多列条件
2. **old 不匹配**：定位错了或数据已变，重新 inspect
3. **表头不在第 1 行**：传 `header_row`
4. **列名不存在**：报错会列出可用列名
5. **sheet 不存在**：报错会列出可用 sheet 名
6. **写入合并区域非锚点格**：报错提示改用区域左上角锚点
7. **报「不支持数组公式/外部簿引用」**：该表需人工处理，不要反复重试
