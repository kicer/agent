// officecli 预览槽位 + 网关（自 mcp/officecli 的 watch.js/gateway.js 迁入 executor，合一）。
// 数据面根本变化：预览的文件就是 tasks 卷上的真实文件（EXECUTOR_ISOLATION_BASE 挂载点下），
// 不再是另一块盘的拷贝——同步教学 / push / 取件链(/f/) / scratch 清理整条双盘动线随之退役。
// 槽位 = 缓存而非承诺：链接按任务路径寻址 <prefix>/<会话id>/<文档相对路径>/，
// 闲置回收/挤占后页面再访问由本进程 revive 就地冷启动。
// 生命周期：由 executor 服务进程（容器内 PID1）托管 spawn，跨 /exec 存活；
// 二进制取技能资产（skills/office/install.sh 由 init 阶段拉到技能卷，executor :ro 挂载执行）。
// 监听 EXECUTOR_PREVIEW_PORT（默认 3100，只走内网）：core 的通用预览反代（登录 cookie 门禁）是唯一入口；
// /__session-kill 供 core 删会话时尽力清槽（Bearer EXECUTOR_TOKEN，与 /exec 同一信任域）。
'use strict';
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORKSPACE = path.resolve(process.env.EXECUTOR_ISOLATION_BASE || '/mnt/host-tasks');
const PREFIX = (process.env.OFFICE_PREVIEW_PREFIX || '/preview').replace(/\/+$/, '');
const PORT = Number(process.env.EXECUTOR_PREVIEW_PORT || 3100);
const SLOTS = Number(process.env.OFFICE_SLOTS || 4);
const WATCH_BASE = Number(process.env.OFFICE_WATCH_BASE || 26315); // watch 自身端口(+slot)，只绑回环
const IDLE_MS = Number(process.env.OFFICE_IDLE_MS || 6 * 3600 * 1000);
const BIN = process.env.OFFICECLI_BIN || '/workspace/skills/office/bin/officecli';
const TOKEN = String(process.env.EXECUTOR_TOKEN || '');
const EXTS = new Set(['.docx', '.xlsx', '.pptx']);

const slots = new Map(); // slot -> {file, task, rel, port, watch, lastUsed, conns, pageDec, pageEnc}
const starting = new Map(); // 文件绝对路径 -> Promise：同文件并发 watch 合并为一次 spawn（vendor 限制同文件单 watch）

function log(...a) { console.log('[preview]', ...a); }

// 路径护栏：tasks 卷下的办公文档，禁止穿越；必须挂在会话目录下（至少两层，寻址/鉴权都按会话组织）。
function guard(p) {
  const abs = path.resolve(WORKSPACE, String(p || ''));
  const rel = path.relative(WORKSPACE, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path must be inside the workspace: ' + p);
  if (!EXTS.has(path.extname(abs).toLowerCase())) throw new Error('Only .docx/.xlsx/.pptx files are supported: ' + p);
  if (!fs.existsSync(abs)) throw new Error('File not found: ' + p);
  const segs = rel.split(path.sep).filter(Boolean);
  if (segs.length < 2) throw new Error('Preview only supports files under a session directory: ' + p);
  return abs;
}

function pageOf(abs) {
  const segs = path.relative(WORKSPACE, abs).split(path.sep).filter(Boolean);
  return {
    task: segs[0],
    rel: segs.slice(1).join('/'),
    pageDec: '/' + segs.join('/'),
    pageEnc: '/' + segs.map((s) => encodeURIComponent(s)).join('/'),
  };
}

function portUp(port, tries = 40) {
  return new Promise((res, rej) => {
    let n = 0;
    (function probe() {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(); });
      s.on('error', () => { s.destroy(); if (++n >= tries) return rej(new Error('watch server did not come up')); setTimeout(probe, 250); });
    })();
  });
}

async function startWatch(file) {
  const abs = guard(file);
  for (const [, s] of slots) if (s.file === abs) { s.lastUsed = Date.now(); return s; }
  if (starting.has(abs)) {
    try { await starting.get(abs); } catch (_) {}
    for (const [, s] of slots) if (s.file === abs) return s;
    throw new Error('Failed to start watch (concurrent start for the same file); retry');
  }
  const p = spawnWatch(abs).finally(() => starting.delete(abs));
  starting.set(abs, p);
  return p;
}

async function spawnWatch(abs) {
  const page = pageOf(abs);
  let slot = -1;
  for (let i = 0; i < SLOTS; i++) if (!slots.has(i)) { slot = i; break; }
  if (slot < 0) { // 槽满：优先踢「无活动连接且最久未用」；全开着页面才抢最冷的
    const ent = [...slots.entries()];
    const idle = ent.filter(([, s]) => !s.conns);
    slot = (idle.length ? idle : ent).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0];
    stop(slot);
  }
  const wp = WATCH_BASE + slot;
  const child = spawn(BIN, ['watch', abs, '--port', String(wp)], {
    stdio: 'ignore',
    cwd: '/tmp',
    env: { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/tmp', TMPDIR: '/tmp', TZ: process.env.TZ || 'Asia/Shanghai',
      // slim 镜像无 ICU：不变式模式跑 .NET；改动即落盘 + 关自动 resident（与命令侧 wrapper 同一组开关）
      DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
      OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_RESIDENT_FLUSH: 'each' },
  });
  child.on('exit', () => { if (slots.get(slot)?.watch === child) stop(slot); });
  const entry = { file: abs, task: page.task, rel: page.rel, port: wp, watch: child, lastUsed: Date.now(), conns: 0, pageDec: page.pageDec, pageEnc: page.pageEnc };
  slots.set(slot, entry); // 同步占坑：等端口就绪期间并发不会踩同一槽
  try {
    await portUp(wp);
  } catch (e) {
    child.kill();
    if (slots.get(slot) === entry) slots.delete(slot);
    throw new Error('Failed to start watch: ' + e.message);
  }
  log(`slot${slot} ${abs} watch:${wp} page=${PREFIX}${page.pageDec}`);
  return entry;
}

function stop(slot) {
  const s = slots.get(slot);
  if (!s) return false;
  try { s.watch.kill(); } catch (_) {}
  slots.delete(slot);
  log(`slot${slot} 已停止`);
  return true;
}

// core 删会话尽力清槽：不删任何数据（盘上的就是任务本体，删目录是 core 自己的事）。
function stopSession(taskId) {
  const t = String(taskId || '');
  const stopped = [];
  for (const [slot, s] of [...slots]) if (s.task === t) { stop(slot); stopped.push(s.rel || s.file); }
  return { session: t, stopped };
}

// 路由：rel = 已解码、剥掉 PREFIX 的请求路径；exact = 页面本身（缺尾斜杠由 301 补），最长前缀优先。
function matchPage(rel) {
  if (!rel) return null;
  const rr = rel.startsWith('/') ? rel : '/' + rel;
  let best = null;
  for (const s of slots.values()) {
    if (rr === s.pageDec) return { entry: s, exact: true };
    if (rr.startsWith(s.pageDec + '/')) {
      if (!best || s.pageDec.length > best.entry.pageDec.length) best = { entry: s, exact: false };
    }
  }
  return best;
}

// 未命中兜底：请求路径本身就是存在的会话文档 → 回收/挤掉后就地复活；不行 = 维持 404。
async function revive(rel) {
  const rr = (rel || '').replace(/\/+$/, '');
  if (!rr || rr === '/') return null;
  try {
    await startWatch(path.join(WORKSPACE, rr));
    return matchPage(rr);
  } catch (_) { return null; }
}

// ---------- 网关转发（原 gateway.js：槽位号不出容器） ----------
// 上游(watch)确实用得到的头；cookie/authorization 等一律不进（core 那层已过滤，这是第二道防线）。
const PASS = new Set(['accept', 'accept-encoding', 'cache-control', 'pragma', 'content-type', 'content-length', 'last-event-id', 'if-modified-since', 'if-none-match']);

function forwardTo(entry, req, res, innerPath) {
  const selfHost = '127.0.0.1:' + entry.port;
  const fwd = { host: selfHost };
  for (const k of Object.keys(req.headers)) if (PASS.has(k)) fwd[k] = req.headers[k];
  if (req.headers.origin) fwd.origin = 'http://' + selfHost;
  const qpos = req.url.indexOf('?');
  const search = qpos >= 0 ? req.url.slice(qpos) : '';
  const inner = innerPath.startsWith('/') ? innerPath : '/' + innerPath;
  // 槽位续命：建连即续，此后每帧回传再续（SSE 长连接只在建连续会把常驻页面误判成闲置）；
  // conns>0 = 有人正开着预览页，闲置回收/槽位挤占都绕着它走。
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
      up.on('data', () => { entry.lastUsed = Date.now(); });
      up.pipe(res);
    });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('预览槽位不可达(可能刚停止或已到期回收)');
    else res.destroy();
    release();
  });
  req.pipe(upstream);
}

// vendor 预览页把交互 API 硬编码成根绝对路径(/api/selection、/events…)：按 Referer 找回来源槽位，原路径原样转发（不剥页面前缀）。
function matchReferer(req) {
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return null;
  try {
    const rp = decodeURIComponent(new URL(ref).pathname);
    if (!rp.startsWith(PREFIX + '/')) return null;
    return matchPage(rp.slice(PREFIX.length));
  } catch (_) { return null; }
}

function tokenOk(req) {
  if (!TOKEN) return true; // 没配 token = 本部署不启用鉴权（与 server.js 同语义）
  return String(req.headers.authorization || '') === 'Bearer ' + TOKEN;
}

function handleSessionKill(req, res) {
  if (!tokenOk(req)) { res.writeHead(403).end('bad token'); return; }
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let sid = '';
    try { sid = String(JSON.parse(body || '{}').session || ''); } catch (_) {}
    if (!sid || sid === '.' || sid === '..' || /[/\\\0]/.test(sid)) {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad session"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stopSession(sid)));
  });
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    .end('无匹配预览(文档不存在/不在会话目录下,或不是 .docx/.xlsx/.pptx)');
}

async function route(req, res) {
  if (req.method === 'POST' && req.url.split('?')[0] === '/__session-kill') return handleSessionKill(req, res);
  let u;
  try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch (_) { res.writeHead(400).end('bad path'); return; }
  if (req.method === 'GET' && u === '/gateway-healthz') {
    const body = JSON.stringify({ ok: true, prefix: PREFIX, slots: slots.size, bin: BIN, bin_ready: fs.existsSync(BIN) });
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    return;
  }
  if (u === PREFIX + '/' || u.startsWith(PREFIX + '/')) {
    const rel = u.slice(PREFIX.length) || '/';
    let m = matchPage(rel);
    if (!m) m = await revive(rel); // 槽=缓存：页面重开/冷槽就地复活
    if (m) {
      if (m.exact && !u.endsWith('/')) { res.writeHead(301, { location: (req.url || u) + '/' }).end(); return; } // 相对资源解析需要尾斜杠
      const cut = PREFIX.length + m.entry.pageDec.length; // 剥掉「前缀+页面路径」才是 watch 的内层路径
      return forwardTo(m.entry, req, res, u.length > cut ? u.slice(cut) : '/');
    }
  }
  const viaRef = matchReferer(req);
  if (viaRef) return forwardTo(viaRef.entry, req, res, u);
  notFound(res);
}

function start() {
  const srv = http.createServer((req, res) => {
    route(req, res).catch(() => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('预览网关内部错误'); });
  });
  srv.listen(PORT, '0.0.0.0', () => log('监听 :' + PORT + ' 前缀=' + PREFIX + ' 工作区=' + WORKSPACE + ' 二进制' + (fs.existsSync(BIN) ? '就位' : '缺失(镜像未烘入?)')));
  setInterval(() => {
    const now = Date.now();
    // 有活动连接的槽 = 有人正开着页面，永不闲置回收（槽满时它最后被抢，见 spawnWatch）
    for (const [slot, s] of [...slots]) if (!s.conns && now - s.lastUsed > IDLE_MS) { log(`slot${slot} 闲置回收`); stop(slot); }
  }, 60000).unref();
  return srv;
}

module.exports = { start, stopSession };
