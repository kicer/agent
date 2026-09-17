// 文件管理 API（README 10.3）：上传 / 列表 / 下载 / 删除
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const engine = require('../engine');
const { listTaskFiles } = require('./sessions');
const { resolveInTask } = require('../tools/executor');
const downloadToken = require('../download-token');
const log = require('../log');

const router = express.Router();

function taskDir(req) {
  const dir = engine.taskDirOf(req.params.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeName(original) {
  let name = Buffer.from(original || 'file', 'latin1').toString('utf8');
  name = path.basename(name).replace(/[\x00-\x1f\x7f]/g, '_');
  // 非常通字符（&?@#=%、emoji、不可见序列等）统一换成 _：
  // 微信图片 URL 直接当文件名时，& ? @ 会让 shell/AI 引用路径处处踩坑。
  // 保留：各国文字/数字（\p{L}\p{N}，含中文）、空格与 . - _ ( ) [ ] 、常见中文标点。
  name = name.replace(/[^\p{L}\p{N} \-_.()\[\]，。、（）【】]+/gu, '_');
  name = name.trim().replace(/^\.+/, '');
  // 限长（字节友好按字符数算）：主体过长截断，保留扩展名
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  if (stem.length > 80) name = stem.slice(0, 80) + ext;
  return name || 'file';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      try { cb(null, taskDir(req)); } catch (err) { cb(err); }
    },
    filename: function (req, file, cb) {
      try {
        const dir = taskDir(req);
        const name = sanitizeName(file.originalname);
        const ext = path.extname(name);
        const stem = name.slice(0, name.length - ext.length);
        let target = name;
        let i = 0;
        while (fs.existsSync(path.join(dir, target))) {
          i++;
          target = stem + '-' + i + ext;
        }
        cb(null, target);
      } catch (err) { cb(err); }
    },
  }),
  limits: { filesize: 50 * 1024 * 1024 },
});

router.post('/:id/files', upload.array('files', 10), function (req, res) {
  try {
    const uploaded = (req.files || []).map(f => ({ filename: f.filename, size: f.size }));
    const db = engine.getDb();
    for (const f of uploaded) {
      db.prepare('INSERT INTO files (session_id, filename, size, created_at) VALUES (?,?,?,?)')
        .run(req.params.id, f.filename, f.size, Date.now());
    }
    // 不再自动通知 AI:附件随用户下一条消息统一告知(见 routes/messages.js 的 attachments)
    if (uploaded.length) {
      log.info('file', (req.user || '-') + ' ' + req.params.id + ' 上传 ' + uploaded.length + ' 个文件：' +
              uploaded.map(f => f.filename + '(' + f.size + 'B)').join('、'));
    }
    res.json({ uploaded });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

router.get('/:id/files', function (req, res) {
  try {
    const session = engine.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    // ?dirs=1：附带目录标记行，前端任务文件面板用它展示空文件夹（默认不附，老消费者不受影响）
    res.json(listTaskFiles(engine.taskDirOf(session.id), { dirs: req.query.dirs === '1' }));
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// ---------- 临时下载链接（带签名 token，供浏览器原生下载使用） ----------
// 移动端浏览器 fetch+blob 下载会丢失文件名（uuid.bin）；改为短时效签名链接，
// 前端拿到后 window.location.href 导航下载，走原生下载流程。
// 密钥随进程启动随机生成，重启后旧 token 自动失效。
// 签名实现（密钥、报文形状、验签）统一在 ../download-token.js。
// （外部服务取文件的 GET /p/<id> 是另一套机制：短 ID + 内存表，见 ../public-files.js。）
const DOWNLOAD_TOKEN_TTL_MS = downloadToken.BROWSER_TTL_MS;
const signDownloadToken = downloadToken.signDownload;
const validDownloadToken = downloadToken.validDownload;

// 签发临时下载链接（需正常认证；拿到的链接 5 分钟内有效）
router.get('/:id/files/download-token', function (req, res) {
  try {
    const rel = String(req.query.path || '');
    if (!rel) return res.status(400).json({ error: '缺少 path 参数' });
    const abs = resolveInTask(engine.taskDirOf(req.params.id), rel);
    if (!fs.statSync(abs).isFile()) return res.status(400).json({ error: '不是文件' });
    const expires = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
    const t = signDownloadToken(req.params.id, rel, expires);
    // 真实文件名放进 URL 路径段：AOSP DownloadManager 解析不了 Content-Disposition 时
    // 会退回“从 URL 猜名字”，这样兜底也能拿到正确名字。token 仍按 query 里的 path 计算。
    res.json({
      url: '/api/sessions/' + encodeURIComponent(req.params.id) + '/files/download-name/'
        + encodeURIComponent(path.basename(rel)) + '?path='
        + encodeURIComponent(rel) + '&expires=' + expires + '&t=' + t,
    });
  } catch (err) {
    res.status(404).json({ error: '文件不存在' });
  }
});

// Content-Disposition / 下载响应统一实现在 ../download-send.js（公网临时文件取用也用它）
const { downloadDisposition, sendDownload } = require('../download-send');

// 下载核心（支持子目录路径，前端用 ?path=xxx 传入相对路径）
function serveDownload(req, res) {
  try {
    const rel = String(req.query.path || '');
    if (!rel) return res.status(400).json({ error: '缺少 path 参数' });
    // 带 token 的请求须先验签（会话/路径/时效任一不符即拒绝）
    if (req.query.t && !validDownloadToken(req.params.id, rel, req.query.expires, String(req.query.t))) {
      return res.status(403).json({ error: '下载链接已过期或无效' });
    }
    const abs = resolveInTask(engine.taskDirOf(req.params.id), rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) return res.status(400).json({ error: '不是文件' });
    sendDownload(res, abs);
  } catch (err) {
    res.status(404).json({ error: '文件不存在' });
  }
}

// 下载（经典形式；URL 末段是固定的 “download”，猜名兜底会拿到 download.pdf）
router.get('/:id/files/download', serveDownload);

// 加固形式：URL 路径末段带上真实文件名（download-name/<名字>?path=...），
// 供解析不了 Content-Disposition 的下载器兜底；path 参数与验签逻辑完全一致。
router.get('/:id/files/download-name/*', serveDownload);

// ---------- 打包下载（选中项含文件夹时，后端把整个选择打成 zip 流式返回） ----------
// 纯 Node 实现（STORE 不压缩 + 手拼 zip 结构）：任务目录里多是媒体/生成产物，
// 压缩收益低；两遍读文件（先算 CRC 再磁盘流发送），内存占用与总大小无关。

const CRC32_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32Update(c, buf) {
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC32_TABLE[(c ^ buf[i]) & 0xFF];
  return c;
}
function crc32Final(c) { return (c ^ 0xFFFFFFFF) >>> 0; }

// 文件修改时间 → zip 的 DOS time/date 两个 16 位字段
function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// zip 条目一律以任务目录为根（rel 用正斜杠），保留所选文件夹内部层级
function collectZipEntries(dir, paths) {
  const entries = [];
  const seen = new Set();
  const addFile = function (abs, rel, st) {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (st.size >= 0xFFFFFFFF) {
      throw Object.assign(new Error('文件超过 4GB，无法打包：' + rel), { status_code: 400 });
    }
    entries.push({ abs, rel, size: st.size, mtime: st.mtimeMs });
  };
  const walk = function (absDir, relDir) {
    let list;
    try { list = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const abs = path.join(absDir, e.name);
      const rel = relDir ? relDir + '/' + e.name : e.name;
      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) addFile(abs, rel, st);
    }
  };
  for (const p of paths) {
    const abs = resolveInTask(dir, p);
    const st = fs.statSync(abs);
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    if (st.isFile()) addFile(abs, rel, st);
    else if (st.isDirectory()) walk(abs, rel);
  }
  if (!entries.length) throw Object.assign(new Error('没有可打包的文件'), { status_code: 400 });
  if (entries.length > 65535) throw Object.assign(new Error('文件过多，无法打包'), { status_code: 400 });
  return entries;
}

function zipLocalHeader(e) {
  const name = Buffer.from(e.rel, 'utf8');
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);            // version needed
  b.writeUInt16LE(0x0800, 6);        // flags: UTF-8 文件名
  b.writeUInt16LE(0, 8);             // method: store
  const dt = dosDateTime(e.mtime);
  b.writeUInt16LE(dt.time, 10); b.writeUInt16LE(dt.date, 12);
  b.writeUInt32LE(e.crc, 14);
  b.writeUInt32LE(e.size, 18); b.writeUInt32LE(e.size, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28);
  return Buffer.concat([b, name]);
}

function zipCentralEntry(e) {
  const name = Buffer.from(e.rel, 'utf8');
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6);
  b.writeUInt16LE(0x0800, 8); b.writeUInt16LE(0, 10);
  const dt = dosDateTime(e.mtime);
  b.writeUInt16LE(dt.time, 12); b.writeUInt16LE(dt.date, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(e.size, 20); b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt16LE(0, 30); b.writeUInt16LE(0, 32);   // extra / comment 长度
  b.writeUInt16LE(0, 34); b.writeUInt16LE(0, 36);   // disk start / internal attrs
  b.writeUInt32LE(0, 38);                           // external attrs
  b.writeUInt32LE(e.offset, 42);                    // local header 偏移
  return Buffer.concat([b, name]);
}

function zipEocd(count, cdSize, cdOffset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4); b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8); b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12); b.writeUInt32LE(cdOffset, 16);
  return b;
}

function writeChunk(res, buf) {
  return new Promise(function (resolve, reject) {
    res.write(buf, function (err) { err ? reject(err) : resolve(); });
  });
}
function pipeFileToRes(res, abs) {
  return new Promise(function (resolve, reject) {
    const s = fs.createReadStream(abs);
    s.on('error', reject);
    s.on('end', resolve);
    s.pipe(res, { end: false });
  });
}

// 流式写出 zip：每个条目两遍读（第一遍算 CRC，第二遍发送），不整包进内存
async function hashFileForZip(abs) {
  let c = 0xFFFFFFFF;
  await new Promise(function (resolve, reject) {
    const s = fs.createReadStream(abs);
    s.on('data', function (buf) { c = crc32Update(c, buf); });
    s.on('error', reject);
    s.on('end', resolve);
  });
  return crc32Final(c);
}

async function streamZip(res, entries) {
  for (const e of entries) e.crc = await hashFileForZip(e.abs);
  let offset = 0;
  const central = [];
  for (const e of entries) {
    const head = zipLocalHeader(e);
    e.offset = offset;
    await writeChunk(res, head); offset += head.length;
    await pipeFileToRes(res, e.abs); offset += e.size;
    central.push(zipCentralEntry(e));
  }
  let cdSize = 0;
  for (const b of central) { await writeChunk(res, b); cdSize += b.length; }
  await writeChunk(res, zipEocd(entries.length, cdSize, offset));
}

// paths 参数：URL 编码的 JSON 字符串数组（可含文件与文件夹相对路径）
function parseZipPaths(raw) {
  let arr;
  try { arr = JSON.parse(String(raw || '')); } catch (_) { arr = null; }
  if (!Array.isArray(arr) || !arr.length || arr.length > 500 ||
      !arr.every(p => typeof p === 'string' && !!p.trim())) {
    throw Object.assign(new Error('paths 参数无效'), { status_code: 400 });
  }
  return arr;
}

// 打包名：单个文件夹 → <名字>.zip；多项 → task-files-<时间戳>.zip
function zipNameFor(paths) {
  if (paths.length === 1) {
    const leaf = path.basename(String(paths[0]).replace(/\/+$/, '')) || 'archive';
    const noExt = leaf.replace(/\.[^.]+$/, '');
    return (noExt || leaf) + '.zip';
  }
  const d = new Date();
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return 'task-files-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.zip';
}

// 打包下载的报文形状与单文件下载不同（整串 paths 一起签），其余共用 ../download-token.js
function zipPayload(sessionId, pathsRaw, expires) {
  return sessionId + '\nzip\n' + pathsRaw + '\n' + expires;
}
function signZipToken(sessionId, pathsRaw, expires) {
  return downloadToken.signPayload(zipPayload(sessionId, pathsRaw, expires));
}
function validZipToken(sessionId, pathsRaw, expires, t) {
  return downloadToken.validPayload(zipPayload(sessionId, pathsRaw, expires), expires, t);
}

// 签发打包下载链接（需正常认证；与单文件下载同一条 token 链路）
router.get('/:id/files/zip-token', function (req, res) {
  try {
    const raw = String(req.query.paths || '');
    const paths = parseZipPaths(raw);
    const dir = engine.taskDirOf(req.params.id);
    for (const p of paths) fs.statSync(resolveInTask(dir, p)); // 先验路径安全与存在性
    const expires = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
    const t = signZipToken(req.params.id, raw, expires);
    const name = zipNameFor(paths);
    // URL 末段带上 zip 名，供解析不了 Content-Disposition 的下载器兜底（同 download-name）
    res.json({
      name,
      url: '/api/sessions/' + encodeURIComponent(req.params.id) + '/files/zip-name/'
        + encodeURIComponent(name) + '?paths='
        + encodeURIComponent(raw) + '&expires=' + expires + '&t=' + t,
    });
  } catch (err) {
    res.status(err.status_code || 404).json({ error: String(err && err.message || err) });
  }
});

// zip 流式下载核心（token 验签逻辑与 serveDownload 一致；无 token 时走 cookie 认证）
async function serveZip(req, res) {
  try {
    const raw = String(req.query.paths || '');
    if (req.query.t && !validZipToken(req.params.id, raw, req.query.expires, String(req.query.t))) {
      return res.status(403).json({ error: '下载链接已过期或无效' });
    }
    const paths = parseZipPaths(raw);
    const dir = engine.taskDirOf(req.params.id);
    const entries = collectZipEntries(dir, paths);
    const name = zipNameFor(paths);
    log.info('file', (req.user || '-') + ' ' + req.params.id + ' 打包下载 ' + name +
      '（' + paths.length + ' 项 / ' + entries.length + ' 个文件）');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', downloadDisposition(name));
    await streamZip(res, entries);
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(err.status_code || 500).json({ error: String(err && err.message || err) });
    } else {
      log.error('file', 'zip 流中断', err);
      try { res.destroy(); } catch (_) {}
    }
  }
}

router.get('/:id/files/zip', function (req, res) { serveZip(req, res); });
// 加固形式：URL 末段带 zip 文件名；paths 与验签逻辑与 /zip 完全一致
router.get('/:id/files/zip-name/*', function (req, res) { serveZip(req, res); });

router.delete('/:id/files', function (req, res) {
  try {
    const rel = String(req.query.path || '');
    if (!rel) return res.status(400).json({ error: '缺少 path 参数' });
    const dir = engine.taskDirOf(req.params.id);
    const abs = resolveInTask(dir, rel);
    if (path.resolve(abs) === path.resolve(dir)) {
      return res.status(400).json({ error: '禁止删除任务目录' });
    }
    fs.rmSync(abs, { recursive: true, force: true });
    engine.getDb().prepare('DELETE FROM files WHERE session_id = ? AND filename = ?')
      .run(req.params.id, rel);
    log.info('file', (req.user || '-') + ' ' + req.params.id + ' 删除文件 ' + rel);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: '文件不存在' });
  }
});

// 兼容 README 形式：GET /:id/files/{filename}（支持子目录）
router.get('/:id/files/*', function (req, res) {
  try {
    const rel = req.params[req.params.length - 1] || '';
    if (!rel) return res.status(400).json({ error: '缺少文件名' });
    const abs = resolveInTask(engine.taskDirOf(req.params.id), rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) return res.status(400).json({ error: '不是文件' });
    sendDownload(res, abs);
  } catch (err) {
    res.status(404).json({ error: '文件不存在' });
  }
});

// 兼容 README 形式：DELETE /:id/files/{filename}
router.delete('/:id/files/*', function (req, res) {
  req.query.path = req.params[req.params.length - 1] || '';
  if (!req.query.path) return res.status(400).json({ error: '缺少文件名' });
  try {
    const dir = engine.taskDirOf(req.params.id);
    const abs = resolveInTask(dir, req.query.path);
    if (path.resolve(abs) === path.resolve(dir)) {
      return res.status(400).json({ error: '禁止删除任务目录' });
    }
    fs.rmSync(abs, { recursive: true, force: true });
    engine.getDb().prepare('DELETE FROM files WHERE session_id = ? AND filename = ?')
      .run(req.params.id, req.query.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: '文件不存在' });
  }
});

module.exports = router;
module.exports.sanitizeName = sanitizeName;
