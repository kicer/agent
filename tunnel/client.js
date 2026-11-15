#!/usr/bin/env node
'use strict';
// 通用反向隧道 · 本机端（家里那台）
//   主动连服务器 → 收请求 → 按 Host 找本地端口 → 转发 → 流式回传
//
// 用法: node client.js [config.yml]     环境变量 TUNNEL_SERVER / TUNNEL_TOKEN 覆盖配置
// 断线自动重连（指数退避 1s → 30s），心跳由服务端 ping 驱动，本端 ws 库自动回 pong。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
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

function log(...a) { console.log(new Date().toISOString().slice(11, 19), '[client]', ...a); }

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
    delete outHeaders['content-encoding'];   // 体已被 fetch 解压，长度也对不上，统一走 chunked
    delete outHeaders['content-length'];
    delete outHeaders['transfer-encoding'];
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

function connect() {
  if (stopping) return;
  const sep = CFG.server.includes('?') ? '&' : '?';
  const url = CFG.server + sep + 'token=' + encodeURIComponent(CFG.token);
  ws = new WebSocket(url, {
    headers: { 'User-Agent': CFG.userAgent },
    handshakeTimeout: 20000,
    perMessageDeflate: false,      // 关压缩：SSE 小帧多，压缩反而添乱且增加特征
  });

  ws.on('open', () => {
    backoff = 1000;
    linked = true;
    log(everLinked ? '已重新连接' : '已连接 ' + CFG.server);
    everLinked = true;
  });
  ws.on('message', onMessage);
  ws.on('close', (code, reason) => {
    if (stopping) return;
    if (linked) {                 // 只在「连着 → 断开」这个跳变上说一次
      linked = false;
      log('断开' + (reason ? '：' + reason : '') + '，重连中');
    }
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);   // 指数退避，封顶 30s
  });
  ws.on('error', () => {});       // close 紧接着会来，不重复报
}

process.on('SIGINT', () => { stopping = true; log('退出'); try { ws && ws.close(1000, 'client shutdown'); } catch (_) {} process.exit(0); });
process.on('SIGTERM', () => { stopping = true; process.exit(0); });

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
