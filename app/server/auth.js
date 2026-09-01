// 多用户会话认证：用户名/明文密码配在 config.yml 的 auth.users，登录后签发 HMAC 签名 token，
// 以 HttpOnly cookie 下发（SameSite=Lax，浏览器在 XHR 与原生下载导航中都会自动携带）。
// 替代原先 nginx htpasswd 的 basic auth：手机浏览器原生下载不带 Basic 认证头，导致下载失败。
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { readConfigText, applyEditsToText, loadConfigFromText, writeConfigText } = require('./config');

const COOKIE_NAME = 'agent_token';
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

function b64url(buf) {
  return Buffer.from(buf).toString('base64url').replace(/=+$/, '');
}
function timingEqual(a, b) {
  // 先哈希再定长比较：timingSafeEqual 要求等长 buffer，哈希后既定长又避免长度旁路
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- token：payloadB64url.signature（无状态，密钥变更/重启即失效） ----------
function signToken(username, expires, secret) {
  const payload = b64url(Buffer.from(JSON.stringify({ u: username, exp: expires }), 'utf8'));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return payload + '.' + sig;
}

function readToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (!timingEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.u !== 'string' || !Number.isFinite(data.exp) || data.exp < Date.now()) return null;
    return { user: data.u };
  } catch (_) { return null; }
}

// ---------- cookie / basic 凭据解析 ----------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Authorization: Basic 兼容层（curl / API 脚本用；浏览器页面下载走 cookie）
function basicAuthUser(req, users) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Basic ')) return null;
  let decoded;
  try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (_) { return null; }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const name = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  for (const u of users) {
    if (timingEqual(u.user, name) && timingEqual(u.password, pass)) return u.user;
  }
  return null;
}

// ---------- 免认证路径（登录页自身需要的资源） ----------
const PUBLIC_EXACT = new Set(['/login', '/logout', '/api/login', '/api/logout', '/api/health']);
function isPublicPath(p) {
  if (PUBLIC_EXACT.has(p)) return true;
  if (p.startsWith('/css/')) return true; // 登录页复用 style.css
  if (p === '/favicon.ico') return true;
  return false;
}

// 带签名 token 的临时下载链接（files.js 自己验签），此处放行由路由层拒绝伪造请求
function isSignedDownload(req) {
  return req.method === 'GET' && /\/files\/download$/.test(req.path) && !!req.query.t;
}

// cfg.auth = { users: [{user, password}], secret?, ttl_ms? }
// users 为空则整个认证关闭（cfg.auth 为 null）。
function createAuth(cfg) {
  const router = express.Router();
  const users = (cfg.auth && cfg.auth.users) || [];
  if (!users.length) {
    return { enabled: false, middleware: (req, res, next) => next(), router };
  }

  const secret = (cfg.auth.secret && String(cfg.auth.secret)) || crypto.randomBytes(32).toString('hex');
  if (!cfg.auth.secret) {
    console.log('[auth] 未配置 auth.secret，已使用随机密钥：进程重启后所有登录态失效');
  }
  const ttlMs = Number(cfg.auth.ttl_ms) || DEFAULT_TTL_MS;
  const validUsers = new Map(users.map(u => [String(u.user), String(u.password)]));

  function setAuthCookie(res, username) {
    const token = signToken(username, Date.now() + ttlMs, secret);
    res.setHeader('Set-Cookie', COOKIE_NAME + '=' + encodeURIComponent(token)
      + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(ttlMs / 1000));
  }
  function clearAuthCookie(res) {
    res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  }
  function sessionUser(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    const data = readToken(token, secret);
    // 用户可能已从配置中删除：token 有效但用户不存在也视为未登录
    if (data && validUsers.has(data.user)) return data.user;
    return null;
  }

  // ----- 登录/登出 API -----
  router.post('/api/login', (req, res) => {
    const { user, password } = req.body || {};
    const expect = validUsers.get(String(user || ''));
    if (expect == null || !timingEqual(expect, String(password == null ? '' : password))) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    setAuthCookie(res, String(user));
    res.json({ ok: true, user: String(user) });
  });

  router.post('/api/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  // ----- 修改密码(设置页) -----
  // 已登录即可改自己的密码(免输原密码) → 写回 config.yml(保留注释,校验失败不动文件)
  // → 同步更新内存(users/validUsers),立即生效无需重启。
  // 已签发的 token 不失效(HMAC 无状态);其他设备下次登录才需新密码。
  // 注:本路由挂在认证中间件之前,需手动验登录态。
  router.post('/api/password', (req, res) => {
    try {
      const me = sessionUser(req);
      if (!me) return res.status(401).json({ error: '未登录' });
      const newP = String((req.body && req.body.new_password == null ? '' : req.body.new_password));
      if (newP.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
      const idx = users.findIndex(u => String(u.user) === me);
      if (idx < 0) return res.status(404).json({ error: '当前用户已不在配置中' });
      if (newP === users[idx].password) return res.status(400).json({ error: '新密码与当前密码相同' });
      const text = readConfigText(cfg);
      if (text === null) return res.status(409).json({ error: '配置文件不存在,无法持久化新密码' });
      let nextText;
      try {
        nextText = applyEditsToText(text, [{ path: ['auth', 'users', String(idx), 'password'], value: newP }]);
        loadConfigFromText(nextText, cfg.config_path);
      } catch (e) {
        return res.status(400).json({ error: '写入配置失败:' + String(e && e.message || e) });
      }
      writeConfigText(cfg, nextText);
      // 内存同步:users 与 engine.cfg 是同一对象,Basic 认证实时生效;cookie 登录查 validUsers
      users[idx].password = newP;
      validUsers.set(me, newP);
      console.log('[auth] 用户 ' + me + ' 修改了密码');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e && e.message || e) });
    }
  });

  router.get('/api/me', (req, res) => {
    res.json({ user: sessionUser(req) });
  });

  // ----- 登录页 / 登出跳转 -----
  router.get('/login', (req, res) => {
    if (sessionUser(req)) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  router.get('/logout', (req, res) => {
    clearAuthCookie(res);
    res.redirect('/login');
  });

  // ----- 全局认证中间件：cookie 或 Basic 任一通过；否则 API 回 401、页面跳登录页 -----
  const middleware = (req, res, next) => {
    const fromBasic = basicAuthUser(req, users);
    const user = fromBasic || sessionUser(req);
    if (user) { req.user = user; return next(); }
    if (isPublicPath(req.path) || isSignedDownload(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未登录' });
    return res.redirect('/login');
  };

  return { enabled: true, middleware, router };
}

module.exports = { createAuth, COOKIE_NAME };
