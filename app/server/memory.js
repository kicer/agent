// 长期记忆（日记）：微信通道拟人化工程的 M0 地基——纯存储与渲染，不碰模型
//（碎片摘要生成在 engine.journalFragment，与自动标题同模式：fire-and-forget + 失败降级）。
// 与 profile（user-profile.js）分工：profile 记「用户是什么样的人」（语义记忆、稳定特质），
// 日记记「我近几天帮他做过什么」（事件记忆、按天条目），两类记忆互不混。
// 规则：
// - (user, day) 一行；碎片 = 会话收口（下班）时生成的一小段第一人称记录，
//   按【收口当日】入条目（时间线跟下班日走，长跨度会话不会把记忆落进已裁掉的旧日期）；
//   同日多碎片按到达顺序拼接，不做 LLM 二次合并（确定性、零成本，每片本身已是条目化短文本）；
// - sid 去重：同一会话向同一天的条目只贡献一次碎片（防轮换竞态双写；代价：同一会话
//   被 /switch 捡回再离开时第二片同样被挡——M0 接受的简化，粒度留到轮换触发接线时复盘）；
// - memory.retain_days = 保留窗口（默认 7 天，硬帽 MAX_RETAIN）；0 = 整体关闭（不写不读不裁）。
// 时区与 cron（scheduler.js）对齐 Asia/Shanghai：上海无夏令时，按毫秒日移取 day 字符串安全。

const TZ = 'Asia/Shanghai';
const MAX_RETAIN = 30;
const DAY_MAX = 4000;  // 单日条目长度帽：溢出从头部裁（保最近片段）
const FRAG_MAX = 600;  // 单碎片长度帽（含【标题 · sid】头行）

function retainDays(cfg) {
  const n = Math.floor(Number((cfg && cfg.memory || {}).retain_days) || 0);
  return Math.max(0, Math.min(MAX_RETAIN, n));
}
function isEnabled(cfg) { return retainDays(cfg) > 0; }

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // en-CA = ISO 'YYYY-MM-DD'
function dayString(ms) { return dayFmt.format(new Date(Number(ms) || Date.now())); }

// 近 n 天窗口（含今天），数组按日期降序（新在前）。
function recentDays(cfg, refMs) {
  const n = retainDays(cfg);
  const out = [];
  const t = Number(refMs) || Date.now();
  for (let i = 0; i < n; i++) out.push(dayString(t - i * 86400000));
  return out;
}

// ---------- 写：碎片追加进对应天条目 ----------
// sid 三重角色：去重标记 / 条目里的下钻索引（M3 回忆按它取旧会话详情与成果文件）/ 溯源。
// 返回值三态：'added' 新落 / 'dupe' 该会话已有碎片（去重命中）/ 'off' 功能关闭或空文。
// 调用方（engine 收口链路）把 added 与 dupe 都视为「已收口」落 journaled 标记，不重试不重复摘要。
function appendFragment(db, cfg, user, day, text, sid) {
  if (!isEnabled(cfg) || !day) return 'off';
  const frag = String(text || '').replace(/\r/g, '').trim().slice(0, FRAG_MAX);
  if (!frag) return 'off';
  const key = String(user || '');
  const row = db.prepare('SELECT content FROM memory_entries WHERE user = ? AND day = ?').get(key, day);
  const base = row ? String(row.content) : '';
  if (sid && base.includes(String(sid))) return 'dupe'; // 本会话已入当天日记
  let next = base ? base + '\n\n' + frag : frag;
  if (next.length > DAY_MAX) next = next.slice(next.length - DAY_MAX);
  db.prepare(
    'INSERT INTO memory_entries (user, day, content, updated_at) VALUES (?,?,?,?)'
    + ' ON CONFLICT(user, day) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at'
  ).run(key, day, next, Date.now());
  prune(db, cfg); // 裁剪就一条廉价 DELETE，每次追加顺带做，表恒在保留窗内
  return 'added';
}

// 收口标记：每会话唯一碎片的物理保证（空闲/任务收口落地后置位；之后会话被再激活也不补碎片——
// 记忆稳定性优先于完备，新工作值得新工作台）。
function markJournaled(db, sessionId, ms) {
  db.prepare('UPDATE sessions SET journaled_at = ? WHERE id = ? AND journaled_at IS NULL')
    .run(Number(ms) || Date.now(), String(sessionId));
}

// ---------- 读：渲染成可注入会话上下文的日记文本（M2 的数据源） ----------
// 无记忆返回 ''；天降序（新在前）；头行说明 sid 用途，AI 自然知道可以下钻。
function journalFor(db, cfg, user) {
  const n = retainDays(cfg);
  if (!n) return '';
  const days = recentDays(cfg);
  const rows = db.prepare(
    'SELECT day, content FROM memory_entries WHERE user = ? AND day IN ('
    + days.map(() => '?').join(',') + ') ORDER BY day DESC'
  ).all(String(user || ''), ...days);
  if (!rows.length) return '';
  const head = '【长期记忆·日记(近' + n + '天)】近期交互的当日事件记录；'
    + '各条【标题 · 编号】里的编号是当时会话的 id，可用它回溯那次工作。';
  const parts = [head];
  for (const r of rows) parts.push('=== ' + r.day + ' ===\n' + r.content);
  return parts.join('\n\n');
}

// ---------- 裁剪：day 为 ISO 串，字典序即日期序 ----------
function prune(db, cfg) {
  const days = recentDays(cfg);
  if (!days.length) return 0;
  const res = db.prepare('DELETE FROM memory_entries WHERE day < ?').run(days[days.length - 1]);
  return res.changes || 0;
}

module.exports = {
  isEnabled, retainDays, dayString, recentDays,
  appendFragment, markJournaled, journalFor, prune,
  MAX_RETAIN, DAY_MAX, FRAG_MAX,
};
