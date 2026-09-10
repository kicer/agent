// 消息与交互 API（README 10.2）：发消息 / SSE 流 / 开始执行 / 终止
const express = require('express');
const engine = require('../engine');
const log = require('../log');

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

// 附件上传只写任务目录文件（见 routes/files.js），消息正文原样入库，不再拼接任何通知行。
router.post('/:id/messages', wrap((req, res) => {
  const content = String((req.body && req.body.content) || '').trim();
  if (!content) return res.status(400).json({ error: 'content 不能为空' });
  // deepThink：是否启用模型该「深度思考」参数（thinking_params 合并进上游请求体）
  const deepThink = !!(req.body && req.body.deepThink);
  const r = engine.postUserMessage(req.params.id, content, { deepThink });
  log.info('msg', (req.user || '-') + ' ' + req.params.id + ' 用户消息（' + (r && r.delivered || '?') + '）：' +
      content.slice(0, 60).replace(/\s+/g, ' '));
  res.json(r);
}));


router.post('/:id/stop', wrap((req, res) => {
  res.json(engine.stop(req.params.id));
}));

// 断开：held 会话主动放弃模型保持租约，结版为已完成（非终止）
router.post('/:id/release', wrap((req, res) => {
  res.json(engine.releaseHold(req.params.id));
}));

// 清空会话内容：删除全部消息记录，保留会话本身与任务目录文件（不再随下条消息重发旧历史）。
// 状态收尾为已完成并释放模型/出队；正在执行的回合会被拒绝（需先「终止」）。
router.delete('/:id/messages', wrap((req, res) => {
  const r = engine.clearSessionMessages(req.params.id);
  log.info('msg', (req.user || '-') + ' ' + req.params.id + ' 清空会话内容（文件保留）');
  res.json(r);
}));

// 上下文压缩：phase-bar「压缩」按钮弹窗里点「摘要」触发。
// AI 总结；摘要之前的历史存档（type='archived'，UI 保留展示、不再发给模型）。
// 摘要行本身标成 type='summary'（见 engine.runLoopInner），作为后续轮次的上下文起点。
// 后端直接开启一个压缩回合（不往会话插入任何消息）：该回合只发一条 system（模板 +
// 完整历史填入 {{conversation}}）且不带 tools（见 engine.summarizeContext）；
// 响应仅回显一句短提示 prompt 供前端渲染指令气泡（不入库、不含模板正文），
// 并在总结回合的最终 SSE assistant_message 上带 is_summary 给前端走收尾。
// 状态非 active 时才允许（避免与正在跑的回合抢上下文）。本接口只是「丢一条总结请求进队列」，
// 不等待 AI 完成——前端通过现有 SSE 流听 assistant_message 事件拿结果。
router.post('/:id/summarize', wrap((req, res) => {
  const r = engine.summarizeContext(req.params.id);
  log.info('msg', (req.user || '-') + ' ' + req.params.id + ' 上下文压缩（' + (r.delivered || '?') + '）');
  res.json(r);
}));

// 删除单条消息（含工具/任务消息）：删 assistant 轮连带其 tool 回执；单删 tool 回执会把该调用
// 从父 assistant 的 tool_calls 里同步摘除（见 engine.deleteMessage），保证调用↔回执成对。
// 库中没了，后续发给模型的消息里自然也没有；执行中删除会在下一轮组装历史时生效。
router.delete('/:id/messages/:messageId', wrap((req, res) => {
  const r = engine.deleteMessage(req.params.id, Number(req.params.messageId));
  log.info('msg', (req.user || '-') + ' ' + req.params.id + ' 删除消息 ' + req.params.messageId +
      (r.removed > 1 ? '（连带 ' + (r.removed - 1) + ' 条工具回执）' : ''));
  res.json(r);
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
    // 可见心跳：具名事件（注释帧 `: ping` 不触发前端 JS 事件，无法做静默看门狗）
    try { res.write('event: ping\ndata: {}\n\n'); } catch (_) {}
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
