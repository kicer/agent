// 文本命令接入端（channel）API：给没有可点击 UI 的端（IM 桥、CLI 等）提供会话内操作的文字入口。
// 设计（docs/ARCHITECTURE.md §4.1/§7）：
// - 命令只在 /api/channel/send 解析，不进普通消息路由——Web 上以斜杠开头的文本照常发给模型。
//   命令是无 UI 端的按钮替代品，不是全局协议（防误伤路径/代码讨论这类合法文本）。
// - 每个 (user, channel) 记一个「当前会话」（channel_sessions 表）：接入端没有会话列表 UI，
//   普通消息与命令都路由到它；/new 新建并换绑，旧会话不打断、按自己状态自然走完。
// - 数据面零特殊：全部走 engine 既有函数（同一张 sessions/messages 表、同一 SSE），
//   Web 端打开这些会话与普通会话无差别。
// - 命令动作本身不落消息行（与 Web 点「终止」按钮不产生消息对称）；
//   /new 尾随文本与普通消息是真实内容，照常入库。
const express = require('express');
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

// ---------- 当前会话绑定 ----------
// 懒自愈：绑定指向的会话已被删除 → 清行按未绑定处理（下一条消息自动新建），不建外键就是为这个。
function boundSession(db, user, channel) {
  const row = db.prepare('SELECT session_id FROM channel_sessions WHERE user = ? AND channel = ?').get(user, channel);
  if (!row) return null;
  const s = engine.getSession(row.session_id);
  if (s) return s;
  db.prepare('DELETE FROM channel_sessions WHERE user = ? AND channel = ?').run(user, channel);
  return null;
}

function setBinding(db, user, channel, sessionId) {
  db.prepare(
    'INSERT INTO channel_sessions (user, channel, session_id, updated_at) VALUES (?,?,?,?)'
    + ' ON CONFLICT(user, channel) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at'
  ).run(user, channel, sessionId, Date.now());
}

// /new 与「无绑定时发普通消息」共用：新建（engine 立即绑模型，空池 503 冒泡）+ 换绑 + 可选首条消息
function newSessionFor(db, user, channel, firstText) {
  const s = engine.createSession('', '', 'secretary', user);
  setBinding(db, user, channel, s.id);
  const sent = firstText ? engine.postUserMessage(s.id, firstText) : null;
  return { s, sent };
}

// 解析 (user,channel) 的当前会话，无绑定则新建并绑定（不发消息）——
// 微信图片入口需要先拿到会话才能落任务目录文件，随后再走 handleSend 拼告知行。
function ensureSession(db, user, channel) {
  return boundSession(db, user, channel) || newSessionFor(db, user, channel, '').s;
}

// ---------- 命令解析 ----------
// 严格匹配：整条消息恰好是命令词（仅 /new 可带尾随文本）才算命令。
// 首词形如 /纯ASCII词 但不在清单 → 回「未知命令」提示、不转发模型（防弱模型就着 /hlep 演一段）；
// 其余一律普通消息：/home/x、/a.b 这类路径代码，以及 /clear abc 这种带尾巴的（用户约定：强检查不匹配）。
const CMDS = new Set(['new', 'stop', 'compact', 'clear', 'status', 'help']);

function parseCommand(text) {
  const t = String(text || '').trim();
  if (t[0] !== '/') return null;
  const sp = t.search(/\s/);
  const head = (sp < 0 ? t.slice(1) : t.slice(1, sp)).toLowerCase();
  const rest = sp < 0 ? '' : t.slice(sp + 1).trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(head)) return { normal: true };
  if (!CMDS.has(head)) return { unknown: head };
  if (rest && head !== 'new') return { normal: true };
  return { cmd: head, rest };
}

// 命令输出统一用 markdown（channel 层的规范格式）：支持渲染的接入端直接用，
// 微信这类纯文本端由 wxbot 发送前 stripMarkdown 降级——格式信息留在生产方，渲染适配在消费方。
const HELP_TEXT = [
  '**可用命令**',
  '- `/new [文本]` 新建会话并切换（带文本则作为首条消息直接开跑；不打断旧会话正在跑的回合）',
  '- `/stop` 终止当前回合',
  '- `/compact` 压缩上下文（摘要稍后作为一条回复出现在会话里）',
  '- `/clear` 清空当前会话（回到顾问模式，会话继续用）',
  '- `/status` 查看当前会话状态',
  '- `/help` 显示本帮助',
].join('\n');

const STATUS_TEXT = { active: '活跃中', held: '保持中', completed: '已完成', cancelled: '已终止' };
const PHASE_TEXT = { advising: '顾问', executing: '执行' };

function fmtTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function statusReply(db, s) {
  const run = engine.getRun(s.id);
  const looping = !!(run && run.looping);
  const lines = [
    '**会话状态**',
    '- 会话：`' + s.id + '`「' + (s.title || '未命名') + '」',
    '- 状态：' + (looping ? '回合进行中' : (STATUS_TEXT[s.status] || s.status))
      + '｜阶段：' + (PHASE_TEXT[s.phase] || s.phase || '-'),
    '- 模型：`' + (s.model_id || '未绑定') + '`',
  ];
  const t = db.prepare('SELECT cron_expr, next_run_at, last_run_at, last_status FROM scheduled_tasks WHERE session_id = ?').get(s.id);
  lines.push(t
    ? '- 定时任务：cron `' + t.cron_expr + '`，下次 ' + fmtTime(t.next_run_at) + '（上次 ' + fmtTime(t.last_run_at) + ' ' + (t.last_status || '-') + '）'
    : '- 定时任务：无');
  return lines.join('\n');
}

// ---------- 入口 ----------
// 命令主流程：Web 接入（POST /api/channel/send）与微信桥接（wechat.js 直调）共用同一函数，
// 命令表/会话绑定/自动建会话只有一份实现；来源差异（日志前缀 tag、身份解析）由调用方注入。
// 返回 {kind, reply, session_id, message_id?}；引擎拒绝的（回合进行中压缩/清空）抛 {status_code}，由调用方映射。
function handleSend(db, opts) {
  const user = String(opts.user || '').trim().slice(0, 64);
  const channel = String(opts.channel || '').trim().slice(0, 64);
  const text = String(opts.text || '').trim();
  if (!text) throw Object.assign(new Error('text 不能为空'), { status_code: 400 });
  const tag = opts.tag || ((user || '-') + ' [' + (channel || 'default') + ']');

  const parsed = parseCommand(text);

  // 普通消息：解析当前会话，无绑定自动新建（IM 用户不会先打 /new 才能聊天）
  if (!parsed || parsed.normal) {
    let s = boundSession(db, user, channel);
    let sent;
    if (!s) {
      const r = newSessionFor(db, user, channel, text);
      s = r.s; sent = r.sent;
    } else {
      sent = engine.postUserMessage(s.id, text);
    }
    log.info('msg', tag + ' channel 消息 → ' + s.id);
    return { kind: 'message', reply: '已发送到会话 ' + s.id, session_id: s.id, message_id: sent.message_id };
  }

  if (parsed.unknown) {
    const s = boundSession(db, user, channel);
    return { kind: 'command', reply: '/' + parsed.unknown + ' 不是有效命令，发送 /help 查看清单', session_id: s ? s.id : null };
  }

  const cmd = parsed.cmd;

  if (cmd === 'help') {
    const s = boundSession(db, user, channel);
    return { kind: 'command', reply: HELP_TEXT, session_id: s ? s.id : null };
  }

  if (cmd === 'new') {
    const r = newSessionFor(db, user, channel, parsed.rest);
    log.info('task', tag + ' channel /new → ' + r.s.id + (parsed.rest ? '（含首条消息）' : ''));
    return {
      kind: 'command',
      reply: '已新建会话 ' + r.s.id + (parsed.rest ? '，首条消息已发出' : '（发普通消息或 /status 查看状态）'),
      session_id: r.s.id,
      message_id: r.sent ? r.sent.message_id : undefined,
    };
  }

  // 其余命令都作用于当前会话；无绑定时不隐式新建（那不是用户点这条命令的意图）
  const s = boundSession(db, user, channel);
  if (!s) {
    return { kind: 'command', reply: '当前没有会话（先 /new，或直接发一条普通消息自动新建）', session_id: null };
  }

  if (cmd === 'stop') {
    // 与 Web 按钮语义对齐：只有回合真在跑才停，idle 不误伤（stop 会把 held 刷成 cancelled）
    const run = engine.getRun(s.id);
    if (!(run && run.looping)) {
      return { kind: 'command', reply: '当前没有进行中的回合（无需终止）', session_id: s.id };
    }
    engine.stop(s.id);
    log.info('msg', tag + ' channel /stop ' + s.id);
    return { kind: 'command', reply: '已发送终止指令，回合收尾中', session_id: s.id };
  }

  if (cmd === 'compact') {
    engine.summarizeContext(s.id); // 回合进行中 engine 抛 409（请先终止），冒给调用方
    log.info('msg', tag + ' channel /compact ' + s.id);
    return { kind: 'command', reply: '已发起上下文压缩，摘要稍后会作为一条回复出现在会话里', session_id: s.id };
  }

  if (cmd === 'clear') {
    engine.clearSessionMessages(s.id); // 同上，回合进行中 409
    log.info('msg', tag + ' channel /clear ' + s.id);
    return { kind: 'command', reply: '已清空当前会话（回到顾问模式），继续发消息即从零开始', session_id: s.id };
  }

  // cmd === 'status'
  return { kind: 'command', reply: statusReply(db, s), session_id: s.id };
}

// HTTP 入口：POST /api/channel/send {channel?, text} → handleSend 结果。
// - kind='message'：普通消息已入会话开跑；kind='command'：reply 即命令回执（纯文本，IM 直接转发）。
// - AI 的正式回复不在本接口返回：接入端复用 SSE GET /api/sessions/:id/stream 或轮询会话详情。
// - 引擎主动拒绝的走 HTTP 4xx {error}，语义与 Web 路由一致。
router.post('/send', wrap((req, res) => {
  res.json(handleSend(engine.getDb(), {
    user: String(req.user || '').trim(), // 认证用户；未开认证为空串（自用单用户）
    channel: (req.body || {}).channel,
    text: (req.body || {}).text,
  }));
}));

module.exports = router;
module.exports.handleSend = handleSend;
module.exports.ensureSession = ensureSession;
// 微信桥（wechat.js）直调面：命令识别（渠道上下文注入时机）与「建会话+换绑不发消息」（/new 带尾随文本）
module.exports.parseCommand = parseCommand;
module.exports.newSessionFor = newSessionFor;
