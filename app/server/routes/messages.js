// 消息与交互 API（README 10.2）：发消息 / SSE 流 / 开始执行 / 终止
const express = require('express');
const engine = require('../engine');

const router = express.Router();

function wrap(fn) {
  return function (req, res) {
    try {
      fn(req, res);
    } catch (err) {
      res.status(err && err.status_code || 500).json({ error: String(err && err.message || err) });
    }
  };
}

router.post('/:id/messages', wrap((req, res) => {
  const content = String((req.body && req.body.content) || '').trim();
  if (!content) return res.status(400).json({ error: 'content 不能为空' });
  const r = engine.postUserMessage(req.params.id, content);
  res.json(r);
}));

router.post('/:id/start', wrap((req, res) => {
  res.json(engine.startExecution(req.params.id));
}));

router.post('/:id/stop', wrap((req, res) => {
  res.json(engine.stop(req.params.id));
}));

// 断开：held 会话主动放弃模型保持租约，结版为已完成（非终止）
router.post('/:id/release', wrap((req, res) => {
  res.json(engine.releaseHold(req.params.id));
}));

// SSE 事件流
router.get('/:id/stream', (req, res) => {
  const session = engine.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const bus = engine.getBus();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders && res.flushHeaders();
  res.write('retry: 3000\n\n');
  bus.addClient(session.id, res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.removeClient(session.id, res);
  });
  bus.emit(session.id, 'status', {
    session_id: session.id,
    status: session.status,
    phase: session.phase,
    model_id: session.model_id,
    queue_pos: session.status === 'queued' ? engine.queuePosition(session.id) : null,
  });
});

module.exports = router;
