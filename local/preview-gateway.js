#!/usr/bin/env node
// local/preview-gateway.js —— 本地 office 文档预览网关（对位服务器上 executor 的 :3100）。
//
// 为什么要有它：服务器上「点开 docx」这条链是 core → 反代 /preview → executor 预览网关 →
// 网关自己按需 spawn `officecli watch`。本地没有 executor，那条链路会断，面板里是个空 iframe。
// 这里用零依赖 Node 复刻 executor/preview.js 的**数据面**，但不复刻它的隔离层：
//   服务器给 watch 造 pid/mount ns 牢笼、bind 会话 .tmp 到 /tmp，是为了让**沙箱里的命令**
//   和 watch 看见同一个世界（vendor 用 TMPDIR 下的 .port 文件 + TCP 回环发现彼此）。
//   本地既没有沙箱，命令和 watch 本来就在同一个文件系统、同一个临时目录里，
//   那些 unshare/nsenter 不但用不上，有些平台上根本不存在。于是这里只剩数据面：
//
//   1. /preview/<会话id>/<相对路径>/ → 解析成真实文件 → 确保它有 watch → 转发
//   2. 页内数据面（/events、/api/*、以及 vendor 拿去比对自身的 /）→ 按 Referer 认领槽位转发
//   3. 槽位：最多 N 个并发 watch，挤占最久未用的，闲置回收
//   4. 缺 officecli 时给人能看懂的一页，而不是无限转圈（服务器那份二进制是构建期必装的，
//      所以 executor 那份没为「没装」设计过；本地全新 clone 一定没有，这是常态不是异常）
//
// 与服务器实现逐条对齐的几处（都踩过，别简化掉）：
//   - 探活 = 真发一次 `GET /`（首帧渲染就在这次请求里完成），裸 TCP 连上只说明 Kestrel bind 好了
//   - HEAD 探针等槽位就绪（有上限）再回 200：否则冷启动的首次渲染全砸在 iframe 的导航请求上
//   - 导航请求绝不为启动/自愈阻塞首字节：未就绪 → 立刻回中转页 + 后台热槽
//   - vendor 页把 `/` 当作「自身最新 HTML」来比对，回 404 它就 location.reload() —— 用户看到白屏
//   - 外部写盘（不走 officecli 的）靠 mtime 指纹 + 2s 轮询 POST /api/switch 触发重读
//
// 平台：只用 Node 内置能力，进程回收/二进制名/可执行位都按平台分支，不假设 POSIX。
// 监听回环（默认 127.0.0.1:3100），唯一入口仍是 core 的 /preview 反代（登录门禁在那边）。
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const http = require('node:http');
const net = require('node:net');
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
const RESPOND_TIMEOUT_MS = Number(process.env.OFFICE_RESPOND_TIMEOUT_MS || 15000); // 数据请求等首响包
const NAV_TIMEOUT_MS = Number(process.env.OFFICE_NAV_TIMEOUT_MS || 5000);         // 导航请求更短：失败转中转页
const COOLDOWN_MS = Number(process.env.OFFICE_COOLDOWN_MS || 8000);               // 启动失败后短期不再重试
const HEAD_WAIT_MS = Number(process.env.OFFICE_HEAD_WAIT_MS || 15000);            // 探针等首帧的上限
const NAV_TIMEOUT_RETRIES = 3;                                                   // 连续导航超时几次才判死

// 会话真实目录：默认 <tasks 根>/<会话id>；手选过工作目录的会话要问 core 拿 work_dir（本地免鉴权）。
const TASKS_ROOT = path.resolve(process.env.AGENT_TASKS_ROOT || process.cwd());
const SKILLS_ROOT = path.resolve(process.env.AGENT_SKILLS_ROOT || path.join(TASKS_ROOT, '..', 'skills'));
const REPO_ROOT = path.resolve(process.env.AGENT_REPO_ROOT || path.join(__dirname, '..'));
const RUNTIME = path.resolve(process.env.AGENT_RUNTIME || path.join(__dirname, '.runtime'));
const CORE_URL = process.env.AGENT_CORE_URL || '';
const EXTS = new Set(['.docx', '.xlsx', '.pptx']);
const SID_RE = /^task-[0-9A-Za-z_-]+$/;

const slots = new Map();     // 文件绝对路径 → { file, port, watch, pageDec, ready, readyP, lastUsed, conns, ... }
const starting = new Map();  // 文件绝对路径 → Promise：同文件并发请求合并成一次 spawn
const cooldown = new Map();  // 文件绝对路径 → 冷却截止时间戳
const dirCache = new Map();  // 会话id → 真实目录（只缓存命中，避免会话晚建时永久失效）
let watchGen = 0;            // watch 端口按代轮转：残留孤儿占着旧口也不会被新槽撞上

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

// 端口能不能连上（判「有没有人在听」）。注意它**不能**当就绪判定：Kestrel bind 完成就能连，
// 首帧还没渲染；就绪一律用 portUp（真发一次 GET /）。
function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false)); // 回环上不回 SYN 几乎不存在，按空闲处理
    s.once('error', () => fin(false));
  });
}

// 就绪探活：真发一次 `GET /`（首帧渲染在这次请求里完成，后续浏览器请求走 vendor 的页内缓存）。
// 任何状态码都算活着；拒连/超时继续重试，预算 40 次 x 250ms。
function portUp(port, tries = 40) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const probe = () => {
      const rq = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (up) => {
        up.resume();
        resolve();
      });
      const retry = () => {
        if (++n >= tries) return reject(new Error('watch 未在预期时间内就绪'));
        setTimeout(probe, 250);
      };
      rq.on('error', retry);
      rq.on('timeout', () => { try { rq.destroy(); } catch (_) {} retry(); });
    };
    probe();
  });
}

// 端口代次轮转 + 领取前确认空闲：AI 手动起的 watch、以及被杀的旧 watch 残留，都占着固定口。
async function allocPort() {
  for (let i = 0; i < WATCH_SPAN; i++) {
    const p = WATCH_BASE + (watchGen++ % WATCH_SPAN);
    let used = false;
    for (const s of slots.values()) if (s.port === p) { used = true; break; }
    if (used) continue;
    if (!(await portListening(p))) return p;
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

function killWatch(entry) {
  // 已退出的进程不再按 pid 杀：pid 可能已被系统回给别的进程组（POSIX 上是 -pid）
  if (entry.watch && entry.watch.exitCode === null && entry.watch.signalCode === null) killTree(entry.watch);
}

function stopEntry(entry, why) {
  const key = entry.file;
  if (slots.get(key) === entry) slots.delete(key);
  killWatch(entry);
  if (why) log('回收槽位 ' + path.basename(key) + '（' + why + '）');
}

// ---------- 页面 ----------
function htmlPage(res, title, body, autoRefresh, code) {
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>' + escapeHtml(title) + '</title>' +
    (autoRefresh ? '<meta http-equiv="refresh" content="' + autoRefresh + '">' : '') +
    '<style>body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:40px;line-height:1.7;color:#222}' +
    'h1{font-size:18px;margin:0 0 12px}code{background:#f2f2f2;padding:1px 5px;border-radius:3px;font-size:13px}' +
    'p{margin:8px 0;max-width:46em;color:#444}</style></head><body>' +
    '<h1>' + escapeHtml(title) + '</h1>' + body + '</body></html>';
  res.writeHead(code || 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// 中转页：槽位在启动/刚死，先给浏览器一个纯 CSS 转圈 + 自动刷新，别白屏干等（与服务器同一张页）。
function loading(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">' +
    '<title>正在准备预览</title><style>' +
    'html,body{height:100%;margin:0;font-family:system-ui,-apple-system,sans-serif;background:#fafafa;color:#666}' +
    '.w{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center}' +
    '.s{width:36px;height:36px;margin:0 auto 14px;border:3px solid #ddd;border-top-color:#4a90d9;border-radius:50%;animation:r 1s linear infinite}' +
    '@keyframes r{to{transform:rotate(360deg)}}p{font-size:14px}' +
    '</style><div class="w"><div class="s"></div><p>正在准备预览，请稍候。</p></div>');
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

function notFound(res) {
  // no-store：前端拿 HEAD 当探针，404 一旦被浏览器缓存，文件补上后还会继续显示「暂无文档」
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    .end('无匹配预览（文档不存在、不在会话目录下，或不是 .docx/.xlsx/.pptx）');
}

function fail502(res) {
  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('预览暂时不可用，请稍后重试');
  }
}

// ---------- 会话目录与路径护栏 ----------
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
    // 手选工作目录的会话：只有 core 知道真实路径（sessions.work_dir）。
    // 接口回的是 { session, ... }，limit=1 只为别把整段历史拉回来。
    try {
      const row = await coreGet('/api/sessions/' + encodeURIComponent(sid) + '?limit=1');
      const wd = String((row && row.session && row.session.work_dir) || '');
      if (wd && fs.existsSync(wd)) dir = wd;
    } catch (_) { /* core 没起来 / 会话不存在：下面按缺失处理 */ }
  }
  if (dir) dirCache.set(sid, dir);
  return dir;
}

// /preview/<会话id>/<相对路径> → { sid, dir, abs, rel }；越界（..、绝对路径）与非办公文档一律 null。
async function guard(sid, rawRel) {
  if (!SID_RE.test(sid)) return null;
  const dir = await sessionDir(sid);
  if (!dir) return null;
  const rel = rawRel.replace(/^\/+/, '');
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  if (!EXTS.has(path.extname(abs).toLowerCase())) return null;
  try { await fsp.access(abs); } catch (_) { return null; }
  return { sid, dir, abs, rel: path.relative(dir, abs).split(path.sep).join('/') };
}

function pageOf(t) {
  return '/' + t.sid + '/' + t.rel; // 页面前缀（已解码）：槽位按它寻址
}

// 路由：rel = 已解码、剥掉 PREFIX 的请求路径（形如 /task-x/doc.docx/…）；最长前缀优先。
// exact = 命中的就是页面本身（此时缺尾斜杠要 301，否则页面内相对资源会解析错）。
function matchPage(rel) {
  if (!rel) return null;
  const rr = rel.startsWith('/') ? rel : '/' + rel;
  const cut = rr.replace(/\/+$/, '');
  let best = null;
  for (const s of slots.values()) {
    if (cut === s.pageDec) return { entry: s, exact: true };
    if (cut.startsWith(s.pageDec + '/')) {
      if (!best || s.pageDec.length > best.entry.pageDec.length) best = { entry: s, exact: false };
    }
  }
  return best;
}

// ---------- watch 生命周期 ----------
async function spawnWatch(t) {
  const bin = resolveBin();
  if (!bin) {
    const e = new Error('缺少 officecli 二进制');
    e.code = 'MISSING_BIN';
    throw e;
  }
  // 槽满：优先踢「就绪且无活动连接」里最久未用的；正在启动的槽最后才动（踢掉它等于白费冷启动）
  if (slots.size >= SLOTS) {
    const list = [...slots.values()];
    const pick = (list.filter((s) => !s.conns && s.ready).length ? list.filter((s) => !s.conns && s.ready)
      : list.filter((s) => !s.conns).length ? list.filter((s) => !s.conns) : list)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (pick) stopEntry(pick, '槽满挤占');
  }
  const port = await allocPort();
  try { await fsp.mkdir(RUNTIME, { recursive: true }); } catch (_) {}
  const logPath = path.join(RUNTIME, 'watch-' + port + '.log');
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(bin, ['watch', t.abs, '--port', String(port)], {
    cwd: t.dir,
    detached: !WIN,           // POSIX：自成进程组便于整组回收；Windows 靠 taskkill /T
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: Object.assign({}, process.env, {
      // 与技能封装层同一组开关：不变式模式跑 .NET、改动即落盘、关自动 resident
      DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
      OFFICECLI_NO_AUTO_RESIDENT: '1',
      OFFICECLI_RESIDENT_FLUSH: 'each',
    }),
  });
  try { fs.closeSync(fd); } catch (_) {}

  const entry = {
    file: t.abs, port, watch: child, pageDec: pageOf(t),
    lastUsed: Date.now(), conns: 0, ready: false, readyP: null, navTimeouts: 0,
    mtimeMs: 0, size: -1, logPath,
  };
  let exited = null;
  child.on('exit', (code, sig) => {
    exited = { code, sig };
    if (slots.get(entry.file) === entry) slots.delete(entry.file); // 死了就别留在册（否则一直转发到死端口）
  });
  child.on('error', (e) => { exited = { code: -1, sig: String((e && e.message) || e) }; });
  slots.set(entry.file, entry); // 同步占坑（未就绪）：并发请求等 readyP，绝不盲转发

  let markDead;
  const dead = new Promise((_, rej) => { markDead = rej; });
  const deadTimer = setInterval(() => { if (exited) markDead(new Error('watch 进程提前退出')); }, 100);
  deadTimer.unref();

  entry.readyP = Promise.race([
    portUp(port).then(() => { entry.ready = true; log('起 watch ' + path.basename(t.abs) + ' @' + port); }),
    dead,
  ]).catch((e) => {
    if (slots.get(entry.file) === entry) slots.delete(entry.file);
    killWatch(entry);
    throw e instanceof Error ? e : new Error('watch 启动失败：' + ((e && e.message) || e));
  }).finally(() => clearInterval(deadTimer));

  try {
    await entry.readyP;
  } catch (e) {
    let tail = '';
    try { tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-3).join(' | ').trim(); } catch (_) {}
    const err = new Error(e.message + (tail ? '：' + tail : ''));
    err.logPath = logPath;
    throw err;
  }
  // mtime+size 作为本次渲染的指纹：导航侧对照，外部写盘后回收重渲染
  try { const st = await fsp.stat(t.abs); entry.mtimeMs = st.mtimeMs; entry.size = st.size; } catch (_) {}
  return entry;
}

async function startWatch(t) {
  const have = slots.get(t.abs);
  if (have) { have.lastUsed = Date.now(); return have; }
  const cool = cooldown.get(t.abs);
  if (cool && Date.now() < cool) throw new Error('刚才启动失败，稍后再试');
  if (starting.has(t.abs)) return starting.get(t.abs);
  const p = spawnWatch(t).then(
    (entry) => { starting.delete(t.abs); cooldown.delete(t.abs); return entry; },
    (err) => {
      starting.delete(t.abs);
      cooldown.set(t.abs, Date.now() + COOLDOWN_MS);
      log('watch 启动失败 ' + t.abs + '：' + err.message);
      throw err;
    },
  );
  starting.set(t.abs, p);
  return p;
}

// 未命中兜底：请求路径本身就是存在的会话文档 → 就地冷启动。不行 = null。
async function revive(decRel) {
  const rr = (decRel || '').replace(/\/+$/, '');
  if (!rr) return null;
  const segs = rr.split('/').filter(Boolean);
  const sid = segs.shift() || '';
  const t = await guard(sid, segs.join('/'));
  if (!t) return null;
  try { await startWatch(t); return { entry: slots.get(t.abs), exact: false }; } catch (_) { return null; }
}

// 数据请求用：拿到「就绪」的槽位，等正在启动的那次；启动刚失败就再补一次。
async function waitReady(decRel) {
  for (let round = 0; round < 2; round++) {
    let m = matchPage(decRel);
    if (!m) m = await revive(decRel);
    if (!m || !m.entry) return null;
    if (m.entry.ready) return m;
    await m.entry.readyP.catch(() => {});
    if (m.entry.ready) return m;
  }
  return null;
}

// 探针预热：把槽位等到「就绪」（= 首帧渲染完成），复用时直接返回。任何失败/超时都静默。
async function warmSlot(decRel, t) {
  let timer;
  try {
    await Promise.race([
      (async () => {
        const have = slots.get(t.abs);
        if (have && have.ready) return;
        const e = await startWatch(t);
        if (!e.ready) await e.readyP.catch(() => {});
      })(),
      new Promise((r) => { timer = setTimeout(r, HEAD_WAIT_MS); }),
    ]);
  } catch (_) {} finally { clearTimeout(timer); }
}

// 就地重读：POST watch /api/switch（同路径 = 强制从磁盘重载），watch 原生推 doc-switched，页面自刷。
function notifySwitch(entry) {
  try {
    const q = http.request({ host: '127.0.0.1', port: entry.port, path: '/api/switch', method: 'POST', timeout: 8000,
      headers: { 'content-type': 'application/json' } }, (up) => { up.resume(); });
    q.on('error', () => {});
    q.on('timeout', () => { try { q.destroy(); } catch (_) {} });
    q.end(JSON.stringify({ file: entry.file }));
  } catch (_) {}
}

// ---------- 转发 ----------
const PASS_HEADERS = new Set(['accept', 'accept-encoding', 'cache-control', 'pragma', 'content-type',
  'content-length', 'if-modified-since', 'if-none-match', 'last-event-id', 'referer', 'user-agent']);

// 单次转发：拒连/首响应超时 → reject（此时尚未向浏览器写出任何字节，可安全改道）；
// 已出字节的流内失败只能毁掉响应（SSE 长流的正常路径不受看门狗影响）。
function tryForward(entry, req, res, innerPath, respondTimeoutMs) {
  return new Promise((resolve, reject) => {
    const selfHost = '127.0.0.1:' + entry.port;
    const headers = {};
    for (const k of Object.keys(req.headers)) if (PASS_HEADERS.has(k)) headers[k] = req.headers[k];
    // watch 的同源校验只认回环：从别的名字（host 名解析到 127.0.0.1）打开 core 时会被 403
    if (req.headers.origin) headers.origin = 'http://' + selfHost;

    const search = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?')) : '';
    const inner = innerPath.startsWith('/') ? innerPath : '/' + innerPath;

    entry.lastUsed = Date.now();
    entry.conns = (entry.conns || 0) + 1;
    let released = false;
    const release = () => { if (!released) { released = true; entry.conns = Math.max(0, entry.conns - 1); } };
    res.once('close', release);
    res.once('finish', release);

    let started = false;
    let upRes = null;
    const upstream = http.request(
      { host: '127.0.0.1', port: entry.port, path: encodeURI(inner) + search, method: req.method, headers },
      (up) => {
        started = true;
        upRes = up;
        clearTimeout(watchdog);
        const h = Object.assign({}, up.headers);
        delete h.connection; delete h['keep-alive'];
        const isSSE = String(h['content-type'] || '').includes('text/event-stream');
        if (isSSE) { h['cache-control'] = 'no-cache'; h['x-accel-buffering'] = 'no'; }
        res.writeHead(up.statusCode || 502, h);
        up.on('data', (d) => {
          entry.lastUsed = Date.now();
          // 抓到「真改文档」的原生推送（牢笼内 CLI 编辑会推 excel-patch/full 等）：给轮询器一个吸收窗口。
          // 只认改文档的 action —— selection-update/mark-update 是 UI 态，把页内编辑的救场 switch 也吸掉就永不刷新了
          if (isSSE && /"action":"(?:full|excel-patch|word-patch|replace|add|remove)"/.test(String(d))) entry.lastNative = Date.now();
        });
        up.pipe(res);
        resolve();
      });
    const watchdog = setTimeout(() => {
      if (started) return;
      try { upstream.destroy(); } catch (_) {}
      release();
      if (!res.headersSent) reject(new Error('watch 响应超时'));
    }, respondTimeoutMs || RESPOND_TIMEOUT_MS);
    upstream.on('error', () => {
      clearTimeout(watchdog);
      release();
      if (!started && !res.headersSent) return reject(new Error('watch 不可达'));
      // 已开始回写后上游报错：留一拍再判（watch 会在响应其实已完整时断链，对 HEAD 必现）
      setTimeout(() => {
        if (res.writableEnded) return;
        try { res.destroy(); } catch (_) {}
      }, upRes && upRes.complete ? 0 : 120);
    });
    req.pipe(upstream);
  });
}

// 转发自愈一次：失败 → 摘槽 → 同页原地复活 → 重试。GET/HEAD 才可重试（无请求体，重放无副作用）。
async function forwardHealed(entry, req, res, innerPath) {
  try { await tryForward(entry, req, res, innerPath); return true; }
  catch (e) {
    stopEntry(entry, '转发失败：' + String((e && e.message) || e));
    if (res.headersSent || !/^(GET|HEAD)$/.test(req.method)) return false;
    await new Promise((r) => setTimeout(r, 400)); // 给内核回收旧 listen 套接字留个极短窗口
    const m2 = await waitReady(entry.pageDec);
    if (!m2 || !m2.entry) return false;
    try {
      await tryForward(m2.entry, req, res, innerPath);
      return true;
    } catch (_) { return false; }
  }
}

// 槽位过期：外部（非 officecli）写盘改的是文件，watch 内存里的渲染不感知 → 导航时比对指纹回收重渲染
function fileChanged(entry) {
  try {
    const st = fs.statSync(entry.file);
    return st.mtimeMs !== entry.mtimeMs || st.size !== entry.size;
  } catch (_) { return false; }
}

// 浏览器导航请求判定：只有地址栏/iframe 直开页面带 text/html
function isNav(req) {
  return req.method === 'GET' && /text\/html/.test(String(req.headers.accept || ''));
}

// 数据请求（资源/API/SSE/Referer 兜底）：按 Referer 找回来源页面
function refererRel(req) {
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return null;
  try {
    const rp = decodeURIComponent(new URL(ref).pathname);
    if (!rp.startsWith(PREFIX + '/')) return null;
    return rp.slice(PREFIX.length);
  } catch (_) { return null; }
}

// ---------- 编辑命令的事后一脚 ----------
// office 封装层改动成功后 fire-and-forget 打这里（本地没有沙箱，原生通知本来就能到 watch；
// 这一脚是无害的补强，也让行为与服务器保持一致）。
function handleTouch(req, res) {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let f = '';
    try { f = String(JSON.parse(body || '{}').file || ''); } catch (_) {}
    let hit = null;
    if (f) {
      const rp = path.resolve(f);
      for (const s of slots.values()) if (s.file === rp) { hit = s; break; }
    }
    if (hit && hit.ready) {
      hit.lastUsed = Date.now();
      notifySwitch(hit);
      try { const st = fs.statSync(hit.file); hit.mtimeMs = st.mtimeMs; hit.size = st.size; } catch (_) {}
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"touched":true}');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"touched":false}');
    }
  });
  req.on('error', () => {});
}

// ---------- 路由 ----------
const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    log('请求失败 ' + req.url + '：' + ((e && e.message) || e));
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('预览网关内部错误');
  });
});

async function route(req, res) {
  if (req.method === 'POST' && req.url.split('?')[0] === '/__pv-touch') return handleTouch(req, res);

  let u;
  try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch (_) { res.writeHead(400).end('bad path'); return; }

  if (req.method === 'GET' && u === '/gateway-healthz') {
    const body = JSON.stringify({ ok: true, prefix: PREFIX, slots: slots.size, bin: resolveBin() });
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    return;
  }

  if (u === PREFIX + '/' || u.startsWith(PREFIX + '/')) {
    const rel = u.slice(PREFIX.length) || '/';
    const rr = rel.replace(/\/+$/, '');          // 去掉尾斜杠后的页面路径
    const segs = rel.split('/').filter(Boolean);
    const sid = segs.shift() || '';
    const wantSlash = !/\/$/.test(u);            // 缺尾斜杠：相对资源会解析错，要补 301

    // HEAD = 前端预览窗的「这份文档能不能预览」探针。存在性只在本地按文件系统回答，绝不上探 watch；
    // 但回 200 前要等槽位就绪（有上限）：冷启动的首次渲染很贵，这里等掉，iframe 一挂上就是渲染好的页面。
    if (req.method === 'HEAD') {
      const t = await guard(sid, segs.join('/'));
      if (t) {
        if (!resolveBin()) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': '0' }).end();
          return;
        }
        await warmSlot(rel, t);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': '0' }).end();
        return;
      }
      if (EXTS.has(path.extname(rr).toLowerCase())) return notFound(res);
    }

    if (isNav(req)) {
      // 导航请求 = 用户正盯着这一刻：绝不为启动/自愈阻塞首字节。未就绪 → 中转页 + 后台热槽。
      const t = await guard(sid, segs.join('/'));
      if (!t) return notFound(res);
      if (!resolveBin()) return installPage(res);
      const m = matchPage(rr);
      if (!m || !m.entry.ready) {
        startWatch(t).catch(() => {});
        return loading(res);
      }
      if (fileChanged(m.entry)) {
        stopEntry(m.entry, '外部变更');
        startWatch(t).catch(() => {});
        return loading(res);
      }
      if (m.exact && wantSlash) { res.writeHead(301, { location: (req.url || u) + '/' }).end(); return; }
      const cut = PREFIX.length + m.entry.pageDec.length;
      try {
        await tryForward(m.entry, req, res, u.length > cut ? u.slice(cut) : '/', NAV_TIMEOUT_MS);
        m.entry.navTimeouts = 0;
        return;
      } catch (e) {
        const msg = String((e && e.message) || e);
        // 超时 ≠ 死：大文档首次渲染可能超过 5s。单次超时保留槽位，连续几次才判死重启。
        m.entry.navTimeouts = /超时/.test(msg) ? (m.entry.navTimeouts || 0) + 1 : NAV_TIMEOUT_RETRIES;
        if (m.entry.navTimeouts >= NAV_TIMEOUT_RETRIES) {
          stopEntry(m.entry, msg);
          startWatch(t).catch(() => {});
        }
        if (!res.headersSent) return loading(res);
        return;
      }
    }

    // 非导航（页面资源/API/SSE）：等就绪槽位后自愈转发——用户看不见这些请求，值得原地救活
    const m = await waitReady(rel);
    if (m && m.entry) {
      if (m.exact && wantSlash) { res.writeHead(301, { location: (req.url || u) + '/' }).end(); return; }
      const cut = PREFIX.length + m.entry.pageDec.length;
      if (await forwardHealed(m.entry, req, res, u.length > cut ? u.slice(cut) : '/')) return;
      return fail502(res);
    }
  }

  // vendor 页面把交互 API 与「自身最新 HTML」硬编码成根绝对路径（/、/events、/api/*）：
  // 按 Referer 找回来源页，原路径原样转发（不剥页面前缀）。`/` 尤其关键——回 404 页面会
  // 判定自身过期并 location.reload()，用户看到的就是白屏后重新加载。
  const rrel = refererRel(req);
  if (rrel) {
    const mv = await waitReady(rrel);
    if (mv && mv.entry) {
      if (await forwardHealed(mv.entry, req, res, u)) return;
      return fail502(res);
    }
  }
  notFound(res);
}

// 闲置回收：watch 是常驻进程，不回收会一直占着内存与端口（与服务器一致 6h）。
const idleTimer = setInterval(() => {
  const now = Date.now();
  for (const s of [...slots.values()]) {
    if (!s.conns && now - s.lastUsed > IDLE_MS) stopEntry(s, '闲置回收');
  }
  for (const [k, v] of cooldown) if (v <= now) cooldown.delete(k);
}, 60000);
idleTimer.unref();

// 带外写盘兜底 + 页内编辑（POST /api/send 实测只落盘不推事件）的唯一刷新通道：
// 开着页面时比对 mtime，变了就对活槽位 POST /api/switch 就地重读。
const pollTimer = setInterval(() => {
  const now = Date.now();
  for (const s of [...slots.values()]) {
    let st = null;
    try { st = fs.statSync(s.file); } catch (_) {}
    if (!st) { stopEntry(s, '文件已删除'); continue; } // 会话被删/文件被移走
    if (!s.conns) continue;                           // 没人开着页面：导航侧的指纹门会兜住
    if (!s.ready || st.mtimeMs === s.mtimeMs) continue;
    if (now - (s.lastNative || 0) < 10000) { s.mtimeMs = st.mtimeMs; s.size = st.size; continue; }
    s.mtimeMs = st.mtimeMs;
    s.size = st.size;
    notifySwitch(s);
  }
}, 2000);
pollTimer.unref();

function shutdown() {
  for (const s of [...slots.values()]) stopEntry(s);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// 退出/崩溃时别把 spawn 出去的 watch 养成孤儿
process.on('exit', () => { for (const s of [...slots.values()]) killWatch(s); });
process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝：' + ((e && e.message) || e)));

server.listen(PORT, HOST, () => {
  log('预览网关 listening ' + HOST + ':' + PORT + '  prefix=' + PREFIX + '/' +
    '  tasks=' + TASKS_ROOT + '  skills=' + SKILLS_ROOT + '  slots=' + SLOTS);
});
