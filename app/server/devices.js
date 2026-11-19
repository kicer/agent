// 设备（远端执行节点）接入层。
//
// 设备主动出站连 wss://<公网前缀>/dev/ws，core 维护连接表；工具调用时把命令推下去、
// 把 stdout/stderr/退出码收回来。设备侧不需要任何入站端口，所以家里的盒子、公司的
// Windows 都能直接在 NAT 后面接进来。
//
// 启用条件：有公网前缀（config.yml public_link.base_url 或 env PUBLIC_BASE_URL）
// 且配了 DEVICE_TOKEN。本地部署两者都没有，设备也连不进来，端点干脆不挂。
const crypto = require('crypto');
const fs = require('fs');
const WebSocket = require('ws');
const log = require('./log');

const PATH = '/dev/ws';
const PING_MS = 20000;        // nginx 默认 60s 空闲断，20s 足够安全
const DEAD_SEC = 61;          // 超过这么久没任何消息 → 判假死
const HELLO_MS = 10000;       // 连上后多久没 hello 就踢
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_OUT_CHARS = 256 * 1024; // 单流回传上限，超出截断（免得一次把上下文塞爆）

const state = {
  enabled: false,
  token: '',
  wss: null,
  byName: new Map(), // name -> device
  pending: new Map(), // 请求 id -> { onChunk, onExit, onHealth }
};

function init(cfg) {
  const base = String((cfg.public_link && cfg.public_link.base_url) || '').trim();
  state.token = String(process.env.DEVICE_TOKEN || '').trim();
  state.enabled = !!(base && state.token);
  if (state.enabled) {
    let host = base;
    try { host = new URL(base).host; } catch (_) { /* 保留原文 */ }
    log.info('devices', '设备接入已启用：wss://' + host + PATH);
  } else {
    log.info('devices', '设备接入未启用（' + (base ? '缺 DEVICE_TOKEN' : '无公网前缀') + '）');
  }
  return state.enabled;
}

function enabled() {
  return state.enabled;
}

function tokenOK(given) {
  if (!state.token) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(state.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function attach(server) {
  if (!state.enabled) return;
  state.wss = new WebSocket.Server({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (_) { return; }
    if (url.pathname !== PATH) return; // 不认识的 upgrade 不归这层管
    const hdr = String(req.headers.authorization || '');
    const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7).trim() : '';
    if (!tokenOK(bearer || url.searchParams.get('token'))) {
      log.warn('devices', '设备接入被拒：token 不匹配（来自 ' + (req.socket.remoteAddress || '?') + '）');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    state.wss.handleUpgrade(req, socket, head, ws => state.wss.emit('connection', ws, req));
  });
  state.wss.on('connection', onConnection);
  setInterval(() => {
    const now = Date.now();
    for (const dev of state.byName.values()) {
      if (now - dev.lastSeen > DEAD_SEC * 1000) {
        log.warn('devices', '设备无消息超时，断开：' + dev.name);
        try { dev.ws.terminate(); } catch (_) {}
        continue;
      }
      try { dev.ws.send(JSON.stringify({ t: 'ping' })); } catch (_) {}
    }
  }, PING_MS).unref();
}

function onConnection(ws) {
  const dev = {
    ws, name: null, os: '', arch: '', shell: '', shellPath: '', shellVer: '', root: '', ver: '',
    connectedAt: Date.now(), lastSeen: Date.now(), health: null, helloTimer: null,
  };
  dev.helloTimer = setTimeout(() => {
    if (!dev.name) { try { ws.close(4001, 'hello timeout'); } catch (_) {} }
  }, HELLO_MS);

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(String(raw)); } catch (_) { return; }
    dev.lastSeen = Date.now();
    if (m.t === 'hello') return onHello(dev, m);
    if (m.t === 'chunk') {
      const p = state.pending.get(m.id);
      if (p && p.onChunk) p.onChunk(m);
      return;
    }
    if (m.t === 'exit') {
      const p = state.pending.get(m.id);
      if (p && p.onExit) p.onExit(m);
      return;
    }
    if (m.t === 'file.chunk') {
      const p = state.pending.get(m.id);
      if (p && p.onFileChunk) p.onFileChunk(m);
      return;
    }
    if (m.t === 'file.done') {
      const p = state.pending.get(m.id);
      if (p && p.onFileDone) p.onFileDone(m);
      return;
    }
    if (m.t === 'health') {
      const p = state.pending.get(m.id);
      if (p && p.onHealth) p.onHealth(m);
    }
  });

  ws.on('close', () => {
    clearTimeout(dev.helloTimer);
    if (dev.name && state.byName.get(dev.name) === dev) {
      state.byName.delete(dev.name);
      log.info('devices', '设备下线：' + dev.name);
    }
  });
  ws.on('error', () => {});
}

function onHello(dev, m) {
  clearTimeout(dev.helloTimer);
  dev.name = String(m.name || '').trim() || ('dev-' + crypto.randomBytes(3).toString('hex'));
  dev.os = String(m.os || '');
  dev.arch = String(m.arch || '');
  dev.shell = String(m.shell || '');
  dev.shellPath = String(m.shell_path || '');
  dev.shellVer = String(m.shell_ver || '');
  dev.root = String(m.root || '');
  dev.ver = String(m.ver || '');

  const old = state.byName.get(dev.name);
  if (old && old !== dev) {
    log.warn('devices', '同名设备重新接入，踢掉旧连接：' + dev.name);
    try { old.ws.close(4000, 'replaced'); } catch (_) {}
  }
  state.byName.set(dev.name, dev);
  log.info('devices', `设备上线：${dev.name}（${dev.os}/${dev.arch} shell=${dev.shellPath || dev.shell} ${dev.shellVer} root=${dev.root}）`);

  // 上线即取一次健康快照，list 时能顺带看到负载；失败不影响接入
  health(dev.name).catch(() => {});
}

function pick(name) {
  if (name) return state.byName.get(String(name).trim()) || null;
  const first = state.byName.values().next();
  return first.done ? null : first.value;
}

function list() {
  const now = Date.now();
  return [...state.byName.values()].map(d => ({
    device: d.name,
    os: d.os,
    arch: d.arch,
    // shell 是模型的命令入口：kind 决定调用形式（sh -c / cmd /c），path 决定实际解释器
    //（/bin/sh 可能是 dash、bash 或 busybox），ver 拿得到就给。
    shell: d.shell,
    shell_path: d.shellPath,
    shell_ver: d.shellVer,
    root: d.root,
    ver: d.ver,
    connected_sec: Math.round((now - d.connectedAt) / 1000),
    idle_sec: Math.round((now - d.lastSeen) / 1000),
    health: d.health,
  }));
}

function health(name) {
  const dev = pick(name);
  if (!dev) return Promise.reject(new Error(name ? `设备 ${name} 不在线` : '当前没有设备在线'));
  const id = newJobId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`设备 ${dev.name} 未在 5s 内回应 health`));
    }, 5000);
    state.pending.set(id, {
      onHealth(m) {
        clearTimeout(timer);
        state.pending.delete(id);
        dev.health = {
          uptime_sec: m.uptime_sec, host_uptime_sec: m.host_uptime_sec,
          load1: m.load1, load5: m.load5, load15: m.load15,
          mem_total_mb: m.mem_total_mb, mem_free_mb: m.mem_free_mb,
          disk_total_gb: m.disk_total_gb, disk_free_gb: m.disk_free_gb, temp_c: m.temp_c,
        };
        resolve({ device: dev.name, os: dev.os, arch: dev.arch, ...dev.health });
      },
    });
    try {
      dev.ws.send(JSON.stringify({ t: 'health', id }));
    } catch (e) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(new Error('下发 health 失败：' + e.message));
    }
  });
}

function newJobId() {
  return crypto.randomBytes(6).toString('hex');
}

function exec({ device, command, cwd, timeout_ms }) {
  return new Promise((resolve, reject) => {
    const dev = pick(device);
    if (!dev) return reject(new Error(device ? `设备 ${device} 不在线` : '当前没有设备在线'));
    const cmd = String(command || '');
    if (!cmd.trim()) return reject(new Error('command 不能为空'));
    const tmo = Math.min(Math.max(Number(timeout_ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const id = newJobId();
    const started = Date.now();
    let out = '';
    let err = '';
    let truncated = false;
    let settled = false;

    const done = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      state.pending.delete(id);
      resolve(payload);
    };

    // 兜底看门狗：设备侧本来就会按 timeout 杀进程，这里再晚 10s 收尸，防止设备掉线后永远挂着
    const watchdog = setTimeout(() => {
      done({
        device: dev.name, code: -1, killed_by: 'watchdog', ms: Date.now() - started,
        stdout: out, stderr: err, truncated,
        note: '设备未在超时后回传结果（可能已掉线）',
      });
    }, tmo + 10000);

    state.pending.set(id, {
      onChunk(m) {
        const text = Buffer.from(String(m.chunk || ''), 'base64').toString('utf8');
        if (m.out === 'err') {
          if (err.length + text.length > MAX_OUT_CHARS) { truncated = true; err += text.slice(0, Math.max(0, MAX_OUT_CHARS - err.length)); }
          else err += text;
        } else {
          if (out.length + text.length > MAX_OUT_CHARS) { truncated = true; out += text.slice(0, Math.max(0, MAX_OUT_CHARS - out.length)); }
          else out += text;
        }
      },
      onExit(m) {
        done({
          device: dev.name,
          code: typeof m.code === 'number' ? m.code : -1,
          killed_by: m.killed_by || '',
          ms: Number(m.ms) || Date.now() - started,
          stdout: out,
          stderr: err + (m.err ? String(m.err) : ''),
          truncated: truncated || !!m.truncated,
        });
      },
    });

    try {
      dev.ws.send(JSON.stringify({
        t: 'exec', id, cmd, cwd: cwd ? String(cwd) : '', timeout_ms: tmo,
      }));
    } catch (e) {
      state.pending.delete(id);
      clearTimeout(watchdog);
      reject(new Error('下发命令失败：' + e.message));
    }
  });
}


// ---------- 文件通道 ----------
// core 与设备之间拉/推单个文件，复用同一条 WS：256 KiB 一块，base64 传输。
// 写盘一律先落 .part，size 与 sha256 都对上才 rename——不留半截文件。
const FILE_CHUNK = 256 * 1024;
const MAX_FILE = 50 * 1024 * 1024;

function fileTimeout(bytes) {
  return Math.max(61000, Math.ceil(bytes / FILE_CHUNK) * 3000);
}

// pull：设备 → 会话目录
function pull({ device, remotePath, localPath }) {
  return new Promise((resolve, reject) => {
    const dev = pick(device);
    if (!dev) return reject(new Error(device ? `设备 ${device} 不在线` : '当前没有设备在线'));
    if (!remotePath) return reject(new Error('remote_path 不能为空'));

    const id = newJobId();
    const tmp = localPath + '.part';
    const out = fs.createWriteStream(tmp);
    const hash = crypto.createHash('sha256');
    let got = 0;
    let settled = false;

    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      state.pending.delete(id);
      return true;
    };
    const fail = msg => {
      if (!finish()) return;
      try { out.destroy(); } catch (_) {}
      try { fs.unlinkSync(tmp); } catch (_) {}
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('拉取超时（60s 无完成）'), 60000);

    state.pending.set(id, {
      onFileChunk(m) {
        if (settled) return;
        let b;
        try { b = Buffer.from(String(m.data || ''), 'base64'); } catch (_) { return fail('数据块解码失败'); }
        got += b.length;
        if (got > MAX_FILE) return fail('文件超过 50MiB 上限');
        hash.update(b);
        out.write(b);
      },
      onFileDone(m) {
        if (settled) return;
        if (m.err) return fail(String(m.err));
        out.end(() => {
          if (!finish()) return;
          const sum = hash.digest('hex');
          if (typeof m.size === 'number' && m.size !== got) {
            try { fs.unlinkSync(tmp); } catch (_) {}
            return reject(new Error(`大小不符：收到 ${got}，设备报 ${m.size}`));
          }
          if (m.sha256 && String(m.sha256).toLowerCase() !== sum) {
            try { fs.unlinkSync(tmp); } catch (_) {}
            return reject(new Error('sha256 不符'));
          }
          try { fs.renameSync(tmp, localPath); } catch (e) { return reject(e); }
          resolve({ device: dev.name, bytes: got, sha256: sum, path: localPath });
        });
      },
    });

    dev.ws.send(JSON.stringify({ t: 'file', id, op: 'read', path: remotePath }));
  });
}

// push：会话目录 → 设备
async function push({ device, localPath, remotePath }) {
  const dev = pick(device);
  if (!dev) throw new Error(device ? `设备 ${device} 不在线` : '当前没有设备在线');
  if (!remotePath) throw new Error('remote_path 不能为空');

  const st = fs.statSync(localPath);
  if (!st.isFile()) throw new Error('只能推文件，不能推目录：' + localPath);
  if (st.size > MAX_FILE) throw new Error('文件超过 50MiB 上限');
  const buf = fs.readFileSync(localPath);
  const sum = crypto.createHash('sha256').update(buf).digest('hex');
  const id = newJobId();

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error('推送超时'));
    }, fileTimeout(buf.length));
    state.pending.set(id, {
      onFileDone(m) {
        clearTimeout(timer);
        state.pending.delete(id);
        if (m.err) return reject(new Error(String(m.err)));
        resolve({ device: dev.name, bytes: buf.length, sha256: sum, path: remotePath });
      },
    });
  });

  dev.ws.send(JSON.stringify({ t: 'file', id, op: 'write', path: remotePath, size: buf.length, sha256: sum }));
  for (let off = 0; off < buf.length; off += FILE_CHUNK) {
    dev.ws.send(JSON.stringify({
      t: 'file.chunk', id,
      data: buf.subarray(off, off + FILE_CHUNK).toString('base64'),
    }));
    // 简单背压：发送缓冲堆到 4MB 就等一等，避免把内存打满
    while (dev.ws.bufferedAmount > 4 * 1024 * 1024) await new Promise(r => setTimeout(r, 10));
  }
  dev.ws.send(JSON.stringify({ t: 'file.done', id }));
  return done;
}

module.exports = { init, attach, enabled, list, health, exec, pull, push, PATH };
