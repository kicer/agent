// 用户管理（仅管理员）：增删改查 config.yml 的 auth.users（用户名 / 密码 / 角色 / 默认模型）。
// 写盘后同步刷新内存（engine.cfg.auth.users + auth 的登录校验表），立即生效、无需重启：
// 新增用户马上能登录，删除的用户已签发 token 立刻失效（sessionUser 查的是刷新后的表）。
// 删除用户会连带清理其数据：微信绑定（含 wxbot 实例与凭证）、会话（消息/文件/定时任务/任务目录/日记碎片）、
// 画像、长期记忆与通道绑定。清理尽力而为，单项失败只记日志，不回滚已完成的配置删除。
const express = require('express');
const engine = require('../engine');
const wechat = require('../wechat');
const log = require('../log');
const { readConfigText, applyEditsToText, loadConfigFromText, writeConfigText } = require('../config');

// 用户名同时是 YAML 值、日志字段和 URL 路径参数：只允许字母/数字/下划线/点/横线/@/中文，
// 放开空白或斜杠会让 PATCH/DELETE 的路径与日志难以辨认。
const USER_RE = /^[\w.\-@\u4e00-\u9fa5]{1,32}$/;

function bad(msg, code) { return Object.assign(new Error(msg), { status_code: code || 400 }); }
function sendErr(res, err) { res.status((err && err.status_code) || 500).json({ error: String((err && err.message) || err) }); }
function wrap(fn) {
  return function (req, res) {
    try {
      const r = fn(req, res);
      if (r && typeof r.catch === 'function') r.catch(err => sendErr(res, err));
    } catch (err) { sendErr(res, err); }
  };
}

function publicUsers(users) {
  return (users || []).map(u => ({ user: u.user, role: u.role, model: u.model || '' }));
}

// 启用中的模型清单（cfg.models 按 key 展开过，这里按 id 去重、过滤禁用），供前端下拉。
function modelChoices(cfg) {
  const seen = new Set();
  const out = [];
  for (const m of cfg.models || []) {
    if (m.enable === false || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, name: m.display_name || m.mid || m.id });
  }
  return out;
}

function adminCount(users) {
  return (users || []).filter(u => u.role === 'admin').length;
}

function requireAuthCfg() {
  const cfg = engine.getConfig();
  if (!cfg.auth || !Array.isArray(cfg.auth.users) || !cfg.auth.users.length) {
    throw bad('未启用多用户认证（config.yml 的 auth.users 为空）');
  }
  return cfg;
}

// 删除用户后的数据善后（尽力而为，单项失败只记日志）：绑定 → 会话 → 跨会话残留。
// 顺序有讲究：先解绑定——绑定行还在而 wxbot 实例已销毁时，core 启动对账会把它补建回来；
// 再用 engine.deleteSession 删会话（停运行、收预览槽、清消息/文件行、日记碎片与任务目录，
// scheduled_tasks 由外键 CASCADE 带走）；最后清画像、长期记忆、通道绑定与废弃表残留。
async function purgeUserData(name) {
  const db = engine.getDb();
  const cleaned = { bindings: 0, sessions: 0, profiles: 0, fragments: 0, channels: 0 };
  // 日记先计数：会话删除时会连带清掉各自碎片，事后无法再区分「本用户原有几条」。
  // model_usage 不动：那张表有意不建外键，删会话后累计统计仍保留。
  const fragBefore = db.prepare('SELECT COUNT(*) AS c FROM memory_fragments WHERE user = ?').get(name).c;

  let bindings = [];
  try { bindings = wechat.listBindings(name) || []; }
  catch (e) { log.warn('auth', name + ' 读取微信绑定失败：' + e.message); }
  for (const b of bindings) {
    try { await wechat.deleteBinding(b.id); cleaned.bindings++; }
    catch (e) { log.warn('auth', name + ' 解绑微信 ' + b.id + ' 失败：' + e.message); }
  }

  const sids = db.prepare('SELECT id FROM sessions WHERE user = ?').all(name).map(r => r.id);
  for (const sid of sids) {
    try {
      // 废弃的 FIFO 队列表无 CASCADE，先清行避免外键拦住 sessions 删除
      db.prepare('DELETE FROM wait_queue WHERE session_id = ?').run(sid);
      engine.deleteSession(sid, true);
      cleaned.sessions++;
    } catch (e) { log.warn('auth', name + ' 删除会话 ' + sid + ' 失败：' + e.message); }
  }

  cleaned.channels = db.prepare('DELETE FROM channel_sessions WHERE user = ?').run(name).changes;
  // 按 user 全量删，命中数即用户原有碎片数（含没有会话对应的孤儿碎片）
  db.prepare('DELETE FROM memory_fragments WHERE user = ?').run(name);
  cleaned.fragments = fragBefore;
  cleaned.profiles = db.prepare('DELETE FROM user_profiles WHERE user = ?').run(name).changes;
  return cleaned;
}

function normName(v) {
  const name = String(v == null ? '' : v).trim();
  if (!name) throw bad('用户名不能为空');
  if (!USER_RE.test(name)) throw bad('用户名只能包含字母/数字/下划线/点/横线/@/中文，最长 32 字符');
  return name;
}
function normPassword(v) {
  const p = String(v == null ? '' : v);
  if (p.length < 6) throw bad('密码至少 6 位');
  return p;
}
function normRole(v) {
  const r = String(v == null ? '' : v).trim();
  if (!r) return 'user';
  if (r !== 'admin' && r !== 'user') throw bad('角色只能是 admin 或 user');
  return r;
}
function normModel(cfg, v) {
  const model = String(v == null ? '' : v).trim();
  if (!model) return '';
  if (!modelChoices(cfg).some(m => m.id === model)) throw bad('模型不存在或已禁用：' + model);
  return model;
}

// 写盘 + 热更新：先校验（不合法不动文件），再同步 cfg.auth.users 与 auth 的登录校验表。
function saveUsers(cfg, nextText, auth) {
  const next = loadConfigFromText(nextText, cfg.config_path);
  writeConfigText(cfg, nextText);
  const nextUsers = (next.auth && next.auth.users) || [];
  if (next.auth) {
    if (!cfg.auth) cfg.auth = next.auth;
    else cfg.auth.users = nextUsers;
  } else {
    cfg.auth = null;
  }
  auth.refreshUsers(nextUsers);
  return nextUsers;
}

module.exports = function createUsersRouter(auth) {
  const router = express.Router();
  router.use(auth.requireAdmin);

  // 列表：用户名/角色/默认模型（不回密码）+ 可选模型清单
  router.get('/', wrap((req, res) => {
    const cfg = engine.getConfig();
    const users = (cfg.auth && cfg.auth.users) || [];
    res.json({
      enabled: !!(cfg.auth && users.length),
      users: publicUsers(users),
      models: modelChoices(cfg),
    });
  }));

  // 新增
  router.post('/', wrap((req, res) => {
    const cfg = requireAuthCfg();
    const b = req.body || {};
    const name = normName(b.user);
    const password = normPassword(b.password);
    const role = normRole(b.role);
    const model = normModel(cfg, b.model);
    if (cfg.auth.users.some(u => String(u.user) === name)) throw bad('用户名已存在：' + name, 409);
    const text = readConfigText(cfg);
    if (text === null) throw bad('配置文件不存在，无法保存用户', 409);
    const value = { user: name, password, role };
    if (model) value.model = model;
    const nextText = applyEditsToText(text, [{ path: ['auth', 'users'], append: true, value }]);
    const users = saveUsers(cfg, nextText, auth);
    log.info('auth', (req.user || '-') + ' 新增用户 ' + name + '（' + role + (model ? '，模型 ' + model : '') + '）');
    res.json({ ok: true, users: publicUsers(users) });
  }));

  // 修改密码 / 角色 / 默认模型（只改传入的字段）
  router.patch('/:name', wrap((req, res) => {
    const cfg = requireAuthCfg();
    const name = String(req.params.name || '');
    const idx = cfg.auth.users.findIndex(u => String(u.user) === name);
    if (idx < 0) throw bad('用户不存在：' + name, 404);
    const cur = cfg.auth.users[idx];
    const b = req.body || {};
    const edits = [];
    if (b.password !== undefined) {
      edits.push({ path: ['auth', 'users', idx, 'password'], value: normPassword(b.password) });
    }
    if (b.role !== undefined) {
      const role = normRole(b.role);
      if (cur.role === 'admin' && role !== 'admin' && adminCount(cfg.auth.users) <= 1) {
        throw bad('至少保留一个管理员');
      }
      edits.push({ path: ['auth', 'users', idx, 'role'], value: role });
    }
    if (b.model !== undefined) {
      const model = normModel(cfg, b.model);
      if (model) edits.push({ path: ['auth', 'users', idx, 'model'], value: model });
      else if (cur.model) edits.push({ path: ['auth', 'users', idx, 'model'], delete: true });
    }
    if (!edits.length) throw bad('没有可修改的字段');
    const text = readConfigText(cfg);
    if (text === null) throw bad('配置文件不存在，无法保存用户', 409);
    const users = saveUsers(cfg, applyEditsToText(text, edits), auth);
    log.info('auth', (req.user || '-') + ' 修改用户 ' + name + '：' + Object.keys(b).join(','));
    res.json({ ok: true, users: publicUsers(users) });
  }));

  // 删除（不允许删自己；至少保留一个管理员）
  // 配置先落盘（失败则什么都不动），再尽力清理该用户的数据。
  router.delete('/:name', wrap(async (req, res) => {
    const cfg = requireAuthCfg();
    const name = String(req.params.name || '');
    if (name === String(req.user || '')) throw bad('不能删除当前登录用户');
    const idx = cfg.auth.users.findIndex(u => String(u.user) === name);
    if (idx < 0) throw bad('用户不存在：' + name, 404);
    if (cfg.auth.users[idx].role === 'admin' && adminCount(cfg.auth.users) <= 1) throw bad('至少保留一个管理员');
    const text = readConfigText(cfg);
    if (text === null) throw bad('配置文件不存在，无法保存用户', 409);
    const nextText = applyEditsToText(text, [{ path: ['auth', 'users', idx], delete: true }]);
    const users = saveUsers(cfg, nextText, auth);
    const cleaned = await purgeUserData(name);
    log.info('auth', (req.user || '-') + ' 删除用户 ' + name +
      '（绑定 ' + cleaned.bindings + ' / 会话 ' + cleaned.sessions +
      ' / 画像 ' + cleaned.profiles + ' / 日记 ' + cleaned.fragments + '）');
    res.json({ ok: true, users: publicUsers(users), cleaned });
  }));

  return router;
};
