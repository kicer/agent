// 会话管理 API（README 10.1）
const express = require('express');
const fs = require('fs');
const path = require('path');
const engine = require('../engine');

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

// 递归列出任务目录文件
function listTaskFiles(dir) {
  const out = [];
  (function rec(d, rel) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const relPath = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) rec(abs, relPath);
      else if (e.isFile()) {
        let size = null, mtime = null;
        try { const st = fs.statSync(abs); size = st.size; mtime = st.mtimeMs; } catch (_) {}
        out.push({ filename: relPath, size, mtime });
      }
    }
  })(dir, '');
  out.sort(function (a, b) { return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0; });
  return out;
}

router.post('/', wrap((req, res) => {
  const title = (req.body && req.body.title || '').trim();
  const modelId = (req.body && req.body.model_id || '').trim();
  const session = engine.createSession(title, modelId);
  res.json(session);
}));

router.get('/', wrap((req, res) => {
  const db = engine.getDb();
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50').all();
  const qpos = db.prepare(
    'SELECT session_id, ROW_NUMBER() OVER (ORDER BY queued_at, id) AS pos FROM wait_queue'
  ).all();
  const posMap = {};
  for (const r of qpos) posMap[r.session_id] = r.pos;
  for (const row of rows) {
    row.queue_pos = row.status === 'queued' ? (posMap[row.id] || null) : null;
  }
  res.json(rows);
}));

router.get('/:id', wrap((req, res) => {
  const session = engine.getSession(req.params.id);
  if (!session) return sendErr(res, Object.assign(new Error('会话不存在'), { status_code: 404 }));
  const db = engine.getDb();
  const messages = db.prepare('SELECT id, role, content, tool_calls, tool_call_id, name, created_at FROM messages WHERE session_id = ? ORDER BY id').all(session.id);
  const taskDir = engine.taskDirOf(session.id);
  res.json({
    session,
    messages,
    files: listTaskFiles(taskDir),
    queue_pos: session.status === 'queued' ? engine.queuePosition(session.id) : null,
    running: !!(engine.getRun(session.id) || {}).looping,
  });
}));

router.delete('/:id', wrap((req, res) => {
  const delDir = req.query.delete_dir === 'true' || req.query.delete_dir === '';
  res.json(engine.deleteSession(req.params.id, delDir));
}));

module.exports = router;
module.exports.listTaskFiles = listTaskFiles;
