#!/usr/bin/env node
'use strict';
// 上下文缓存中继：把「每轮重传全量历史」换成「只传增量」。
//
// 客户端带两个头：
//   X-Context-Id    <core_id>:<user>:<session_id>
//   X-Context-Hash  客户端认为本服务已存的那段消息的 sha256（空 = 全量替换）
// 命中就把缓存拼在新增前面转发给上游；不命中回 409，客户端改发全量。
// 不带这两个头 → 完全透明转发，行为与直连一致。
//
// 本服务只做三件事：查表、拼数组、pipe 响应。不解析 SSE、不改帧、不缓冲。

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- 配置 ----------
const DEFAULTS = {
  port: 7865,
  upstream: 'http://127.0.0.1:7863',
  max_body_mb: 64,
  store: {
    ttl_ms: 7 * 24 * 3600 * 1000,
    max_bytes: 5 * 1024 * 1024,        // 单个会话上限
    max_total_bytes: 256 * 1024 * 1024, // 全部会话总量闸（安全阀）
    models: {},
  },
};

function loadConfig() {
  const file = process.argv[2] || path.join(__dirname, '..', 'config.json');
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error('[relay] 配置不是合法 JSON：' + file + ' → ' + e.message);
      process.exit(1);
    }
  }
  const store = Object.assign({}, DEFAULTS.store, raw.store || {});
  store.models = store.models && typeof store.models === 'object' ? store.models : {};
  return Object.assign({}, DEFAULTS, raw, { store });
}
const CFG = loadConfig();

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), '[relay]', ...a);
}

// ---------- 模型白名单 ----------
// 精确匹配优先，其次只认尾部带 * 的前缀通配（cn:*）。不写 = 不开。
function storeEnabled(model) {
  const m = CFG.store.models;
  const name = String(model || '');
  if (Object.prototype.hasOwnProperty.call(m, name)) return m[name] === true;
  for (const k of Object.keys(m)) {
    if (k.endsWith('*') && name.startsWith(k.slice(0, -1))) return m[k] === true;
  }
  return false;
}

// ---------- 缓存 ----------
// key -> { hash, messages, bytes, expireAt, lastUsed }
// 两个字节数阈值，语义不同：
//   max_bytes       —— 单个会话上限，超了就这个会话不缓存（下次全量），不影响别人
//   max_total_bytes —— 全部会话总量闸，超了按 LRU 淘汰最久没用的
// 不设条数上限：那会在「会话最长、最需要增量」的时候把人打回全量，正好反着来。
const cache = new Map();
let cacheBytes = 0;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
// 两侧（core 与本服务）都只认 JSON.stringify 的结果：字段顺序取自原始报文，
// 客户端拼出来的字符串与服务端一致。
function messagesHash(messages) {
  return sha256(JSON.stringify(messages));
}
function byteLen(s) {
  return Buffer.byteLength(s, 'utf8');
}

function touch (key, entry) {
  entry.lastUsed = Date.now();
  // Map 插入顺序即 LRU 顺序：删了再插，等价于移到队尾
  cache.delete(key);
  cache.set(key, entry);
}

function evictIfNeeded() {
  const max = CFG.store.max_total_bytes;
  const now = Date.now();
  for (const [k, e] of cache) {
    if (e.expireAt <= now) {
      cache.delete(k);
      cacheBytes -= e.bytes;
    }
  }
  while (cacheBytes > max && cache.size) {
    const oldest = cache.keys().next().value;
    const e = cache.get(oldest);
    cache.delete(oldest);
    cacheBytes -= e.bytes;
    log('LRU 淘汰 ' + oldest + '（' + fmtBytes(e.bytes) + '）');
  }
}

function put(key, messages) {
  const prev = cache.get(key);
  if (prev) { cacheBytes -= prev.bytes; cache.delete(key); }
  const bytes = byteLen(JSON.stringify(messages));
  if (bytes > CFG.store.max_bytes) {
    // 单会话超上限：直接不缓存。不能截断（截断会破坏上下文），只能退回全量模式。
    log(key + ' 单会话 ' + fmtBytes(bytes) + ' 超过上限 ' + fmtBytes(CFG.store.max_bytes) + '，不缓存');
    return null;
  }
  const entry = {
    hash: messagesHash(messages),
    messages,
    bytes,
    expireAt: Date.now() + CFG.store.ttl_ms,
    lastUsed: Date.now(),
  };
  cache.set(key, entry);
  cacheBytes += bytes;
  evictIfNeeded();
  return entry;
}

function get(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expireAt <= Date.now()) {
    cache.delete(key);
    cacheBytes -= e.bytes;
    return null;
  }
  touch(key, e);
  return e;
}

function fmtBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(2) + 'MB';
}

// ---------- 同 key 串行 ----------
// core 本来就是串行发的，这把锁只防「同一会话被两个客户端同时打」导致拼接乱序。
const locks = new Map();
async function withLock(key, fn) {
  while (locks.has(key)) await locks.get(key);
  let release;
  const p = new Promise((r) => (release = r));
  locks.set(key, p);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}

// ---------- 转发 ----------
function splitUrl(u) {
  const m = /^(https?):\/\/([^/]+)(\/.*)?$/.exec(u);
  if (!m) throw new Error('上游地址非法: ' + u);
  return { mod: m[1] === 'https' ? https : http, host: m[2], base: m[3] || '' };
}
const UP = splitUrl(CFG.upstream);

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

function forward(bodyBuf, req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers['content-length'] = bodyBuf.length;

  const out = UP.mod.request(
    { host: UP.host.split(':')[0], port: UP.host.split(':')[1] || (UP.mod === https ? 443 : 80),
      path: UP.base + req.url.replace(/^\/v1c/, ''), method: req.method, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);   // 流式原样回传：SSE 不受影响
    }
  );
  out.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'upstream_unreachable', message: String(e && e.message || e) } }));
    } else {
      res.destroy();
    }
  });
  out.end(bodyBuf);
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

// ---------- 主流程 ----------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { status: 'ok', service: 'ctx-relay', conversations: cache.size, bytes: cacheBytes });
  }

  const chunks = [];
  let size = 0;
  const limit = CFG.max_body_mb * 1024 * 1024;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) {
      sendJson(res, 413, { error: { code: 'body_too_large', message: 'body > ' + CFG.max_body_mb + 'MB' } });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const ctxId = String(req.headers['x-context-id'] || '').trim();
    const ctxHash = String(req.headers['x-context-hash'] || '').trim();

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      return forward(raw, req, res);   // 非 JSON 一律透明转发
    }

    // 没带 context id，或模型没开 store → 原样转发
    if (!ctxId || !storeEnabled(body.model)) {
      return forward(raw, req, res);
    }

    withLock(ctxId, () => {
      const delta = Array.isArray(body.messages) ? body.messages : [];
      const deltaBytes = byteLen(JSON.stringify(delta));
      const entry = get(ctxId);
      let messages;

      if (ctxHash === '') {
        messages = delta;                      // 全量替换（首轮 / 压缩后 / 回退重发）
      } else if (entry && entry.hash === ctxHash) {
        messages = entry.messages.concat(delta);
      } else {
        log(ctxId + ' hash 不匹配，回 409（delta=' + delta.length + '）');
        return sendJson(res, 409, {
          error: { code: 'context_mismatch', message: 'context hash mismatch, resend full messages with empty X-Context-Hash' },
        });
      }

      const saved = byteLen(JSON.stringify(messages)) - deltaBytes;
      put(ctxId, messages);
      log(ctxId + ' delta=' + delta.length + ' total=' + messages.length +
          ' 上传 ' + fmtBytes(deltaBytes) + ' 省 ' + fmtBytes(saved > 0 ? saved : 0) +
          ' 缓存 ' + fmtBytes(cacheBytes) + '/' + fmtBytes(CFG.store.max_total_bytes));

      const outBody = Buffer.from(JSON.stringify(Object.assign({}, body, { messages })));
      forward(outBody, req, res);
    }).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'relay_error', message: String(e && e.message || e) } });
    });
  });
});

server.listen(CFG.port, '0.0.0.0', () => {
  log('监听 0.0.0.0:' + CFG.port + ' → ' + CFG.upstream);
  log('store: ttl=' + (CFG.store.ttl_ms / 3600000) + 'h 单会话≤' + fmtBytes(CFG.store.max_bytes) +
      ' 总量≤' + fmtBytes(CFG.store.max_total_bytes) + ' models=' + JSON.stringify(CFG.store.models));
});
