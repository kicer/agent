---
name: data-page
description: 数据页面脚手架：把 table/dashboard/kanban 模板复制到任务目录 .app/，配合 db 工具产出 /app/{task_id}/ 可访问、经 /api/db/{task_id}/query 读写 data.db 的查看/管理页
visit_url: /app/{task_id}/
---

# data-page

## 何时使用

当用户提出以下需求时使用本技能：

- 把数据整理到数据库
- 生成数据查看页面
- 生成数据管理页面
- 数据统计展示

不适用：纯粹的文件读写、代码编写、信息检索。

## 环境约定

每个会话有独立的任务目录：

- 数据库：任务目录下的 `data.db`
- 页面目录：任务目录下的 `.app/`（带点目录，任务文件面板默认隐藏；URL 路径与目录名在路由层解耦）
- 页面入口：`.app/index.html`
- 访问地址：`/app/{task_id}/`（URL 无点、目录有点，别写错；完整 URL = 站点地址 + 该路径，run 输出末尾的「访问地址」已拼好，直接转发）
- 数据 API：`/api/db/{task_id}/query`

`{task_id}` 是任务目录的名称。页面通过 URL 动态解析，不要硬编码。

## 初始化

调用 `skill(name="data-page", op="run")`，无需参数。它会把以下文件复制到 `.app/`：

- `table.html` / `dashboard.html` / `kanban.html` —— 三个页面模板
- `base.css` —— 共用样式
- `config-table.js` / `config-dashboard.js` / `config-kanban.js` —— 配置骨架

已存在则跳过，不会覆盖（重跑幂等）。

## 数据 API

页面通过此接口读写数据。

### 请求

```
POST /api/db/{task_id}/query
Content-Type: application/json

{
  "sql": "SELECT * FROM parts WHERE qty > ?",
  "params": [0]
}
```

- `sql`：任意 SQLite 语句
- `params`：参数化绑定的值数组，可省略
- 必须使用参数化，不要把用户输入拼进 SQL

### 响应

成功时返回 JSON：

- SELECT：行数组 `[{"id": 1, "name": "螺丝"}, ...]`
- 写操作：`{"rowsAffected": 1, "lastInsertRowid": 3}`
- 建表等 DDL：`{"ok": true}`

失败时返回 `{"error": "错误信息"}`，HTTP 状态码仍为 200。前端需要检查 `error` 字段。

### task_id 获取

```javascript
const taskId = location.pathname.split('/').filter(Boolean)[1];
```

## 页面生成流程

1. **明确数据结构**：与用户确认字段。如果描述模糊，可以建议合理的结构。
2. **创建表并录入数据**：用 `db` 工具完成。
3. **初始化**：调用 `skill(name="data-page", op="run")`。
4. **为每个要生成的页面写 config 文件**（见下一节）。**不要读也不要改模板本身**。
5. **选定入口页**：把要作为首页的模板复制为 `.app/index.html`（同目录复制，引用路径不变），或直接保留多个页面并在 index.html 里做导航。
6. **告知用户**：把 run 输出末尾「访问地址」那行的完整 URL 发给用户，再简要说明页面功能。

默认只写 config 就够。模板无法覆盖需求时，才走自定义路径（见「自定义页面」一节）。

## 页面配置

三个模板对应三份 config：

| 模板 | config 文件 | 用途 |
|---|---|---|
| `table.html` | `config-table.js` | 清单、列表、增删改 |
| `dashboard.html` | `config-dashboard.js` | 统计、汇总、明细 |
| `kanban.html` | `config-kanban.js` | 按字段分列，状态流转 |

每份 config 的结构：

```javascript
window.PAGE_CONFIG = {
  table: '表名',
  pk: 'id',
  title: '页面标题',
  // ...字段见下
};
```

只写实际需要的字段，其余用模板默认值。

### config-table.js 字段

- `table`、`pk`、`title`、`pageSize`、`editable`
- `labels`：`{ 列名: '中文标签' }`，未列出的列用原名
- `numCols`：`['数值列名', ...]`，数字列右对齐
- `options`：`{ 列名: ['枚举值1', '枚举值2'] }`，编辑时用下拉
- `pills`：`{ 列名: { '值': 'ok|ship|pay|refund' } }`，状态着色

### config-dashboard.js 字段

- `table`、`pk`、`title`、`groupBy`、`detailColumns`、`detailLimit`
- `metric`：`{ type: 'count' }` 或 `{ type: 'sum', column: '列名', label: '标签' }`

### config-kanban.js 字段

- `table`、`pk`、`title`
- `groupField`：分列字段
- `groups`：`['列1', '列2', ...]`，列的显示顺序
- `titleField`：卡片主标题字段
- `metaFields`：`['字段1', '字段2']`，卡片上显示的次要信息

## 自定义页面

只有当模板无法覆盖需求时（特殊图表、多表关联、自定义交互等）才使用。

自定义页面必须满足：

1. 使用独立文件名（如 `.app/custom.html`）
2. 引用 `./base.css` 继承统一视觉
3. 提供返回会话入口（FAB，跳 `/?s=<task_id>`）
4. 在回复中说明为什么没用模板
5. HTML 骨架完整：`<!DOCTYPE html>`、`<meta charset="UTF-8">`、`<meta name="viewport" content="width=device-width, initial-scale=1">`
6. 用户数据渲染必转义：优先 `textContent`；用 `innerHTML` 先过 `esc()`（照抄模板里的实现），绝不把 API 查询结果裸拼进 HTML——模板自带转义，手写页面没有这层保护
7. 所有 SQL 参数化（`?`）；fetch 结果检查 `error` 字段（失败仍是 HTTP 200），并有加载态/错误提示
8. 大表查询加 `LIMIT`：页面数据 API 单次超 2000 行直接返回 `error`（注意与 `db` 工具不同——工具是截断到 500 行/100KB 仍返数据，API 无截断返回形态，静默少返会让页面统计/分页失真，所以显式报错）

`.app/` 下每个 HTML 页面（含 index.html）都要有返回会话入口——用户可能从任意子页直入，缺出口即被困住。

## 视觉规范

配色、圆角、字体、阴影、容器宽度、FAB、看板卡片等基础样式由 `base.css` 统一提供，模板和自定义页面都引用它。自定义页面不要重写这些基础样式。

## 常见错误

1. 硬编码 task_id —— 必须从 URL 解析
2. 忘记 `await` —— fetch 返回 Promise
3. 没检查 `error` 字段 —— API 错误时仍返回 200
4. 表名或字段名拼错
5. 引入 CDN 外部库 —— 容器可能无网络，优先纯原生
6. 页面文件不在 `.app/` 下 —— 无法通过 `/app/{task_id}/` 访问（目录带点、URL 不带点）
7. SQL 占位符与参数数量不匹配 —— 优先用结构化 insert
8. 读或改模板文件 —— 应只写 config
9. 自定义页面没引用 `base.css` —— 视觉会和其它页面割裂

## 检查清单

- [ ] 数据库表已创建、数据已录入
- [ ] 调用了 `skill run`
- [ ] 写好了对应的 `config-*.js`
- [ ] 选定入口页（复制为 `.app/index.html` 或保留多页 + 导航）
- [ ] 页面动态解析 task_id
- [ ] 每个 `.app/*.html` 都有返回会话入口
- [ ] 自定义页面：引用了 `base.css`、数据渲染已转义、SQL 参数化、大表加 LIMIT
- [ ] 已告知用户完整访问 URL（含域名）
