// 预览网关:单入口端口(:OFFICE_PREVIEW_PORT,默认 3100)按路径路由到槽位 watch —— 槽位号不出容器。
// 主路由:<prefix>/<会话id>/<文档相对路径>/** → 槽位注册表最长前缀匹配 → 转发该槽位 watch。
// 自愈:路由未命中但请求路径本身是存在的会话文档 → 就地复活 watch(watch.revive)——
// 槽位只是缓存不是承诺,闲置回收/被别的会话挤掉后,页面再访问 = 正常冷启动。
// 兜底:vendor 预览页把交互 API 硬编码成根绝对路径(/api/selection、/events…)→ 按 Referer 找回槽位,原样转发。
// masquerade:头白名单 + Host/Origin 成对改写为目标回环自源(watch 自带 DNS-rebinding/跨源防护);
// 凭据永不转发(core 那层已过滤,这里是容器内第二道防线)。
'use strict';
const http = require('node:http');
const watch = require('./watch');

const PREFIX = watch.PREFIX;
// 上游(watch)确实用得到的头;cookie/authorization/referer/sec-fetch/user-agent 等一律不进
const PASS = new Set(['accept', 'accept-encoding', 'cache-control', 'pragma', 'content-type', 'content-length', 'last-event-id', 'if-modified-since', 'if-none-match']);

function forwardTo(entry, req, res, innerPath) { // innerPath：页面内相对路径（主路由剥前缀）或根绝对原路径（Referer 兜底），不再二次加工
  const selfHost = '127.0.0.1:' + entry.port;
  const fwd = { host: selfHost };
  for (const k of Object.keys(req.headers)) if (PASS.has(k)) fwd[k] = req.headers[k];
  if (req.headers.origin) fwd.origin = 'http://' + selfHost;
  const qpos = req.url.indexOf('?');
  const search = qpos >= 0 ? req.url.slice(qpos) : '';
  const inner = innerPath.startsWith('/') ? innerPath : '/' + innerPath;
  // 槽位续命信号:建连即续,此后每帧回传再续(SSE 是长连接,只在建连那刻续会把长驻页面误判成闲置)。
  // conns 记「正在回传」的请求数:conns>0 = 有人正开着预览页,闲置回收/槽位挤占都绕着它走。
  entry.lastUsed = Date.now();
  entry.conns = (entry.conns || 0) + 1;
  let released = false;
  const release = () => { if (!released) { released = true; entry.conns = Math.max(0, entry.conns - 1); } };
  res.once('close', release);
  res.once('finish', release);
  const upstream = http.request(
    { host: '127.0.0.1', port: entry.port, path: encodeURI(inner) + search, method: req.method, headers: fwd },
    (up) => {
      const h = Object.assign({}, up.headers);
      if (String(h['content-type'] || '').includes('text/event-stream')) { h['cache-control'] = 'no-cache'; h['x-accel-buffering'] = 'no'; }
      res.writeHead(up.statusCode, h);
      up.on('data', () => { entry.lastUsed = Date.now(); }); // 含 SSE 心跳/事件帧:任何回传 = 上游活着
      up.pipe(res);
    });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('预览槽位不可达(可能刚停止或已到期回收)');
    else res.destroy();
    release(); // 上面两条终结路径各自触发 close/finish 前,这里幂等兜底
  });
  req.pipe(upstream);
}

function matchReferer(req) {
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return null;
  try {
    const rp = decodeURIComponent(new URL(ref).pathname);
    if (!rp.startsWith(PREFIX + '/')) return null;
    return watch.matchPage(rp.slice(PREFIX.length));
  } catch (_) { return null; }
}

function start(port, host) {
  return http.createServer((req, res) => {
    route(req, res).catch(() => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('预览网关内部错误'); });
  }).listen(port, host);
}

async function route(req, res) {
  let u;
  try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch (_) { res.writeHead(400).end('bad path'); return; }
  if (req.method === 'GET' && u === '/gateway-healthz') {
    const body = JSON.stringify({ ok: true, prefix: PREFIX, slots: watch.status('').length });
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    return;
  }
  if (req.method === 'GET' && u.startsWith('/f/')) return watch.serveDl(decodeURIComponent(u.slice(3)), req, res); // 交付取件口：URL 即能力，只在内部网络可达（core 反代只转 /preview）
  if (u === PREFIX + '/' || u.startsWith(PREFIX + '/')) {
    const rel = u.slice(PREFIX.length) || '/';
    let m = watch.matchPage(rel);
    if (!m) m = await watch.revive(rel); // 槽=缓存:页面重开/冷槽就地复活
    if (m) {
      if (m.exact && !u.endsWith('/')) { res.writeHead(301, { location: (req.url || u) + '/' }).end(); return; } // 相对路径资源解析需要尾斜杠
      const cut = PREFIX.length + m.entry.pageDec.length; // 剥掉「前缀+页面路径」才是 watch 的内层路径
      return forwardTo(m.entry, req, res, u.length > cut ? u.slice(cut) : '/');
    }
  }
  const viaRef = matchReferer(req); // vendor 页面的根绝对 API：Referer 找回来源槽位，原路径原样转发（不剥页面前缀！）
  if (viaRef) return forwardTo(viaRef.entry, req, res, u);
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('无匹配预览(文档不存在/不在会话目录下,或不是 .docx/.xlsx/.pptx；若文档在任务目录里,先 officecli push 进来)');
}

module.exports = { start };
