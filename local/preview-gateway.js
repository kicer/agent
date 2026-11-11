#!/usr/bin/env node
// local/preview-gateway.js —— 本地 office 文档预览网关（对位服务器上 executor 的 :3100）。
//
// 为什么要有它：服务器上「点开 docx」这条链路是 core → 反代 /preview → executor 预览网关 →
// 网关自己按需 spawn `officecli watch`。本地没有 executor，那条链路会断，面板里是个空 iframe。
// 这里用零依赖 Node 复刻网关的数据面，但不复刻它的隔离层：
//   服务器给 watch 造 pid/mount ns 牢笼、bind 挂会话 .tmp 到 /tmp，是为了让**沙箱里的命令**
//   和 watch 看见同一个世界（vendor 用 TMPDIR 下的 .port 文件 + TCP 回环发现彼此）。
//   本地既没有沙箱，命令和 watch 本来就在同一个文件系统、同一个临时目录里，
//   那些 unshare/nsenter 不但用不上，有些平台上根本不存在。于是这里只剩四件事：
//
//   1. /preview/<会话id>/<相对路径>/ → 解析成真实文件 → 确保它有 watch → 转发
//   2. /events（SSE）与 /api/*（选区/改内容/切换）→ 按 Referer 找归属的 watch 转发
//   3. 槽位：最多 N 个并发 watch，挤占最久未用的，闲置回收
//   4. 缺 officecli 时给人能看懂的一页，而不是无限转圈（服务器那份二进制是构建期必装的，
//      所以它没为「没装」设计过；本地全新 clone 一定没有，这是常态不是异常）
//
// 平台：只用 Node 内置能力，进程回收/二进制名/可执行位都按平台分支，不假设 POSIX。
// 监听回环（默认 127.0.0.1:3100），唯一入口仍是 core 的 /preview 反代（登录门禁在那边）。
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WIN = process.platform === 'win32';

const HOST = process.env.OFFICE_PREVIEW_HOST || '127.0.0.1';
const PORT = Number(process.env.OFFICE_PREVIEW_PORT || 3100);
const PREFIX = (process.env.OFFICE_PREVIEW_PREFIX || '/preview').replace(/\/+$/, '');
const SLOTS = Math.max(1, Number(process.env.OFFICE_SLOTS || 4));
const WATCH_BASE = Number(process.env.OFFICE_WATCH_BASE || 26315);
const WATCH_SPAN = Math.max(SLOTS, Number(process.env.OFFICE_WATCH_SPAN || 64));
const IDLE_MS = Number(process.env.OFFICE_IDLE_MS || 6 * 3600 * 1000);
const START_TIMEOUT_MS = Number(process.env.OFFICE_START_TIMEOUT_MS || 20000); // 冷启动实测 2~6s，大文档更久
const NAV_WAIT_MS = Number(process.env.OFFICE_NAV_WAIT_MS || 8000);            // 导航请求最多等这么久，超时给中转页
const COOLDOWN_MS = Number(process.env.OFFICE_COOLDOWN_MS || 8000);             // 启动失败后短期内不再重试

// 会话真实目录：默认 <tasks 根>/<会话id>；手选过工作目录的会话要问 core 拿 work_dir（本地免鉴权）。
// tasks 根就是配置里的 workspace_root（local 形态下它等于 <工作目录>/tasks）。
const TASKS_ROOT = path.resolve(process.env.AGENT_TASKS_ROOT || process.cwd());
const SKILLS_ROOT = path.resolve(process.env.AGENT_SKILLS_ROOT || path.join(TASKS_ROOT, '..', 'skills'));
const REPO_ROOT = path.resolve(process.env.AGENT_REPO_ROOT || path.join(__dirname, '..'));
const RUNTIME = path.resolve(process.env.AGENT_RUNTIME || path.join(__dirname, '.runtime'));
const CORE_URL = process.env.AGENT_CORE_URL || '';
const EXTS = new Set(['.docx', '.xlsx', '.pptx']);
const SID_RE = /^task-[0-9A-Za-z_-]+$/;

const slots = new Map();     // 文件绝对路径 → { port, child, lastUsed, conns }
const starting = new Map();  // 文件绝对路径 → Promise：同文件并发请求合并成一次 spawn
const cooldown = new Map();  // 文件绝对路径 → 冷却截止时间戳
const dirCache = new Map();  // 会话id → 真实目录（只缓存命中，避免会话晚建时永久失效）
let portGen = 0;

const log = (msg) => process.stdout.write(new Date().toISOString() + ' ' + msg + '\n');

// ---------- 小工具 ----------
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 二进制解析：每次 spawn 时才做——AI 按技能 AGENTS.md 装好之后，用户点一下刷新就该能用，不该要求重启网关。
// 名字不一定是 officecli：官方资产叫 officecli-<平台>-<架构>[.exe]，AI 很可能原样下载，所以标准名之后
// 再认同目录里任何 officecli* 可执行文件。可执行位只在 POSIX 上有意义，且 curl 下来的资产常常是 0644，
// 这里顺手补一下（不能要求调用者先 chmod）。
function executable(p) {
  if (WIN) {
    try { return fs.statSync(p).isFile(); } catch (_) { return false; }
  }
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) {}
  try { fs.chmodSync(p, 0o755); fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; }
}

function binDirs() {
  return [path.join(SKILLS_ROOT, 'office', 'bin'), path.join(REPO_ROOT, 'skills', 'office', 'bin')];
}

function resolveBin() {
  const env = String(process.env.OFFICECLI_BIN || '').trim();
  if (env && executable(env)) return env;
  const std = WIN ? ['officecli.exe', 'officecli'] : ['officecli'];
  const dirs = binDirs();
  for (const d of dirs) {
    for (const n of std) {
      const p = path.join(d, n);
      if (executable(p)) return p;
    }
  }
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d).sort(); } catch (_) { continue; }
    for (const n of list) {
      if (!/^officecli/i.test(n)) continue;
      if (WIN ? !/\.exe$/i.test(n) : /\.(?:log|txt|md|zip|tar|gz|sha\d*)$/i.test(n)) continue;
      const p = path.join(d, n);
      if (executable(p)) return p;
    }
  }
  return null;
}

function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(400);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

// watch 端口按代轮转，跳过被占用的：AI 手动起的 watch 会占着固定口，不能硬撞。
async function allocPort() {
  for (let i = 0; i < WATCH_SPAN; i++) {
    const p = WATCH_BASE + ((portGen + i) % WATCH_SPAN);
    if (!(await portListening(p))) { portGen = (portGen + i + 1) % WATCH_SPAN; return p; }
  }
  throw new Error('没有空闲的 watch 端口（' + WATCH_BASE + '~' + (WATCH_BASE + WATCH_SPAN - 1) + '）');
}

// 回收 watch：POSIX 上它自成进程组（detached），按组杀才不会留下占端口的子进程；
// Windows 没有进程组信号，用 taskkill /T 连子树一起收。
function killTree(child) {
  if (!child || !child.pid) return;
  if (WIN) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch (_) {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch (_) {}
  }
  try { child.kill('SIGKILL'); } catch (_) {}
}

function killSlot(abs) {
  const s = slots.get(abs);
  if (!s) return;
  slots.delete(abs);
  // 已退出的进程不再按 pid 杀：pid 可能已被系统回给别的进程组（POSIX 上是 -pid）
  if (s.child && s.child.exitCode === null && s.child.signalCode === null) killTree(s.child);
}

function evictOne(keep) {
  const list = [...slots.entries()].filter(([k]) => k !== keep).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const idle = list.filter(([, s]) => !s.conns);
  const victim = (idle.length ? idle : list)[0];
  if (!victim) return;
  killSlot(victim[0]);
  log('挤占槽位 ' + victim[0]);
}

function htmlPage(res, title, body, autoRefresh) {
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>' + escapeHtml(title) + '</title>' +
    (autoRefresh ? '<meta http-equiv="refresh" content="' + autoRefresh + '">' : '') +
    '<style>body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:40px;line-height:1.7;color:#222}' +
    'h1{font-size:18px;margin:0 0 12px}code{background:#f2f2f2;padding:1px 5px;border-radius:3px;font-size:13px}' +
    'p{margin:8px 0;max-width:46em;color:#444}</style></head><body>' +
    '<h1>' + escapeHtml(title) + '</h1>' + body + '</body></html>';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function installPage(res) {
  const bin = path.join(SKILLS_ROOT, 'office', 'bin', WIN ? 'officecli.exe' : 'officecli');
  htmlPage(res, 'office 预览组件未安装',
    '<p>预览需要 <code>officecli</code> 二进制，这台机器上还没有。</p>' +
    '<p>它应该放在 <code>' + escapeHtml(bin) + '</code>。</p>' +
    '<p>让 AI 打开一次这个文档即可（说「用 office 打开这个文档」）——它会按技能目录里的 ' +
    '<code>AGENTS.md</code> 自己下载好；装完点下面的按钮刷新，不用重启服务。</p>' +
    '<p><button onclick="location.reload()">刷新</button></p>');
}

// ---------- 会话目录解析 ----------
function coreGet(pathname) {
  return new Promise((resolve, reject) => {
    if (!CORE_URL) return reject(new Error('未配置 AGENT_CORE_URL'));
    const u = new URL(CORE_URL);
    const req = http.request({ host: u.hostname, port: u.port, path: pathname, method: 'GET', timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('core ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('core 超时')); });
    req.end();
  });
}

async function sessionDir(sid) {
  if (dirCache.has(sid)) return dirCache.get(sid);
  const plain = path.join(TASKS_ROOT, sid);
  let dir = fs.existsSync(plain) ? plain : '';
  if (!dir) {
    // 手选工作目录的会话：只有 core 知道真实路径（sessions.work_dir）
    try {
      const row = await coreGet('/api/sessions/' + encodeURIComponent(sid) + '?limit=1');
      // 接口回的是 { session, messages, ... }，work_dir 在 session 里（limit=1 只为别把整段历史拉回来）
      const wd = String((row && row.session && row.session.work_dir) || '');
      if (wd && fs.existsSync(wd)) dir = wd;
    } catch (_) { /* core 没起来 / 会话不存在：下面按缺失处理 */ }
  }
  if (dir) dirCache.set(sid, dir);
  return dir;
}

// /preview/<sid>/<rel...> → { sid, dir, abs }；逐段解码再拼（整串解码会把 %2F 变成路径分隔符）。
// 越界（..、绝对路径）一律当不存在。
async function resolvePreview(rawPath) {
  const rest = rawPath.slice(PREFIX.length).replace(/^\/+/, '');
  const rawSeg = rest.split('/');
  const rawSid = rawSeg.shift() || '';
  let sid;
  try { sid = decodeURIComponent(rawSid); } catch (_) { return null; }
  if (!SID_RE.test(sid)) return null;
  let rel;
  try { rel = rawSeg.map(decodeURIComponent).join('/'); } catch (_) { return null; }
  const dir = await sessionDir(sid);
  if (!dir) return null;
  const abs = path.resolve(dir, rel.replace(/\/+$/, ''));
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  return { sid, dir, abs };
}

// ---------- watch 生命周期 ----------
async function spawnWatch(abs, dir) {
  const bin = resolveBin();
  if (!bin) {
    const e = new Error('缺少 officecli 二进制');
    e.code = 'MISSING_BIN';
    throw e;
  }
  if (slots.size >= SLOTS) evictOne(abs);
  const port = await allocPort();
  try { await fsp.mkdir(RUNTIME, { recursive: true }); } catch (_) {}
  const logPath = path.join(RUNTIME, 'watch-' + port + '.log');
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(bin, ['watch', abs, '--port', String(port)], {
    cwd: dir,
    detached: !WIN,           // POSIX：自成进程组便于整组回收；Windows 靠 taskkill /T
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: Object.assign({}, process.env, {
      // 与技能封装层同一组开关：无 ICU 环境跑 .NET 不变式模式、改动即落盘、关自动 resident
      DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
      OFFICECLI_NO_AUTO_RESIDENT: '1',
      OFFICECLI_RESIDENT_FLUSH: 'each',
    }),
  });
  try { fs.closeSync(fd); } catch (_) {}
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });
  child.on('error', (e) => { exited = { code: -1, sig: String((e && e.message) || e) }; });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await portListening(port)) {
      const entry = { port, child, lastUsed: Date.now(), conns: 0 };
      slots.set(abs, entry);
      log('起 watch ' + path.basename(abs) + ' @' + port);
      return entry;
    }
    if (exited) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  killTree(child);
  let tail = '';
  try { tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-4).join(' | ').trim(); } catch (_) {}
  const e = new Error('watch 启动失败' + (exited ? '（进程已退出）' : '（超时）') + (tail ? '：' + tail : ''));
  e.code = 'START_FAILED';
  e.logPath = logPath;
  throw e;
}

async function ensureWatch(abs, dir) {
  const have = slots.get(abs);
  if (have) {
    // watch 可能自己退了（vendor 崩溃、被外部 kill）：槽位留着就会一直往死端口转发，
    // 面板上只看得到一个 502。每次拿槽位前探活，死了就丢掉重起。
    if (await portListening(have.port)) { have.lastUsed = Date.now(); return have; }
    log('槽位失效，重起 watch ' + path.basename(abs));
    killSlot(abs);
  }
  const cool = cooldown.get(abs);
  if (cool && Date.now() < cool) {
    const e = new Error('刚才启动失败，稍后再试');
    e.code = 'COOLDOWN';
    throw e;
  }
  if (starting.has(abs)) return starting.get(abs);
  const p = spawnWatch(abs, dir).then(
    (entry) => { starting.delete(abs); cooldown.delete(abs); return entry; },
    (err) => {
      starting.delete(abs);
      cooldown.set(abs, Date.now() + COOLDOWN_MS);
      log('watch 启动失败 ' + abs + '：' + err.message);
      throw err;
    },
  );
  starting.set(abs, p);
  return p;
}

// ---------- 转发 ----------
const PASS_HEADERS = new Set(['accept', 'accept-encoding', 'cache-control', 'pragma', 'content-type',
  'content-length', 'if-modified-since', 'if-none-match', 'last-event-id', 'referer', 'user-agent']);

function forward(port, req, res, outPath, abs) {
  const headers = {};
  for (const k of Object.keys(req.headers)) if (PASS_HEADERS.has(k)) headers[k] = req.headers[k];
  // watch 的同源校验只认回环：从别的名字（host 名解析到 127.0.0.1）打开 core 时会被 403。
  // 网关本身只监听回环、可达即本机，这里把 Origin 归一成上游自己的地址。
  if (req.headers.origin) headers.origin = 'http://127.0.0.1:' + port;

  const upstream = http.request({ host: '127.0.0.1', port, path: outPath, method: req.method, headers }, (up) => {
    const h = Object.assign({}, up.headers);
    delete h.connection; delete h['keep-alive'];
    if (String(h['content-type'] || '').includes('text/event-stream')) {
      h['cache-control'] = 'no-cache';
      h['x-accel-buffering'] = 'no';
    }
    res.writeHead(up.statusCode || 502, h);
    up.pipe(res);
  });
  upstream.on('error', () => {
    // 上游已死：立刻把槽位扔掉，下一次导航（面板重开 / 刷新）会重新拉起，
    // 而不是让这个会话在槽位闲置回收（6h）之前一直 502。
    if (abs) killSlot(abs);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('预览服务不可达，刷新可重新拉起');
    else res.destroy();
  });
  req.pipe(upstream);
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('预览不存在');
}

// 数据请求（SSE / api）：按 Referer 认领，和 core 反代那段兜底同一套信任模型。
function refererPath(req) {
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return null;
  try {
    const p = new URL(ref).pathname;   // 不解码：下面按段解，避免 %2F 被当成分隔符
    return p === PREFIX || p.startsWith(PREFIX + '/') ? p : null;
  } catch (_) { return null; }
}

const server = http.createServer((req, res) => {
  (async () => {
    let rawPath;
    try { rawPath = new URL(req.url, 'http://127.0.0.1').pathname; } catch (_) { return notFound(res); }

    // ---- 预览入口 ----
    if (rawPath === PREFIX || rawPath.startsWith(PREFIX + '/')) {
      const target = await resolvePreview(rawPath);
      if (!target) return notFound(res);
      if (!EXTS.has(path.extname(target.abs).toLowerCase())) return notFound(res);
      let exists = true;
      try { await fsp.access(target.abs); } catch (_) { exists = false; }
      // HEAD 是面板的探针（判断「这份文档在不在」），立刻回，不陪着等冷启动。
      if (req.method === 'HEAD') {
        if (exists) ensureWatch(target.abs, target.dir).catch(() => {});
        res.writeHead(exists ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': '0' });
        return res.end();
      }
      if (!exists) return notFound(res);
      if (!resolveBin()) return installPage(res);

      let entry = null;
      try {
        entry = await Promise.race([
          ensureWatch(target.abs, target.dir),
          new Promise((r) => setTimeout(() => r(null), NAV_WAIT_MS)),
        ]);
      } catch (e) {
        // 启动失败：给人能看懂的一页（附日志位置），别让面板停在转圈上
        return htmlPage(res, '预览启动失败',
          '<p>' + escapeHtml(e.message) + '</p>' +
          (e.logPath ? '<p>日志：<code>' + escapeHtml(e.logPath) + '</code></p>' : '') +
          '<p>稍后点刷新即可重试。</p><p><button onclick="location.reload()">重试</button></p>',
          Math.ceil(COOLDOWN_MS / 1000));
      }
      if (!entry) {
        // 冷启动还没完：给中转页自动刷新，别让 iframe 白屏干等
        return htmlPage(res, '正在准备预览…', '<p>首次打开需要启动预览进程（大文档要几秒）。</p>', 1);
      }
      entry.lastUsed = Date.now();
      return forward(entry.port, req, res, rawPath.slice(PREFIX.length) || '/', target.abs);
    }

    // ---- 页内数据面：/events（SSE）与 /api/* 都是根绝对路径 ----
    if (rawPath === '/events' || rawPath.startsWith('/api/')) {
      const refPath = refererPath(req);
      if (!refPath) return notFound(res);
      const target = await resolvePreview(refPath);
      if (!target) return notFound(res);
      const entry = slots.get(target.abs);
      if (!entry) return notFound(res); // 槽位已被回收：页面下次导航会重新起
      entry.lastUsed = Date.now();
      return forward(entry.port, req, res, req.url, target.abs);
    }

    return notFound(res);
  })().catch((e) => {
    log('请求失败 ' + req.url + '：' + (e && e.message));
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('预览网关内部错误');
  });
});

// 闲置回收：watch 是常驻进程，不回收会一直占着内存与端口（服务器那份是 6h）
const timer = setInterval(() => {
  const now = Date.now();
  for (const [abs, s] of [...slots.entries()]) {
    if (!s.conns && now - s.lastUsed > IDLE_MS) { killSlot(abs); log('回收闲置 watch ' + path.basename(abs)); }
  }
}, 60000);
timer.unref();

function shutdown() {
  for (const abs of [...slots.keys()]) killSlot(abs);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// 退出/崩溃时别把 spawn 出去的 watch 养成孤儿
process.on('exit', () => { for (const abs of [...slots.keys()]) killSlot(abs); });
process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝：' + (e && e.message)));

server.listen(PORT, HOST, () => {
  log('预览网关 listening ' + HOST + ':' + PORT + '  prefix=' + PREFIX + '/' +
    '  tasks=' + TASKS_ROOT + '  skills=' + SKILLS_ROOT + '  slots=' + SLOTS);
});
