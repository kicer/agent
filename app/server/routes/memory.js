// 长期记忆（日记）只读调试 API：独立页面 memory.html 专用，查表即答，零写操作。
// 数据三块：按天条目原样（带裁剪窗外标记）、新会话实际会注入的渲染文本（与 journalFor
// 同源，所见即模型所得）、该用户已收口会话清单（碎片 ↔ 来源会话对照排查）。
const express = require('express');
const engine = require('../engine');
const memory = require('../memory');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const db = engine.getDb();
    const cfg = engine.getConfig();
    const user = String(req.user || '');
    const cutoff = memory.cutoffDay(cfg); // '' = 永久存储，无下界
    const rows = db.prepare('SELECT day, content, updated_at FROM memory_entries WHERE user = ? ORDER BY day DESC').all(user);
    const sessions = db.prepare(
      'SELECT id, title, status, model_id, journaled_at, updated_at FROM sessions WHERE user = ? AND journaled_at IS NOT NULL ORDER BY journaled_at DESC LIMIT 100'
    ).all(user);
    res.json({
      user,
      inject_max: memory.injectMax(cfg),
      retain_days: memory.retainDays(cfg), // 0 = 永久
      wrap_idle_ms: Math.floor(Number((cfg.memory || {}).wrap_idle_ms) || 0),
      auto_complete_ms: Math.floor(Number((cfg.agent || {}).auto_complete_ms) || 0),
      injection: memory.journalFor(db, cfg, user),
      entries: rows.map(r => ({ day: r.day, updated_at: r.updated_at, in_window: !cutoff || r.day >= cutoff, content: r.content })),
      sessions,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

module.exports = router;
