---
name: data-page
description: 数据页面脚手架：把 table/dashboard/kanban 模板复制到任务目录 app/templates/，配合 db 工具产出 /app/{task_id}/ 可访问、经 /api/db/{task_id}/query 读写 data.db 的查看/管理页
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
- 页面目录：任务目录下的 `app/`
- 页面入口：`app/index.html`
- 访问地址：`/app/{task_id}/`（完整 URL = 站点地址 + 该路径；run 输出末尾的「访问地址」已拼好，直接转发）
- 数据 API：`/api/db/{task_id}/query`

`{task_id}` 是任务目录的名称。页面通过 URL 动态解析，不要硬编码。

## 初始化

生成页面前，调用 `skill(name="data-page", op="run")`（无需参数，模板固定复制到 `app/templates/`）。已存在则跳过，不会覆盖修改过的文件（重跑幂等）。

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
3. **初始化模板**：调用 `skill(name="data-page", op="run")`（无参数）。
4. **生成页面**：从 `app/templates/` 选合适的模板，根据表结构调整字段和 SQL，写入 `app/index.html`。
5. **告知用户**：把 run 输出末尾「访问地址」那行的**完整 URL**（含域名）发给用户——只给 `/app/...` 相对路径用户打不开；再简要说明页面功能。

页面必须包含：

- HTML 骨架（`<!DOCTYPE html>`、`<meta viewport>`、UTF-8）
- 移动端友好的样式
- 通过 `fetch` 调用数据 API
- 错误处理和加载状态

## 模板

模板位于 `app/templates/`。

- **table.html**：标准表格，适合清单、列表。含排序、搜索、分页。
- **dashboard.html**：统计看板，顶部卡片 + 简单图表 + 明细表。
- **kanban.html**：分组看板，按字段分列展示。

优先使用模板。模板都不合适时才从零写。

## 最小示例

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>采购清单</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #f5f5f5; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    .card { background: white; border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #eee; font-size: 14px; }
    th { color: #666; font-weight: 500; }
    .empty { text-align: center; color: #999; padding: 32px; }
    .error { color: #d33; padding: 12px; }
  </style>
</head>
<body>
  <h1>采购清单</h1>
  <div class="card" id="content">加载中…</div>

  <script>
    const taskId = location.pathname.split('/').filter(Boolean)[1];
    const API = `/api/db/${taskId}/query`;

    async function query(sql, params = []) {
      const res = await fetch(API, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sql, params})
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    }

    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }

    async function render() {
      const el = document.getElementById('content');
      try {
        const rows = await query('SELECT * FROM parts ORDER BY id');
        if (!rows.length) {
          el.innerHTML = '<div class="empty">暂无数据</div>';
          return;
        }
        el.innerHTML = `<table>
          <thead><tr><th>名称</th><th>规格</th><th>类别</th><th>数量</th><th>单位</th><th>备注</th></tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.spec)}</td>
            <td>${escapeHtml(r.category)}</td>
            <td>${escapeHtml(r.qty)}</td>
            <td>${escapeHtml(r.unit)}</td>
            <td>${escapeHtml(r.note)}</td>
          </tr>`).join('')}</tbody>
        </table>`;
      } catch (e) {
        el.innerHTML = `<div class="error">加载失败：${escapeHtml(e.message)}</div>`;
      }
    }

    render();
  </script>
</body>
</html>
```

## 最佳实践

**前端**

- 用原生 JS + fetch，不引入框架
- 样式用内联 `<style>` 或独立 CSS，不依赖外部 CSS 库
- 图表用纯 SVG 或 CSS 绘制
- 移动优先
- 显示加载状态和错误提示
- 提交类按钮加禁用状态，避免重复点击

**数据库**

- 使用参数化查询
- 大表查询加 `LIMIT`

**安全**

- 用户输入渲染到 HTML 时用 `textContent`，或用 `escapeHtml` 转义后再用 `innerHTML`

**用户体验**

- 页面标题反映数据内容
- 空数据时显示友好提示
- 操作有反馈（保存成功、删除确认）

## 常见错误

1. 硬编码 task_id —— 必须从 URL 解析
2. 忘记 `await` —— fetch 返回 Promise
3. 没检查 `error` 字段 —— API 错误时仍返回 200
4. 表名或字段名拼错
5. 引入 CDN 外部库 —— 容器可能无网络，优先纯原生
6. 页面文件不在 `app/` 下 —— 无法通过 `/app/{task_id}/` 访问
7. SQL 占位符与参数数量不匹配 —— 优先用结构化 insert，避免手写

## 检查清单

- [ ] 数据库表已创建
- [ ] 数据已录入
- [ ] `app/index.html` 已写入
- [ ] 页面动态解析 task_id
- [ ] 包含错误处理和加载状态
- [ ] 用户输入渲染时已转义
- [ ] 已告知用户完整访问 URL（run 输出「访问地址」那行，含域名，非相对路径）
