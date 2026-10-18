// watch 槽位管理:officecli watch 只绑 127.0.0.1(实测),且 watch 进程必须与
// officecli MCP 子进程同容器(刷新信号 = 进程内 IPC,跨容器收不到)。
// 本模块在 shim(容器 PID1)里 spawn watch 子进程 → 跨命令存活。
// 不再开对外 TCP 转发口:预览路由交给 gateway.js —— url 按任务身份组织
// (/preview/<会话id>/<文档相对路径>/),槽位号不出容器。
// 槽位语义 = 可再生缓存而非承诺:链接按任务路径寻址,被回收/被别人挤掉后
// 页面再访问由 gateway 就地复活(revive)。因此闲置阈值可以放心激进,AI 忘了
// unwatch 不再有实质危害。
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const WORKSPACE = process.env.OFFICE_WORKSPACE || '/workspace/tasks';
const SLOTS = Number(process.env.OFFICE_SLOTS || 4);
const WATCH_BASE = Number(process.env.OFFICE_WATCH_BASE || 26315); // watch 自身端口(+slot),仅容器内回环
const PREFIX = (process.env.OFFICE_PREVIEW_PREFIX || '/preview').replace(/\/+$/, '');
const IDLE_MS = Number(process.env.OFFICE_IDLE_MS || 6 * 3600 * 1000); // 闲置回收阈值(默认 6h;槽=缓存,链接自愈,激进无副作用)
const EXTS = new Set(['.docx', '.xlsx', '.pptx']);

const slots = new Map(); // slot -> {file, task, rel, port, watch, lastUsed, conns, pageDec, pageEnc}
const starting = new Map(); // 文件绝对路径 -> Promise:同文件并发 watch 合并为一次 spawn(watch 启动需秒级,窗口不窄)

function log(...a) { console.log('[watch]', ...a); }

// 路径护栏:限定 WORKSPACE 下的办公文档,禁止穿越
function guard(p) {
  const abs = path.resolve(WORKSPACE, String(p || ''));
  const rel = path.relative(path.resolve(WORKSPACE), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path must be inside ' + WORKSPACE + ': ' + p);
  if (!EXTS.has(path.extname(abs).toLowerCase())) throw new Error('Only .docx/.xlsx/.pptx files are supported: ' + p);
  if (!fs.existsSync(abs)) throw new Error('File not found: ' + p);
  return abs;
}

// 文件 → 预览页前缀:WORKSPACE/<会话>/<rel…> → /<会话>/<rel…>(另有分段编码形态供 url 用)。
// 任务根下的文件没有预览页(url 必须挂在会话身份下,才能鉴权/稳定),要求至少两层。
function pageOf(abs) {
  const segs = path.relative(path.resolve(WORKSPACE), abs).split(path.sep).filter(Boolean);
  if (segs.length < 2) throw new Error('Preview only supports files under a session directory (<' + WORKSPACE + '/<session-id>/...>): ' + abs);
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

async function start(file, publicBase) {
  const abs = guard(file);
  for (const [slot, s] of slots) if (s.file === abs) { s.lastUsed = Date.now(); return info(slot, publicBase); }
  if (starting.has(abs)) { // vendor 限制同文件只许一个 watch:并发调用共享在飞的启动结果
    try { await starting.get(abs); } catch (_) {}
    for (const [slot, s] of slots) if (s.file === abs) return info(slot, publicBase);
    throw new Error('Failed to start watch (concurrent start for the same file); retry');
  }
  const p = spawnWatch(abs, publicBase).finally(() => starting.delete(abs));
  starting.set(abs, p);
  return p;
}

async function spawnWatch(abs, publicBase) {
  const page = pageOf(abs); // 先验证 url 可组织,再占坑
  let slot = -1;
  for (let i = 0; i < SLOTS; i++) if (!slots.has(i)) { slot = i; break; }
  if (slot < 0) { // 槽位满:优先踢「没有在看且最久未用」;全都有活动连接(= 页面开着)才抢最冷的活跃槽
    const ent = [...slots.entries()];
    const idle = ent.filter(([, s]) => !s.conns);
    slot = (idle.length ? idle : ent).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0];
    stop(slot);
  }
  const wp = WATCH_BASE + slot;
  const child = spawn('officecli', ['watch', abs, '--port', String(wp)], { stdio: 'ignore' });
  child.on('exit', () => { if (slots.get(slot)?.watch === child) stop(slot); });
  const entry = { file: abs, task: page.task, rel: page.rel, port: wp, watch: child, lastUsed: Date.now(), conns: 0, pageDec: page.pageDec, pageEnc: page.pageEnc };
  slots.set(slot, entry); // 同步占坑:等端口就绪期间也不给并发 spawn 踩同一槽
  try {
    await portUp(wp);
  } catch (e) {
    child.kill();
    if (slots.get(slot) === entry) slots.delete(slot);
    throw new Error('Failed to start watch (only one watch per file is allowed): ' + e.message);
  }
  log(`slot${slot} ${abs} watch:${wp} page=${PREFIX}${page.pageDec}`);
  return info(slot, publicBase);
}

function stop(slot) {
  const s = slots.get(slot);
  if (!s) return false;
  try { s.watch.kill(); } catch (_) {}
  slots.delete(slot);
  log(`slot${slot} 已停止`);
  return true;
}

function stopOne(file) {
  const abs = guard(file);
  for (const [slot, s] of slots) if (s.file === abs) { stop(slot); return { stopped: abs }; }
  throw new Error('No watch running for this file: ' + abs);
}

// command 透传时顺带给命中的槽位续命(AI 活跃 = 预览还有人关心)
function touch(command) {
  for (const s of slots.values()) if (String(command || '').includes(s.file)) s.lastUsed = Date.now();
}

function info(slot, publicBase) {
  const s = slots.get(slot);
  return {
    slot: slot, file: s.file,
    path: PREFIX + s.pageEnc + '/',
    url: (publicBase || '') + PREFIX + s.pageEnc + '/',
    idle_min: Math.round((Date.now() - s.lastUsed) / 60000), // 闲置分钟(watch ls 给模型/用户看活性)
    conns: s.conns || 0, // 正在回传的预览请求数(SSE 在场 = 页面开着)
  };
}

// gateway 路由用:rel = 已解码、剥掉 PREFIX 的请求路径(以 / 开头);
// exact = 正好是页面本身(缺尾斜杠由 gateway 补 301),prefix = 页面下的资源/端点。最长前缀优先。
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

function status(publicBase) {
  return [...slots.keys()].map((slot) => info(slot, publicBase));
}

// 会话结束批量清理：core 删会话时经桥打一发 unwatch --session <会话id> [--purge]。
// --purge：连带删除该会话在本工作区的目录副本（任务真相在 core/executor 侧，这里只是可再生 scratch）；
// purge 语义下幂等：无槽/目录不存在都不报错，只在会话号非法时拒（防穿越）。
function stopSession(taskId, purge) {
  const t = String(taskId || '');
  const stopped = [];
  for (const [slot, s] of slots) if (s.task === t) { stop(slot); stopped.push(s.file); }
  let purged = false;
  if (purge) {
    if (!t || t === '.' || t === '..' || /[/\\]/.test(t) || t.includes('\0')) throw new Error('Invalid session id.');
    const dir = path.join(path.resolve(WORKSPACE), t);
    if (path.relative(path.resolve(WORKSPACE), dir) !== t) throw new Error('Invalid session id.');
    if (fs.existsSync(dir)) { try { fs.rmSync(dir, { recursive: true, force: true }); purged = true; log('会话 purge:', t); } catch (_) {} }
  }
  if (!stopped.length && !purge) throw new Error('No watch running for this session: ' + t);
  return { session: t, stopped, purged };
}

// gateway 未命中兜底:请求路径本身就是一个存在的会话文档 → 回收/被挤掉后就地复活。
// 只接受整体形如办公文档的路径(扩展名把关);/api/… 等资源路径无扩展名 → null,404 语义不变。
async function revive(rel) {
  const rr = (rel || '').replace(/\/+$/, '');
  if (!rr || rr === '/') return null;
  try {
    await start(path.join(WORKSPACE, rr)); // guard/pageOf 复核越界、存在性、会话层级;不行 = 维持原 404
    return matchPage(rr);
  } catch (_) { return null; }
}

// 纯路径推导预览页地址（无需 watch 在场；布局不满足——越界/任务根下——返回 null）
function pageUrl(abs, publicBase) {
  const rel = path.relative(path.resolve(WORKSPACE), abs);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  let page;
  try { page = pageOf(abs); } catch (_) { return null; }
  const p = PREFIX + page.pageEnc + '/';
  return { path: p, url: (publicBase || '') + p };
}

// ---------- /f/<token> 交付能力链：save/close 成功时签发（同 core /p/ 的设计：随机 id + TTL，URL 即能力）----------
const DL_TTL_MS = Number(process.env.OFFICE_DL_TTL_MS || 30 * 60 * 1000);
const DL_MAX = 512;
const dls = new Map(); // token -> { abs, exp }
const MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function dlMint(abs) {
  const now = Date.now();
  for (const [k, v] of dls) if (v.exp <= now) dls.delete(k);
  // 同一文件重复 save/close 复用原 token（滑动 TTL）：serveDl 实时读盘，链接永远指向盘上最新内容，AI 改完重新下载原链即可
  for (const [k, v] of dls) if (v.abs === abs) { v.exp = now + DL_TTL_MS; return k; }
  while (dls.size >= DL_MAX) dls.delete(dls.keys().next().value);
  const token = crypto.randomBytes(16).toString('base64url');
  dls.set(token, { abs, exp: now + DL_TTL_MS });
  return token;
}

function serveDl(token, req, res) {
  const e = token ? dls.get(token) : null;
  if (!e || e.exp <= Date.now()) {
    if (e) dls.delete(token);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Link not found or expired. Run save on the file again to issue a new link.');
    return;
  }
  let st;
  try { st = fs.statSync(e.abs); } catch (_) {
    dls.delete(token);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('File is no longer in the workspace; save or push it again first');
    return;
  }
  if (!st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('File is no longer in the workspace; save or push it again first'); return; }
  const base = path.basename(e.abs);
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'document';
  res.writeHead(200, {
    'content-type': MIME[path.extname(base).toLowerCase()] || 'application/octet-stream',
    'content-length': String(st.size),
    'content-disposition': 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(base),
    'cache-control': 'no-store',
  });
  fs.createReadStream(e.abs).pipe(res);
}

// ---------- scratch 卫生：这份盘只是工作副本（交付真相在 core 的 tasks），两道闸：闲置 TTL + 容量水位 ----------
const SCRATCH_TTL_MS = Number(process.env.OFFICE_SCRATCH_TTL_MS || 7 * 24 * 3600 * 1000);
// 容量水位：总量（含 busy）超上限时，按目录最新 mtime 从旧到新删非 busy 目录，删到低水位为止。
// busy（正开预览）永不触碰，宁可短时超水位也不打扰活跃会话；编辑即落盘会把 mtime 刷新，活跃会话天然排最后。
const SCRATCH_MAX_BYTES = Number(process.env.OFFICE_SCRATCH_MAX_BYTES || 2 * 1073741824); // 0 = 关
const SCRATCH_LOW_RATIO = 0.8;

function newestMtime(dir, budget) { // 目录树最新 mtime；budget 封顶防巨目录卡住定时器
  let best = 0;
  try { best = fs.statSync(dir).mtimeMs; } catch (_) { return 0; }
  const stack = [dir];
  while (stack.length && budget.n > 0) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const en of ents) {
      if (budget.n-- <= 0) break;
      const p = path.join(d, en.name);
      if (en.isSymbolicLink()) continue;
      if (en.isDirectory()) { stack.push(p); continue; }
      try { const m = fs.statSync(p).mtimeMs; if (m > best) best = m; } catch (_) {}
    }
  }
  return best;
}

function dirSize(dir, budget) { // 目录树总字节；budget 封顶，截断时偏小（水位是粗粒度启发式，可接受）
  let total = 0;
  const stack = [dir];
  while (stack.length && budget.n > 0) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const en of ents) {
      if (budget.n-- <= 0) break;
      const p = path.join(d, en.name);
      if (en.isSymbolicLink()) continue;
      if (en.isDirectory()) { stack.push(p); continue; }
      try { total += fs.statSync(p).size; } catch (_) {}
    }
  }
  return total;
}

function pruneScratch() {
  if (!(SCRATCH_TTL_MS > 0) && !(SCRATCH_MAX_BYTES > 0)) return [];
  const now = Date.now();
  const busy = new Set([...slots.values()].map((s) => path.relative(WORKSPACE, s.file).split(path.sep)[0]));
  let tops;
  try { tops = fs.readdirSync(WORKSPACE, { withFileTypes: true }); } catch (_) { return []; }
  const removed = [];
  // 道闸一：闲置 TTL（整目录最新 mtime 超时即回收）
  if (SCRATCH_TTL_MS > 0) {
    for (const en of tops) {
      if (!en.isDirectory() || en.isSymbolicLink() || busy.has(en.name)) continue;
      const dir = path.join(WORKSPACE, en.name);
      const m = newestMtime(dir, { n: 800 });
      if (m && now - m > SCRATCH_TTL_MS) {
        try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(en.name); } catch (_) {}
      }
    }
  }
  // 道闸二：容量水位总量超限则从旧到新删非 busy 目录，删到低水位或候选耗尽
  if (SCRATCH_MAX_BYTES > 0) {
    const infos = [];
    let total = 0;
    for (const en of tops) {
      if (!en.isDirectory() || en.isSymbolicLink()) continue;
      const dir = path.join(WORKSPACE, en.name);
      const size = dirSize(dir, { n: 4000 });
      total += size;
      if (!busy.has(en.name) && !removed.includes(en.name)) infos.push({ name: en.name, dir, size, m: newestMtime(dir, { n: 800 }) });
    }
    infos.sort((a, b) => a.m - b.m);
    const lowLimit = SCRATCH_MAX_BYTES * SCRATCH_LOW_RATIO;
    for (const it of infos) {
      if (total <= lowLimit) break;
      try { fs.rmSync(it.dir, { recursive: true, force: true }); total -= it.size; removed.push(it.name); } catch (_) {}
    }
  }
  if (removed.length) log('scratch 清理:', removed.join(', '));
  return removed;
}
setInterval(pruneScratch, 3600 * 1000).unref();
setTimeout(pruneScratch, 10000).unref(); // 重启后不等整点，早扫一轮

setInterval(() => {
  const now = Date.now();
  // 有活动连接的槽 = 有人正开着页面,永不闲置回收(槽满时它最后被抢,见 spawnWatch)
  for (const [slot, s] of slots) if (!s.conns && now - s.lastUsed > IDLE_MS) { log(`slot${slot} 闲置回收`); stop(slot); }
}, 60000).unref();

module.exports = { start, stop, stopOne, stopSession, touch, status, guard, slots, IDLE_MS, matchPage, revive, pageUrl, dlMint, serveDl, pruneScratch, DL_TTL_MS, WORKSPACE, PREFIX };
