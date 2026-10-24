// officecli 预览槽位 + 网关（自 mcp/officecli 的 watch.js/gateway.js 迁入 executor，合一）。
// 数据面根本变化：预览的文件就是 tasks 卷上的真实文件（EXECUTOR_ISOLATION_BASE 挂载点下），
// 不再是另一块盘的拷贝——同步教学 / push / 取件链(/f/) / scratch 清理整条双盘动线随之退役。
// 槽位 = 缓存而非承诺：链接按任务路径寻址 <prefix>/<会话id>/<文档相对路径>/，
// 闲置回收/挤占后页面再访问由本进程 revive 就地冷启动；转发失败同样先自愈重试，不把死槽摊给用户。
// 启动闸门：watch 冷启动要数秒，期间槽位在册但未就绪。同页并行请求（页面/资源/SSE）若照旧盲转发，
// 拒连会被误判死槽而 SIGKILL 正在启动的进程，反复归零（实测 4 并行请求把 4.7s 冷启动拖成 9.8s 全灭）。
// 故：未就绪槽位一律等就绪，绝不 retire；导航请求（浏览器地址栏/iframe 直开页面）不等启动，
// 未就绪立即回加载中转页自动刷新，杜绝白屏干等。
// 刷新链路（实测钉死）：watch 原生命名管道通知跨不了命令沙箱的 --pid（SO_PEERCRED 取不到对端 pid，
// 静默退化独立模式），MCP 单 ns 时代不存在此墙。替代 = 事件驱动的 TCP 环：wrapper 编辑成功后
// POST /__pv-touch -> 网关对活槽位 POST watch /api/switch（同路径 = 就地重读磁盘）-> watch 原生
// 推 doc-switched，vendor 页面自带监听器自己 reload，无需重启进程、无需篡改页面 HTML。
// 2s 轮询只做带外写（cp/python 等不走 officecli 的改动）兜底；页面没开时靠导航侧 mtime 指纹门。
// 生命周期：由 executor 服务进程（容器内 PID1）托管 spawn，跨 /exec 存活；
// 二进制取技能资产（skills/office/install.sh 由 init 阶段拉到技能卷，executor :ro 挂载执行）。
// 监听 EXECUTOR_PREVIEW_PORT（默认 3100，只走内网）：core 的通用预览反代（登录 cookie 门禁）是唯一入口；
// /__session-kill 供 core 删会话时尽力清槽（Bearer EXECUTOR_TOKEN，与 /exec 同一信任域）。
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');

const WORKSPACE = path.resolve(process.env.EXECUTOR_ISOLATION_BASE || '/mnt/host-tasks');
// 沙箱（命令侧世界）的虚拟任务根：vendor 找 watch 的键 = 路径字符串 hash + TMPDIR 下的 .port，
// watch 必须以同一视图注册（preview.js 用私有 mount ns 给 watch 造出这个视图，不新增任何对外暴露）。
const VIRT_ROOT = path.resolve(process.env.EXECUTOR_CWD || '/workspace/tasks');
const PREFIX = (process.env.OFFICE_PREVIEW_PREFIX || '/preview').replace(/\/+$/, '');
const PORT = Number(process.env.OFFICE_PREVIEW_PORT || 3100);
const SLOTS = Number(process.env.OFFICE_SLOTS || 4);
const WATCH_BASE = Number(process.env.OFFICE_WATCH_BASE || 26315); // watch 自身端口(代次轮转)，只绑回环
const WATCH_SPAN = Math.max(16, Number(process.env.OFFICE_WATCH_SPAN || 64)); // 端口轮转窗口：孤儿残留占旧口时自动跳过
const IDLE_MS = Number(process.env.OFFICE_IDLE_MS || 6 * 3600 * 1000);
const RESPOND_TIMEOUT_MS = 15000; // 数据请求(资源/API/SSE)等待 watch 首响应包的时限；拒连/超时走自愈重试
const NAV_TIMEOUT_MS = 5000; // 导航请求等就绪页面首响应：更短——失败立刻转中转页，不白屏干等
const COOLDOWN_MS = 8000; // 启动失败拉黑该文件一段时间：中转页自动刷新不成 spawn 风暴（二进制缺失/坏文件早退）
// 探针（HEAD）等「首帧可用」的上限：watch 冷启动 = 起进程 + 首次渲染，实测 2~6s（大文档更久）。
// 等不到就照回 200，把后续交给导航侧的中转页 + 自愈，探针不无限挂着。
const HEAD_WAIT_MS = 15000;
// 导航请求连续超时多少次才判死重启：单次超时只是「还没渲染完」（见 route 里的注释）。
const NAV_TIMEOUT_RETRIES = 3;
const BIN = process.env.OFFICECLI_BIN || '/workspace/skills/office/bin/officecli';
const TOKEN = String(process.env.EXECUTOR_TOKEN || '');
const EXTS = new Set(['.docx', '.xlsx', '.pptx']);

const slots = new Map(); // slot -> {file, virt, task, rel, port, watch, lastUsed, conns, pageDec, pageEnc, ready, readyP, mtimeMs, size}
let watchGen = 0; // 代次计数器：watch 端口按代轮转，永不与上一代（可能被孤儿占着）同口
const starting = new Map(); // 文件绝对路径 -> Promise：同文件并发 watch 合并为一次 spawn（vendor 限制同文件单 watch）
const backoff = new Map(); // 文件绝对路径 -> 冷却截止时间戳：冷启动刚失败过，短周期内不再重试

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

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function pageOf(abs) {
  const segs = path.relative(WORKSPACE, abs).split(path.sep).filter(Boolean);
  return {
    task: segs[0],
    rel: segs.slice(1).join('/'),
    pageDec: '/' + segs.join('/'),
    pageEnc: '/' + segs.map((s) => encodeURIComponent(s)).join('/'),
  };
}

// 端口探活不能只看 TCP 能连：刚被杀的旧进程，其 listen 套接字在内核 backlog 里还能完成极短窗口的
// 握手，裸 connect 探活会被「尸体」骗成就绪（实测导致复活后首次转发秒败）。用一次真 HTTP 请求验活：
// 任何状态码都算 server 活着；拒连/出错继续重试，预算同前 40 次 x 250ms。
// 探活路径 '/' 就是文档页本身：首次渲染即在这里完成（随后 vendor 页内缓存，浏览器实请求走热路径）。
function portUp(port, tries = 40) {
  return new Promise((res, rej) => {
    let n = 0;
    (function probe() {
      const rq = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (up) => {
        up.resume();
        res();
      });
      rq.on('error', () => { if (++n >= tries) return rej(new Error('watch server did not come up')); setTimeout(probe, 250); });
      rq.on('timeout', () => { rq.destroy(); if (++n >= tries) return rej(new Error('watch server did not come up')); setTimeout(probe, 250); });
    })();
  });
}

// 探端口「是否空闲」：拒连 = 无人监听 = 可用。背景：watch 冷启动父退子存(--fork)，网关只摸得到
// 包装链 pid，SIGKILL 可能漏杀真服务进程；旧方案端口=槽号，踢槽后新 watch 撞孤儿占着的同口绑不上，
// 而 portUp 探活不认身份——秒过的其实是上一份文档的服务，demo.pptx 的槽被转发到 xlsx 页面（串文件）。
// 改为代次轮转 + 领取前确认空闲：残留孤儿再也无法冒充新槽。
function portFree(port) {
  return new Promise((res) => {
    let settled = false;
    const done = (free) => { if (settled) return; settled = true; try { rq.destroy(); } catch (_) {} res(free); };
    const rq = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    rq.on('connect', () => done(false)); // 连上了 = 有人守着，不是空闲
    rq.on('timeout', () => done(true)); // 不回 SYN 的监听在回环上几乎不存在：超时按空闲交给 bind 定夺
    rq.on('error', (e) => done(e.code === 'ECONNREFUSED'));
  });
}

// 领一个本代未用、登记表不占、且当前无人在听的端口；窗口绕满全被占 = 抛错进冷却
async function allocPort() {
  for (let i = 0; i < WATCH_SPAN; i++) {
    const wp = WATCH_BASE + (watchGen++ % WATCH_SPAN);
    let used = false;
    for (const s of slots.values()) if (s.port === wp) { used = true; break; }
    if (used) continue;
    if (await portFree(wp)) return wp;
  }
  throw new Error('no free watch port in span ' + WATCH_SPAN);
}

// 会话 watch 牢笼：每会话一个常驻 pid ns（holder = sleep，自绑到 <会话>/.tmp/watchns）。
// 内核规则：setns(pid) 只能进自身/后代 ns——所以 watch 向下入笼（nsenter 从容器 ns 合法），
// 命令侧由 server.js 把整个沙箱也建在笼内（同样向下入笼），二者同 ns -> vendor 原生管道通知恢复。
// ns 文件 bind 在会话 .tmp：跨会话不可见，爆炸半径 = 本会话的 watch 与本会话命令互杀，自愈可活。
async function ensureJail(realSession) {
  const tmp = path.join(realSession, '.tmp');
  const jns = path.join(tmp, 'watchns');
  const jp = path.join(tmp, 'watchjail-pid');
  if (fs.existsSync(jns)) {
    try { if (spawnSync('nsenter', ['--pid=' + jns, '/bin/true'], { timeout: 3000 }).status === 0) return jns; } catch (_) {}
    try { spawnSync('umount', [jns]); } catch (_) {}
    try { fs.rmSync(jns, { force: true }); } catch (_) {}
  }
  fs.writeFileSync(jns, '');
  const script = 'mount --bind /proc/self/ns/pid ' + shq(jns) +
    ' && readlink /proc/self > ' + shq(jp) +
    ' && exec -a ' + shq('officecli-jail-' + path.basename(realSession)) + ' sleep infinity';
  const h = spawn('unshare', ['--pid', '--fork', 'bash', '-c', script], {
    stdio: 'ignore',
    env: { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp', TMPDIR: '/tmp' },
  });
  h.on('error', () => {});
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { if (spawnSync('nsenter', ['--pid=' + jns, '/bin/true'], { timeout: 3000 }).status === 0) return jns; } catch (_) {}
  }
  return null; // 牢笼建不起来：watch 退回容器 ns，刷新链自动降级为 touch/switch
}

async function startWatch(file) {
  const abs = guard(file);
  const cool = backoff.get(abs);
  if (cool && Date.now() < cool) throw new Error('watch start cooling down');
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
  if (slot < 0) { // 槽满：优先踢「就绪且无活动连接」里最久未用的；正在启动的槽最后才动
    // （踢掉一个还没就绪的槽 = 白白浪费数秒冷启动，且会让等它的那一路请求失败并进冷却）
    const ent = [...slots.entries()];
    const idleReady = ent.filter(([, s]) => !s.conns && s.ready);
    const idle = ent.filter(([, s]) => !s.conns);
    slot = (idleReady.length ? idleReady : (idle.length ? idle : ent))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0];
    stop(slot); // 端口按代轮转，新 watch 不会落在被踢者的旧口上，无需等其回收
  }
  const wp = await allocPort();
  const realSession = path.dirname(abs);
  const virt = path.join(VIRT_ROOT, page.pageDec); // 命令侧同串路径（发现键 hash 一致）
  try { fs.mkdirSync(path.join(realSession, '.tmp'), { recursive: true }); } catch (_) {}
  const jail = await ensureJail(realSession); // null = 牢笼建不起来，watch 直跑容器 ns
  const pidFile = path.join(realSession, '.tmp', 'watchpid-' + wp);
  // 命令↔watch 协同的三个世界条件（实测：发现 = <TMPDIR>/officecli-watch-<路径hash>.port + TCP 回环）：
  // /tmp 指向会话 .tmp、路径以 VIRT_ROOT 开头、pid 视图自洽。用最小私有 mount ns 摆出后 exec；
  // 必须在 readlink 自报之后补挂 proc：watch 已被 nsenter 进 holder pid-ns，沿用外层 /proc 会拿错位的
  // pid 编号做自校验，vendor 注册/discovery 静默降级——实测：不写 .port、页内 /api/send 找不到 resident，
  // 退化成只写盘（内存不升版、SSE 零广播、页面永不刷新）；补挂后 send 回正（升版+cascade full）。
  // note readlink 在挂 proc 之前：pidFile 保持容器 ns 编号，网关 killWatch/判死语义不变。
  const runner = 'mount -t tmpfs -o nosuid,nodev tmpfs ' + shq(VIRT_ROOT) +
    ' && mkdir -p ' + shq(path.join(VIRT_ROOT, page.task)) +
    ' && mount --bind ' + shq(realSession) + ' ' + shq(path.join(VIRT_ROOT, page.task)) +
    ' && mount --bind ' + shq(path.join(realSession, '.tmp')) + ' /tmp' +
    ' && readlink /proc/self > ' + shq(pidFile) +
    ' && mount -t proc proc /proc' +
    ' && exec ' + shq(BIN) + ' watch ' + shq(virt) + ' --port ' + wp;
  // 命令↔watch 同牢笼（会话 pid ns）：vendor 管道通知的 peer pid 校验可过，原生平滑刷新恢复。
  // mount ns 仍私有（virt 视图 + /tmp 指向会话 .tmp）；pid 自报到 watchpid-<端口> 供网关 kill。
  const opts = {
    stdio: 'ignore',
    cwd: realSession,
    // detached = 包装链(nsenter/unshare/sh→officecli)自成进程组：杀组能扫到 --fork 同组残留的
    // 真服务子进程（杀单个包装 pid 只会留下孤儿继续占端口）
    detached: true,
    env: { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/tmp', TMPDIR: '/tmp', TZ: process.env.TZ || 'Asia/Shanghai',
      // slim 镜像无 ICU：不变式模式跑 .NET；改动即落盘 + 关自动 resident（与命令侧 wrapper 同一组开关）
      DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
      OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_RESIDENT_FLUSH: 'each' },
  };
  const child = jail
    ? spawn('nsenter', ['--pid=' + jail, 'unshare', '--mount', '--propagation', 'private', '/bin/sh', '-c', runner], opts)
    : spawn('unshare', ['--mount', '--propagation', 'private', '/bin/sh', '-c', runner], opts);
  const entry = { file: abs, virt, task: page.task, rel: page.rel, port: wp, watch: child,
    lastUsed: Date.now(), conns: 0, pageDec: page.pageDec, pageEnc: page.pageEnc, ready: false, pidFile, watchPid: 0 };
  let markDead = () => {};
  const dead = new Promise((_, rej) => { markDead = () => rej(new Error('watch process exited before it was ready')); });
  child.on('exit', () => {
    // --fork 的父进程可能先退而 watch 还在：只在 pidfile 已写且 pid 确认死时才判死；
    // 其余情况（父先退/早期崩溃未写 pid）交给 portUp 超时与转发自愈兔底，绝不误杀在途启动。
    let deadConfirmed = false;
    try {
      const p = Number(fs.readFileSync(pidFile, 'utf8')) || 0;
      if (p > 0) { try { process.kill(p, 0); } catch (_) { deadConfirmed = true; } }
    } catch (_) {}
    if (!deadConfirmed) return;
    markDead();
    if (slots.get(slot)?.watch === child) stop(slot);
  });
  child.on('error', () => { markDead(); if (slots.get(slot) === entry) slots.delete(slot); });
  slots.set(slot, entry); // 同步占坑（未就绪）：并发请求等 readyP，绝不盲转发、也绝不给未就绪槽位判死
  entry.readyP = Promise.race([
    portUp(wp).then(() => { entry.ready = true; log(`slot${slot} ${abs} watch:${wp} page=${PREFIX}${page.pageDec}`); }),
    dead,
  ]).catch((e) => {
    try { child.kill('SIGKILL'); } catch (_) {}
    if (slots.get(slot) === entry) slots.delete(slot);
    throw e instanceof Error ? e : new Error('Failed to start watch: ' + (e && e.message || e));
  });
  try {
    await entry.readyP;
  } catch (e) {
    backoff.set(abs, Date.now() + COOLDOWN_MS);
    throw new Error('Failed to start watch: ' + e.message);
  }
  // mtime+size 作为本次渲染版本的指纹：导航侧 fileChanged 对照用
  try { const st = fs.statSync(abs); entry.mtimeMs = st.mtimeMs; entry.size = st.size; } catch (_) { entry.mtimeMs = 0; entry.size = -1; }
  try { entry.watchPid = Number(fs.readFileSync(pidFile, 'utf8')) || 0; } catch (_) {}
  return entry;
}

function killWatch(s) {
  // 三道尽力而为：先杀整组（盖住 --fork 同组子进程），再补 pidFile 记录的包装 pid 与包装链本身。
  // setsid 脱离组的孤儿杀不到也不致命：端口代次轮转已保证新 watch 不会与其同口（串文件根除）。
  try { process.kill(-s.watch.pid, 'SIGKILL'); } catch (_) {}
  if (s.watchPid) { try { process.kill(s.watchPid, 'SIGKILL'); } catch (_) {} }
  try { s.watch.kill('SIGKILL'); } catch (_) {}
}

function stop(slot) {
  const s = slots.get(slot);
  if (!s) return false;
  killWatch(s);
  slots.delete(slot);
  log(`slot${slot} 已停止`);
  return true;
}

// core 删会话尽力清槽：不删任何数据（盘上的就是任务本体，删目录是 core 自己的事）。
function stopSession(taskId) {
  const t = String(taskId || '');
  const stopped = [];
  for (const [slot, s] of [...slots]) if (s.task === t) { stop(slot); stopped.push(s.rel || s.file); }
  // 牢笼也拆掉（holder + watchns bind）：否则 rm -rf 会话目录会因挂载点而 EBUSY
  if (t && !/[\\/]/.test(t)) {
    const tmp = path.join(WORKSPACE, t, '.tmp');
    let hp = 0;
    try { hp = Number(fs.readFileSync(path.join(tmp, 'watchjail-pid'), 'utf8')) || 0; } catch (_) {}
    if (hp) { try { process.kill(hp, 'SIGKILL'); } catch (_) {} }
    try { spawnSync('umount', [path.join(tmp, 'watchns')]); } catch (_) {}
    try { fs.rmSync(path.join(tmp, 'watchns'), { force: true }); } catch (_) {}
    try { fs.rmSync(path.join(tmp, 'watchjail-pid'), { force: true }); } catch (_) {}
  }
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

// 探针预热：把槽位等到「就绪」（= 首帧渲染完成，portUp 探的就是页面本身），复用时直接返回。
// 与并发请求共用同一次 startWatch（starting 去重）；任何失败/超时都静默——就绪与否不影响 200。
async function warmSlot(rr) {
  let timer;
  try {
    await Promise.race([
      waitReady(rr),
      new Promise((r) => { timer = setTimeout(r, HEAD_WAIT_MS); }),
    ]);
  } catch (_) {} finally { clearTimeout(timer); }
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

// 数据请求（资源/API/SSE/Referer 兜底）用：拿到「就绪」的槽位，等正在启动的那次；
// 启动刚失败就再补一次 revive（revive 内的 startWatch 自己会 await spawn），二次仍不就绪 = null。
// 关键点：等待期内没人 kill 在途 watch——启动不再被并行请求打断，冷启动耗时回归单请求水平。
async function waitReady(rel) {
  for (let round = 0; round < 2; round++) {
    const m = matchPage(rel) || await revive(rel);
    if (!m) return null;
    if (m.entry.ready) return m;
    await m.entry.readyP.catch(() => {});
    if (m.entry.ready) return m;
  }
  return null;
}

// 就地重读：POST watch /api/switch {"file": <注册路径>)}（同路径也接受 = 强制从磁盘重载）。
// watch 原生推 update + doc-switched，vendor 页面自带监听器自刷新；不重启进程，页内编辑/选区状态外
// 全部无损。TCP 回环跨 pid ns 无碍（命名管道的 SO_PEERCRED 校验才跨不过去）。失败静默：
// watch 若已死，exit 事件已清槽，导航门/轮询兜底。
function notifySwitch(entry) {
  try {
    const q = http.request({ host: '127.0.0.1', port: entry.port, path: '/api/switch', method: 'POST', timeout: 8000,
      headers: { 'content-type': 'application/json' } }, (up) => { up.resume(); });
    q.on('error', () => {});
    q.on('timeout', () => { try { q.destroy(); } catch (_) {} });
    q.end(JSON.stringify({ file: entry.virt }));
  } catch (_) {}
}

// ---------- 网关转发（原 gateway.js：槽位号不出容器） + 自愈 ----------
// 上游(watch)确实用得到的头；cookie/authorization 等一律不进（core 那层已过滤，这是第二道防线）。
const PASS = new Set(['accept', 'accept-encoding', 'cache-control', 'pragma', 'content-type', 'content-length', 'last-event-id', 'if-modified-since', 'if-none-match']);

// 单次转发：拒连/响应超时 → reject（此时尚未向浏览器写出任何字节，可安全改道）；
// 已出字节的流内失败只能毁掉响应（SSE 长流正常路径不受看门狗影响：看门狗只管首响应）。
function tryForward(entry, req, res, innerPath, respondTimeoutMs) {
  return new Promise((resolve, reject) => {
    const selfHost = '127.0.0.1:' + entry.port;
    const fwd = { host: selfHost };
    for (const k of Object.keys(req.headers)) if (PASS.has(k)) fwd[k] = req.headers[k];
    if (req.headers.origin) fwd.origin = 'http://' + selfHost;
    const qpos = req.url.indexOf('?');
    const search = qpos >= 0 ? req.url.slice(qpos) : '';
    const inner = innerPath.startsWith('/') ? innerPath : '/' + innerPath;
    // 槽位续命：建连即续，此后每帧回传再续；conns>0 = 有人正开着预览页，闲置回收/挤占都绕着走。
    entry.lastUsed = Date.now();
    entry.conns = (entry.conns || 0) + 1;
    let released = false;
    const release = () => { if (!released) { released = true; entry.conns = Math.max(0, entry.conns - 1); } };
    res.once('close', release);
    res.once('finish', release);
    let started = false;
    let upRes = null;
    const upstream = http.request(
      { host: '127.0.0.1', port: entry.port, path: encodeURI(inner) + search, method: req.method, headers: fwd },
      (up) => {
        started = true;
        upRes = up;
        clearTimeout(watchdog);
        const h = Object.assign({}, up.headers);
        const isSSE = String(h['content-type'] || '').includes('text/event-stream');
        if (isSSE) { h['cache-control'] = 'no-cache'; h['x-accel-buffering'] = 'no'; }
        res.writeHead(up.statusCode, h);
        up.on('data', (d) => {
          entry.lastUsed = Date.now();
          // 监听到真正改文档的原生推送（牢笼内 CLI 编辑会推 excel-patch/full 等）：watch 内存
          // 已平滑更新，给轮询器 10s 吸收窗口，不再追加 switch 重载（那会闪）。只认改文档的
          // action——selection-update/mark-update 是 UI 态：点了格子再打字几秒后回车，若把它们
          // 也盖上时间戳，会把页内编辑（send）唯一的救场 switch 也「吸收」掉，页面永不刷新。
          // 页内编辑 (POST /api/send) 实测在当前 vendor 上不推任何事件，见 start() 轮询器注释。
          if (isSSE && /"action":"(?:full|excel-patch|word-patch|replace|add|remove)"/.test(String(d))) entry.lastNative = Date.now();
        });
        up.pipe(res);
        resolve();
      });
    const watchdog = setTimeout(() => {
      if (!started) {
        try { upstream.destroy(); } catch (_) {}
        release();
        if (!res.headersSent) reject(new Error('watch 响应超时'));
      }
    }, respondTimeoutMs || RESPOND_TIMEOUT_MS);
    upstream.on('error', () => {
      clearTimeout(watchdog);
      release();
      if (!started && !res.headersSent) { reject(new Error('watch 不可达')); return; }
      // 已开始回写后上游报错：不立刻销毁客户端响应。watch 会在响应其实已完整时断链
      //（对 HEAD 必现，见 route 里的注释），Node 客户端的报错早于 'end' 一拍到达，直接
      // destroy 会把马上要 flush 的响应打断。留一拍再判，真断裂照样收掉，不把半截响应当成功。
      setTimeout(() => {
        if (res.writableEnded) return;
        try { res.destroy(); } catch (_) {}
      }, upRes && upRes.complete ? 0 : 120);
    });
    req.pipe(upstream);
  });
}

// 死槽摘除：记录从注册表抹掉 + SIGKILL 残骸（进程若还吊着一口气，别让它占着文件锁和端口）。
// 只对「就绪过」的槽位调用：未就绪的失败由 readyP 统一善后，不在这里误杀在途启动。
function retire(entry, why) {
  for (const [slot, s] of [...slots]) if (s === entry) {
    killWatch(s);
    slots.delete(slot);
    log(`slot${slot} 转发失败摘除(${why})`);
    return;
  }
}

// 数据请求自愈一次：转发失败 → retire → 同页原地 revive → 重试。
// GET/HEAD 才可重试（无请求体，重放无副作用）；其余方法失败直接落 502 兜底。
async function forwardHealed(entry, req, res, innerPath) {
  try { await tryForward(entry, req, res, innerPath); return true; }
  catch (e) {
    retire(entry, String(e && e.message || e));
    if (res.headersSent || !/^(GET|HEAD)$/.test(req.method)) return false;
    await new Promise((r) => setTimeout(r, 400)); // 给内核彻底回收旧 listen 套接字留极短窗口，避免新 watch 绑不上/探活误判
    const m2 = await waitReady(entry.pageDec);
    if (!m2) return false;
    try { await tryForward(m2.entry, req, res, innerPath); return true; } catch (_) { return false; }
  }
}

// 槽位缓存键 = 文件 mtime + size。外部（非 officecli）的写盘是直接改文件的，watch 内存渲染不感知；
// 导航请求（重开/刷新页面）时比对指纹，不一致 = 槽位过期，回收重渲染。开页状态由 2s 轮询兜底。
function fileChanged(entry) {
  try {
    const st = fs.statSync(entry.file);
    return st.mtimeMs !== entry.mtimeMs || st.size !== entry.size;
  } catch (_) { return false; }
}

// 过期槽位回收：只在导航层调用，数据请求与开着页面的 SSE 会话一律不动
//（页面侧编辑是 watch 自己写盘并推流，内存态本来就是新的，杀掉反而打断活会话）。
function dropChanged(entry) {
  for (const [slot, s] of [...slots]) if (s === entry) {
    killWatch(s);
    slots.delete(slot);
    log(`slot${slot} 外部变更，回收重渲染`);
    return;
  }
}

// 浏览器导航请求判定：只有地址栏/iframe 直开页面带 text/html；资源带具体类型、EventSource 带
// text/event-stream、页内 fetch 带 */*，都不落这里（数据请求走 waitReady+自愈，不打中转页）。
function isNav(req) {
  return req.method === 'GET' && /text\/html/.test(String(req.headers.accept || ''));
}

// 中转页：槽位在启动/刚死，先给浏览器一个纯 CSS 转圈 + 自动刷新，别白屏干等。
// 不带任何业务内容；就绪后下一次刷新直达真实页面。no-store 防被当页面缓存。
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

// vendor 预览页把交互 API 硬编码成根绝对路径(/api/selection、/events…)：按 Referer 找回来源页面路径；
// 开着页面的 SSE 重连/轮询不经过页面 URL，Referer 命中即照常 revive/等就绪——死槽对用户不可见。
// guard() 只认办公文档路径，/api/… 本身无扩展名不会误复活。
function refererRel(req) {
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return null;
  try {
    const rp = decodeURIComponent(new URL(ref).pathname);
    if (!rp.startsWith(PREFIX + '/')) return null;
    return rp.slice(PREFIX.length);
  } catch (_) { return null; }
}

// 编辑命令的事后一脚：wrapper 编辑成功后 fire-and-forget 打这里（127.0.0.1 内网，与 watch 端口
// 同一信任面）。file = 命令侧解析出的绝对路径（= entry.virt 同串；也兼容宿主实路径）。
// 命中就绪槽位 -> notifySwitch + 指纹更新；无槽位（没人开着预览）-> touched:false，纯 no-op。
function handleTouch(req, res) {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let f = '';
    try { f = String(JSON.parse(body || '{}').file || ''); } catch (_) {}
    let hit = null;
    if (f) for (const s of slots.values()) if (s.virt === f || s.file === f) { hit = s; break; }
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

function fail502(res) {
  if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('预览暂时不可用，请稍后重试');
}

function notFound(res) {
  // no-store：前端拿 HEAD 当探针，404 一旦被浏览器缓存，文件补上后还会继续显示「暂无文档」
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    .end('无匹配预览(文档不存在/不在会话目录下,或不是 .docx/.xlsx/.pptx)');
}

async function route(req, res) {
  if (req.method === 'POST' && req.url.split('?')[0] === '/__session-kill') return handleSessionKill(req, res);
  if (req.method === 'POST' && req.url.split('?')[0] === '/__pv-touch') return handleTouch(req, res);
  let u;
  try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch (_) { res.writeHead(400).end('bad path'); return; }
  if (req.method === 'GET' && u === '/gateway-healthz') {
    const body = JSON.stringify({ ok: true, prefix: PREFIX, slots: slots.size, bin: BIN, bin_ready: fs.existsSync(BIN) });
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    return;
  }
  if (u === PREFIX + '/' || u.startsWith(PREFIX + '/')) {
    const rel = u.slice(PREFIX.length) || '/';
    const rr = rel.replace(/\/+$/, '');
    // HEAD = 前端预览窗的「这份文档能不能预览」探针。文档在不在只在本地按文件系统回答，绝不上探 watch：
    // 实测 watch(Kestrel) 对 HEAD 只发响应头(带 content-length)不发 body 就断链，Node 客户端抛
    // HPE_CLOSED_CONNECTION；旧逻辑把它当上游故障 res.destroy()，同一文档十次 HEAD 里六七次变成
    // 空响应/502。
    // 但回 200 前要等槽位就绪（有上限）：冷启动的首次渲染很贵，旧实现由 HEAD 自己把这段等掉，
    // iframe 一挂上就是渲染好的页面；若秒回 200，这段开销就落到随后 5s 时限的导航请求上，
    // 慢文档会被判超时，表现为冷启动转圈很久。等不到也照回 200（见 HEAD_WAIT_MS）。
    if (req.method === 'HEAD') {
      let abs = null;
      try { abs = guard(path.join(WORKSPACE, rr)); } catch (_) {}
      if (abs) {
        await warmSlot(rr);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': '0' }).end();
        return;
      }
      // 只有办公文档路径由本网关判定存在性；页面资源等其它 HEAD 仍走原转发逻辑
      if (EXTS.has(path.extname(rr).toLowerCase())) return notFound(res);
    }
    if (isNav(req)) {
      // 导航请求 = 用户正盯着这一刻：绝不为启动/自愈阻塞首字节。
      // 槽位不在或未就绪 → 中转页 + 后台热槽（startWatch 去重，在途就等它）；就绪槽位转发失败 → 同样中转页。
      let abs = null;
      try { abs = guard(path.join(WORKSPACE, rr)); } catch (_) {}
      if (!abs) return notFound(res);
      const m = matchPage(rr);
      if (!m) { startWatch(abs).catch(() => {}); return loading(res); }
      if (!m.entry.ready) { startWatch(abs).catch(() => {}); return loading(res); }
      if (fileChanged(m.entry)) { dropChanged(m.entry); startWatch(abs).catch(() => {}); return loading(res); }
      if (m.exact && !u.endsWith('/')) { res.writeHead(301, { location: (req.url || u) + '/' }).end(); return; } // 相对资源解析需要尾斜杠
      const cut = PREFIX.length + m.entry.pageDec.length; // 剥掉「前缀+页面路径」才是 watch 的内层路径
      try { await tryForward(m.entry, req, res, u.length > cut ? u.slice(cut) : '/', NAV_TIMEOUT_MS); m.entry.navTimeouts = 0; return; }
      catch (e) {
        const msg = String(e && e.message || e);
        // 超时 ≠ 死：watch 可能只是首次渲染还没完（大文档 >5s）。一超时就摘掉会把在跑的渲染连坐杀掉，
        // 中转页刷新后从头再来——用户看到的就是「冷启动一直转圈」。单次超时保留槽位，
        // 连续 NAV_TIMEOUT_RETRIES 次（约 15s 无首字节）才判死重启，兼顶真卡死。
        m.entry.navTimeouts = /超时/.test(msg) ? (m.entry.navTimeouts || 0) + 1 : NAV_TIMEOUT_RETRIES;
        if (m.entry.navTimeouts < NAV_TIMEOUT_RETRIES) {
          log(`slot 保留：导航超时第 ${m.entry.navTimeouts} 次（${msg}）`);
        } else {
          retire(m.entry, msg);
          startWatch(abs).catch(() => {});
        }
        if (!res.headersSent) return loading(res);
        return;
      }
    }
    // 非导航（页面资源/API/SSE）：等就绪槽位后自愈转发——用户看不见这些请求，值得原地救活。
    const m = await waitReady(rel);
    if (m) {
      if (m.exact && !u.endsWith('/')) { res.writeHead(301, { location: (req.url || u) + '/' }).end(); return; }
      const cut = PREFIX.length + m.entry.pageDec.length;
      if (await forwardHealed(m.entry, req, res, u.length > cut ? u.slice(cut) : '/')) return;
      return fail502(res);
    }
  }
  const rrel = refererRel(req); // vendor 页面的根绝对 API：Referer 找回来源页，原路径原样转发（不剥页面前缀！）
  if (rrel) {
    const mv = await waitReady(rrel);
    if (mv) {
      if (await forwardHealed(mv.entry, req, res, u)) return;
      return fail502(res);
    }
  }
  notFound(res);
}

function start() {
  const srv = http.createServer((req, res) => {
    route(req, res).catch(() => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('预览网关内部错误'); });
  });
  srv.listen(PORT, '0.0.0.0', () => log('监听 :' + PORT + ' 前缀=' + PREFIX + ' 工作区=' + WORKSPACE + ' 二进制' + (fs.existsSync(BIN) ? '就位' : '缺失(install.sh 未拉到技能卷?)')));
  setInterval(() => {
    const now = Date.now();
    // 有活动连接的槽 = 有人正开着页面，永不闲置回收（槽满时它最后被抢，见 spawnWatch）
    for (const [slot, s] of [...slots]) if (!s.conns && now - s.lastUsed > IDLE_MS) { log(`slot${slot} 闲置回收`); stop(slot); }
    for (const [k, v] of backoff) if (v <= now) backoff.delete(k);
  }, 60000).unref();
  // 带外写兜底（officecli 系编辑由 wrapper 的 /__pv-touch 事件驱动，不走这里）+ 页内编辑
  // (POST /api/send) 唯一刷新通道：实测当前 vendor 的 send 处理只落盘、不推任何 SSE 事件，
  // 页面刷新全指望这里比对 mtime → switch 重读。只有该槽 SSE 流上抓到改文档的原生推送
  //（tryForward 盖的 lastNative）才在 10s 窗口内吸收一次免双刷；绝不可按「API 写入新鲜度」
  // 吸收——那正是此前 send 后页面永不刷新的根因（send 走本网关，新鲜度永远命中）。
  setInterval(() => {
    const now = Date.now();
    for (const [, s] of [...slots]) {
      if (!s.ready || !s.conns) continue;
      let st = null;
      try { st = fs.statSync(s.file); } catch (_) {}
      if (!st || st.mtimeMs === s.mtimeMs) continue;
      if (now - (s.lastNative || 0) < 10000) { s.mtimeMs = st.mtimeMs; s.size = st.size; continue; }
      s.mtimeMs = st.mtimeMs;
      s.size = st.size;
      notifySwitch(s);
    }
  }, 2000).unref();
  return srv;
}

module.exports = { start, stopSession };
