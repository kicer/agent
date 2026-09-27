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

// 实例快照探测（GET /api/wechat 面板数据 + 探活二合一）：2s 缓存，一次拿齐「活没活 +
// 每个绑定的实例状态/有无二维码」；wxbot 挂掉只表现为 alive:false，绝不外抛。
let instCache = { at: 0, alive: false, map: new Map() }; // map: id -> {state, accountId, hasQr}
async function wxbotInstances(timeoutMs) {
  if (!enabled()) return instCache;
  if (now() - instCache.at < 2000) return instCache;
  const map = new Map();
  let alive = false;
  try {
    const res = await fetch(wxUrl() + '/api/instances', {
      headers: { Authorization: 'Bearer ' + wxToken() },
      signal: AbortSignal.timeout(timeoutMs || 2500),
    });
    if (res.ok) { for (const r of (await res.json()) || []) map.set(String(r.id), r); alive = true; }
  } catch (_) { /* 不在线 */ }
  instCache = { at: now(), alive, map };
  return instCache;
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
  // fire-and-forget 建实例：点击秒回——不拿 wxbot 的网络往返卡住按钮（实测 SDK 取码瞬时超时过，
  // 同步 await 会毁掉整个绑定 UX）。成功由 QR 出现体现；失败落 note，轮询可见、刷新按钮可恢复。
  wxbotApi('POST', '/api/instances', { id }, 15000).catch(e => {
    touchBinding(id, { status: 'error', note: '实例启动失败：' + msg(e) });
    log.warn('wechat', id + ' wxbot 实例启动失败：' + msg(e));
  });
  log.info('wechat', (user || '-') + ' 新建微信绑定 ' + id);
  return getBinding(id);
}

// 重发登录（二维码过期/失败后用）：本地先置 pending（界面立刻变「正在获取二维码」），
// wxbot 后台 destroy+recreate（路由幂等，实例不存在时等效新建）；失败落 note 由轮询呈现。
async function refreshBinding(id) {
  const b = mustBinding(id);
  wxbotApi('POST', '/api/instances/' + encodeURIComponent(b.id) + '/refresh', null, 15000).catch(e => {
    touchBinding(b.id, { status: 'error', note: 'wxbot 刷新失败：' + msg(e) });
    log.warn('wechat', b.id + ' 刷新失败：' + msg(e));
  });
  touchBinding(b.id, { status: 'pending', note: null });
  return getBinding(b.id);
}

// 解绑：本地行秒删（channel 绑定一并清）；通知 wxbot 销毁 fire-and-forget，
// 通知丢了有两层兑底：inbox 404 → wxbot 自毁孤儿实例；core 启动 restore 双向对账清理。
async function deleteBinding(id) {
  const b = mustBinding(id);
  wxbotApi('DELETE', '/api/instances/' + encodeURIComponent(b.id), null, 10000)
    .catch(e => log.warn('wechat', b.id + ' 通知 wxbot 销毁失败（对账/自毁兑底）：' + msg(e)));
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

// 面板总览（GET /api/wechat 唯一实现）：{enabled, alive, bindings:[行+has_qr]}，
// 并向实例快照「静默自愈」——hook 只是尽力而为（core 重启窗口/wxbot 瞬时抖动都会丢事件），
// 每轮页面访问/轮询顺带纠偏：
//  - 实例 online 而行未 online → 纠正（不等 inbox 兑底）；
//  - 实例回退到 qr/scanned 而行还挂着 online（登录态掉了）→ 打回 pending 提示重扫；
//  - 实例 expired 而行 pending → 标过期（出刷新按钮）；
//  - 行该有实例而快照没有（wxbot 重启前 core 先起等）→ 后台补建（幂等）。
async function overview(user) {
  if (!enabled()) return { enabled: false, alive: false, bindings: [] };
  const snap = await wxbotInstances();
  const rows = listBindings(user);
  for (const b of rows) {
    const ins = snap.map.get(b.id);
    b.has_qr = !!(ins && ins.hasQr);
    if (!snap.alive) continue;
    if (!ins) {
      if (b.status === 'pending' || b.status === 'online') {
        wxbotApi('POST', '/api/instances', { id: b.id }, 15000)
          .catch(e => log.warn('wechat', b.id + ' 实例补建失败：' + msg(e)));
      }
    } else if (ins.state === 'online' && b.status !== 'online') {
      touchBinding(b.id, { status: 'online', bot_account_id: ins.accountId || b.bot_account_id, note: null });
      b.status = 'online';
      if (ins.accountId) b.bot_account_id = ins.accountId;
    } else if ((ins.state === 'qr' || ins.state === 'scanned') && b.status === 'online') {
      touchBinding(b.id, { status: 'pending', note: '登录态失效，需重新扫码' });
      b.status = 'pending';
    } else if (ins.state === 'expired' && b.status === 'pending') {
      touchBinding(b.id, { status: 'expired', note: '二维码已过期，点刷新重新获取' });
      b.status = 'expired';
    }
  }
  return { enabled: true, alive: snap.alive, bindings: rows };
}

// QR 代理：wxbot 的 SVG 原样透传给账户页内联渲染（cookie 鉴权在路由层，wxbot token 只在内网）。
// wxbot 404（无待扫二维码）翻译成 {none:true}；前端只在 has_qr 就绪后才拉这个接口，这里短超时即可。
async function qrSvg(b) {
  if (!enabled()) return { none: true };
  try {
    const res = await fetch(wxUrl() + '/api/instances/' + encodeURIComponent(b.id) + '/qr.svg', {
      headers: { Authorization: 'Bearer ' + wxToken() },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { none: true };
    return { svg: await res.text() };
  } catch (_) { return { none: true }; }
}

// 启动双向对账（fire-and-forget，不阻塞 listen）：core 有行而 wxbot 缺实例 → 补建；
// wxbot 有实例而 core 无行（解绑通知丢失的孤儿）→ 销毁。wxbot 不可达只留一行 info，
// 之后 overview() 每轮访问还会自愈补建，这里不求一次成功。
async function restore() {
  if (!enabled()) return;
  const rows = db.prepare('SELECT id FROM wechat_bindings').all();
  const snap = await wxbotInstances(5000);
  if (!snap.alive) {
    if (rows.length) log.info('wechat', '启动对账：wxbot 不可达，跳过（设置页访问时会自动补建实例）');
    return;
  }
  const want = new Set(rows.map(r => r.id));
  let built = 0;
  for (const r of rows) {
    if (snap.map.has(r.id)) continue;
    built++;
    wxbotApi('POST', '/api/instances', { id: r.id }, 15000).catch(e => log.warn('wechat', r.id + ' 补建失败：' + msg(e)));
  }
  let orphan = 0;
  for (const id of snap.map.keys()) {
    if (want.has(id)) continue;
    orphan++;
    log.info('wechat', '对账清理孤儿微信实例 ' + id);
    wxbotApi('DELETE', '/api/instances/' + encodeURIComponent(id), null, 10000).catch(() => {});
  }
  log.info('wechat', '启动对账：绑定 ' + rows.length + ' / 实例 ' + snap.map.size + '，补建 ' + built + '，清理孤儿 ' + orphan);
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
  overview,
  getBinding,
  listBindings,
  createBinding,
  refreshBinding,
  deleteBinding,
  qrSvg,
  handleHook,
  handleInbox,
};
