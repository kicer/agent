// 用户画像：一行一个登录用户（user_profiles 表），跨会话共享、按登录用户隔离；
// 未启用认证时即空串键的隐式单用户，功能不变。
//
// 设计原则（「只记不知道就会做错的信息」）：
// - 存储封闭三字段 honorific/industry/preference。早期快照附带的「近期关注」（现取最近会话标题）已移除：
//   标题无信息量、与长期记忆日记重叠，还会干扰 AI 对当下任务的判断（评审定稿）。
// - 注入：会话创建/清空时把渲染文本冻结进 sessions.profile_snapshot，
//   buildMessages 每轮以 system 后首条 user 消息注入——内容字节恒定不破坏前缀缓存，
//   且不落 messages 表，阶段切换归档/压缩都动不到它。
// - 更新（原 handoff 落槌一次性提取链路已移除）：AI 沟通中经 profile 工具增量维护
//   （list/set/add/remove，见 executor.js；写入只影响下个会话——快照冻结语义不变），
//   用户也可在设置页手动编辑。preference 按顿号标签列表管理，工具只做增量增删、
//   不做整段覆写——防模型重写时吃掉旧标签；停用（enabled=0）时拒写不拒读。
const log = require('./log');

const FIELDS = ['honorific', 'industry', 'preference'];
const MAX_FIELD = 80;   // honorific/industry 长度帽（Web 手改与工具共用）
const PREF_MAX = 300;   // preference 总长帽
const SET_MAX = 20;     // AI 写 honorific/industry 的单值帽（称谓应当短小）
const TAG_MAX = 15;     // 单个偏好标签长度帽
const TAGS_MAX = 24;    // 偏好标签数量帽
const TAG_SPLIT = /[、，,;；\n]+/;
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
      patch.fields[k] = b[k].replace(/\s+/g, ' ').trim().slice(0, k === 'preference' ? PREF_MAX : MAX_FIELD);
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

// ---------- profile 工具（AI 增量维护入口；op 语义与 executor.js toolProfile 对应） ----------
// preference 存顿号连接的标签串；读取按分隔符拆 token（人工输入的整句会被拆为 token 存留，可接受）。
function profileTokens(preference) {
  return String(preference || '').split(TAG_SPLIT).map(t => t.trim()).filter(Boolean);
}

// 所有写 op 的统一后缀：快照「新会话冻结注入」语义不因工具改变，明说免 AI 在本会话里困惑等待。
const WRITE_NOTE = '（新会话开始时注入，本会话内不变；可用 op=list 查看实时状态）';

function requireEnabled(db, user) {
  if (!getProfile(db, user).enabled) {
    throw new Error('该用户已停用画像（设置页·账户·用户画像可重新启用），本次未写入。');
  }
}

// 单值字段（称谓/行业）设置；空串 = 清除。
function setProfileField(db, user, field, value) {
  if (!FIELDS.includes(field) || field === 'preference') {
    throw new Error('op=set 仅支持 honorific / industry（偏好标签请用 op=add / op=remove）');
  }
  requireEnabled(db, user);
  const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, SET_MAX);
  const cur = getProfile(db, user)[field];
  if (cur === v) return FIELD_LABELS[field] + '已是「' + v + '」，未改动。';
  saveProfile(db, user, { fields: { [field]: v } });
  return v
    ? FIELD_LABELS[field] + '已设为「' + v + '」' + WRITE_NOTE
    : FIELD_LABELS[field] + '已清除（下次冻结时将不再出现）。';
}

// 追加偏好标签：清洗 → 逐条校验长度 → 去重 → 数量/总长帽（整批原子：任一带帽违例则不落库）
function addProfileTags(db, user, tags) {
  const list = (Array.isArray(tags) ? tags : [tags])
    .map(t => String(t == null ? '' : t).replace(TAG_SPLIT, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!list.length) throw new Error('op=add 需要非空的 tags 字符串数组（单个标签也用数组传）');
  requireEnabled(db, user);
  const cur = profileTokens(getProfile(db, user).preference);
  const added = [], dup = [];
  for (const t of list) {
    if (t.length > TAG_MAX) throw new Error('标签「' + t + '」超过 ' + TAG_MAX + ' 字上限，请换成更概括的说法');
    if (cur.includes(t)) { dup.push(t); continue; }
    cur.push(t); added.push(t);
  }
  if (cur.length > TAGS_MAX) throw new Error('偏好标签已达 ' + TAGS_MAX + ' 个上限（本次将到 ' + cur.length + '），先用 op=remove 合并精简');
  const joined = cur.join('、');
  if (joined.length > PREF_MAX) throw new Error('偏好总长将超 ' + PREF_MAX + ' 字（现 ' + joined.length + '），先用 op=remove 精简');
  if (!added.length) {
    return '均已存在，未新增（' + dup.join('、') + '）；当前偏好 ' + cur.length + ' 条。';
  }
  saveProfile(db, user, { fields: { preference: joined } });
  return '已记录：' + added.join('、')
    + (dup.length ? '（已存在未重复：' + dup.join('、') + '）' : '')
    + '；偏好现共 ' + cur.length + ' 条' + WRITE_NOTE;
}

// 删除偏好标签：按 token 精确匹配；未命中的回报（引导先 list 核对写法）。
function removeProfileTags(db, user, tags) {
  const list = (Array.isArray(tags) ? tags : [tags]).map(t => String(t == null ? '' : t).trim()).filter(Boolean);
  if (!list.length) throw new Error('op=remove 需要非空的 tags 字符串数组');
  requireEnabled(db, user);
  const cur = profileTokens(getProfile(db, user).preference);
  const removed = list.filter(t => cur.includes(t));
  const missing = list.filter(t => !cur.includes(t));
  if (!removed.length) return '未找到要删除的标签：' + missing.join('、') + '（op=list 可查看当前精确标签）';
  saveProfile(db, user, { fields: { preference: cur.filter(t => !removed.includes(t)).join('、') } });
  return '已移除：' + removed.join('、')
    + (missing.length ? '；未找到：' + missing.join('、') : '')
    + '；偏好现共 ' + (cur.length - removed.length) + ' 条' + WRITE_NOTE;
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
  setProfileField, addProfileTags, removeProfileTags,
};
