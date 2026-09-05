// agent-executor：命令执行服务（独立容器，供 agent-core 调用）。单文件零依赖，仅用 Node 内置 http，默认端口 9000。
//
// 接口：
//   GET    /health   → {ok, running:[{id,pid,cwd,started_at}]}
//   POST   /exec     body {command, cwd?, timeout_ms?, max_output_chars?, env?}
//                    响应 SSE(text/event-stream)，每条 data 为一个 JSON：
//                      {"type":"start","id","pid","cwd"}          进程已启动
//                      {"type":"out","chunk"}                      stdout 增量（实时分块下发）
//                      {"type":"err","chunk"}                      stderr 增量
//                      {"type":"exit","code","killed_by","stdout_chars","stderr_chars","truncated"} 结束汇总
//                    期间每 15s 发 ": ping" 注释行保活。
//   DELETE /exec/:id → {ok:true} 杀整个进程组（core 侧取消/超时用）
//
// 安全约束：
//   - 设置 EXECUTOR_TOKEN 后，除 /health 外必须带 Authorization: Bearer <token>（compose 内网互访，token 可选）；
//   - cwd 必须落在 EXECUTOR_ROOTS（逗号分隔白名单，默认 /workspace）内，先解析再 realpath 校验，防穿越；
//   - timeout_ms 夹在 [1s, EXECUTOR_MAX_TIMEOUT_MS]（默认 30 分钟）；
//   - stdout/stderr 各自按 max_output_chars 截断（默认 EXECUTOR_MAX_OUTPUT_CHARS=200000），超限后丢弃剩余输出，exit 事件带 truncated 标记。
//
// 约定：core 与 executor 把同一份宿主机 ./tasks、./skills 挂到相同容器路径（/workspace/*），
// 所以 core 下发的任务目录 cwd 在 executor 内原样可用。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 9000;
const TOKEN = process.env.EXECUTOR_TOKEN || '';
const ROOTS = (process.env.EXECUTOR_ROOTS || '/workspace').split(',').map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));
const DEFAULT_CWD = process.env.EXECUTOR_CWD || path.join(ROOTS[0], 'tasks');
const MAX_TIMEOUT = parseInt(process.env.EXECUTOR_MAX_TIMEOUT_MS, 10) || 30 * 60 * 1000;
const DEFAULT_MAX_OUT = parseInt(process.env.EXECUTOR_MAX_OUTPUT_CHARS, 10) || 200000;
const PING_MS = 15000;
const BODY_LIMIT = 1024 * 1024; // /exec 请求体上限 1MB

const runs = new Map(); // id -> { child, killedBy, started_at, cwd }

// 统一日志（ISO 时间戳 + 前缀）
function log(...args) { console.log(new Date().toISOString(), '[executor]', ...args); }

// 常量时间比较，避免通过响应耗时猜 token
function tokenOk(req) {
  if (!TOKEN) return true;
  const auth = String(req.headers.authorization || '');
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('请求体超过 ' + BODY_LIMIT + ' 字节')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('body 不是合法 JSON：' + e.message)); } });
    req.on('error', reject);
  });
}

// cwd 白名单校验：解析为绝对路径后必须位于某个 root 的 realpath 之下（含 root 本身）。
function checkCwd(raw) {
  let cwd;
  try { cwd = path.resolve(raw); } catch (_) { return null; }
  let real;
  try { real = fs.realpathSync(cwd); } catch (_) { return null; } // 不存在直接拒绝
  for (const root of ROOTS) {
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch (_) { continue; }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }
  return null;
}

function killGroup(entry) {
  const child = entry.child;
  // detached 启动后 child 是组长：对 -pid 发信号可连子进程的子孙一起杀掉
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* 已退出 */ } }
}

function sseWrite(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }

async function handleExec(req, res) {
  let args;
  try { args = await readJsonBody(req); } catch (e) { return send(res, 400, { error: e.message }); }

  const command = String(args.command || '');
  if (!command.trim()) return send(res, 400, { error: 'command 必填' });

  const rawCwd = args.cwd ? String(args.cwd) : DEFAULT_CWD;
  const cwd = checkCwd(rawCwd);
  if (!cwd) return send(res, 400, { error: 'cwd 不存在或不在白名单目录内：' + rawCwd + '（允许：' + ROOTS.join(', ') + '）' });

  let timeout = parseInt(args.timeout_ms, 10);
  if (!isFinite(timeout) || timeout <= 0) timeout = 5 * 60 * 1000;
  timeout = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT);

  let maxChars = parseInt(args.max_output_chars, 10);
  if (!isFinite(maxChars) || maxChars <= 0) maxChars = DEFAULT_MAX_OUT;
  maxChars = Math.min(maxChars, DEFAULT_MAX_OUT);

  const env = Object.assign({}, process.env);
  if (args.env && typeof args.env === 'object') {
    for (const [k, v] of Object.entries(args.env)) env[String(k)] = String(v);
  }

  const id = crypto.randomUUID();
  let child;
  try {
    child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return send(res, 500, { error: 'spawn 失败：' + e.message });
  }

  const entry = { child, killedBy: null, started_at: Date.now(), cwd, timer: null };
  runs.set(id, entry);
  log('start', id, 'pid=' + child.pid, 'cwd=' + cwd, 'timeout=' + timeout + 'ms', JSON.stringify(command).slice(0, 200));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx 前置时对 SSE 关缓冲（配合 core 的 proxy_buffering off 习惯）
  });
  const ping = setInterval(() => { res.write(': ping\n\n'); }, PING_MS);
  // 先下发 start 事件：core 靠这里的 id 调 DELETE /exec/:id 取消
  sseWrite(res, { type: 'start', id, pid: child.pid, cwd });

  // 输出计数：超限后停止下发（truncated），但仍要持续消费流，防子进程因管道满阻塞。
  const out = { stdout: 0, stderr: 0, truncated: false };
  function streamChunk(kind, chunk) {
    const key = kind === 'out' ? 'stdout' : 'stderr';
    const text = chunk.toString('utf8');
    const remain = maxChars - out[key];
    if (remain <= 0) { out.truncated = true; return; }
    if (text.length > remain) { out.truncated = true; sseWrite(res, { type: kind, chunk: text.slice(0, remain) }); out[key] = maxChars; return; }
    out[key] += text.length;
    sseWrite(res, { type: kind, chunk: text });
  }
  child.stdout.on('data', c => streamChunk('out', c));
  child.stderr.on('data', c => streamChunk('err', c));

  entry.timer = setTimeout(() => { entry.killedBy = 'timeout'; killGroup(entry); }, timeout);

  // core 断开连接（取消/重启）：连带杀掉进程，防孤儿。
  res.on('close', () => {
    if (runs.has(id)) { entry.killedBy = entry.killedBy || 'disconnected'; killGroup(entry); }
  });

  function finish(code) {
    if (!runs.has(id)) return;
    clearTimeout(entry.timer); clearInterval(ping); runs.delete(id);
    sseWrite(res, {
      type: 'exit', code, signal: child.signalCode, killed_by: entry.killedBy,
      stdout_chars: out.stdout, stderr_chars: out.stderr, truncated: out.truncated,
    });
    log('exit ', id, 'code=' + code, 'killed_by=' + entry.killedBy, 'out=' + out.stdout + 'B err=' + out.stderr + 'B');
    res.end();
  }
  child.on('error', err => { entry.killedBy = entry.killedBy || 'spawn_error'; log('spawn error', id, err.message); streamChunk('err', Buffer.from('spawn 失败：' + err.message + '\n')); finish(-1); });
  child.on('close', (code) => finish(entry.killedBy ? -1 : (code === null ? -1 : code)));
}

function handleKill(req, res, id) {
  const entry = runs.get(id);
  if (!entry) return send(res, 404, { error: '没有该执行任务（可能已结束）' });
  entry.killedBy = 'cancelled';
  killGroup(entry);
  send(res, 200, { ok: true, id });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const seg = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/health') return send(res, 200, { ok: true, time: Date.now(), running: Array.from(runs.entries()).map(([id, e]) => ({ id, pid: e.child.pid, cwd: e.cwd, started_at: e.started_at })) });
  if (!tokenOk(req)) return send(res, 401, { error: '缺少或错误的 Authorization: Bearer token' });

  try {
    if (req.method === 'POST' && url.pathname === '/exec') return await handleExec(req, res);
    if (req.method === 'DELETE' && seg.length === 2 && seg[0] === 'exec') return handleKill(req, res, seg[1]);
  } catch (e) {
    log('处理异常：', e.message);
    if (!res.headersSent) send(res, 500, { error: e.message }); else res.end();
    return;
  }
  send(res, 404, { error: '未知路由 ' + req.method + ' ' + url.pathname });
});

server.listen(PORT, () => {
  log('listening on ' + PORT + '  roots=' + ROOTS.join(', ') + '  default_cwd=' + DEFAULT_CWD + '  auth=' + (TOKEN ? 'token' : 'off'));
});

// 退出前杀掉所有在跑的进程组，防容器停止后遗留
function shutdown(sig) {
  log('收到 ' + sig + '，停止服务（杀掉 ' + runs.size + ' 个运行中任务）');
  for (const entry of runs.values()) { entry.killedBy = 'shutdown'; killGroup(entry); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
