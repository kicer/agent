// 单文件下载响应的公共实现：任务文件的浏览器下载（routes/files.js）与公网临时文件
// （routes/public-files.js）共用，避免两处各写一套文件名/缓存策略。
'use strict';

const path = require('path');

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

module.exports = { downloadDisposition, sendDownload };
