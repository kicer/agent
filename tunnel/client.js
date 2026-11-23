#!/usr/bin/env node
'use strict';
// 通用反向隧道 · 本机端（家里那台）
//   主动连服务器 → 收请求 → 按 Host 找本地端口 → 转发 → 流式回传
//
// 用法: node client.js [config.yml]     环境变量 TUNNEL_SERVER / TUNNEL_TOKEN 覆盖配置
// 断线自动重连（指数退避 1s → 30s）。心跳由服务端 ping 驱动、本端 ws 库自动回 pong；
// 但半死链路（Mac 睡眠/切网后 TCP 还在、实际不通）不会触发 close，所以本端另设看门狗。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const YAML = require('yaml');
const WebSocket = require('ws');

// ---------- 配置 ----------
function loadConfig() {
  const file = process.argv[2] || path.join(__dirname, 'client.yml');
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = YAML.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) {
      console.error('[tunnel] ' + file + ' 不是合法 YAML：' + e.message);
      process.exit(1);
    }
  }
  cfg.server = String(process.env.TUNNEL_SERVER || cfg.server || '').trim();
  cfg.token = String(process.env.TUNNEL_TOKEN || cfg.token || '').trim();
  cfg.services = Array.isArray(cfg.services) ? cfg.services : [];
  // 默认 UA 伪装成浏览器：跨境链路上「frp/x.x」这种 UA 是明显特征
  cfg.userAgent = cfg.userAgent ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  cfg.maxBodyMb = Number(cfg.maxBodyMb || 64);
  if (!cfg.server || !cfg.token) {
    console.error('[tunnel] 需要 server 和 token：写进 client.yml，或设 TUNNEL_SERVER / TUNNEL_TOKEN');
    process.exit(1);
  }
  if (!cfg.services.length) {
    console.error('[tunnel] services 为空：至少配一项 {host, port}');
    process.exit(1);
  }
  return cfg;
}
const CFG = loadConfig();

// 日志时间固定东八区：本机时区可能变，跨时区看日志不该换算。
// 带上日期：只留时分秒的话，跨天排查分不清早上和晚上的那两条（这次就吃了这个亏）。
const CST_MS = 8 * 3600 * 1000;
function log(...a) {
  const d = new Date(Date.now() + CST_MS);
  const p = (n) => String(n).padStart(2, '0');
  console.log(p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' '
    + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()),
    '[client]', ...a);
}

// ---------- 服务路由：Host → 本地端口 ----------
// 精确匹配优先；再退到「忽略端口」；最后允许 *.xxx 通配一项
// 服务匹配优先级：固定端口指定的 name → host 精确 → *.域名 通配 → "*" 兜底
// "*" 是给「服务器没有域名」的场景用的：浏览器访问 http://1.2.3.4:19000，
// Host 头是 IP，对不上任何域名，此时所有请求都交给这个服务（单服务形态）。
function pickService(meta) {
  const list = CFG.services || [];
  if (meta.service) {
    const byName = list.find(s => String(s.name || '') === String(meta.service));
    if (byName) return byName;
  }
  const host = String((meta.headers && meta.headers.host) || '').toLowerCase().split(':')[0];
  for (const s of list) if (String(s.host || '').toLowerCase() === host) return s;
  for (const s of list) {
    const h = String(s.host || '').toLowerCase();
    if (h.startsWith('*.') && host.endsWith(h.slice(1))) return s;
  }
  for (const s of list) if (s.host === '*') return s;
  return null;
}

// ---------- 在途请求 ----------
// 收到 op=req 建条目，body 帧往里堆，op=end 才真正发出去；
// op=abort（手机提前断开）→ abort 本地请求，别让上游白跑。
const inflight = new Map();
let ws = null;
let backoff = 1000;
let stopping = false;
let lastSeen = 0;          // 最近一次收到服务端任何帧的时刻
let retryTimer = null;     // 已排队但还没执行的重连（单飞：同时只允许一个，防两条 ws 互顶）
let reconnects = 0;        // 连续重连次数，连上即清零
let lastBeatLog = 0;       // 上次打「在线」心跳账的时刻

// 单次握手的硬超时。handshakeTimeout 只在 socket 分配后才生效，DNS 卡住时形同虚设：
// 那种情况 ws 会永远停在 CONNECTING，close 永不到来，重连就此停摆——只能重启进程。
const CONN_TIMEOUT_MS = 30000;
const ONLINE_LOG_MS = 30 * 60 * 1000;

function send(obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function onMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch (_) { return; }
  if (m.op === 'req') {
    inflight.set(m.id, { meta: m, chunks: [], size: 0, ac: new AbortController() });
  } else if (m.op === 'body') {
    const st = inflight.get(m.id);
    if (!st) return;
    const buf = Buffer.from(m.b64 || '', 'base64');
    st.size += buf.length;
    if (st.size > CFG.maxBodyMb * 1048576) {   // 和服务端同一个上限，双保险
      st.ac.abort();
      inflight.delete(m.id);
      return send({ id: m.id, ev: 'error', msg: 'body too large' });
    }
    st.chunks.push(buf);
  } else if (m.op === 'end') {
    const st = inflight.get(m.id);
    if (!st) return;
    inflight.delete(m.id);
    handleRequest(m.id, st);
  } else if (m.op === 'abort') {
    const st = inflight.get(m.id);
    if (st) { st.ac.abort(); inflight.delete(m.id); }
  }
}

// gzip 阈值：小于 1KB 压了反而亏（gzip 头开销），超过 8MB 不进内存直接流式
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|x-javascript)|image\/svg)/i;
const GZ_MIN = 1024;
const GZ_MAX = 8 * 1024 * 1024;

async function handleRequest(id, st) {
  const { meta, chunks, ac } = st;
  const svc = pickService(meta);
  if (!svc) {
    return send({ id, ev: 'error', msg: '没有匹配的本地服务: host=' + ((meta.headers || {}).host || '?') });
  }

  const headers = {};
  for (const [k, v] of Object.entries(meta.headers || {})) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'content-length' || lk === 'expect') continue;
    headers[k] = v;
  }
  // 强制不压缩：本端 fetch 会自动解压响应体，若保留 gzip 头，下游浏览器会拿明文当压缩流解析
  headers['accept-encoding'] = 'identity';

  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  try {
    const r = await fetch('http://127.0.0.1:' + svc.port + meta.path, {
      method: meta.method,
      headers,
      body,
      signal: ac.signal,
      redirect: 'manual',          // 302 要原样交给浏览器，别在这里跟丢
    });
    const outHeaders = {};
    r.headers.forEach((v, k) => { outHeaders[k] = v; });
    const ct = String(outHeaders['content-type'] || '');
    const cl = Number(outHeaders['content-length']) || 0;
    delete outHeaders['content-encoding'];   // 体已被 fetch 解压，长度也对不上，统一走 chunked
    delete outHeaders['content-length'];
    delete outHeaders['transfer-encoding'];

    // 可压缩、大小已知且在阈值内：缓冲后 gzip 再发。跨境链路上带宽是瓶颈，
    // JS/CSS/JSON 能压到 1/4 左右。SSE 不能缓冲（会毁掉流式），大文件不进内存，
    // 已压缩的二进制（图片/zip）压了反而变大——这几种都走下面的原路径。
    if (COMPRESSIBLE.test(ct) && !/event-stream/i.test(ct) && cl > 0 && cl <= GZ_MAX) {
      const buf = Buffer.from(await r.arrayBuffer());
      const gz = buf.length >= GZ_MIN ? zlib.gzipSync(buf, { level: 6 }) : null;
      if (gz && gz.length < buf.length * 0.9) {   // 压不动（已压缩/随机数据）就发明文
        outHeaders['content-encoding'] = 'gzip';
        send({ id, ev: 'head', status: r.status, headers: outHeaders });
        send({ id, ev: 'data', b64: gz.toString('base64') });
      } else {
        send({ id, ev: 'head', status: r.status, headers: outHeaders });
        send({ id, ev: 'data', b64: buf.toString('base64') });
      }
      send({ id, ev: 'end' });
      return;
    }

    send({ id, ev: 'head', status: r.status, headers: outHeaders });
    if (r.body) {
      for await (const chunk of r.body) send({ id, ev: 'data', b64: Buffer.from(chunk).toString('base64') });
    }
    send({ id, ev: 'end' });
  } catch (e) {
    if (ac.signal.aborted) return;           // 对端主动取消，不算错误
    send({ id, ev: 'error', msg: (e.message || String(e)) + (e.cause ? ' | cause: ' + (e.cause.message || e.cause) : '') });
  }
}

// ---------- 连接 / 重连 ----------
// 日志只在状态变化时说：启动一条、连上一条、断开一条，重试过程完全静默
// （和 MCP 服务一个风格：启动时报一次自己在哪，之后没人连也不刷屏）。
let linked = false;      // 当前是否连着
let everLinked = false;  // 是否连上过（区分首连和重连）

// 重连排队（单飞）：以前这里是裸的 setTimeout(connect)，一旦有两条路径同时触发
// 就会出现两条 ws 并存、互相顶（日志里连刷的 "replaced by new connection" 即此）。
// 连续失败才吭声：正常抖动 1s 就连上，不该刷屏；真出问题第 3 次起就有记录。
function scheduleReconnect() {
  if (stopping || retryTimer) return;
  const wait = backoff;
  backoff = Math.min(backoff * 2, 30000);     // 指数退避，封顶 30s
  reconnects++;
  if (reconnects === 3 || reconnects % 5 === 0) {
    log('第 ' + reconnects + ' 次重连排队（' + Math.round(wait / 1000) + 's 后）');
  }
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
}

function connect() {
  if (stopping) return;
  // 起新连接前先收掉旧的：旧 socket 的 close 会因为 ws 已换人而被忽略（见下面守卫），
  // 不会反过来再排一次重连。
  if (ws) { const old = ws; ws = null; try { old.terminate(); } catch (_) {} }
  const sep = CFG.server.includes('?') ? '&' : '?';
  const url = CFG.server + sep + 'token=' + encodeURIComponent(CFG.token);
  const sock = new WebSocket(url, {
    headers: { 'User-Agent': CFG.userAgent },
    handshakeTimeout: 20000,
    perMessageDeflate: false,      // 关压缩：SSE 小帧多，压缩反而添乱且增加特征
  });
  ws = sock;
  let opened = false;              // 本次握手是否成功（守卫只在没成功时才动手）

  // 握手全程硬超时，兜住 handshakeTimeout 管不到的那一段（DNS 解析）。
  // terminate 未必带来 close，所以这里自己补一次重连，靠单飞守卫去重。
  const guard = setTimeout(() => {
    if (opened) return;
    log('连接 ' + Math.round(CONN_TIMEOUT_MS / 1000) + 's 未建立，重新来过');
    try { sock.terminate(); } catch (_) {}
    scheduleReconnect();
  }, CONN_TIMEOUT_MS);

  sock.on('open', () => {
    opened = true;
    clearTimeout(guard);
    backoff = 1000;
    reconnects = 0;
    linked = true;
    lastSeen = Date.now();
    lastBeatLog = lastSeen;
    log(everLinked ? '已重新连接' : '已连接 ' + CFG.server);
    everLinked = true;
  });
  sock.on('message', (data) => { lastSeen = Date.now(); onMessage(data); });
  sock.on('ping', () => { lastSeen = Date.now(); });
  sock.on('close', (code, reason) => {
    clearTimeout(guard);
    if (stopping || ws !== sock) return;   // 已被新连接取代，这条 close 不算数
    // 断线时把在途请求全部作废：对端已 502，不会再有 end/abort 过来，留着就是
    // chunks 的内存 + 一个永不结束的本地 fetch（长 SSE 会话频繁掉线会一直涨）。
    for (const [, st] of inflight) { try { st.ac.abort(); } catch (_) {} }
    inflight.clear();
    if (linked) {                 // 只在「连着 → 断开」这个跳变上说一次
      linked = false;
      log('断开' + (reason ? '：' + reason : '') + '，重连中');
    }
    scheduleReconnect();
  });
  sock.on('error', () => {});     // close 紧接着会来，不重复报
}

// 看门狗：服务端每 25s ping 一次，超过 75s（连丢 3 次）一个帧都没收到就认定链路半死。
// 这种连接 close 事件永远不来，只能本端主动 terminate，由 close 走既有重连。
setInterval(() => {
  if (stopping || !ws || ws.readyState !== 1) return;   // CONNECTING 交给 connect 里的 guard
  if (Date.now() - lastSeen > 75000) {
    log('链路 ' + Math.round((Date.now() - lastSeen) / 1000) + 's 无响应，主动断开重连');
    try { ws.terminate(); } catch (_) {}
    return;
  }
  // 每 30 分钟留一条心跳账：事后能分清「当时活着」还是「静默挂了」。
  // 以前只有状态跳变才打日志，出问题的那个时间点根本无从回溯。
  if (Date.now() - lastBeatLog > ONLINE_LOG_MS) {
    lastBeatLog = Date.now();
    log('在线（' + Math.round((Date.now() - lastSeen) / 1000) + 's 前收到服务端心跳）');
  }
}, 20000).unref();

process.on('SIGINT', () => {
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
  log('退出');
  try { ws && ws.close(1000, 'client shutdown'); } catch (_) {}
  process.exit(0);
});
process.on('SIGTERM', () => { stopping = true; if (retryTimer) clearTimeout(retryTimer); process.exit(0); });

// 启动：一条说清楚往哪连、暴露了什么（之后只在状态变化时再说）
log('隧道 → ' + CFG.server + '（' + CFG.services.map(s => s.host + '→127.0.0.1:' + s.port).join(', ') + '）');

// 本地端口不通时早点说（只报问题，正常不吭声）
for (const s of CFG.services) {
  const req = http.request({ host: '127.0.0.1', port: s.port, path: '/', method: 'HEAD', timeout: 3000 }, (res) => res.resume());
  req.on('error', (e) => log('警告：127.0.0.1:' + s.port + ' 不可达（' + e.code + '），本地服务没起来？'));
  req.on('timeout', () => { req.destroy(); log('警告：127.0.0.1:' + s.port + ' 超时'); });
  req.end();
}

connect();
