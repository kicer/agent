// 文本命令接入端（channel）API：给没有可点击 UI 的端（IM 桥、CLI 等）提供会话内操作的文字入口。
// 设计：
// - 命令只在 /api/channel/send 解析，不进普通消息路由——Web 上以斜杠开头的文本照常发给模型。
//   命令是无 UI 端的按钮替代品，不是全局协议（防误伤路径/代码讨论这类合法文本）。
// - 每个 (user, channel) 记一个「当前会话」（channel_sessions 表）：接入端没有会话列表 UI，
//   普通消息与命令都路由到它；/new /switch 换绑，旧会话不打断、按自己状态自然走完；
//   /list /rename /delete /models 覆盖 Web 端其余管理操作（同 engine 函数，数据面零特殊）。
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
function newSessionFor(db, user, channel, firstText, opts) {
  const s = engine.createSession('', '', 'secretary', user);
  setBinding(db, user, channel, s.id);
  const sent = firstText ? engine.postUserMessage(s.id, firstText, opts) : null;
  return { s, sent };
}

// 解析 (user,channel) 的当前会话，无绑定则新建并绑定（不发消息）——
// 微信图片入口需要先拿到会话才能落任务目录文件，随后再走 handleSend 拼告知行。
function ensureSession(db, user, channel) {
  return boundSession(db, user, channel) || newSessionFor(db, user, channel, '').s;
}

// ---------- 会话列表与编号（/list /switch /delete） ----------
// 编号 = 本列表行号，最近更新在前（排序与用户隔离同 Web 会话列表 GET /api/sessions 一致）。
// 列表是动态的：switch/delete 回执复述目标标题，中间恰好有人新建/删除时用户能发现编号指错了对象。
// 命令回执占 1 条微信回复额度：截 10 行，更早的会话留给网页端管理。
const LIST_LIMIT = 10;

function listedSessions(db, user) {
  const me = String(user || '').trim();
  const where = me ? ' WHERE user = ?' : '';
  const args = me ? [me] : [];
  const rows = db.prepare(
    'SELECT id, title, model_id, status, updated_at FROM sessions' + where
    + ' ORDER BY updated_at DESC, id DESC LIMIT ?'
  ).all(...args, LIST_LIMIT);
  const total = db.prepare('SELECT COUNT(*) AS n FROM sessions' + where).get(...args).n;
  return { rows: rows, total: total };
}

// 参数解析：纯数字 = /list 编号；否则按会话 id 前缀在列表内匹配（task-20260928-3 比记编号省事）。
function pickSession(rows, arg) {
  if (/^\d+$/.test(arg)) {
    const n = parseInt(arg, 10);
    return n >= 1 && n <= rows.length ? rows[n - 1] : null;
  }
  const hit = rows.filter(r => String(r.id).startsWith(arg));
  return hit.length === 1 ? hit[0] : null;
}

// /switch 目标解析：编号（/list 行号）、id 前缀，或完整 id 直查——完整 id 不受列表 10 行窗口限制。
function findSession(db, user, arg) {
  if (/^task-[0-9A-Za-z_\-]+$/.test(arg)) {
    return db.prepare('SELECT id, title, status, updated_at FROM sessions WHERE id = ? AND user = ?')
      .get(arg, String(user || '').trim()) || null;
  }
  return pickSession(listedSessions(db, user).rows, arg);
}

function shortTitle(r) {
  const t = String(r.title || '').trim() || '未命名';
  return t.length > 24 ? t.slice(0, 24) + '…' : t;
}

function listReply(db, user, curId) {
  const res = listedSessions(db, user);
  const rows = res.rows;
  if (!rows.length) return '**会话列表**\n暂无会话';
  const lines = rows.map((r, i) => (i + 1) + '. `' + r.id + '`: ' + shortTitle(r) + (r.id === curId ? ' [当前]' : ''));
  lines.push(res.total > rows.length
    ? '---\n*共 ' + res.total + ' 个会话，只列最近 ' + rows.length + ' 个*'
    : '');
  return ['**会话列表**'].concat(lines).join('\n');
}

// ---------- 模型清单（/models） ----------
// cfg.models 按 key 展开（同平台多 key 每个模型重复多份），按 id 去重保配置序；
// enable:false 不列（bind 会被 engine 拒，列出来只会诱导白点）。上限 15 行，同样为回执占额度。
const MODELS_LIMIT = 15;

function modelChoices() {
  const seen = new Set();
  const out = [];
  for (const m of (engine.getConfig() || {}).models || []) {
    if (m.enable === false || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function modelsReply(ms, curModelId) {
  if (!ms.length) return '**模型清单**\n配置里没有启用的模型（网页端设置页添加后重启）';
  const shown = ms.slice(0, MODELS_LIMIT);
  const lines = shown.map((m, i) => '' + (i + 1) + '. `' + m.id + '`'
    + (m.id === curModelId ? ' [当前]' : ''));
  if (ms.length > shown.length) lines.push('共 ' + ms.length + ' 个，只列前 ' + MODELS_LIMIT + ' 个');
  return ['**模型清单**'].concat(lines).join('\n');
}

// ---------- 命令解析 ----------
// 严格匹配：整条消息恰好是命令词（ARG_CMDS 内的可带参数）才算命令。
// 首词形如 /纯ASCII词 但不在清单 → 回「未知命令」提示、不转发模型（防弱模型就着 /hlep 演一段）；
// 其余一律普通消息：/home/x、/a.b 这类路径代码，以及 /clear abc 这种裸命令带尾巴的（用户约定：强检查不匹配）。
const CMDS = new Set(['new', 'stop', 'compact', 'clear', 'status', 'help', 'list', 'switch', 'rename', 'delete', 'models', 'think']);
// 可带参数的命令：/new 尾随文本作首条消息；/switch /delete 吃 /list 编号或会话 id；
// /rename 吃新标题；/models 可带模型编号或完整 id；/think 吃 on|off（1|0 同样认，隐式不写 help）。
// 清单外的命令带尾巴仍按普通消息回落。
const ARG_CMDS = new Set(['new', 'switch', 'rename', 'delete', 'models', 'think']);

function parseCommand(text) {
  const t = String(text || '').trim();
  if (t[0] !== '/') return null;
  const sp = t.search(/\s/);
  const head = (sp < 0 ? t.slice(1) : t.slice(1, sp)).toLowerCase();
  const rest = sp < 0 ? '' : t.slice(sp + 1).trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(head)) return { normal: true };
  if (!CMDS.has(head)) return { unknown: head };
  if (rest && !ARG_CMDS.has(head)) return { normal: true };
  return { cmd: head, rest };
}

// 命令输出统一用 markdown（channel 层的规范格式）：支持渲染的接入端直接用，
// 微信端渲染适配在 wxbot 出口：默认透传 markdown（微信已支持渲染），env WXBOT_STRIP_MARKDOWN=1 才 stripMarkdown 纯文化——格式信息留在生产方，渲染适配在消费方。
const HELP_TEXT = [
  '**可用命令**',
  '---',
  '**会话**',
  '- `/list` 会话列表',
  '- `/new [msg]` 新建会话并切换',
  '- `/switch <编号>` 切换当前会话',
  '- `/delete <编号>` 删除指定会话',
  '- `/rename <标题>` 重命名当前会话',
  '',
  '**模型**',
  '- `/models [编号]` 切换指定模型',
  '- `/think on|off` 深度思考开关',
  '',
  '**上下文**',
  '- `/stop` 终止当前回合',
  '- `/clear` 清空当前会话',
  '- `/compact` 压缩上下文',
  '',
  '**信息**',
  '- `/status` 查看当前状态',
  '- `/help` 显示本帮助',
].join('\n');

const STATUS_TEXT = { active: '活跃中', held: '保持中', completed: '已完成', cancelled: '已终止' };

function fmtTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function statusReply(db, s, channel) {
  const run = engine.getRun(s.id);
  const looping = !!(run && run.looping);
  const lines = [
    '**会话状态**',
    '- 会话：`' + (s.title || s.id) + '`',
    '- 状态：' + (looping ? '回合进行中' : (STATUS_TEXT[s.status] || s.status)),
    '- 模型：`' + (s.model_id || '未绑定') + '`',
  ];
  // 思考开关只对微信通道有意义（web 端用按钮，不读这列）
  if (String(channel || '').startsWith('wx:')) {
    const bt = db.prepare('SELECT deep_think FROM wechat_bindings WHERE id = ?').get(String(channel).slice(3));
    if (bt) lines.push('- 深度思考：' + (bt.deep_think ? '开' : '关'));
  }
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

  // 普通消息：解析当前会话，无绑定自动新建（IM 用户不会先打 /new 才能聊天）。
  // 微信通道以 binding 行的全局 deep_think 开关作消息的 deepThink 取值（与 H5 按钮 body 同义，
  // 只是没得点、改用 /think 拨）；非 wx 通道照旧不传 opts，行为零变化。
  if (!parsed || parsed.normal) {
    const wx = String(channel).startsWith('wx:');
    const deepThink = wx ? !!((db.prepare('SELECT deep_think FROM wechat_bindings WHERE id = ?').get(channel.slice(3)) || {}).deep_think) : undefined;
    let s = boundSession(db, user, channel);
    let sent;
    if (!s) {
      const r = newSessionFor(db, user, channel, text, wx ? { deepThink } : undefined);
      s = r.s; sent = r.sent;
    } else {
      sent = engine.postUserMessage(s.id, text, wx ? { deepThink } : undefined);
    }
    log.info('msg', tag + ' channel 消息 → ' + s.id);
    return { kind: 'message', reply: '已发送到会话 ' + s.id, session_id: s.id, message_id: sent.message_id };
  }

  if (parsed.unknown) {
    const u = boundSession(db, user, channel);
    return { kind: 'command', reply: '/' + parsed.unknown + ' 不是有效命令，发送 /help 查看清单', session_id: u ? u.id : null };
  }

  const cmd = parsed.cmd;
  // 当前绑定会话：list/switch/delete 不依赖它（列表操作面向全部会话，switch 本身就是换绑），
  // 其余命令作用于它；help/new 只用它回 session_id。
  const s = boundSession(db, user, channel);

  if (cmd === 'help') {
    return { kind: 'command', reply: HELP_TEXT, session_id: s ? s.id : null };
  }

  if (cmd === 'new') {
    const r = newSessionFor(db, user, channel, parsed.rest);
    log.info('task', tag + ' channel /new → ' + r.s.id + (parsed.rest ? '（含首条消息）' : ''));
    return {
      kind: 'command',
      reply: '已新建会话 ' + r.s.id + (parsed.rest ? '，首条消息已发出' : ''),
      session_id: r.s.id,
      message_id: r.sent ? r.sent.message_id : undefined,
    };
  }

  if (cmd === 'list') {
    return { kind: 'command', reply: listReply(db, user, s ? s.id : null), session_id: s ? s.id : null };
  }

  if (cmd === 'switch') {
    if (!parsed.rest) {
      return { kind: 'command', reply: '用法：/switch <编号或会话id>（编号来自 /list）', session_id: s ? s.id : null };
    }
    const t = findSession(db, user, parsed.rest);
    if (!t) {
      return {
        kind: 'command',
        reply: /^task-/.test(parsed.rest)
          ? '没找到会话 ' + parsed.rest + '（不存在或不属于你）'
          : '没找到 ' + parsed.rest + '（编号来自 /list，也可直接发会话 id）',
        session_id: s ? s.id : null,
      };
    }
    if (s && s.id === t.id) {
      return { kind: 'command', reply: '当前已是 ' + t.id, session_id: t.id };
    }
    setBinding(db, user, channel, t.id);
    log.info('task', tag + ' channel /switch → ' + t.id);
    return { kind: 'command', reply: '已切到 ' + t.id + ', ' + shortTitle(t), session_id: t.id };
  }

  if (cmd === 'delete') {
    if (!parsed.rest) {
      return { kind: 'command', reply: '用法：/list 查看编号，再 /delete <编号>', session_id: s ? s.id : null };
    }
    const t = pickSession(listedSessions(db, user).rows, parsed.rest);
    if (!t) {
      return { kind: 'command', reply: '没找到 ' + parsed.rest + ' 对应的会话（编号以最新的 /list 为准）', session_id: s ? s.id : null };
    }
    engine.deleteSession(t.id, true); // 同 Web 默认（删除弹窗「同时删除任务文件夹」预勾选）：IM 没有二次确认 UI，对齐默认语义
    const wasCur = s && s.id === t.id;
    if (wasCur) db.prepare('DELETE FROM channel_sessions WHERE user = ? AND channel = ?').run(user, channel);
    log.info('task', tag + ' channel /delete ' + t.id + '（含任务目录）' + (wasCur ? '（当前会话，已解绑）' : ''));
    return { kind: 'command', reply: '已删除会话「' + shortTitle(t) + '」（连同任务目录，不可恢复）' + (wasCur ? '，下次发消息自动新建会话' : ''), session_id: wasCur ? null : (s ? s.id : null) };
  }

  // 裸 /models 只是看清单，不要求已有会话；带编号的在下面换绑分支里（需当前会话）
  if (cmd === 'models' && !parsed.rest) {
    return { kind: 'command', reply: modelsReply(modelChoices(), s ? s.model_id : ''), session_id: s ? s.id : null };
  }

  // /think：微信全局深度思考开关——存用户 binding 行（不随会话/switch 丢），投递时替进
  // 既有 deepThink 参数（开=沿用现链路合并模型 thinking_params，关=什么都不带，
  // 与 H5 按钮勾选/取消完全同构）。裸 /think 报当前态；1|0 隐式同义（不写 help）。
  if (cmd === 'think') {
    const v = /^(on|1)$/i.test(parsed.rest) ? 1 : /^(off|0)$/i.test(parsed.rest) ? 0 : null;
    if (parsed.rest && v === null) {
      return { kind: 'command', reply: '用法：/think on|off', session_id: s ? s.id : null };
    }
    const b = db.prepare('SELECT id, deep_think FROM wechat_bindings WHERE user = ?').get(user);
    if (!b) {
      return { kind: 'command', reply: '未绑定微信，此开关不适用', session_id: s ? s.id : null };
    }
    if (v === null) {
      return { kind: 'command', reply: '微信深度思考当前：' + (b.deep_think ? '开' : '关') + '（/think on|off 切换）', session_id: s ? s.id : null };
    }
    if (v !== b.deep_think) db.prepare('UPDATE wechat_bindings SET deep_think = ? WHERE id = ?').run(v, b.id);
    log.info('task', tag + ' channel /think → ' + (v ? 'on' : 'off') + '（用户全局，binding ' + b.id + '）');
    return { kind: 'command', reply: '微信深度思考已' + (v ? '开启（后续消息带思考参数）' : '关闭（后续消息不带）'), session_id: s ? s.id : null };
  }

  // 其余命令都作用于当前会话；无绑定时不隐式新建（那不是用户点这条命令的意图）
  if (!s) {
    return { kind: 'command', reply: '当前没有会话，请直接发送消息', session_id: null };
  }

  if (cmd === 'rename') {
    if (!parsed.rest) {
      return { kind: 'command', reply: '用法：/rename <标题>', session_id: s.id };
    }
    const r = engine.renameSession(s.id, parsed.rest); // 空/超长/不存在校验与 Web 同源，400/404 冒给调用方
    log.info('task', tag + ' channel /rename ' + s.id + ' → 「' + r.title + '」');
    return { kind: 'command', reply: '已改名为「' + r.title + '」', session_id: s.id };
  }

  if (cmd === 'models') {
    const ms = modelChoices();
    // 编号或完整 id（如 deepseek/deepseek-flash）都认
    const m = /^\d+$/.test(parsed.rest) ? ms[parseInt(parsed.rest, 10) - 1] : ms.find(x => x.id === parsed.rest);
    if (!m) {
      return { kind: 'command', reply: '没有 ' + parsed.rest + ' 对应的模型（/models 查看清单）', session_id: s.id };
    }
    engine.bindToSession(s.id, m.id); // 与 Web 换绑弹窗同源：回合进行中/平台无 key 的 409 冒给调用方
    log.info('model', tag + ' channel /models ' + s.id + ' → ' + m.id);
    return { kind: 'command', reply: '会话「' + shortTitle(s) + '」模型已切到 `' + m.id + '`', session_id: s.id };
  }

  if (cmd === 'stop') {
    // 与 Web 按钮语义对齐：只有回合真在跑才停，idle 不误伤（stop 会把 held 刷成 cancelled）
    const run = engine.getRun(s.id);
    if (!(run && run.looping)) {
      return { kind: 'command', reply: '当前没有进行中的回合，无需终止', session_id: s.id };
    }
    engine.stop(s.id);
    log.info('msg', tag + ' channel /stop ' + s.id);
    return { kind: 'command', reply: '已发送终止指令，回合收尾中', session_id: s.id };
  }

  if (cmd === 'compact') {
    engine.summarizeContext(s.id); // 回合进行中 engine 抛 409（请先终止），冒给调用方
    log.info('msg', tag + ' channel /compact ' + s.id);
    return { kind: 'command', reply: '已发起上下文压缩，摘要稍后回复', session_id: s.id };
  }

  if (cmd === 'clear') {
    engine.clearSessionMessages(s.id); // 同上，回合进行中 409
    log.info('msg', tag + ' channel /clear ' + s.id);
    return { kind: 'command', reply: '已清空当前会话，现在从零开始', session_id: s.id };
  }

  // cmd === 'status'
  return { kind: 'command', reply: statusReply(db, s, channel), session_id: s.id };
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
