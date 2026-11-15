#!/usr/bin/env node
'use strict';
// 通用反向隧道 · 服务器端
//   浏览器/手机 ──https──> nginx ──> 本进程 ──WebSocket──> 本机(家里) client ──> 127.0.0.1:port
//
// 本进程不认识任何业务：只按请求的 Host 头把字节搬给 client，client 再按自己的
// services 配置找本地端口。所以任何 HTTP 服务接进来都不用改这里的代码。
//
// 用法: node server.js [config.yml]      环境变量 TUNNEL_PORT / TUNNEL_TOKEN 覆盖配置
// 协议: 见 README.md「隧道协议」一节

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const YAML = require('yaml');
const { WebSocketServer } = require('ws');

// ---------- 配置 ----------
function loadConfig() {
  const file = process.env.TUNNEL_CONFIG || process.argv[2] || path.join(__dirname, 'server.yml');
  let cfg = {};
  let dirty = false;
  if (fs.existsSync(file)) {
    try { cfg = YAML.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) {
      console.error('[tunnel] ' + file + ' 不是合法 YAML：' + e.message);
      process.exit(1);
    }
  } else {
    dirty = true;                       // 没有配置文件 → 首次启动
  }
  cfg.port = Number(process.env.TUNNEL_PORT || cfg.port || 19000);
  cfg.token = String(process.env.TUNNEL_TOKEN || cfg.token || '');
  cfg.maxBodyMb = Number(cfg.maxBodyMb || 64);
  cfg.heartbeatMs = Number(cfg.heartbeatMs || 25000);

  // 没 token 就现生成一个随机串并落盘：省掉「先手写配置再启动」这一步，
  // docker compose up -d 直接就能跑。落盘失败也不阻断（本次仍可用）。
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    dirty = true;
  }
  if (dirty) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const out = { port: cfg.port, token: cfg.token, maxBodyMb: cfg.maxBodyMb, heartbeatMs: cfg.heartbeatMs };
      if (Array.isArray(cfg.routes) && cfg.routes.length) out.routes = cfg.routes;
      // 写回带注释的模板：YAML.stringify 本身会丢掉注释，头部这几行手动拼。
      // 这份自动生成的 server.yml 就是字段说明的唯一出处（不另维护示例文件）。
      const head = '# tunnel 服务端配置（首次启动自动生成，可直接改，改完重启生效）\n'
        + '#   port        本端口，按 Host 头路由\n'
        + '#   token       必须和家里 client.yml 里的一致\n'
        + '#   maxBodyMb   单请求体上限（MB）\n'
        + '#   heartbeatMs 心跳间隔（ms），跨境链路靠它发现半死连接\n'
        + '#   routes      可选，固定端口路由：一个端口钉死一个服务（每个 port 还要在\n'
        + '#               docker-compose.yml 的 ports 里放开）。写法：\n'
        + '#                 routes:\n'
        + '#                   - port: 19001\n'
        + '#                     service: agent\n';
      fs.writeFileSync(file, head + YAML.stringify(out));
      console.log('============================================================');
      console.log(' 首次启动，已生成配置：' + file);
      console.log(' TOKEN: ' + cfg.token);
      console.log(' ↑ 填到家里 client.yml 的 token，然后重启 client');
      console.log('============================================================');
    } catch (e) {
      console.error('[tunnel] 写配置失败：' + e.message + '（本次 token 仅进程内有效）');
    }
  }
  return cfg;
}
const CFG = loadConfig();

// ---------- 连接状态 ----------
let client = null;               // 家里那条 WS（只允许一条，新的顶掉旧的）
const pending = new Map();       // id -> { res, timer }
let seq = 0;
const nextId = () => 'r' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);

// 逐跳头：只对单段连接有意义，不能透传
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);

function log(...a) { console.log(new Date().toISOString().slice(11, 19), '[server]', ...a); }

// ---------- HTTP：把请求搬给 client ----------
// fixedService：由「固定端口路由」传进来（无域名时一个端口对一个服务）；null = 按 Host 头路由
function handleRequest(req, res, fixedService) {
  // 健康检查：只在主端口答，固定端口一律当业务流量转走
  if (!fixedService && req.url === '/__tunnel/health') {
    return json(res, 200, {
      ok: true,
      client: client ? 'online' : 'offline',
      pending: pending.size,
      uptime_s: Math.round(process.uptime()),
    });
  }

  if (!client || client.readyState !== 1) {
    return json(res, 503, { error: 'tunnel client offline', hint: '家里那台没连上，或 token 不对' });
  }

  const id = nextId();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;

  pending.set(id, { res, timer: null });
  const frame = { id, op: 'req', method: req.method, path: req.url, headers };
  if (fixedService) frame.service = fixedService;      // 端口绑定的服务名，client 优先按它找
  client.send(JSON.stringify(frame));

  let size = 0;
  let overflow = false;
  req.on('data', (chunk) => {
    if (overflow) return;
    size += chunk.length;
    if (size > CFG.maxBodyMb * 1048576) {          // 超限直接掐，别把内存吃穿
      overflow = true;
      client.send(JSON.stringify({ id, op: 'abort' }));
      pending.delete(id);
      return json(res, 413, { error: 'body too large', limit_mb: CFG.maxBodyMb });
    }
    client.send(JSON.stringify({ id, op: 'body', b64: chunk.toString('base64') }));
  });
  req.on('end', () => { if (!overflow) client.send(JSON.stringify({ id, op: 'end' })); });
  // 客户端提前断开：让家里把上游请求也停掉，别白跑。
  // 必须挂在 res 上：SSE 是 GET 无 body，req 的 'aborted' 只在传 body 时触发（且已废弃）。
  // 漏掉这条时，前端关掉 SSE 后 client 会继续读流、继续往 WS 灌数据，切会话时
  // 新旧两条流同时推，把单条 WS 占满，后发的 detail 请求只能排队。
  res.on('close', () => {
    if (!pending.has(id)) return; // 正常结束时 pending 已删
    client.send(JSON.stringify({ id, op: 'abort' }));
    pending.delete(id);
  });
}

// 主端口：按 Host 路由（有域名时的常规形态）
const server = http.createServer((req, res) => handleRequest(req, res, null));

// 固定端口：routes[{port, service}]，一个端口钉死一个服务（没有域名也能多服务）
const extraServers = [];
for (const r of (CFG.routes || [])) {
  const port = Number(r && r.port);
  const service = String((r && r.service) || '').trim();
  if (!port || !service) continue;
  const s2 = http.createServer((req, res) => handleRequest(req, res, service));
  s2.on('error', (e) => log('固定端口 ' + port + ' 起不来：' + e.message));
  s2.listen(port, () => log('固定端口 ' + port + ' → 服务 "' + service + '"'));
  extraServers.push(s2);
}

// ---------- client 回传的响应事件 ----------
function onClientMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch (_) { return log('丢弃坏帧'); }
  const entry = pending.get(m.id);
  if (!entry) return;                     // 已超时/已断开，安静丢弃
  const { res } = entry;
  try {
    if (m.ev === 'head') {
      const h = {};
      for (const [k, v] of Object.entries(m.headers || {})) {
        const lk = k.toLowerCase();
        // content-length 必然对不上（客户端已解压 / 分帧传输），交给 chunked
        if (HOP_BY_HOP.has(lk) || lk === 'content-length') continue;
        h[k] = v;
      }
      res.writeHead(m.status || 502, h);
    } else if (m.ev === 'data') {
      res.write(Buffer.from(m.b64 || '', 'base64'));
    } else if (m.ev === 'end') {
      res.end();
      pending.delete(m.id);
    } else if (m.ev === 'error') {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('tunnel error: ' + (m.msg || 'unknown'));
      pending.delete(m.id);
    }
  } catch (e) {
    log('回写失败', m.id, e.message);
    try { res.destroy(); } catch (_) {}
    pending.delete(m.id);
  }
}

// ---------- WebSocket 升级：家里连上来 ----------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://placeholder');
  if (url.pathname !== '/tunnel') { socket.destroy(); return; }
  if (url.searchParams.get('token') !== CFG.token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return log('拒绝：token 不匹配', req.socket.remoteAddress);
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (client && client.readyState === 1) {
      log('新连接顶掉旧连接');
      try { client.close(4000, 'replaced by new connection'); } catch (_) {}
    }
    client = ws;
    ws.isAlive = true;
    log('client 已连接', req.socket.remoteAddress);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', onClientMessage);
    ws.on('close', () => {
      if (client === ws) client = null;
      log('client 断开，未完成请求 ' + pending.size + ' 个一并收尾');
      // 连接没了，等在途的请求不可能再有响应，直接 502，别让浏览器干等
      for (const [id, e] of pending) {
        try { if (!e.res.headersSent) e.res.writeHead(502); e.res.end('tunnel client disconnected'); } catch (_) {}
        pending.delete(id);
      }
    });
    ws.on('error', (e) => log('client 错误', e.message));
  });
});

// 心跳：跨境链路半死状态（TCP 还在但早不通了）靠这个发现
setInterval(() => {
  if (!client || client.readyState !== 1) return;
  if (client.isAlive === false) { log('心跳超时，踢掉 client'); try { client.terminate(); } catch (_) {} client = null; return; }
  client.isAlive = false;
  try { client.ping(); } catch (_) {}
}, CFG.heartbeatMs).unref();

// 在途请求超时兜底：SSE 长连接不该被砍，所以只在「还没收到 head」时计时
setInterval(() => {
  const now = Date.now();
  for (const [id, e] of pending) {
    if (e.res.headersSent) continue;
    if (!e.born) { e.born = now; continue; }
    if (now - e.born > 120000) {
      log('请求 120s 无响应，放弃', id);
      try { e.res.writeHead(504); e.res.end('tunnel upstream timeout'); } catch (_) {}
      pending.delete(id);
      if (client && client.readyState === 1) client.send(JSON.stringify({ id, op: 'abort' }));
    }
  }
}, 10000).unref();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// SSE / 长轮询不能被 Node 的默认超时砍掉
server.timeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

server.listen(CFG.port, () => {
  log('监听 0.0.0.0:' + CFG.port + '，健康检查 /__tunnel/health');
  log('等待 client 连接 wss://<本机域名>/tunnel?token=***');
});
