// 公网临时文件的取用端点：GET /p/<id>（id 由内置工具 mint_public_link 在 core 进程内现签）。
//
// 这一跳的访问者是**外部服务**（如智谱服务器来拉参考图），它不带 cookie、不带 Authorization，
// 所以必须匿名可达。安全性完全来自：
//   1. id 是 22 字符随机串（crypto.randomBytes(16) base64url），不可枚举；
//   2. 服务端按时过期（public_link.ttl_ms），过期即 404；
//   3. 只吐"签发时已校验过、且落在该会话任务目录内"的文件，这里再用 resolveInTask 复核一次。
//
// 挂在 auth.middleware **之前**（server.js），所以登录与否都能访问；未命中一律 404，不吐内部信息。
//
// 响应头按扩展名分两路：图片（png/jpg/webp/gif/.../svg）走 inline + 明确 image/*，
// 用户或外部服务点开链接就能直接看图；其余一律 attachment，交给下载器
// （安卓封装壳的 DownloadManager 只认 attachment，下载语义不能改）。
'use strict';

const fs = require('fs');
const express = require('express');
const engine = require('../engine');
const publicFiles = require('../public-files');
const { resolveInTask } = require('../tools/executor');
const { sendDownload, sendInlineImage, inlineImageType } = require('../download-send');
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

  // 图片单独走 inline：用户点开 /p/<id> 是要看图，不是要下载文件。安卓封装壳 / WebView
  // 对 Content-Disposition: attachment 一律交系统下载器，图片外链因此“只下载、不打开”。
  // 其余类型保持原下载语义（PDF/Office 等交给下载器或外部服务自己处理）。
  const imgType = inlineImageType(abs);
  log.info('public-file', entry.sessionId + ' 外部取用' + (imgType ? '（图片，inline）' : '（附件）') + '：' + entry.rel);
  if (imgType) return sendInlineImage(res, abs, imgType);
  sendDownload(res, abs);
});

module.exports = router;
