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

// 从哨兵 JSON __blocks__ 中剥离 base64 图片数据，避免加载会话时传输大体积 base64。
// 返回新content字符串，以及 hasImage 布尔标志（标识原内容含图片，可用于前端按需加载）。
function stripBase64FromContent(content) {
  if (typeof content !== 'string' || !content.startsWith('{"__blocks__":')) {
    return { content, hasImage: false };
  }
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.__blocks__)) return { content, hasImage: false };
    let hasImage = false;
    const blocks = parsed.__blocks__.map(block => {
      if (block && block.type === 'image_url' && block.image_url && block.image_url.url) {
        const url = block.image_url.url;
        if (url.startsWith('data:')) {
          hasImage = true;
          return { type: 'image_url', image_url: { url: '' } }; // 剥离 base64，置空由前端按需加载
        }
      }
      return block;
    });
    return { content: JSON.stringify({ __blocks__: blocks }), hasImage };
  } catch (_) {
    return { content, hasImage: false };
  }
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

router.get('/:id', wrap((req, res) => {
  const session = engine.getSession(req.params.id);
  if (!session) return sendErr(res, Object.assign(new Error('会话不存在'), { status_code: 404 }));
  const db = engine.getDb();
  const rows = db.prepare('SELECT id, role, content, reasoning, tool_calls, tool_call_id, name, type, is_error, created_at FROM messages WHERE session_id = ? ORDER BY id').all(session.id);
  // 剥离 base64 图片数据，避免大体积传输；前端按 hasImage 标志按需加载图片
  const messages = rows.map(row => {
    const { content, hasImage } = stripBase64FromContent(row.content);
    return { ...row, content, hasImage };
  });
  const taskDir = engine.taskDirOf(session.id);
  res.json({
    session,
    messages,
    files: listTaskFiles(taskDir),
    queue_pos: session.status === 'queued' ? engine.queuePosition(session.id) : null,
    running: !!(engine.getRun(session.id) || {}).looping,
  });
}));

// 按需加载消息的图片（base64 已剥离，由前端此接口获取）
router.get('/:id/messages/:mid/image', wrap((req, res) => {
  const session = engine.getSession(req.params.id);
  if (!session) return sendErr(res, Object.assign(new Error('会话不存在'), { status_code: 404 }));
  const db = engine.getDb();
  const row = db.prepare(
    'SELECT content FROM messages WHERE id = ? AND session_id = ?'
  ).get(req.params.mid, req.params.id);
  if (!row) return sendErr(res, Object.assign(new Error('消息不存在'), { status_code: 404 }));
  const blocks = (function () {
    if (typeof row.content !== 'string' || !row.content.startsWith('{"__blocks__":')) return null;
    try {
      const parsed = JSON.parse(row.content);
      return Array.isArray(parsed.__blocks__) ? parsed.__blocks__ : null;
    } catch (_) { return null; }
  })();
  if (!blocks) return sendErr(res, Object.assign(new Error('该消息不含图片'), { status_code: 404 }));
  const imgBlock = blocks.find(b => b && b.type === 'image_url' && b.image_url && b.image_url.url);
  if (!imgBlock || !imgBlock.image_url.url || !imgBlock.image_url.url.startsWith('data:')) {
    return sendErr(res, Object.assign(new Error('图片数据不存在或已被清理'), { status_code: 404 }));
  }
  const url = imgBlock.image_url.url; // e.g. "data:image/jpeg;base64,/9j/..."
  const mimeMatch = /^data:([^;]+);base64,/.exec(url);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const base64Data = url.slice(url.indexOf(',') + 1);
  const buffer = Buffer.from(base64Data, 'base64');
  res.set('Content-Type', mime);
  res.set('Content-Length', buffer.length);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(buffer);
}));

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

module.exports = router;
module.exports.listTaskFiles = listTaskFiles;
