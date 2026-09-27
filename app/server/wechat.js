// 微信接入桥接（core 侧大脑）。信任与分工模型（设计讨论见 docs/ARCHITECTURE.md §5.13）：
//   - wxbot（独立容器，只挂 agent-mcp-net）= 纯微信「调制解调器」：iLink SDK 多实例、收信转发、外发投递；
//     对 core 的一切认知只有共享服务 token，不持有任何用户凭据。
//   - core = 身份与调度的唯一权威：wechat_bindings 表维护 (core 用户 ↔ binding ↔ 微信 bot 账号)；
//     微信会话复用 routes/channel.js 同一套命令层（channel = 'wx:'+binding_id），引擎不感知微信。
//   - 扫码登录的呈现挪进 core 的 Web 设置页（QR 经本模块代理 wxbot 的 SVG）；
//     iLink 协议保证扫码后仅本人可与 bot 单线对话，故无联系人授权面。
// 方向：
//   Web   → routes/wechat.js → 本模块 → wxbot /api/instances*（实例控制 / QR 代理）
//   wxbot → core  /wxhook/{inbox,hook}（Bearer 服务 token，挂在 auth.middleware 之前）
//   core  → wxbot /api/deliver（assistant 最终回复推送；总线内部监听驱动，游标落库不重发）
// 降级承诺：wxbot.url 未配置 = 功能整体静默关闭；配置了但 wxbot 没起 = 启动只留一行日志，
// 面板显示「未连接」、操作时报可读错误，绝不抛出未捕获异常影响 Web 主流程。
const crypto = require('crypto');
const engine = require('./engine');
const log = require('./log');
const channel = require('./routes/channel'); // 只用 handleSend（模块加载无副作用；engine 不 require 本模块，无环）

let cfg, db, bus;
let busAttached = false;

function init(cfg_, db_, bus_) {
  cfg = cfg_; db = db_; bus = bus_;
  attachBus();
}

const now = () => Date.now();
const msg = e => String((e && e.message) || e || 'unknown');

// ---------- 开关与 wxbot 客户端 ----------
function enabled() { return !!(cfg && cfg.wxbot && cfg.wxbot.url); }

function wxUrl() { return (cfg.wxbot && cfg.wxbot.url) || ''; }
function wxToken() { return (cfg.wxbot && cfg.wxbot.token) || ''; }

async function wxbotApi(method, path, body, timeoutMs) {
  if (!enabled()) throw Object.assign(new Error('微信接入未配置：wxbot.url 为空'), { status_code: 409 });
  const res = await fetch(wxUrl() + path, {
    method,
    headers: Object.assign(
      { Authorization: 'Bearer ' + wxToken() },
      body ? { 'Content-Type': 'application/json' } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || 8000),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = (JSON.parse(text) || {}).error || text; } catch (_) {}
    throw Object.assign(new Error('wxbot ' + res.status + ': ' + String(detail).slice(0, 200)), { status_code: 502 });
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text; }
}

// 存活探测（GET /wxbot 面板用）：带 5s 缓存，wxbot 挂掉只表现为 false，绝不外抛。
let aliveCache = { at: 0, ok: false };
async function wxbotAlive() {
  if (!enabled()) return false;
  if (now() - aliveCache.at < 5000) return aliveCache.ok;
  let ok = false;
  try {
    const r = await fetch(wxUrl() + '/health', { signal: AbortSignal.timeout(2500) });
    ok = r.ok;
  } catch (_) { /* 不在线 */ }
  aliveCache = { at: now(), ok };
  return ok;
}

// ---------- 绑定表 ----------
const BIND_COLS = 'id, user, status, note, bot_account_id, wx_to_user, last_msg_id, created_at, updated_at';

function getBinding(id) {
  return db.prepare('SELECT * FROM wechat_bindings WHERE id = ?').get(id);
}

function touchBinding(id, fields) {
  const sets = ['updated_at = ?'];
  const vals = [now()];
  for (const [k, v] of Object.entries(fields || {})) { sets.push(k + ' = ?'); vals.push(v); }
  vals.push(id);
  db.prepare('UPDATE wechat_bindings SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
}

// 一人一绑（自用形态；换微信号走「解绑→重绑」）；id 兼作 channel 后缀与 wxbot 存储目录名 → 只允许安全字符。
async function createBinding(user) {
  if (!enabled()) throw Object.assign(new Error('微信接入未配置（wxbot.url 为空），请联系管理员在 config.yml / 环境变量 WXBOT_URL 启用后重启'), { status_code: 409 });
  const dup = db.prepare('SELECT id FROM wechat_bindings WHERE user = ?').get(user);
  if (dup) throw Object.assign(new Error('你已绑定微信（' + dup.id + '），请先解绑'), { status_code: 409 });
  const id = 'wx' + crypto.randomBytes(5).toString('hex');
  db.prepare(
    "INSERT INTO wechat_bindings (id, user, status, last_msg_id, created_at, updated_at) VALUES (?,?,'pending',0,?,?)"
  ).run(id, user, now(), now());
  try {
    await wxbotApi('POST', '/api/instances', { id });
  } catch (e) {
    touchBinding(id, { status: 'error', note: msg(e) });
    log.warn('wechat', id + ' 创建绑定成功但 wxbot 实例启动失败：' + msg(e));
  }
  log.info('wechat', (user || '-') + ' 新建微信绑定 ' + id);
  return getBinding(id);
}

// 重发登录（二维码过期/失败后用）：清状态 → wxbot 重起登录流程。
async function refreshBinding(id) {
  const b = mustBinding(id);
  await wxbotApi('POST', '/api/instances/' + encodeURIComponent(b.id) + '/refresh');
  touchBinding(b.id, { status: 'pending', note: null });
  return getBinding(b.id);
}

// 解绑：wxbot 停实例并删凭证（尽力而为，网络断了本地也必须删干净）。
async function deleteBinding(id) {
  const b = mustBinding(id);
  try { await wxbotApi('DELETE', '/api/instances/' + encodeURIComponent(b.id)); }
  catch (e) { log.warn('wechat', b.id + ' 通知 wxbot 销毁实例失败（本地继续解绑）：' + msg(e)); }
  db.prepare('DELETE FROM wechat_bindings WHERE id = ?').run(b.id);
  db.prepare("DELETE FROM channel_sessions WHERE channel = ?").run('wx:' + b.id);
  log.info('wechat', (b.user || '-') + ' 解绑微信 ' + b.id);
  return { ok: true };
}

function mustBinding(id) {
  const b = getBinding(id);
  if (!b) throw Object.assign(new Error('绑定不存在'), { status_code: 404 });
  return b;
}

function listBindings(user) {
  return db.prepare('SELECT ' + BIND_COLS + ' FROM wechat_bindings WHERE user = ? ORDER BY created_at DESC').all(user);
}

// QR 代理：wxbot 的 SVG 原样透传给 core 前端 <img>（cookie 鉴权在路由层，wxbot token 只在内网）。
// wxbot 404（无待扫二维码）翻译成 {none:true}，前端按状态渲染，避免 img 报错红叉。
async function qrSvg(b) {
  if (!enabled()) return { none: true };
  try {
    const res = await fetch(wxUrl() + '/api/instances/' + encodeURIComponent(b.id) + '/qr.svg', {
      headers: { Authorization: 'Bearer ' + wxToken() },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { none: true };
    return { svg: await res.text() };
  } catch (_) { return { none: true }; }
}

// 启动恢复：把表里的 binding 逐个 POST 到 wxbot（幂等，wxbot 端 Map 去重）。
// wxbot 不在线只留一行 info（它起来后用户点一次「刷新」或重新绑定即可自愈，不追着重试）。
async function restore() {
  if (!enabled()) return;
  const rows = db.prepare('SELECT id FROM wechat_bindings').all();
  if (!rows.length) return;
  let ok = 0, fail = 0;
  for (const r of rows) {
    try { await wxbotApi('POST', '/api/instances', { id: r.id }, 4000); ok++; }
    catch (_) { fail++; }
  }
  if (fail) log.info('wechat', '启动恢复：' + ok + '/' + rows.length + ' 个实例已确保存在，' + fail + ' 个失败（wxbot 未启动？可在设置页刷新重试）');
  else log.info('wechat', '启动恢复：' + ok + ' 个微信实例已确保存在');
}

// ---------- wxbot → core 回调（/wxhook，Bearer 服务 token，auth.middleware 之前挂载） ----------
function handleHook(body) {
  const b = getBinding(String((body || {}).id || ''));
  if (!b) return false;
  const event = String(body.event || '');
  if (event === 'online') touchBinding(b.id, { status: 'online', bot_account_id: body.accountId || b.bot_account_id, note: null });
  else if (event === 'expired') touchBinding(b.id, { status: 'expired', note: String(body.note || '二维码已过期').slice(0, 200) });
  else if (event === 'error') touchBinding(b.id, { status: 'error', note: String(body.note || '实例异常').slice(0, 200) });
  else if (event === 'offline') touchBinding(b.id, { status: 'error', note: '实例已离线' });
  else return false;
  log.info('wechat', b.id + ' 状态 → ' + event);
  return true;
}

// 微信来消息 → channel 层同一入口。返回 handleSend 结果；抛错冒给 hook 路由映射成非 2xx，
// wxbot 会把 error 文案直接回给用户（IM 里「出错要出声」）。
function handleInbox(body) {
  const b = getBinding(String((body || {}).id || ''));
  if (!b) throw Object.assign(new Error('绑定不存在（可能已解绑）'), { status_code: 404 });
  const from = String((body || {}).from || '').trim().slice(0, 128);
  if (from && from !== b.wx_to_user) touchBinding(b.id, { wx_to_user: from });
  // 能收到消息就说明实例活着；漏收 online 回调（core 重启窗口）时顺带纠偏
  if (b.status !== 'online') touchBinding(b.id, { status: 'online', note: null });
  return channel.handleSend(db, {
    user: b.user,
    channel: 'wx:' + b.id,
    text: (body || {}).text,
    tag: (b.user || '-') + ' [微信 ' + b.id + ']',
  });
}

// ---------- 投递：进程内总线监听 → 分段 push wxbot /api/deliver ----------
// 只推最终 assistant 文本（type=errAck / 纯工具轮空文本 / 存档类事件都不进微信）；
// 游标 last_msg_id 落库：core 重启不补发历史，wxbot 短暂不可达时不丢（下一条事件连带补齐）。
function attachBus() {
  if (busAttached || !bus) return;
  busAttached = true;
  bus.onInternal((sessionId, event, data) => {
    if (event !== 'assistant_message' || !data) return;
    try {
      const cs = db.prepare('SELECT user, channel FROM channel_sessions WHERE session_id = ?').get(sessionId);
      if (!cs || !String(cs.channel || '').startsWith('wx:')) return;
      enqueueDelivery(cs.channel.slice(3), () => deliverNow(cs.channel.slice(3), data));
    } catch (e) {
      log.warn('wechat', '投递监听异常：' + msg(e));
    }
  });
}

// 每绑定一条串行链：assistant 事件按序到达也按序投递，且防并发推进游标互相覆盖。
const deliveryQ = new Map();
function enqueueDelivery(key, fn) {
  const prev = deliveryQ.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).catch(() => {});
  deliveryQ.set(key, next);
  next.then(() => { if (deliveryQ.get(key) === next) deliveryQ.delete(key); });
}

async function deliverNow(bid, m) {
  const b = getBinding(bid);
  if (!b || b.status !== 'online' || !b.wx_to_user) return;
  if (m.type === 'errAck') return;
  let content = String(m.content || '').trim();
  if (!content) return; // 纯工具调用轮（无文本）不打扰微信
  if (content.startsWith('{"__blocks__"')) content = '【富文本消息，请到网页端查看】';
  const id = Number(m.id) || 0;
  if (id && id <= (b.last_msg_id || 0)) return;
  const segs = splitText(content);
  for (const s of segs) {
    try { await wxbotApi('POST', '/api/deliver', { id: b.id, to: b.wx_to_user, text: s }, 15000); }
    catch (e) {
      log.warn('wechat', b.id + ' 投递失败，游标未推进（下次回复连带补齐）：' + msg(e));
      return;
    }
  }
  if (id > (b.last_msg_id || 0)) touchBinding(b.id, { last_msg_id: id });
  log.info('wechat', b.id + ' 已投递消息 ' + id + '（' + segs.length + ' 段）→ 微信');
}

// 微信单条上限按 ~1800 字保守分段：先按行聚合，超长行硬切。
function splitText(text, max = 1800) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (line.length > max) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
      continue;
    }
    if (cur && (cur.length + 1 + line.length) > max) { out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = {
  init,
  restore,
  enabled,
  wxbotAlive,
  getBinding,
  listBindings,
  createBinding,
  refreshBinding,
  deleteBinding,
  qrSvg,
  handleHook,
  handleInbox,
};
