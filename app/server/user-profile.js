// 用户画像：一行一个登录用户（user_profiles 表），跨会话共享、按登录用户隔离；
// 未启用认证时即空串键的隐式单用户，功能不变。
//
// 设计原则（「只记不知道就会做错的信息」）：
// - 存储封闭三字段 honorific/industry/preference；「近期关注」不入库，
//   仅在快照冻结时从该用户最近会话标题现取现拼，UI 不展示也不编辑。
// - 注入：会话创建/清空时把渲染文本冻结进 sessions.profile_snapshot，
//   buildMessages 每轮以 system 后首条 user 消息注入——内容字节恒定不破坏前缀缓存，
//   且不落 messages 表，阶段切换归档/压缩都动不到它。
// - 更新：唯一提取时机是 enterExecuting（任务书落地、advising 轮尘埃落定），一次廉价模型调用；
//   当前画像随证据一起喂给模型，要求按【全量覆写】输出（见 profile-prompt.txt）：没提的字段
//   原值拄回，明确被纠正的才改写/清空。服务端按字段覆写（空串 = 清），模型漏输出/解析失败的
//   字段保留旧值；不中途写、不定时投递写。
const { profileMessages, callModel } = require('./llm');
const log = require('./log');

const FIELDS = ['honorific', 'industry', 'preference'];
const MAX_FIELD = 80;        // 字段长度帽：防模型把画像写成小作文
const RECENT_TITLES = 5;
const SNAPSHOT_HEAD = '【用户画像 · 背景参考】以下为历史会话沉淀的粗粒度认知，非任务约束；与当前请求冲突时，一律以当前请求为准。';
const FIELD_LABELS = { honorific: '称谓', industry: '行业', preference: '偏好' };

function readRow(db, user) {
  return db.prepare('SELECT data, enabled FROM user_profiles WHERE user = ?').get(String(user || ''));
}
function readData(row) {
  try { const d = JSON.parse((row && row.data) || '{}'); return d && typeof d === 'object' ? d : {}; }
  catch (_) { return {}; }
}

function getProfile(db, user) {
  const row = readRow(db, user);
  const data = readData(row);
  const out = { enabled: row ? !!row.enabled : true }; // 无行 = 默认启用（首次保存/提取前即此语义）
  for (const k of FIELDS) out[k] = typeof data[k] === 'string' ? data[k] : '';
  return out;
}

function writeRow(db, user, data, enabled) {
  db.prepare(`
    INSERT INTO user_profiles (user, data, enabled, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user) DO UPDATE SET data = excluded.data, enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(String(user || ''), JSON.stringify(data), enabled ? 1 : 0, Date.now());
}

// UI PUT 入参规范化：只认白名单键；字符串压空白 + 截断；enabled 仅认显式布尔/0/1（缺省 = 不改）。
function sanitizePatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const patch = { fields: {}, enabled: undefined };
  for (const k of FIELDS) {
    if (typeof b[k] === 'string') patch.fields[k] = b[k].replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
  }
  if (typeof b.enabled === 'boolean' || b.enabled === 0 || b.enabled === 1) patch.enabled = !!b.enabled;
  return patch;
}

// 用户手动保存：字段照写（空串 = 清空，尊重显式操作）。
function saveProfile(db, user, patch) {
  const row = readRow(db, user);
  const data = readData(row);
  for (const k of FIELDS) if (typeof patch.fields[k] === 'string') data[k] = patch.fields[k];
  const enabled = patch.enabled === undefined ? (row ? !!row.enabled : true) : patch.enabled;
  writeRow(db, user, data, enabled);
}

// 提取结果应用：全量覆写——parseExtraction 只收录了模型确实返回的字符串字段，
// 其中空串 = 按对话证据清除；未返回的字段（漏输出/胡输出）不收录，保留旧值。
// 返回实际变化的字段名（无变化不写库、不刷 updated_at）。
function mergeExtraction(db, user, parsed) {
  const row = readRow(db, user);
  const data = readData(row);
  const changed = [];
  for (const k of FIELDS) {
    const v = parsed[k]; // undefined = 模型没给这个字段 → 不动；'' = 显式清除
    if (typeof v === 'string' && v !== (typeof data[k] === 'string' ? data[k] : '')) { data[k] = v; changed.push(k); }
  }
  if (changed.length) writeRow(db, user, data, row ? !!row.enabled : true);
  return changed;
}

// 提取回合喂给模型的【Current profile】文本：三键定序，空值渲染 (empty)。
function profileForExtraction(p) {
  return FIELDS.map(k => k + ' = ' + (p[k] ? JSON.stringify(p[k]) : '(empty)')).join('\n');
}

// 渲染注入文本：三字段（非空才成行）+ 现取的近期关注；停用或全空 → 空串（不注入）。
function snapshotText(db, user, excludeSessionId) {
  const p = getProfile(db, user);
  if (!p.enabled) return '';
  const lines = [];
  for (const k of FIELDS) if (p[k]) lines.push('- ' + FIELD_LABELS[k] + '：' + p[k]);
  const titles = db.prepare(
    "SELECT title FROM sessions WHERE user = ? AND id != ? AND title IS NOT NULL AND title != '' ORDER BY updated_at DESC LIMIT " + RECENT_TITLES
  ).all(String(user || ''), String(excludeSessionId || '')).map(r => r.title);
  if (titles.length) lines.push('- 近期关注：' + titles.join('；'));
  return lines.length ? SNAPSHOT_HEAD + '\n' + lines.join('\n') : '';
}

// 会话创建/清空时冻结画像快照。失败静默（大不了这轮不注入，不影响建会话/清空主流程）。
function freezeSnapshot(db, sessionId) {
  try {
    const s = db.prepare('SELECT user FROM sessions WHERE id = ?').get(sessionId);
    if (!s) return;
    db.prepare('UPDATE sessions SET profile_snapshot = ? WHERE id = ?').run(snapshotText(db, s.user, sessionId), sessionId);
  } catch (e) { log.warn('profile', '画像快照冻结失败(忽略)：' + (e && e.message || e)); }
}

// 提取输出解析：剥 ``` 围栏、JSON.parse、只取白名单字段（同样截断）。解析失败返回 null。
function parseExtraction(content) {
  let text = String(content || '').trim();
  const fence = /^```[a-zA-Z]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  if (!text.startsWith('{')) { const m = /\{[\s\S]*\}/.exec(text); if (m) text = m[0]; }
  let obj;
  try { obj = JSON.parse(text); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of FIELDS) if (typeof obj[k] === 'string') out[k] = obj[k].replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
  return out;
}

// advising→executing 落槌处调用的一次提取更新：fire-and-forget，永不抛出。
// 不传 key_slot：旁路调用回落到该模型首个 key 副本，避免与在跑的回合抢同一槽限流（失败本就静默）。
async function runExtraction(db, cfg, ctx) {
  try {
    const { sessionId, user, modelId, historyRows, briefText } = ctx || {};
    const p = getProfile(db, user);
    if (!modelId || !p.enabled) return;
    if (!(historyRows || []).length || !String(briefText || '').trim()) return;
    const msgs = profileMessages(historyRows, (cfg.agent || {}).language, profileForExtraction(p), briefText);
    const r = await callModel(cfg, modelId, msgs, null, {});
    const parsed = parseExtraction(r && r.content);
    if (!parsed) { log.debug('profile', '提取输出不可解析，忽略：' + sessionId); return; }
    const changed = mergeExtraction(db, user, parsed);
    log.info('profile', '画像' + (changed.length ? '更新 ' + (user || '-') + '：' + changed.join(',') : '无变化') + ' ←' + sessionId);
  } catch (e) { log.warn('profile', '画像提取失败(忽略)：' + (e && e.message || e)); }
}

module.exports = { getProfile, sanitizePatch, saveProfile, snapshotText, freezeSnapshot, runExtraction };
