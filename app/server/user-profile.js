// 用户画像：一行一个登录用户（user_profiles 表），跨会话共享、按登录用户隔离；
// 未启用认证时即空串键的隐式单用户，功能不变。
//
// 设计原则（「只记不知道就会做错的信息」）：
// - 存储封闭三字段 honorific/industry/preference。早期快照附带的「近期关注」（现取最近会话标题）已移除：
//   标题无信息量、与长期记忆日记重叠，还会干扰 AI 对当下任务的判断（评审定稿）。
// - 注入：会话创建/清空时把渲染文本冻结进 sessions.profile_snapshot，
//   buildMessages 每轮以 system 后首条 user 消息注入——内容字节恒定不破坏前缀缓存，
//   且不落 messages 表，阶段切换归档/压缩都动不到它。
// - 更新：只由用户在设置页手动编辑。原 AI 侧的 profile 工具（list/set/add/remove）已移除：
//   模型自主记录容易把错的东西冻结成长期上下文，记什么由用户把关。
// - preference 是用户自由输入的多行文本（一行一条即可）：原样入库、原样注入，不拆不拼、
//   不把分隔符规范化；只卡一个总长帽（PREF_MAX）。
const log = require('./log');

const FIELDS = ['honorific', 'industry', 'preference'];
const MAX_FIELD = 80;   // honorific/industry 长度帽
const PREF_MAX = 1000;  // preference 总长帽（用户自由输入的多行文本，只卡总量）
// 画像快照头：AI 友好的分块标记（与 channel_note/memory_note 同款「# [CTX] <名>」体例，
// buildMessages 把快照作 system 后首条 user 注入，标题即自描述来源）。
const SNAPSHOT_HEAD = '# [CTX] user_profile\n\n以下为历史会话沉淀的粗粒度认知，非任务约束；与当前请求冲突时，一律以当前请求为准。';
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
  const out = { enabled: row ? !!row.enabled : true }; // 无行 = 默认启用（首次保存前即此语义）
  for (const k of FIELDS) out[k] = typeof data[k] === 'string' ? data[k] : '';
  return out;
}

function writeRow(db, user, data, enabled) {
  db.prepare(`
    INSERT INTO user_profiles (user, data, enabled, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user) DO UPDATE SET data = excluded.data, enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(String(user || ''), JSON.stringify(data), enabled ? 1 : 0, Date.now());
}

// UI PUT 入参规范化：只认白名单键；字符串压空白 + 截断（preference 高帽）；enabled 仅认显式布尔/0/1（缺省 = 不改）。
function sanitizePatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const patch = { fields: {}, enabled: undefined };
  for (const k of FIELDS) {
    if (typeof b[k] === 'string') {
      // preference 是用户按条目输入的自由文本：保留换行，只去首尾空白；另两字段压成单行
      const v = k === 'preference' ? b[k].trim() : b[k].replace(/\s+/g, ' ').trim();
      patch.fields[k] = v.slice(0, k === 'preference' ? PREF_MAX : MAX_FIELD);
    }
  }
  if (typeof b.enabled === 'boolean' || b.enabled === 0 || b.enabled === 1) patch.enabled = !!b.enabled;
  return patch;
}

// 落库入口：字段照写（空串 = 清空，尊重显式操作）；enabled 缺省保持现状。
function saveProfile(db, user, patch) {
  const row = readRow(db, user);
  const data = readData(row);
  for (const k of FIELDS) if (typeof patch.fields[k] === 'string') data[k] = patch.fields[k];
  const enabled = patch.enabled === undefined ? (row ? !!row.enabled : true) : patch.enabled;
  writeRow(db, user, data, enabled);
}

// 渲染注入文本：三字段（非空才成行）；停用或全空 → 空串（不注入）。
function snapshotText(db, user) {
  const p = getProfile(db, user);
  if (!p.enabled) return '';
  const lines = [];
  for (const k of FIELDS) if (p[k]) lines.push('- ' + FIELD_LABELS[k] + '：' + p[k]);
  return lines.length ? SNAPSHOT_HEAD + '\n\n' + lines.join('\n') : '';
}

// 会话创建/清空时冻结画像快照。失败静默（大不了这轮不注入，不影响建会话/清空主流程）。
function freezeSnapshot(db, sessionId) {
  try {
    const s = db.prepare('SELECT user FROM sessions WHERE id = ?').get(sessionId);
    if (!s) return;
    db.prepare('UPDATE sessions SET profile_snapshot = ? WHERE id = ?').run(snapshotText(db, s.user), sessionId);
  } catch (e) { log.warn('profile', '画像快照冻结失败(忽略)：' + (e && e.message || e)); }
}

module.exports = {
  getProfile, sanitizePatch, saveProfile, snapshotText, freezeSnapshot,
};
