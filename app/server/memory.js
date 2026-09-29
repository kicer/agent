// 长期记忆（日记）：微信通道拟人化的记忆地基——纯存储与渲染，不碰模型
//（碎片摘要生成在 engine.journalFragment，与自动标题同模式：fire-and-forget + 失败降级）。
// 与 profile（user-profile.js）分工：profile 记「用户是什么样的人」（语义记忆、稳定特质），
// 日记记「我近来做帮他做过什么」（事件记忆），两类记忆互不混。
// 记忆分层（评审定稿）：
// - 存储默认永久：会话收口（4h 空闲 / 设定定时任务）= 一条几十字的第一人称碎片，按【收口当日】
//   入 (user, day) 条目；同日多片按到达顺序拼接，不做 LLM 二次合并（确定性、零成本）——
//   虚拟人的过去不能到点就抹，「只记 7 天」会把人做成金鱼；
// - 注入 =「嘴上的工作记忆」：新会话开场只带最近 inject_max 条碎片（默认 10）；更早的记忆
//   不自动出现但也没消失——recall 工具按会话 id 下钻（op=list 翻旧条目 / files/link 查成果文件）；
// - retain_days > 0 才按天硬裁（默认 0 = 永不删除），留给确要自动清理/隐私抹除的场景。
// - sid 去重：同一会话只贡献一条碎片（防收口竞态双写；主闸是 sessions.journaled_at 物理占坑，
//   这里是末道防线）。
// 时区与 cron（scheduler.js）对齐 Asia/Shanghai：上海无夏令时，按毫秒日移取 day 字符串安全。

const TZ = 'Asia/Shanghai';
const INJECT_CAP = 50; // inject_max 硬帽：防配置手滑把整个日记灌进上下文
const FRAG_MAX = 600;  // 单碎片长度帽（含【会话id】头行）
// 单日条目不设长度帽（曾有 DAY_MAX=4000 按字符合切——会把碎片削成孤儿残句，且职责已被
// 两层取代：注入端 inject_max 按条数封顶，存储端 FRAG_MAX 限单碎片 + 每会话仅一片天然有界）。

// 存储裁剪窗：0 = 永久（默认）。正数 = 只留最近 n 天，窗外条目物理删除。
function retainDays(cfg) {
  const n = Math.floor(Number((cfg && cfg.memory || {}).retain_days) || 0);
  return n > 0 ? n : 0;
}
// 开场注入条数上限：0 = 只记录、不自动注入（回忆仍可查）。
function injectMax(cfg) {
  const n = Math.floor(Number((cfg && cfg.memory || {}).inject_max) || 0);
  return Math.max(0, Math.min(INJECT_CAP, n));
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // en-CA = ISO 'YYYY-MM-DD'
function dayString(ms) { return dayFmt.format(new Date(Number(ms) || Date.now())); }

// 保留窗最旧一天的日串（retain_days=0 → 空串 = 无下界）。
function cutoffDay(cfg, refMs) {
  const n = retainDays(cfg);
  return n ? dayString((Number(refMs) || Date.now()) - (n - 1) * 86400000) : '';
}

// ---------- 写：碎片追加进对应天条目 ----------
// sid 三重角色：去重标记 / 条目里的下钻索引（M3 回忆按它取旧会话详情与成果文件）/ 溯源。
// 返回值：'added' 新落 / 'dupe' 该会话已有碎片 / 'invalid' 空输入。
// 收口链路把 added 与 dupe 都视为「已收口」落 journaled 标记，不重试不重复摘要。
function appendFragment(db, cfg, user, day, text, sid) {
  if (!day) return 'invalid';
  const frag = String(text || '').replace(/\r/g, '').trim().slice(0, FRAG_MAX);
  if (!frag) return 'invalid';
  const key = String(user || '');
  const row = db.prepare('SELECT content FROM memory_entries WHERE user = ? AND day = ?').get(key, day);
  const base = row ? String(row.content) : '';
  if (sid && base.includes(String(sid))) return 'dupe'; // 本会话已入日记
  let next = base ? base + '\n\n' + frag : frag;
  db.prepare(
    'INSERT INTO memory_entries (user, day, content, updated_at) VALUES (?,?,?,?)'
    + ' ON CONFLICT(user, day) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at'
  ).run(key, day, next, Date.now());
  prune(db, cfg); // 裁剪就一条廉价 DELETE，每次追加顺带做（retain_days=0 时 no-op）
  return 'added';
}

// 收口标记：每会话唯一碎片的物理保证（空闲/任务收口落地后置位；之后会话被再激活也不补碎片——
// 记忆稳定性优先于完备，新工作值得新工作台）。
function markJournaled(db, sessionId, ms) {
  db.prepare('UPDATE sessions SET journaled_at = ? WHERE id = ? AND journaled_at IS NULL')
    .run(Number(ms) || Date.now(), String(sessionId));
}

// ---------- 读：开场注入文本（wechat.js 的数据源） ----------
// 全库取最近 inject_max 条碎片（不限天）：天降序、天内正序；渲染按天分组（新日在前）。
// 更早的记忆不在此出现但仍在库里——M3 回忆按会话 id 下钻。
function journalFor(db, cfg, user) {
  const cap = injectMax(cfg);
  if (!cap) return '';
  const rows = db.prepare('SELECT day, content FROM memory_entries WHERE user = ? ORDER BY day DESC').all(String(user || ''));
  const picked = []; // { day, frag }，全局新在前
  for (const r of rows) {
    const frags = String(r.content || '').split('\n\n').filter(Boolean);
    for (let i = frags.length - 1; i >= 0 && picked.length < cap; i--) picked.push({ day: r.day, frag: frags[i] });
    if (picked.length >= cap) break;
  }
  if (!picked.length) return '';
  const groups = []; // 按天分组，天内恢复到达顺序
  for (const p of picked) {
    if (!groups.length || groups[groups.length - 1].day !== p.day) groups.push({ day: p.day, frags: [] });
    groups[groups.length - 1].frags.unshift(p.frag);
  }
  const head = '【长期记忆·日记(最近' + picked.length + '条)】收工时的当日事件摘要，近日的在前、天内按发生顺序；'
    + '每条【编号】是来源会话 id：更早的日记用 recall 工具 op=search 关键词检索、op=days 按日期翻页再 op=day 取整天；'
    + '那次工作的成果文件用 op=files 查、op=link 取。';
  const parts = [head];
  for (const g of groups) parts.push('=== ' + g.day + ' ===\n' + g.frags.join('\n\n'));
  return parts.join('\n\n');
}

// ---------- 读：关键词检索（recall 主入口：用户记起的是「一段事」不是「第几条」） ----------
// 碎片级全库搜索：存储量小（每天一行、内容几十行），内存打分足够，不引入 FTS。
// 分词：空白/标点切词（多词命中多者为先）；单字命中 = 子串包含；CJK 长词未整串命中时
// 按二元字组兼容（过半才算模糊命中，得分打折）——支撑「记个大概」的模糊查。英文词大小写不敏感。
// 无命中返回 ''（友好提示由调用方给）。
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
  const rows = db.prepare('SELECT day, content FROM memory_entries WHERE user = ? ORDER BY day DESC').all(String(user || ''));
  const hits = [];
  let seq = 0;
  for (const r of rows) {
    const frags = String(r.content || '').split('\n\n').filter(Boolean);
    for (let i = frags.length - 1; i >= 0; i--) { // 天内新在前，seq 自然全局新在前
      const frag = frags[i];
      seq++;
      const fl = frag.toLowerCase();
      let sum = 0;
      for (const t of toks) sum += tokenScore(fl, t);
      if (sum > 0) hits.push({ day: r.day, frag: frag, score: sum / toks.length, seq: seq });
    }
  }
  if (!hits.length) return '';
  hits.sort((a, b) => b.score - a.score || a.seq - b.seq);
  const shown = hits.slice(0, lim);
  const parts = ['【日记检索】「' + String(query).trim() + '」命中 ' + hits.length + ' 条，按相关度列前 ' + shown.length + ' 条'
    + (hits.length > shown.length ? '；要更多加大 count 或关键词收窄' : '') + '：'];
  for (const h of shown) parts.push('--- ' + h.day + '（' + Math.round(h.score * 100) + '% 匹配）---\n' + h.frag);
  return parts.join('\n\n');
}

// ---------- 读：日期索引（只记得「大概哪天」时，先看有哪些天有账） ----------
function daysIndex(db, user) {
  const rows = db.prepare('SELECT day, content FROM memory_entries WHERE user = ? ORDER BY day DESC').all(String(user || ''));
  return rows.map(r => '- ' + r.day + '（' + String(r.content || '').split('\n\n').filter(Boolean).length + ' 条）');
}

// ---------- 读：某天的完整日记 ----------
function dayEntry(db, user, date) {
  const r = db.prepare('SELECT content FROM memory_entries WHERE user = ? AND day = ?').get(String(user || ''), String(date || '').trim());
  return r ? String(r.content) : '';
}

// ---------- 裁剪：day 为 ISO 串，字典序即日期序；默认永久存储为 no-op ----------
function prune(db, cfg) {
  const cutoff = cutoffDay(cfg);
  if (!cutoff) return 0;
  const res = db.prepare('DELETE FROM memory_entries WHERE day < ?').run(cutoff);
  return res.changes || 0;
}

module.exports = {
  retainDays, injectMax, dayString, cutoffDay,
  appendFragment, markJournaled, journalFor,
  searchFragments, daysIndex, dayEntry, prune,
  INJECT_CAP, FRAG_MAX,
};
