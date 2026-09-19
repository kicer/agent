// 会话管理 API（README 10.1）
const express = require('express');
const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const log = require('../log');

const router = express.Router();

function wrap(fn) {
  return function (req, res) {
    try {
      const r = fn(req, res);
      if (r && typeof r.catch === 'function') {
        r.catch(err => sendErr(res, err));
      }
    } catch (err) {
      sendErr(res, err);
    }
  };
}

function sendErr(res, err) {
  const code = err && err.status_code || 500;
  res.status(code).json({ error: String(err && err.message || err) });
}

// 按需加载单条消息的完整内容（用于 tool 消息的懒加载）。
// 返回消息行原始 content（含 base64 图片），前端负责渲染。
function getMessage(req, res) {
  const session = engine.getSession(req.params.id);
  if (!session) return sendErr(res, Object.assign(new Error('会话不存在'), { status_code: 404 }));
  const db = engine.getDb();
  const row = db.prepare(
    'SELECT id, role, content, reasoning, tool_calls, tool_call_id, name, type, is_error, created_at FROM messages WHERE id = ? AND session_id = ?'
  ).get(req.params.mid, req.params.id);
  if (!row) return sendErr(res, Object.assign(new Error('消息不存在'), { status_code: 404 }));
  res.json(row);
}

// 递归列出任务目录文件。opts.dirs=true 时额外输出目录标记行
//（filename 以 '/' 结尾 + dir:true），使不含任何文件的空夹子也能被前端展示。
function listTaskFiles(dir, opts) {
  const wantDirs = !!(opts && opts.dirs);
  const out = [];
  (function rec(d, rel) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const relPath = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (wantDirs) out.push({ filename: relPath + '/', dir: true });
        rec(abs, relPath);
      }
      else if (e.isFile()) {
        let size = null, mtime = null, ctime = null;
        // birthtime 在部分文件系统不可用(返回 0),回退 mtime;新生成/上传的文件两者基本一致
        try {
          const st = fs.statSync(abs);
          size = st.size; mtime = st.mtimeMs;
          ctime = (st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs) || null;
        } catch (_) {}
        out.push({ filename: relPath, size, mtime, ctime });
      }
    }
  })(dir, '');
  // 按创建时间倒序(最新在前)方便查找;同一时刻按文件名升序保证稳定
  out.sort(function (a, b) {
    const ca = a.ctime || a.mtime || 0, cb = b.ctime || b.mtime || 0;
    if (cb !== ca) return cb - ca;
    return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;
  });
  return out;
}

router.post('/', wrap((req, res) => {
  const title = (req.body && req.body.title || '').trim();
  const modelId = (req.body && req.body.model_id || '').trim();
  // 助手类型建档时锁定，后续不可变更；缺省按文秘助理
  const assistantType = String((req.body && req.body.assistant_type) || 'secretary').trim().slice(0, 32) || 'secretary';
  // 创建者取认证中间件的 req.user(不信客户端传参);未启用认证时为空串
  const user = String(req.user || '').trim().slice(0, 64);
  const session = engine.createSession(title, modelId, assistantType, user);
  log.info('task', (req.user || '-') + ' 新建任务 ' + session.id + '「' + (session.title || '未命名') + '」model=' + (modelId || '自动') + ' type=' + (session.assistant_type || 'secretary'));
  res.json(session);
}));

// 列表查询参数(2.0):
//   status=active|done|all  归档分组:active=排队/活跃/保持,done=已完成/已终止
//   q=关键词                标题或消息内容 LIKE 搜索
//   before + before_id      游标分页(上一页末行的 updated_at,id),避免 offset 翻页在
//                           updated_at 变动时重复/漏行
//   with_total=1            返回 {rows,total}(归档折叠区需要总数);默认仍返回纯数组
router.get('/', wrap((req, res) => {
  const db = engine.getDb();
  const status = String(req.query.status || 'all');
  const q = String(req.query.q || '').trim();
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  const where = [];
  const args = [];
  // 按创建者隔离:已登录只列自己的会话;未启用认证(req.user 空)不过滤，保持自用场景全可见
  const me = String(req.user || '').trim();
  if (me) { where.push('user = ?'); args.push(me); }
  if (status === 'active') where.push("status IN ('queued','active','held')");
  else if (status === 'done') where.push("status IN ('completed','cancelled')");
  if (q) {
    where.push('(title LIKE ? OR EXISTS(SELECT 1 FROM messages m WHERE m.session_id = sessions.id AND m.content LIKE ?))');
    args.push('%' + q + '%', '%' + q + '%');
  }
  const before = req.query.before;
  const beforeId = req.query.before_id;
  if (before != null && before !== '' && beforeId) {
    where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    args.push(String(before), String(before), String(beforeId));
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const stmt = db.prepare(
    'SELECT * FROM sessions' + whereSql + ' ORDER BY updated_at DESC, id DESC LIMIT ?'
  );
  const rows = stmt.all.apply(stmt, args.concat([limit]));

  const qpos = db.prepare(
    'SELECT session_id, ROW_NUMBER() OVER (ORDER BY queued_at, id) AS pos FROM wait_queue'
  ).all();
  const posMap = {};
  for (const r of qpos) posMap[r.session_id] = r.pos;
  for (const row of rows) {
    row.queue_pos = row.status === 'queued' ? (posMap[row.id] || null) : null;
  }
  if (req.query.with_total === '1') {
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM sessions' + whereSql);
    const total = cnt.all.apply(cnt, args)[0].n;
    return res.json({ rows: rows, total: total });
  }
  res.json(rows);
}));

// assistant 消息附加 tool_call_msg_ids（tool_call.id → tool 消息行 id，让前端展开工具卡时知道去拉哪条消息）
function attachToolCallMap(row, toolCallMsgMap) {
  if (row.role === 'assistant' && row.tool_calls) {
    let toolCalls;
    try { toolCalls = JSON.parse(row.tool_calls); } catch (_) { toolCalls = []; }
    const tool_call_msg_ids = {};
    for (const tc of toolCalls) {
      if (tc && tc.id && toolCallMsgMap[tc.id]) {
        tool_call_msg_ids[tc.id] = toolCallMsgMap[tc.id];
      }
    }
    row.tool_call_msg_ids = Object.keys(tool_call_msg_ids).length ? tool_call_msg_ids : undefined;
  }
  return row;
}

const MSG_COLS = 'id, role, content, reasoning, tool_calls, tool_call_id, name, type, is_error, usage, created_at';

router.get('/:id', wrap((req, res) => {
  const session = engine.getSession(req.params.id);
  if (!session) return sendErr(res, Object.assign(new Error('会话不存在'), { status_code: 404 }));
  const db = engine.getDb();

  // tool_call_id → tool 消息行 id 映射：单独轻查询（只取 id），不随分页窗口截断，
  // 保证分页边界处的 assistant 消息也能拿到自己 tool 行的懒加载映射
  const toolCallMsgMap = {};
  for (const r of db.prepare(
    "SELECT id, tool_call_id FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id IS NOT NULL AND tool_call_id != ''"
  ).all(session.id)) toolCallMsgMap[r.tool_call_id] = r.id;

  // 历史懒加载：传 limit 只返回最近 limit 条非 tool 消息（tool 不单独展示，不计入），
  // before 为行 id 游标（取 id < before 的更早一页）；多取一条判断是否还有更早历史。
  // 不传 limit 保持旧行为：返回全部消息。
  let limit = parseInt(req.query.limit, 10);
  limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 0;
  let hasMore = false;
  let messages = [];
  if (limit) {
    const before = parseInt(req.query.before, 10);
    const args = [session.id];
    let sql = 'SELECT ' + MSG_COLS + " FROM messages WHERE session_id = ? AND role != 'tool'";
    if (Number.isFinite(before) && before > 0) { sql += ' AND id < ?'; args.push(before); }
    args.push(limit + 1);
    // 注意：better-sqlite3 的 all 必须以 Statement 实例为 this 调用，不能脱离绑定
    const stmt = db.prepare(sql + ' ORDER BY id DESC LIMIT ?');
    let rows = stmt.all(...args);
    hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    rows.reverse(); // 还原时间升序
    messages = rows.map(r => attachToolCallMap(r, toolCallMsgMap));
  } else {
    const allRows = db.prepare(
      'SELECT ' + MSG_COLS + ' FROM messages WHERE session_id = ? ORDER BY id'
    ).all(session.id);
    for (const row of allRows) {
      if (row.role === 'tool') continue; // tool 结果不单独展示，由映射懒加载
      messages.push(attachToolCallMap(row, toolCallMsgMap));
    }
  }

  const taskDir = engine.taskDirOf(session.id);
  // 定时任务状态（scheduler.js / schedule_task 工具；每会话至多一行，无则 null）。
  // 列表接口故意不带此字段，避免 N+1；前端进会话详情时才拉。
  const schedule = db.prepare(
    'SELECT cron_expr, next_run_at, last_run_at, last_status, last_note FROM scheduled_tasks WHERE session_id = ?'
  ).get(session.id) || null;
  res.json({
    session,
    messages,
    files: listTaskFiles(taskDir),
    schedule,
    queue_pos: session.status === 'queued' ? engine.queuePosition(session.id) : null,
    running: !!(engine.getRun(session.id) || {}).looping,
    has_more: hasMore, // 分页模式下：是否还有更早的历史
    oldest_id: messages.length ? messages[0].id : null, // 本页最早行 id，作为下一页 before 游标
  });
}));

// 按需加载单条消息的完整内容（用于 tool 消息的懒加载）
router.get('/:id/messages/:mid', wrap(getMessage));

router.post('/:id/bind', wrap((req, res) => {
  res.json(engine.bindToSession(req.params.id, req.body && req.body.model_id));
}));

router.patch('/:id', wrap((req, res) => {
  res.json(engine.renameSession(req.params.id, req.body && req.body.title));
}));

router.delete('/:id', wrap((req, res) => {
  const delDir = req.query.delete_dir === 'true' || req.query.delete_dir === '';
  log.info('task', (req.user || '-') + ' 删除任务 ' + req.params.id + (delDir ? '（含任务目录）' : ''));
  res.json(engine.deleteSession(req.params.id, delDir));
}));

// 手动删除定时任务（用户端唯一入口；创建只经 AI 工具，改 = 删后让 AI 重建）。
// 通知消息只 saveMessage 落库，不走 postUserMessage：不触发 AI 运行，
// 下一次自然对话时 AI 自会看到（type='scheduler_note' 对 buildMessages 是未知型，按普通 user 消息发）。
// 删会话无需此处：scheduled_tasks 随 sessions 行 ON DELETE CASCADE 自动清理。
router.delete('/:id/schedule', wrap((req, res) => {
  const db = engine.getDb();
  const t = db.prepare('SELECT cron_expr FROM scheduled_tasks WHERE session_id = ?').get(req.params.id);
  if (!t) throw Object.assign(new Error('本会话没有定时任务'), { status_code: 404 });
  db.prepare('DELETE FROM scheduled_tasks WHERE session_id = ?').run(req.params.id);
  engine.saveMessage(req.params.id, {
    role: 'user',
    content: '[系统] 定时任务已删除（原定 ' + t.cron_expr + '）',
    type: 'scheduler_note',
  });
  log.info('scheduler', req.params.id + ' 删除定时任务 ' + t.cron_expr);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.listTaskFiles = listTaskFiles;
