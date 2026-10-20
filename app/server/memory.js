// 长期记忆（日记）：微信通道拟人化的记忆地基——纯存储与渲染，不碰模型
//（碎片摘要生成在 engine.journalFragment，与自动标题同模式：fire-and-forget + 候选模型兜底链）。
// 与 profile（user-profile.js）分工：profile 记「用户是什么样的人」（语义记忆、稳定特质），
// 日记记「我近来帮他做过什么」（事件记忆），两类记忆互不混。
// 结构（C 定稿）：一片碎片一行——memory_fragments(user, session_id PK, day, text, created_at, last_active_at)。
// - day = 事件日（Asia/Shanghai），由 last_active_at 派生：人回忆问的是「哪天干的活」，不是「哪天补记的」；
// - last_active_at = 收口时快照的最后一条真实 user/assistant 消息时刻（存量数据可为 NULL）；
// - text = 纯日记正文（"- " 行列表），【来源会话 id】展示样式只在渲染层拼，存储零冗余元数据；
// - title 不落碎片表，渲染时 join sessions 取当前标题；
// - (user, session_id) 主键即「每会话唯一碎片」的存储级保证（engine 侧 journaled_at 是扫描预排除）；
// - 注入 =「嘴边的工作记忆」：开场只带最近 inject_max 片（day 优先、同日按 last_active_at 倒序）；更早的没消失——
//   recall 工具 op=search/days/day 走全表；retain_days > 0 才按 day 硬裁（默认 0 = 不按时间删，
//   但删会话会连带撕掉它的碎片，见 dropFragment）。
// 时区与 cron（scheduler.js）对齐 Asia/Shanghai：上海无夏令时，按毫秒日移取 day 字符串安全。

const TZ = 'Asia/Shanghai';
const INJECT_CAP = 50; // inject_max 硬帽：防配置手滑把整个日记灌进上下文
const FRAG_MAX = 600;  // 单碎片正文长度帽

// 存储裁剪窗：0 = 永久（默认）。正数 = 只留最近 n 天的事件，更旧碎片物理删除。
function retainDays(cfg) {
  const n = Math.floor(Number((cfg && cfg.memory || {}).retain_days) || 0);
  return n > 0 ? n : 0;
}
// 开场注入条数上限：0 = 只记录、不自动注入（recall 仍可查）。
function injectMax(cfg) {
  const n = Math.floor(Number((cfg && cfg.memory || {}).inject_max) || 0);
  return Math.max(0, Math.min(INJECT_CAP, n));
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // en-CA = ISO 'YYYY-MM-DD'
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function dayString(ms) { return dayFmt.format(new Date(Number(ms) || Date.now())); }
// 'YYYY-MM-DD HH:MM:SS'（上海时区）；脏/空值返 ''，由调用方退回只显示 day。
function stampString(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return dayFmt.format(d) + ' ' + timeFmt.format(d);
}

// 保留窗最旧一天的日串（retain_days=0 → 空串 = 无下界）。
function cutoffDay(cfg, refMs) {
  const n = retainDays(cfg);
  return n ? dayString((Number(refMs) || Date.now()) - (n - 1) * 86400000) : '';
}

// ---------- 写：一片一行，主键即去重 ----------
// 返回 'added' 新落 / 'dupe' 该会话已有碎片（主键冲突）/ 'invalid' 参数不全。
// 调用方（engine 收口链路）把 added/dupe 都视为已收口落 journaled 标记，不重试不重复摘要。
function appendFragment(db, cfg, user, sessionId, day, text, lastActiveAt) {
  const body = String(text || '').replace(/\r/g, '').trim().slice(0, FRAG_MAX);
  if (!sessionId || !day || !body) return 'invalid';
  // last_active_at 是事件时刻快照；created_at 是本碎片收口/写入时间，两者不可混用。
  const stamp = Number(lastActiveAt) || Date.now();
  const r = db.prepare(
    'INSERT OR IGNORE INTO memory_fragments (user, session_id, day, text, created_at, last_active_at) VALUES (?,?,?,?,?,?)'
  ).run(String(user || ''), String(sessionId), day, body, Date.now(), stamp);
  if (!r.changes) return 'dupe';
  prune(db, cfg); // 廉价 DELETE 顺带做；retain_days=0 时 no-op
  return 'added';
}

// ---------- 删：来源会话销毁时连带撕掉它的碎片 ----------
// 会话没了，这条「我帮他做过什么」就再无出处：recall 拿到 sid 翻不出原文，也带不出成果文件，
// 留着是幽灵记忆（还会白占 inject_max 额度）。session id 全局唯一，按 sid 删即可，不必再限 user。
// 调用方：engine.deleteSession（Web 删除弹窗与微信 /delete 同源）。
function dropFragment(db, sessionId) {
  const res = db.prepare('DELETE FROM memory_fragments WHERE session_id = ?').run(String(sessionId));
  return res.changes || 0;
}

// 收口标记：sessions.journaled_at 物理占坑（扫描预排除，防陈年空闲会话每轮重复烧摘要 LLM）。
function markJournaled(db, sessionId, ms) {
  db.prepare('UPDATE sessions SET journaled_at = ? WHERE id = ? AND journaled_at IS NULL')
    .run(Number(ms) || Date.now(), String(sessionId));
}

// ---------- 读：开场注入文本（wechat/web 新会话的数据源） ----------
// 最近 inject_max 片按事件日优先（同序供 injectedIds/journalFor 共用），逐片「## id, date, title」自描述：
// 新日在前、天内按发生顺序。
// 选取序单点定义在此（调试 API/页面走 injectedIds 取名单，不另算一套，避免两边错位）。
const INJECT_ORDER = ' ORDER BY f.day DESC, COALESCE(f.last_active_at, f.created_at) DESC';
// 读路径统一列清单：renderFrag 依赖 day/last_active_at/title，三处查询不再各写 SELECT，避免漏列。
const FRAG_COLS = 'f.session_id, f.day, f.text, f.last_active_at, s.title';
const FRAG_FROM = ' FROM memory_fragments f LEFT JOIN sessions s ON s.id = f.session_id';
// 注入窗名单：与 journalFor 同选取规则的 session_id 列表（调试页打「已注入」标用）。
function injectedIds(db, cfg, user) {
  const cap = injectMax(cfg);
  if (!cap) return [];
  return db.prepare(
    'SELECT f.session_id FROM memory_fragments f WHERE f.user = ?' + INJECT_ORDER + ' LIMIT ?'
  ).all(String(user || ''), cap).map(r => r.session_id);
}
// 渲染逐片自描述：「## id=…, date=YYYY-MM-DD HH:MM:SS, title=…」——新在前、天内按发生顺序。
// 旧数据没有 last_active_at 时只显示 day；标题为空时整段省略，绝不拼出 undefined。
function renderFrag(r) {
  const when = stampString(r.last_active_at) || r.day || '未知';
  const title = String(r.title || '').replace(/\s+/g, ' ').trim();
  return '## id=' + r.session_id + ', date=' + when + (title ? ', title=' + title : '') + '\n' + r.text;
}
function journalFor(db, cfg, user) {
  const cap = injectMax(cfg);
  if (!cap) return '';
  const rows = db.prepare(
    // 选取按事件日（积压补记/迁移会令 created_at 齐平，按收口序会拿到「最晚补记」而非「最新事件」；
    // 稳态下两者等价，事件日序更符合「最近记忆」直觉），同日并列再按最后对话时刻。
    'SELECT ' + FRAG_COLS + FRAG_FROM + ' WHERE f.user = ?' + INJECT_ORDER + ' LIMIT ?'
  ).all(String(user || ''), cap);
  if (!rows.length) return '';
  const groups = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (!g || g.day !== r.day) groups.push({ day: r.day, items: [renderFrag(r)] });
    else g.items.unshift(renderFrag(r));
  }
  return groups.map(g => g.items.join('\n\n')).join('\n\n');
}

// ---------- 读：关键词检索（recall 主入口：用户记起的是「一段事」不是「第几条」） ----------
// 逐行内存打分（表行数=收口会话数，量级小到不值得建 FTS）。
// 分词：空白/标点切词，多词命中多者为先；单词命中=子串包含（小写化）；
// CJK 长词整串不中时二元字组过半即模糊命中（得分 0.9 折算）——支撑「记个大概」。
const CJK_RE = /[\u4e00-\u9fff]/;
function tokenScore(fl, t) {
  if (fl.includes(t)) return 1;
  if (t.length < 2 || !CJK_RE.test(t)) return 0;
  let hit = 0;
  for (let i = 0; i + 2 <= t.length; i++) if (fl.includes(t.slice(i, i + 2))) hit++;
  const frac = hit / (t.length - 1);
  return frac >= 0.5 ? frac * 0.9 : 0;
}
function searchFragments(db, user, query, count) {
  const toks = String(query || '').toLowerCase().split(/[\s,，、;；。.!！?？]+/).filter(Boolean).slice(0, 8);
  if (!toks.length) return '';
  const lim = Math.max(1, Math.min(30, Number(count) || 10));
  const rows = db.prepare(
    'SELECT ' + FRAG_COLS + FRAG_FROM + ' WHERE f.user = ? ORDER BY COALESCE(f.last_active_at, f.created_at) DESC'
  ).all(String(user || ''));
  const hits = [];
  rows.forEach((r, i) => {
    const fl = String(r.text).toLowerCase();
    let sum = 0;
    for (const t of toks) sum += tokenScore(fl, t);
    if (sum > 0) hits.push({ r: r, score: sum / toks.length, i: i });
  });
  if (!hits.length) return '';
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  const shown = hits.slice(0, lim);
  // 条目自带 date（renderFrag 标题），行内只留相关度不重复日期
  const parts = ['【日记检索】「' + String(query).trim() + '」命中 ' + hits.length + ' 条，按相关度列前 ' + shown.length + ' 条：'];
  for (const h of shown) parts.push('--- 匹配 ' + Math.round(h.score * 100) + '% ---\n' + renderFrag(h.r));
  return parts.join('\n\n');
}

// ---------- 读：日期索引 / 某天整天（只记得「大概哪天」时的翻页） ----------
function daysIndex(db, user) {
  return db.prepare(
    'SELECT day, COUNT(*) n FROM memory_fragments WHERE user = ? GROUP BY day ORDER BY day DESC'
  ).all(String(user || '')).map(r => '- ' + r.day + '（' + r.n + ' 条）');
}
function dayEntry(db, user, date) {
  return db.prepare(
    'SELECT ' + FRAG_COLS + FRAG_FROM + ' WHERE f.user = ? AND f.day = ? ORDER BY COALESCE(f.last_active_at, f.created_at)'
  ).all(String(user || ''), String(date || '').trim()).map(renderFrag).join('\n\n');
}

// ---------- 裁剪：day 为 ISO 串，字典序即日期序；默认永久存储为 no-op ----------
function prune(db, cfg) {
  const cutoff = cutoffDay(cfg);
  if (!cutoff) return 0;
  const res = db.prepare('DELETE FROM memory_fragments WHERE day < ?').run(cutoff);
  return res.changes || 0;
}

module.exports = {
  retainDays, injectMax, dayString, cutoffDay,
  appendFragment, dropFragment, markJournaled, journalFor, injectedIds,
  searchFragments, daysIndex, dayEntry, prune,
  INJECT_CAP, FRAG_MAX,
};
