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

// 附件提示词:用户带附件发消息时,服务端在正文前拼一行系统通知,
// 与消息一并落库(历史重建时 AI 能看到)。格式:
//   【系统通知】用户上传了文件：a.png（大小 1.2 MB）、b.txt（大小 3 KB）
//   <用户原文>
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function composeWithAttachments(content, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return content;
  const list = attachments.slice(0, 20).map(a =>
    String(a && a.name || 'file').slice(0, 200) + '（大小 ' + fmtSize(a && a.size) + '）'
  ).join('、');
  const notice = '【系统通知】用户上传了文件：' + list;
  return content ? notice + '\n' + content : notice;
}

router.post('/:id/messages', wrap((req, res) => {
  const content = String((req.body && req.body.content) || '').trim();
  // 附件告知：正文前拼【系统通知】行（见 composeWithAttachments 注释）；纯附件消息（无正文）也合法。
  const attachments = Array.isArray(req.body && req.body.attachments) && (req.body.attachments || []).length
    ? req.body.attachments : null;
  const full = composeWithAttachments(content, attachments);
  if (!full) return res.status(400).json({ error: 'content 与 attachments 不能同时为空' });
  // deepThink：是否启用模型该「深度思考」参数（thinking_params 合并进上游请求体）
  const deepThink = !!(req.body && req.body.deepThink);
  const r = engine.postUserMessage(req.params.id, full, { deepThink });
  log.info('msg', (req.user || '-') + ' ' + req.params.id + ' 用户消息（' + (r && r.delivered || '?') + '）：' +
      full.slice(0, 60).replace(/\s+/g, ' '));
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

// 清空会话内容：删除全部消息记录，保留会话本身与任务目录文件（不再随下条消息重发旧历史）。
// 状态收尾为已完成并释放模型/出队；正在执行的回合会被拒绝（需先「终止」）。
// ?keep=summary：「压缩总结」收尾专用 —— 只保留最后一条 assistant 总结消息并打上 type='summary' 标记。
router.delete('/:id/messages', wrap((req, res) => {
  const keep = String((req.query && req.query.keep) || '').trim();
  const r = engine.clearSessionMessages(req.params.id, { keepSummary: keep === 'summary' });
  log.info('msg', (req.user || '-') + ' ' + req.params.id + (keep === 'summary' ? ' 压缩清理（仅保留摘要）' : ' 清空会话内容（文件保留）'));
  res.json(r);
}));

// 上下文压缩：phase-bar「压缩」按钮触发。弹窗选模式后调本接口：
//   mode='generate_only'       AI 总结；摘要之前的历史存档（type='archived'，UI 保留展示、不再发给模型）
//   mode='compress_and_clear'  AI 总结；前端完成后另调 DELETE ?keep=summary 把存档行物理清空，界面只留摘要
// 摘要行本身两种模式都会标成 type='summary'（见 engine.runLoopInner），作为后续轮次的上下文起点。
// 后端直接开启一个压缩回合（不往会话插入任何消息）：该回合的 system prompt 整体替换为
// templates/compress-prompt.txt 且不传 tools（见 engine.summarizeContext）；
// 响应回显 prompt 供前端直接渲染该指令气泡（仅展示，不入库），
// 并在总结回合的最终 SSE assistant_message 上带 is_summary + mode 给前端走收尾。
// 状态非 active 时才允许（避免与正在跑的回合抢上下文）。本接口只是「丢一条总结请求进队列」，
// 不等待 AI 完成——前端通过现有 SSE 流听 assistant_message 事件拿结果。
router.post('/:id/summarize', wrap((req, res) => {
  const mode = String((req.body && req.body.mode) || '').trim();
  const valid = mode === 'generate_only' || mode === 'compress_and_clear';
  if (!valid) return res.status(400).json({ error: 'mode 必须是 generate_only 或 compress_and_clear' });
  const r = engine.summarizeContext(req.params.id, mode);
  log.info('msg', (req.user || '-') + ' ' + req.params.id + ' 上下文压缩（mode=' + mode + ', ' + (r.delivered || '?') + '）');
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
