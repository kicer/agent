// 公网临时文件的取用端点：GET /p/<id>（id 由 routes/public-link.js 在内网现签）。
//
// 这一跳的访问者是**外部服务**（如智谱服务器来拉参考图），它不带 cookie、不带 Authorization，
// 所以必须匿名可达。安全性完全来自：
//   1. id 是 22 字符随机串（crypto.randomBytes(16) base64url），不可枚举；
//   2. 服务端按时过期（public_link.ttl_ms），过期即 404；
//   3. 只吐"签发时已校验过、且落在该会话任务目录内"的文件，这里再用 resolveInTask 复核一次。
//
// 挂在 auth.middleware **之前**（server.js），所以登录与否都能访问；未命中一律 404，不吐内部信息。
'use strict';

const fs = require('fs');
const express = require('express');
const engine = require('../engine');
const publicFiles = require('../public-files');
const { resolveInTask } = require('../tools/executor');
const { sendDownload } = require('../download-send');
const log = require('../log');

const router = express.Router();

router.get('/:id', function (req, res) {
  const entry = publicFiles.resolve(req.params.id);
  if (!entry) return res.status(404).type('text/plain').send('not found or expired\n');

  let abs;
  try {
    abs = resolveInTask(engine.taskDirOf(entry.sessionId), entry.rel);
    if (!fs.statSync(abs).isFile()) throw new Error('not a file');
  } catch (_) {
    return res.status(404).type('text/plain').send('not found\n');
  }

  log.info('public-file', entry.sessionId + ' 外部取用：' + entry.rel);
  sendDownload(res, abs);
});

module.exports = router;
