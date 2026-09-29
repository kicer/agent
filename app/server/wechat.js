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
//         + /api/deliver_media（正文里的 /p/ 链接→本地读字节→微信文件/图片卡片，尽力而为）
// 降级承诺：微信接入未配置（env WXBOT_URL 置空或未配 WXBOT_TOKEN）= 功能整体静默关闭；配了但 wxbot 没起 = 启动只留一行日志，
// 面板显示「未连接」、操作时报可读错误，绝不抛出未捕获异常影响 Web 主流程。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const log = require('./log');
const memory = require('./memory');
const publicFiles = require('./public-files');
const channel = require('./routes/channel'); // 只用 handleSend/ensureSession/newSessionFor/parseCommand（模块加载无副作用；engine 不 require 本模块，无环）

let cfg, db, bus;
let busAttached = false;

function init(cfg_, db_, bus_) {
  cfg = cfg_; db = db_; bus = bus_;
  attachBus();
}

const now = () => Date.now();
const msg = e => String((e && e.message) || e || 'unknown');

// ---------- 开关与 wxbot 客户端 ----------
function enabled() { return !!(cfg && cfg.wxbot && cfg.wxbot.url && cfg.wxbot.token); }

function wxUrl() { return (cfg.wxbot && cfg.wxbot.url) || ''; }
function wxToken() { return (cfg.wxbot && cfg.wxbot.token) || ''; }

async function wxbotApi(method, path, body, timeoutMs) {
  if (!enabled()) throw Object.assign(new Error('微信接入未配置：env WXBOT_URL / WXBOT_TOKEN 未就位'), { status_code: 409 });
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
  if (!enabled()) throw Object.assign(new Error('微信接入未配置（WXBOT_URL/WXBOT_TOKEN 未就位），请联系管理员运行 scripts/init.sh 后 docker compose up -d 重建'), { status_code: 409 });
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
// 媒体消息（inbox 带 media:{b64,kind,filename?}，wxbot 已从 CDN 下好）：统一落会话任务目录
// + 记 files 元数据表 → 按 web 上传同款拼「用户上传了文件：<名>」作正文走 handleSend。
// 渠道上下文（普通/媒体/带尾随文本的 /new 在消息入库前先幂等确保）：微信会话直接落 executing
// 跳过顾问 handoff（与定时任务投递同理由：异步接入不能被顾问话术卡住），channel_note 把微信
// 环境说明注入历史（UI 可见的 user 行，模型当普通消息看）——先于首条消息，AI 第一回合就看得到。
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const MEDIA_KINDS = new Set(['image', 'video', 'file']);

const CHANNEL_NOTE = [
  '本会话来自微信单聊，用户只能收发文本与文件，无可点击界面。',
  '- 交流风格：简短口语化，适配手机阅读；内容较长时整理成文件交付，不刷屏。',
  '- 交付文件：生成文件后，在回复时用mint_public_link给出可公开下载的链接，链接文字保留作兜底。',
  '- 接收文件：用户发来的文件会自动存入当前工作目录，可直接读取。',
].join('\n');

// 开场日记（M2）的角色提示：日记是「你」的记忆，不是用户的新输入——拟人化人格锚点。
// 另含关键定性（9-29 实测定调）：日记是当时记录不是现状，可变事实必须现查——
// 此前 AI 把旧碎片里「没有定时任务」当成现状误读。
const MEMORY_NOTE_HEAD = '以下日记是你（助理）过去几天的工作记忆，系统随新工作台自动带来。'
  + '注意：日记是当时的记录，不代表现状——任务、文件、待办都会变，说现状前先查工具。'
  + '用户提旧事时据此作答；不要提「日记」、不要逐条复述；没记的直接说不确定，不要编造。\n\n';

function ensureChannelContext(s) {
  if (!s) return;
  if (s.phase !== 'executing') {
    db.prepare("UPDATE sessions SET phase='executing', updated_at=? WHERE id=?").run(now(), s.id);
    s.phase = 'executing';
  }
  if (!db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND type = 'channel_note' LIMIT 1").get(s.id)) {
    engine.saveMessage(s.id, { role: 'user', type: 'channel_note', content: CHANNEL_NOTE });
    log.info('wechat', s.id + ' 渠道上下文注入（executing + channel_note）');
  }
  // 开场日记：近几天长期记忆一次性写入，会话中途不补——与画像快照同「新会话冻结」语义，
  // 轮换后新会话再带最新全文；无记忆/功能关闭时不写，省一条消息行也稳前缀缓存。
  if (!db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND type = 'memory_note' LIMIT 1").get(s.id)) {
    const journal = memory.journalFor(db, cfg, s.user);
    if (journal) {
      engine.saveMessage(s.id, { role: 'user', type: 'memory_note', content: MEMORY_NOTE_HEAD + journal });
      log.info('wechat', s.id + ' 开场日记注入（' + journal.length + ' 字）');
    }
  }
}

function handleInbox(body) {
  const b = getBinding(String((body || {}).id || ''));
  if (!b) throw Object.assign(new Error('绑定不存在（可能已解绑）'), { status_code: 404 });
  const from = String((body || {}).from || '').trim().slice(0, 128);
  if (from && from !== b.wx_to_user) touchBinding(b.id, { wx_to_user: from });
  // 能收到消息就说明实例活着；漏收 online 回调（core 重启窗口）时顺带纠偏
  if (b.status !== 'online') touchBinding(b.id, { status: 'online', note: null });
  // 新入站 = iLink 发了新 context token，本轮回复额度刷新：重置回合预算。
  // 防御性结算：正常收信时 done 已把挂起投完，这里只兜住 done 丢失（如监听异常）的残留结论。
  const old = turnState.get(b.id);
  if (old && old.held) {
    const h = old.held;
    old.held = null;
    enqueueDelivery(b.id, () => deliverConclusion(b.id, h.m, h.sessionId));
  }
  resetTurn(b.id);
  let text = String((body || {}).text || '').trim();
  const m = (body || {}).media;
  const hasMedia = !!(m && String(m.b64 || '').trim());
  // 媒体先验完再建会话：坏数据不该白造一个会话出来
  let buf = null, kind = '';
  if (hasMedia) {
    kind = MEDIA_KINDS.has(String(m.kind || '')) ? String(m.kind) : 'file';
    try { buf = Buffer.from(String(m.b64).trim().slice(0, Math.ceil(MEDIA_MAX_BYTES / 3) * 4 + 1024), 'base64'); } catch (_) { buf = null; }
    if (!buf || !buf.length) throw Object.assign(new Error('媒体数据无法解析'), { status_code: 400 });
    if (buf.length > MEDIA_MAX_BYTES) throw Object.assign(new Error('附件过大（限 20MB）'), { status_code: 400 });
  }
  const parsed = text ? channel.parseCommand(text) : null;
  // 需要「先确保会话+渠道上下文」的三类：媒体 / 普通消息 / 带尾随文本的 /new（先建会话换绑，
  // 尾随文本随后当普通消息发出）；裸命令（/help /status /裸 /new 等）不隐式建会话。
  const newWithText = !!(parsed && parsed.cmd === 'new' && parsed.rest);
  const plainMsg = hasMedia || !!(text && (!parsed || parsed.normal));
  let s = null;
  if (newWithText) s = channel.newSessionFor(db, b.user, 'wx:' + b.id, '').s;
  else if (plainMsg) s = channel.ensureSession(db, b.user, 'wx:' + b.id);
  if (s) ensureChannelContext(s);
  if (hasMedia) {
    const name = saveTaskMedia(s, buf, kind, String(m.filename || ''));
    log.info('file', (b.user || '-') + ' [微信 ' + b.id + '] ' + kind + ' 落任务目录 ' + s.id + '/' + name + '（' + buf.length + ' 字节）');
    if (text) {
      text = '用户上传了文件：' + name + '\n\n' + text; // 带说明文字：告知行+正文并进一条消息触发回合
    } else {
      // 单发媒体只落盘+留痕，不唤醒 AI（scheduler_note 同构：下一次真实对话时模型自然看到这条
      // user 行，「刚才那张图」的指代仍成立；表情包连发不会每条换来一句「收到」）
      const mid = engine.saveMessage(s.id, { role: 'user', type: 'wx_media', content: '用户上传了文件：' + name });
      return { kind: 'message', reply: '', session_id: s.id, message_id: mid };
    }
  } else if (newWithText) {
    text = parsed.rest;
  }
  const out = channel.handleSend(db, {
    user: b.user,
    channel: 'wx:' + b.id,
    text,
    tag: (b.user || '-') + ' [微信 ' + b.id + ']',
  });
  // 命令回执（/help /status /stop 等）由 wxbot 收到 inbox 响应后同步原样发出，占 1 条回复额度；
  // 普通消息的 reply 字段不发（最终回复走总线投递），不计。
  if (out && out.kind === 'command' && out.reply) getTurn(b.id).sent++;
  return out;
}

// magic bytes 定真实格式（不信声明扩展名）：图片四类 + 常见视频两类；认不出的交给命名处兕底。
function sniffMediaExt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (buf.length > 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'mp4'; // 裸 MPEG 容器/其他
  return '';
}

// 文件名消毒：只留路径末段，剔除控制字符与路径/shell 危符（保留中文），限长；全脏则退回 fallback。
function sanitizeMediaName(raw, fallback) {
  let n = String(raw || '').split(/[\\/]/).pop().trim();
  n = n.replace(/[\u0000-\u001f"'`$\\:*?<>|\u200b\u200e\u200f]+/g, '-').replace(/\s+/g, ' ').replace(/^-+/, '').replace(/\.+$/, '');
  if (n.startsWith('.')) n = n.slice(1); // 防隐藏文件（点前缀在文件列表被隐）
  if (n.length > 48) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 6 ? n.slice(dot) : '';
    n = n.slice(0, 48 - ext.length) + ext;
  }
  return n || (fallback || 'file');
}

// 落盘：图片/视频生成时间戳名（扩展名以嗅探为准），文件保留消毒后的原名；撞名加 -N；记 files 元数据行。
function saveTaskMedia(s, buf, kind, rawName) {
  const dir = engine.taskDirOf(s.id);
  const sniff = sniffMediaExt(buf);
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  let name;
  if (kind === 'image' || kind === 'video') {
    const prefix = kind === 'image' ? 'wximg' : 'wxvid';
    let ext = sniff;
    if (!ext) { // 嗅探失败才退回声明名里的扩展名（≤5 位字母数字），再不行 bin
      const dot = String(rawName || '').lastIndexOf('.');
      const tail = dot >= 0 ? String(rawName).slice(dot + 1).toLowerCase() : '';
      ext = /^[a-z0-9]{1,5}$/.test(tail) ? tail : 'bin';
    }
    name = prefix + '-' + ts + '.' + ext;
  } else {
    const safe = sanitizeMediaName(rawName, 'wxfile-' + ts);
    const dot = safe.lastIndexOf('.');
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : (sniff ? '.' + sniff : '');
    name = stem + ext;
  }
  let final = name;
  for (let n = 1; fs.existsSync(path.join(dir, final)); n++) {
    const dot = name.lastIndexOf('.');
    final = (dot > 0 ? name.slice(0, dot) : name) + '-' + n + (dot > 0 ? name.slice(dot) : '');
  }
  fs.writeFileSync(path.join(dir, final), buf);
  db.prepare('INSERT INTO files (session_id, filename, size, created_at) VALUES (?,?,?,?)')
    .run(s.id, final, buf.length, now());
  return final;
}

// ---------- 投递：进程内总线监听 → 分段 push wxbot /api/deliver ----------
// 只推最终 assistant 文本（type=errAck / 纯工具轮空文本 / 存档类事件都不进微信）；
// 游标 last_msg_id 落库：core 重启不补发历史，wxbot 短暂不可达时不丢（下一条事件连带补齐）。
//
// 回合回复预算（配额在 iLink 上游，不可见也不可查，只能我们自己记账后主动分配）：
// 回复额度挂在「入站消息」的 context token 上——用户每发一条消息，本轮总共只能回约
// REPLY_QUOTA 条（分段与附件卡片各占 1 条）。AI 原生的「多迭代多条中间回复 + 长结论」
// 天然撞上限，且过去靠位置赌重要性（截尾恰好丢掉最要的结论）。现策略：
//   1. handleInbox 每条入站重置预算；命令回执（wxbot 同步原样发出）记 1 条。
//   2. 过程消息（assistant_message 带 tool_calls，回合必然继续）直发至多
//      PROC_HEAD_LIMIT 条——前几条「我打算怎么做」有信息量；且发送后必须给结论
//      留足 CONCLUSION_RESERVE 条；不满足则不投，计数 omitted，结论开头并入
//      「已省略 N 条过程」一行注记（宁精勿滥，长任务靠 typing 心跳感知进展）。
//   3. 结论（不带 tool_calls 的 assistant_message，回合收尾）挂起到 done 再投：
//      预算够 → 全文 + 附件卡片；放不下但 ≥2 → 降级「截断头部 + 全文写会话
//      .md 转文件卡片」（内容零丢失）；<2 → 放弃并告警（网页端完整可见）。
//   4. 工具台账：tool_call/tool_result 只往 st.tools 记账（✓/✗ 状态前缀 + 工具名 + 参数原文
//      不解析；同类计数折叠、失败行尾 (failed)）。攒满一屏（8 行）→ 独立「### 工具调用 +
//      代码块」消息走串行队列即发（占 1 条配额）；done 时零头补发（纯工具轮兜底也在此，
//      不依赖任何文本消息）；预算保不住结论储备、或直投失败 → 降级搭结论「--- 尾段」便车；
//      失败不插队（用户确认：微信端重结果轻过程）。过程正文不再携带工具信息（单一出口防重复）。
// 挂起用「证据」判定而非猜测：下一条 assistant_message 或 done 都会把旧的挂起结算掉。
function attachBus() {
  if (busAttached || !bus) return;
  busAttached = true;
  bus.onInternal((sessionId, event, data) => {
    if (event === 'assistant_message') { if (!data) return; }
    else if (event !== 'done' && event !== 'tool_call' && event !== 'tool_result') return;
    try {
      const cs = db.prepare('SELECT user, channel FROM channel_sessions WHERE session_id = ?').get(sessionId);
      if (!cs || !String(cs.channel || '').startsWith('wx:')) return;
      const bid = cs.channel.slice(3);
      if (event === 'assistant_message') enqueueDelivery(bid, () => onAssistantEvent(bid, data, sessionId));
      else if (event === 'done') enqueueDelivery(bid, () => flushHeld(bid));
      else {
        // 工具调用/回执：心跳 + 台账记账；攒满一屏即经串行队列独立发台账（见策略注释第 4 条）
        if (event === 'tool_call') {
          toolDigestPush(bid, data);
          if (getTurn(bid).tools.length >= DIGEST_MAX_LINES) enqueueDelivery(bid, () => flushLedger(bid, DIGEST_MAX_LINES));
        } else if (event === 'tool_result') toolDigestMark(bid, data);
        maybeTypingPing(bid); // 「正在输入」心跳：微信端在长工具回合里能看到 AI 还在干活
      }
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

// sendTyping 心跳：tool_call/tool_result 事件驱动（并行工具批会连发，2s 冷却去重）；
// 纯 UI 锦上添花，一切失败静默（wxbot 不可达/实例已销都不值得刷日志），不进入投递队列。
const typingLast = new Map(); // bid -> 上次发出时间戳
function maybeTypingPing(bid) {
  try {
    const b = getBinding(bid);
    if (!b || b.status !== 'online' || !b.wx_to_user) return;
    const t = now();
    if (t - (typingLast.get(bid) || 0) < 2000) return;
    typingLast.set(bid, t);
    wxbotApi('POST', '/api/typing', { id: b.id, to: b.wx_to_user }, 5000).catch(() => {});
  } catch (_) { /* 心跳尽力而为 */ }
}

// ---------- 回合预算状态与投递分配 ----------
const REPLY_QUOTA = 10;        // iLink 单个 context token 的回复条数（经验值，撞墙只会多试一次）
const PROC_HEAD_LIMIT = 1;     // 直发的开头过程消息条数（用户确认：1 条「我打算怎么做」足够，工具信息归台账）
const CONCLUSION_RESERVE = 4;  // 过程发送的下限防线：始终给结论留这么多条
const turnState = new Map();   // bid -> { sent, proc, omitted, held, tools }；内存态，重启即新回合，可接受
function resetTurn(bid) { turnState.set(bid, { sent: 0, proc: 0, omitted: 0, held: null, tools: [] }); return turnState.get(bid); }
function getTurn(bid) { return turnState.get(bid) || resetTurn(bid); }

// 投递前的内容归一（语义同旧 deliverNow）：errAck / 空文本 → 不可投；富文本 blocks → 占位文案。
function normalizeContent(m) {
  if (!m || m.type === 'errAck') return '';
  let content = String(m.content || '').trim();
  if (!content) return '';
  if (content.startsWith('{"__blocks__"')) content = '【富文本消息，请到网页端查看】';
  return content;
}

// 分段逐条投递；一段失败即中断并返回 false（游标不推进，同旧语义）。
async function sendSegs(b, segs) {
  for (const s of segs) {
    try { await wxbotApi('POST', '/api/deliver', { id: b.id, to: b.wx_to_user, text: s }, 15000); }
    catch (e) {
      log.warn('wechat', b.id + ' 投递失败，游标未推进（下次回复连带补齐）：' + msg(e));
      return false;
    }
  }
  return true;
}

// 附件（正文 /p/ 链 → 文件卡片）尽力而为：单个失败只 warn，链接文字已在正文兜底。
async function sendAttachments(b, list) {
  let n = 0;
  for (const a of list) {
    try { await wxbotApi('POST', '/api/deliver_media', { id: b.id, to: b.wx_to_user, filename: a.filename, b64: a.b64 }, 60000); n++; }
    catch (e) { log.warn('wechat', b.id + ' 附件投递失败（' + a.filename + '，链接文字兜底）：' + msg(e)); }
  }
  return n;
}

// assistant_message 事件入口：带 tool_calls 的必然是过程（回合还会继续）→ 直接结算；
// 不带的可能收尾 → 挂起，等下一条事件/done 拿证据。挂起顺带保证「结算顺序 = 产生顺序」
// （都在串行投递链里执行）。
async function onAssistantEvent(bid, m, sessionId) {
  const st = getTurn(bid);
  const held = st.held;
  st.held = null;
  if (held) await deliverProcess(bid, held.m, held.sessionId); // 新事件即证据：挂起那条是过程
  if (m.tool_calls && m.tool_calls.length) { await deliverProcess(bid, m, sessionId); return; }
  if (!normalizeContent(m)) return; // 空文本轮不可能当结论投，也不占用挂起
  st.held = { m, sessionId };
}

// done（回合收尾/停止/清空都会发）：先补发台账零头（纯工具轮兜底也在此），
// 再把挂起的最后一条按「结论」结算——保底投递路径。
async function flushHeld(bid) {
  const st = turnState.get(bid);
  if (!st) return;
  await flushLedger(bid);
  if (!st.held) return;
  const held = st.held;
  st.held = null;
  await deliverConclusion(bid, held.m, held.sessionId);
}

function bindReady(bid) {
  const b = getBinding(bid);
  return b && b.status === 'online' && b.wx_to_user ? b : null;
}

function stale(b, m) {
  const id = Number(m.id) || 0;
  return id && id <= (b.last_msg_id || 0);
}

function markSeen(b, m) {
  const id = Number(m.id) || 0;
  if (id > (b.last_msg_id || 0)) touchBinding(b.id, { last_msg_id: id });
}

// ---------- 工具台账（ledger） ----------
// 参数原文按固定长度截取，不做 JSON 解析、不按工具选字段；压平换行只为防撑破一行。
// write_file 等正文类参数最多露出前 DIGEST_ARG_LEN 字。
const DIGEST_MAX_LINES = 8;
const DIGEST_ARG_LEN = 120;    // 代码块在微信端横向滚动不折行，参数尽量露全，仅防超长撑爆消息体
function argHint(args) {
  try {
    const v = String(args || '').replace(/\s+/g, ' ').trim();
    if (!v) return '';
    return v.length > DIGEST_ARG_LEN ? v.slice(0, DIGEST_ARG_LEN) + '...' : v;
  } catch (_) { return ''; }
}
function toolDigestPush(bid, data) {
  try {
    const st = getTurn(bid);
    const name = String((data && data.name) || '');
    if (!name) return;
    const hint = argHint(data && data.arguments);
    const ex = st.tools.find(t => t.name === name && t.hint === hint && !t.err);
    if (ex) { ex.count++; if (data.id) ex.ids.push(data.id); return; }
    st.tools.push({ name, hint, count: 1, err: false, ids: data && data.id ? [data.id] : [] });
  } catch (_) { /* 摘要锦上添花，绝不动摇投递 */ }
}
function toolDigestMark(bid, data) {
  try {
    if (!data || !data.is_error) return;
    const st = getTurn(bid);
    const t = st.tools.find(x => x.ids.indexOf(data.tool_call_id) >= 0);
    if (t) t.err = true;
  } catch (_) { /* 同上 */ }
}
// 台账行：✓/✗ 状态前缀（失败在行首才醒目）+ 工具名 + 参数原文 + 计数折叠（独立直发与结论尾段两处共用）。
const ledgerLine = t => '- ' + (t.err ? '✗' : '✓') + ' ' + t.name + (t.hint ? ' ' + t.hint : '') + (t.count > 1 ? ' x' + t.count : '');
// 降级路径的渲染（peek 不清空）：台账单发预算不足/失败时搭结论尾段，结论投递成功后调用方清空。
// 若 wxbot 开 WXBOT_STRIP_MARKDOWN 回退纯文化，stripMarkdown 会把围栏/标题降为普通行，信息不丢。
function peekToolDigest(st) {
  const ts = st && st.tools;
  if (!ts || !ts.length) return '';
  const lines = ts.slice(0, DIGEST_MAX_LINES).map(ledgerLine);
  if (ts.length > lines.length) lines.push('- ...等 ' + (ts.length - lines.length) + ' 类');
  return '---\n\n### 工具调用\n\n```\n' + lines.join('\n') + '\n```';
}
// 正文与 digest 一起分段：正文照旧 splitText，digest 原子追尾——markdown 代码围栏不能被
// 1800 字分段拦腰斩断；尾段能与正文同段就同段（不多占配额），放不下才单独成段。
function digestSegs(body, digest) {
  const segs = body ? splitText(body) : [];
  if (!digest) return segs;
  if (!segs.length) return [digest];
  const joined = segs[segs.length - 1] + '\n\n' + digest;
  if (joined.length <= 1800) segs[segs.length - 1] = joined;
  else segs.push(digest);
  return segs;
}
// 独立台账消息：一批 ≤8 行整屏渲染，无折叠（零头等下一班车，done 时补发）。
function renderLedger(batch) {
  return '### 工具调用\n\n```\n' + batch.map(ledgerLine).join('\n') + '\n```';
}
// 台账直发：mid 门槛控制节奏（中途=攒满一屏才发，done=零头都发）；预算保不住结论储备就
// 留给结论尾段搭便车；直投失败归还队首（串行队列调度，与正文消息天然排队，无并发互踩）。
async function flushLedger(bid, min) {
  const st = getTurn(bid);
  if (!st.tools.length || st.tools.length < (min || 0)) return;
  const b = bindReady(bid);
  if (!b) return;
  if (st.sent + 1 > REPLY_QUOTA - CONCLUSION_RESERVE) return; // 台账是锦上添花，结论才是刚需
  const batch = st.tools.splice(0, DIGEST_MAX_LINES);
  try {
    await wxbotApi('POST', '/api/deliver', { id: b.id, to: b.wx_to_user, text: renderLedger(batch) }, 15000);
    st.sent++;
    log.debug('wechat', bid + ' 台账直投 ' + batch.length + ' 类调用（余 ' + st.tools.length + '）');
  } catch (e) {
    st.tools = batch.concat(st.tools);
    log.debug('wechat', bid + ' 台账直投失败，归还待搭结论尾段：' + msg(e));
  }
}

// 过程消息：直发窗口内且投完后仍给结论留足储备才投；否则计入 omitted，并进结论的注记行。
// 正文不携带工具信息——台账自有出口（flushLedger 独立直发，预算不足时降级搭结论尾段），不重复。
async function deliverProcess(bid, m, sessionId) {
  const b = bindReady(bid);
  if (!b || stale(b, m)) return;
  const st = getTurn(bid);
  const content = normalizeContent(m);
  if (!content) return;
  const segs = splitText(content);
  const attach = findAttachments(content, sessionId);
  if (st.proc >= PROC_HEAD_LIMIT || st.sent + segs.length + attach.length > REPLY_QUOTA - CONCLUSION_RESERVE) {
    st.omitted++;
    log.debug('wechat', bid + ' 过程消息并入省略（proc=' + st.proc + ' sent=' + st.sent + '）消息 ' + m.id);
    return;
  }
  if (!await sendSegs(b, segs)) return;
  st.sent += segs.length + await sendAttachments(b, attach);
  st.proc++;
  markSeen(b, m);
}

// 结论：优先全文；放不下 → 截断头部 + 全文落会话文件转卡片（2 条兜底，内容零丢失）；
// 预算 <2 → 放弃并告警（网页端完整可见，游标不推进）。
async function deliverConclusion(bid, m, sessionId) {
  const b = bindReady(bid);
  if (!b || stale(b, m)) return;
  const st = getTurn(bid);
  let content = normalizeContent(m);
  if (st.omitted) content = '`以上已省略 ' + st.omitted + ' 条过程消息`\n---\n' + (content || '');
  const digest = peekToolDigest(st);
  if (!content && !digest) { st.omitted = 0; return; } // 只剩注记：不为「省略了什么」单独刷屏
  const full = content ? (digest ? content + '\n\n' + digest : content) : digest; // 兑底文件/卡片用含 digest 的全文
  const segs = digestSegs(content, digest);
  const attach = findAttachments(content, sessionId);
  const remaining = REPLY_QUOTA - st.sent;
  if (segs.length + attach.length <= remaining) {
    if (!await sendSegs(b, segs)) return;
    st.sent += segs.length + await sendAttachments(b, attach);
    st.tools = [];
  } else if (remaining >= 2) {
    try {
      const dir = engine.taskDirOf(sessionId);
      const name = '微信回复全文-' + (Number(m.id) || now()) + '.md';
      fs.writeFileSync(path.join(dir, name), full);
      const head = segs[0].slice(0, 1500) + '\n……内容较长，全文见附件「' + name + '」';
      await wxbotApi('POST', '/api/deliver', { id: b.id, to: b.wx_to_user, text: head }, 15000);
      st.sent++;
      st.sent += await sendAttachments(b, [{ filename: name, b64: Buffer.from(full).toString('base64') }]);
      st.tools = [];
      if (attach.length) log.warn('wechat', b.id + ' 结论走文件兜底，正文内 ' + attach.length + ' 个附件卡片未投（链接仍在文件里）');
    } catch (e) {
      log.warn('wechat', b.id + ' 结论溢出降级投递失败：' + msg(e));
      return;
    }
  } else {
    log.warn('wechat', b.id + ' 回复配额耗尽（已投 ' + st.sent + '/' + REPLY_QUOTA + '），本轮结论未投递（网页端可见）');
    return;
  }
  const omittedNoted = st.omitted;
  st.omitted = 0;
  markSeen(b, m);
  log.info('wechat', b.id + ' 已投递结论 ' + m.id + '（回合已投 ' + st.sent + ' 条，省略过程 ' + omittedNoted + '）→ 微信');
}

// 扫回复文本里的 /p/<22位id> 链 → 可卡片化的本地附件（{filename, b64}，最多 5 个，单文件限 20MB）。
// 归属校验按「同用户」放行（B 案定稿）：recall op=link 合法取旧会话文件，原「同会话」规矩会打断
// 记忆链最后一公里；pid 是 22 位随机不可猜的 bearer 能力，真正要防的是跨用户外流——签发会话查不到
// 主人（已删）也拒。过期（resolve 空）、文件已删、跳出任务目录、超限全部静默跳过——链接文字留在正文可点。
const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
const ATTACH_MAX_COUNT = 5;
function findAttachments(content, sessionId) {
  const out = [];
  const seen = new Set();
  // 会话 id → 用户 的小缓存（一次投递通常命中同几个签发会话）；查无此会话记 null 拒转。
  const userCache = new Map();
  const ownerOf = sid => {
    const key = String(sid || '');
    if (!userCache.has(key)) {
      const row = db.prepare('SELECT user FROM sessions WHERE id = ?').get(key);
      userCache.set(key, row ? String(row.user || '') : null);
    }
    return userCache.get(key);
  };
  const me = ownerOf(sessionId);
  if (me == null) return out; // 当前会话已不存在：无人可收，全跳
  for (const m of String(content).matchAll(/\/p\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g)) {
    const pid = m[1];
    if (seen.has(pid) || out.length >= ATTACH_MAX_COUNT) continue;
    seen.add(pid);
    try {
      const f = publicFiles.resolve(pid);
      if (!f || ownerOf(f.sessionId) !== me) continue; // 同用户即可（含本会话）
      const dir = engine.taskDirOf(String(f.sessionId)); // 从签发会话的目录取件
      const abs = path.resolve(dir, String(f.rel));
      if (!abs.startsWith(dir + path.sep)) continue; // rel 签发时已验，此处再兑一层
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > ATTACH_MAX_BYTES) continue;
      out.push({ filename: path.basename(abs), b64: Buffer.from(fs.readFileSync(abs)).toString('base64') });
    } catch (_) { /* 过期/已删/异常：跳过 */ }
  }
  return out;
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
  findAttachments, // 投递前的附件解析（链接→文件）；导出供上电探针/未来其他投递面复用
};
