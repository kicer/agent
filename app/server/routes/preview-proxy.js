// 通用任务预览反代(注册表驱动;officecli 只是第一个条目):
//   <prefix>/** → 服务的单一预览入口端口。槽位/路径解析托管给服务端自己(路由表在它手里),
//   core 只做三件事:鉴权(挂 auth.middleware 之后,信任模型与 data-page 一致 = 登录 ≈ 运维)、
//   头白名单转发(JSON 体因全局 express.json 已消耗,重序列化重放)。
// 另兜一类底:vendor 化预览页会把交互 API 硬编码成根绝对路径(fetch('/api/selection')、
// EventSource('/events')…),这些请求打到 core 根 —— Referer 指向注册预览页时,把【原路径】
// 原样转给对应服务;Referer 不命中的请求,404 行为一切照旧。
// 挂载:server.js 末尾(所有业务路由之后)调 mount(app),兜底路由不吃任何现有路径。
// 注册表:env PREVIEW_PROXIES(JSON 数组)整体覆盖;缺省 = 内置 officecli 一条。
'use strict';
const http = require('http');
const { Router } = require('express');
const log = require('../log');

let services;
try {
  services = process.env.PREVIEW_PROXIES ? JSON.parse(process.env.PREVIEW_PROXIES) : [{
    name: 'officecli', prefix: '/preview',
    host: process.env.OFFICE_MCP_HOST || 'mcp_officecli',
    port: Number(process.env.OFFICE_PREVIEW_PORT || 3100),
  }];
} catch (e) {
  log.error('preview', 'PREVIEW_PROXIES \u89e3\u6790\u5931\u8d25\uff0c\u56de\u9000\u9ed8\u8ba4\u6ce8\u518c\u8868: ' + (e && e.message));
  services = [{
    name: 'officecli', prefix: '/preview',
    host: process.env.OFFICE_MCP_HOST || 'mcp_officecli',
    port: Number(process.env.OFFICE_PREVIEW_PORT || 3100),
  }];
}

// \u5934\u767d\u540d\u5355\uff1a\u51ed\u636e\u4e0e\u516c\u7f51\u8eab\u4efd\uff08cookie/authorization/sec-fetch-*/connection\uff09\u4e00\u5f8b\u4e0d\u51fa\u5bb9\u5668\uff1b
// referer/origin \u5fc5\u987b\u900f\u4f20\uff1a\u670d\u52a1\u7aef\u7f51\u5173\u9760 Referer \u5b9a\u69fd\u4f4d\uff0c\u4e0a\u6e38\u9632\u62a4\u9760 Origin \u5224\u540c\u6e90\u3002
const PASS_HEADERS = new Set(['accept', 'accept-encoding', 'cache-control', 'pragma', 'content-type', 'content-length', 'last-event-id', 'if-modified-since', 'if-none-match', 'referer', 'origin', 'user-agent']);

function forward(svc, req, res, outPath) {
  const fwd = { host: svc.host + ':' + svc.port };
  for (const k of Object.keys(req.headers)) if (PASS_HEADERS.has(k)) fwd[k] = req.headers[k];
  // \u5168\u5c40 express.json \u5728\u672c\u8def\u7531\u4e4b\u524d\u5df2\u628a JSON \u8bf7\u6c42\u4f53\u8bfb\u5e72\uff08req \u6d41\u4e0d\u53ef\u91cd\u653e\uff09\uff1a\u91cd\u65b0\u5e8f\u5217\u5316\u8f6c\u53d1\u3002
  let payload = null;
  if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && req.readableEnded && req.body !== undefined) {
    payload = Buffer.from(JSON.stringify(req.body));
    fwd['content-length'] = String(payload.length);
  }
  const upstream = http.request({ host: svc.host, port: svc.port, path: outPath, method: req.method, headers: fwd }, (up) => {
    const h = Object.assign({}, up.headers);
    if (String(h['content-type'] || '').includes('text/event-stream')) { h['cache-control'] = 'no-cache'; h['x-accel-buffering'] = 'no'; }
    res.writeHead(up.statusCode, h);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).end('\u9884\u89c8\u670d\u52a1\u4e0d\u53ef\u8fbe: ' + svc.name);
    else res.destroy();
  });
  if (payload) upstream.end(payload); else req.pipe(upstream);
}

function serviceByReferer(req) {
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(ref).pathname); } catch (_) { return null; }
  for (const svc of services) if (pathname === svc.prefix || pathname.startsWith(svc.prefix + '/')) return svc;
  return null;
}

// 前置守卫(server.js 需注册在 express.static 之前):vendor 预览页把「取自身新版 HTML」
// 硬编码成根绝对 '/',打到 core 根上会被 SPA 首页吞掉 → 局部 diff 拿到外来页 → 触发
// location.reload() 兜底(白屏一下)。这里只拦 '/':Referer 命中预览前缀时原样转发回
// 对应服务(与兜底路由同一信任模型),其余路径仍由 mount() 末尾兜底。
function earlyGuard(app) {
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path !== '/') return next();
    const svc = serviceByReferer(req);
    if (!svc) return next();
    forward(svc, req, res, '/');
  });
}

function mount(app) {
  for (const svc of services) {
    if (svc.ownership) log.warn('preview', svc.name + ': ownership \u5b57\u6bb5\u672a\u63a5\u7ebf\uff08\u5f53\u524d\u4fe1\u4efb\u6a21\u578b = \u767b\u5f55\u2248\u8fd0\u7ef4\uff0c\u4e0e data-page \u4e00\u81f4\uff09');
    const r = Router();
    r.all('*', (req, res) => forward(svc, req, res, svc.prefix + req.url));
    app.use(svc.prefix, r);
    log.info('preview', svc.name + ' \u2192 ' + svc.host + ':' + svc.port + ' \u2190 ' + svc.prefix + '/**');
  }
  // \u6839\u5bf9\u5bf9\u8def\u5f84\u515c\u5e95\uff1a\u53ea\u63a5\u6765\u81ea\u9884\u89c8\u9875\uff08Referer \u547d\u4e2d\u6ce8\u518c\u524d\u7f00\uff09\u7684\u8bf7\u6c42\uff0c\u5176\u4f59\u8d70\u6b63\u5e38 404
  const fb = Router();
  fb.all('*', (req, res, next) => {
    const svc = serviceByReferer(req);
    if (!svc) return next();
    forward(svc, req, res, req.url);
  });
  app.use(fb);
}

module.exports = { mount, earlyGuard };
