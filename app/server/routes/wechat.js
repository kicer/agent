// 微信接入路由：
// 本文件默认导出 = Web 侧 router（挂在 auth.middleware 之后，cookie 鉴权 + req.user 隔离）；
// 具名导出 hookRouter = wxbot → core 的内网回调入口（/wxhook/*），挂在 auth.middleware 与全局
// express.json 之前（媒体转发的 base64 远超 2mb，由下方专用大限额解析器处理），
// 凭 Bearer 服务 token（常量时间比较）把门。业务全在 wechat.js，这里只做鉴权、归属过滤与 HTTP 形状。
const crypto = require('crypto');
const express = require('express');
const engine = require('../engine');
const wechat = require('../wechat');

const router = express.Router();
const hookRouter = express.Router();
// wxbot 专用 JSON 入口：媒体 base64 大 body（解码后限 20MB，b64 膨胀 4/3）；比全局 2mb 宽得多。
// 本 router 先于全局解析器挂载，body-parser 认到 req._body 后全局那份会自动跳过。
hookRouter.use(express.json({ limit: '32mb' }));

function wrap(fn) {
  return function (req, res) {
    try {
      const r = fn(req, res);
      if (r && typeof r.catch === 'function') r.catch(err => sendErr(res, err));
    } catch (err) {
      sendErr(res, err);
    }
  };
}

function sendErr(res, err) {
  const code = err && err.status_code || 500;
  res.status(code).json({ error: String(err && err.message || err) });
}

// 先哈希再定长比较（同 auth.js timingEqual）：避免长度旁路与提前返回侧信道
function timingEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- wxbot 内网回调 ----------
function requireService(req, res, next) {
  const cfg = engine.getConfig();
  const token = (cfg.wxbot && cfg.wxbot.token) || '';
  if (!token) return res.status(503).json({ error: '微信接入服务 token 未配置（env WXBOT_TOKEN）' });
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ') || !timingEqual(h.slice(7).trim(), token)) {
    return res.status(401).json({ error: 'invalid service token' });
  }
  next();
}

// 来消息 → channel 层。非 2xx 时 wxbot 会把 {error} 文案回给微信用户（出错出声）。
hookRouter.post('/inbox', requireService, wrap((req, res) => {
  res.json(wechat.handleInbox(req.body) || { ok: true });
}));

// 实例状态回调（online/expired/error/offline）：失败只当丢弃（绑定行没了 = 已解绑）。
hookRouter.post('/hook', requireService, wrap((req, res) => {
  const hit = wechat.handleHook(req.body);
  res.json({ ok: true, ignored: !hit });
}));

// ---------- Web API ----------
function rowFor(req) {
  const b = wechat.getBinding(String(req.params.id || ''));
  if (!b || b.user !== String(req.user || '')) {
    throw Object.assign(new Error('绑定不存在'), { status_code: 404 });
  }
  return b;
}

// 面板总览：enabled=false（WXBOT_URL/WXBOT_TOKEN 未就位）时前端整卡隐藏——没配置就当功能不存在；
// alive/has_qr 与状态自愈全在 wechat.overview()（hook 丢事件也能从实例快照纠回来）。
router.get('/', wrap(async (req, res) => {
  res.json(await wechat.overview(String(req.user || '')));
}));

router.post('/', wrap(async (req, res) => {
  const b = await wechat.createBinding(String(req.user || ''));
  res.json(b);
}));

router.get('/:id', wrap((req, res) => {
  res.json(rowFor(req));
}));

// QR 代理：wxbot SVG 原样透传（前端 <img> 带 cookie 即可，服务 token 不出内网）。
// 无码可给（已上线/未生成/wxbot 不可达）统一 404 {error}，前端按绑定状态渲染占位，不出红叉。
router.get('/:id/qr', wrap(async (req, res) => {
  const b = rowFor(req);
  const r = await wechat.qrSvg(b);
  if (r.none) return res.status(404).json({ error: '当前没有待扫二维码（可能已上线，或点「刷新」重新获取）' });
  res.type('image/svg+xml').send(r.svg);
}));

router.post('/:id/refresh', wrap(async (req, res) => {
  const b = rowFor(req);
  res.json(await wechat.refreshBinding(b.id));
}));

router.delete('/:id', wrap(async (req, res) => {
  const b = rowFor(req);
  res.json(await wechat.deleteBinding(b.id));
}));

module.exports = router;
module.exports.hookRouter = hookRouter;
