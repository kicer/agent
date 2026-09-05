// 文件管理 API（README 10.3）：上传 / 列表 / 下载 / 删除
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const engine = require('../engine');
const { listTaskFiles } = require('./sessions');
const { resolveInTask } = require('../tools/executor');
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
    res.json(listTaskFiles(engine.taskDirOf(session.id)));
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// ---------- 临时下载链接（带签名 token，供浏览器原生下载使用） ----------
// 移动端浏览器 fetch+blob 下载会丢失文件名（uuid.bin）；改为短时效签名链接，
// 前端拿到后 window.location.href 导航下载，走原生下载流程。
// 密钥随进程启动随机生成，重启后旧 token 自动失效。
const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;
const downloadTokenSecret = crypto.randomBytes(32).toString('hex');

function signDownloadToken(sessionId, rel, expires) {
  return crypto.createHmac('sha256', downloadTokenSecret)
    .update(sessionId + '\n' + rel + '\n' + expires).digest('hex');
}

function validDownloadToken(sessionId, rel, expires, t) {
  const exp = Number(expires);
  if (!t || !Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = signDownloadToken(sessionId, rel, exp);
  try {
    return crypto.timingSafeEqual(Buffer.from(String(t), 'utf8'), Buffer.from(expected, 'utf8'));
  } catch (_) { return false; }
}

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

// Content-Disposition 手工构造，绕开 content-disposition 包的 ASCII 兜底：
// 该包会把中文名逐字替换成 ?（???.pdf），且 filename= 后紧跟 filename*= 会让
// 老 AOSP DownloadManager 的正则解析失败而改从 URL 猜名（download.pdf）。
// 这里传统 filename= 直接放百分号编码的 UTF-8：朴素解析器解码后能得到真名，
// 标准客户端照旧优先 filename*（RFC 5987）。
function downloadDisposition(name) {
  const legacy = encodeURIComponent(name);
  // RFC 5987 attr-char 不含 ' ( ) ! *，ext-value 里需额外编码
  const ext = legacy.replace(/['()!*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
  return 'attachment; filename="' + legacy + '"; filename*=UTF-8\'\'' + ext;
}

// 下载统一响应：禁用一切缓存协商。
// 默认的 ETag/Last-Modified + Cache-Control: public, max-age=0 会诱导移动端浏览器
// 先发条件请求拿 304 空体，下载管理器随后卡在“等待中”（桌面 Safari/curl 不受影响）。
// 不能用 res.download：它会用 content-disposition 包覆盖上面的文件名策略；
// res.sendFile 不设置 Content-Disposition，Content-Type 按扩展名自动出，Range 由 send 支持。
function sendDownload(res, abs) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Disposition', downloadDisposition(path.basename(abs)));
  res.sendFile(abs, { lastModified: false, etag: false, maxAge: 0 });
}

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
