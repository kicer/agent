// agent-executor 远程执行客户端：cfg.executor.url 非空时，terminal 工具与技能命令改走远端 executor 容器执行。
// 协议见仓库根 executor/server.js（SSE：start → out/err* → exit）。
// 与本地 spawn 的行为对齐：stdout+stderr 按到达顺序合并成一个 out 字符串；超时/取消杀远端进程组；
// 通过 run.procs 注册句柄（remoteKill），使 engine 的停止/终止会话能连带取消远端任务。
'use strict';
const http = require('node:http');

// 单引号安全包裹（内部单引号按 '\'' 规则转义），供拼 sh -c 命令串用。
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// cmd + args 数组 → 一条 shell 命令行（技能入口、pip 安装等都走它，避免 JSON 参数里的引号被吃掉）。
function shellLine(cmd, args) { return [cmd].concat(args || []).map(shq).join(' '); }

function isRemote(cfg) { return !!(cfg && cfg.executor && cfg.executor.url); }

function reqHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.executor.token) h.Authorization = 'Bearer ' + cfg.executor.token;
  return h;
}

// 执行一条命令。返回 { code, killed_by, out }；传输层失败抛 Error（由调用方决定如何呈现）。
// opts: { command, cwd?, timeout_ms?, env?, run? }（run = engine 的 {cancelled, procs}，可省略）
async function run(cfg, opts) {
  const base = cfg.executor.url;
  const timeoutMs = opts.timeout_ms && opts.timeout_ms > 0 ? opts.timeout_ms : 300000;
  let id = null;        // executor 的 start 事件里下发
  let out = '';
  let exit = null;      // exit 事件
  let localKill = null; // 'cancelled' | 'timeout'（本地判定的终止原因）

  const ac = new AbortController();
  function killRemote() {
    if (!id) return;
    fetch(base + '/exec/' + id, { method: 'DELETE', headers: reqHeaders(cfg), signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
  const handle = {
    remoteKill() {
      if (!localKill) localKill = 'cancelled';
      killRemote();
      ac.abort();
    },
  };
  const runCtx = opts.run;
  if (runCtx && runCtx.procs) runCtx.procs.add(handle);

  // 取消轮询与本地看门狗（executor 自身超时兜底，+15s 仍未见 exit 才动手）。
  const cancelTimer = runCtx ? setInterval(() => { if (runCtx.cancelled) handle.remoteKill(); }, 200) : null;
  const watchdog = setTimeout(() => { if (!exit) { if (!localKill) localKill = 'timeout'; handle.remoteKill(); } }, timeoutMs + 15000);

  try {
    const res = await fetch(base + '/exec', {
      method: 'POST',
      headers: reqHeaders(cfg),
      body: JSON.stringify({ command: opts.command, cwd: opts.cwd, timeout_ms: timeoutMs, env: opts.env }),
      signal: ac.signal,
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error('executor 拒绝请求：' + msg);
    }
    // SSE 帧手工解析：每帧以空行分隔，data: 行是 JSON 事件；": ping" 注释行忽略。
    const dec = new TextDecoder();
    let buf = '';
    outer: for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch (_) { continue; }
          if (ev.type === 'start') id = ev.id;
          else if (ev.type === 'out' || ev.type === 'err') out += ev.chunk;
          else if (ev.type === 'exit') { exit = ev; break outer; }
        }
      }
    }
  } catch (e) {
    if (e && (e.name === 'AbortError' || localKill)) {
      // 取消/看门狗路径：不算错误，合成 exit 结果返回。
    } else {
      throw new Error('executor 调用失败（' + base + '）：' + (e.cause ? e.cause.message : e.message || String(e)));
    }
  } finally {
    clearTimeout(watchdog);
    if (cancelTimer) clearInterval(cancelTimer);
    if (runCtx && runCtx.procs) runCtx.procs.delete(handle);
    if (!exit && localKill) killRemote(); // 兜底再杀一次（abort 早于 start 到达时 id 可能还没拿到）
  }

  if (!exit) {
    if (localKill) return { code: -1, killed_by: localKill, out };
    throw new Error('executor 连接中断（任务 ' + (id || '?') + ' 结果未知，远端可能仍在执行）');
  }
  return { code: exit.code, killed_by: exit.killed_by || localKill, out, truncated: !!exit.truncated };
}

// 预览槽清理：core 删会话后尽力 kill executor 侧该会话的预览槽（executor/preview.js 的 /__session-kill）。
// 与 /exec 同容器异端口：主机名取 cfg.executor.url，端口 env EXECUTOR_PREVIEW_PORT（默认 3100，与 preview.js 对齐）。
// fire-and-forget：槽是缓存不是承诺，漏网槽闲置回收自然到期，失败只静默不阻断会话删除。
function killPreviewSession(cfg, sessionId, timeoutMs) {
  if (!isRemote(cfg) || !sessionId) return;
  let host;
  try { host = new URL(cfg.executor.url).hostname; } catch (_) { return; }
  const port = Number(process.env.EXECUTOR_PREVIEW_PORT || 3100);
  const body = JSON.stringify({ session: String(sessionId) });
  const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
  if (cfg.executor.token) headers.authorization = 'Bearer ' + cfg.executor.token;
  let req;
  try {
    req = http.request({ host, port, path: '/__session-kill', method: 'POST', timeout: Number(timeoutMs) || 5000, headers },
      (res) => { res.resume(); });
  } catch (_) { return; }
  req.on('error', () => {});
  req.on('timeout', () => { req.destroy(); });
  req.end(body);
}

module.exports = { isRemote, run, shq, shellLine, killPreviewSession };
