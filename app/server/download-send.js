// 单文件下载 / 内联响应的公共实现：任务文件的浏览器下载（routes/files.js）、公网临时文件
// （routes/public-files.js）共用，避免两处各写一套文件名/缓存策略。
'use strict';

const path = require('path');
const log = require('./log');

// Content-Disposition 手工构造，绕开 content-disposition 包的 ASCII 兜底：
// 该包会把中文名逐字替换成 ?（???.pdf），且 filename= 后紧跟 filename*= 会让
// 老 AOSP DownloadManager 的正则解析失败而改从 URL 猜名（download.pdf）。
// 这里传统 filename= 直接放百分号编码的 UTF-8：朴素解析器解码后能得到真名，
// 标准客户端照旧优先 filename*（RFC 5987）。
function contentDisposition(name, type) {
  const legacy = encodeURIComponent(name);
  // RFC 5987 attr-char 不含 ' ( ) ! *，ext-value 里需额外编码
  const ext = legacy.replace(/['()!*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
  return type + '; filename="' + legacy + '"; filename*=UTF-8\'\'' + ext;
}

function downloadDisposition(name) {
  return contentDisposition(name, 'attachment');
}

// 内联图片判定：只看扩展名，不读文件头——公网端点不做内容嗅探，也不该为了“猜类型”整包读文件。
// svg 也算：浏览器只有拿到 image/svg+xml 才会渲染而不是下载（脚本风险由下面的 CSP sandbox 兜住）。
const INLINE_IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
]);

function inlineImageType(abs) {
  return INLINE_IMAGE_TYPES.get(path.extname(String(abs || '')).toLowerCase()) || null;
}

// 下载统一响应：禁用一切缓存协商。
// 默认的 ETag/Last-Modified + Cache-Control: public, max-age=0 会诱导移动端浏览器
// 先发条件请求拿 304 空体，下载管理器随后卡在“等待中”（桌面 Safari/curl 不受影响）。
// 不能用 res.download：它会用 content-disposition 包覆盖上面的文件名策略；
// res.sendFile 不设置 Content-Disposition，Content-Type 按扩展名自动出，Range 由 send 支持。
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

// sendFile 失败的统一出口（所有调用方共用，不再各自 try/catch——sendFile 的失败是
// **异步**回调，调用方外层的 try/catch 根本抓不到）。
//
// 为什么必须有人接：没人接就落进 Express 默认错误处理器，而它在 NODE_ENV != production 时
// 会把 err.stack 拼成 HTML 页面吐给请求方——服务端绝对路径、源码文件名+行号、依赖版本全在
// 里面。/p/<id> 是匿名可达端点（public-files.js 挂在 auth 之前），一次失败就等于把内部结构
// 公开。所以正文只留一行固定文案，细节进日志。
//
// 4xx 一律折叠成 404：不向匿名取用方区分「不存在」与「无权限」（原来的 403/416 会变成
// 探针，能区分路径是否存在）。
function sendFileError(res, err, abs) {
  const code = Number(err && err.status);
  const notFound = !!err && (err.code === 'ENOENT' || (code >= 400 && code < 500));
  const status = notFound ? 404 : 500;
  log.warn('download', (notFound ? '取不到文件：' : '发送失败：') + abs +
    '（' + ((err && (err.code || err.message)) || err) + '）');
  if (res.headersSent) { if (res.destroy) res.destroy(); return; } // 已吐了半截，只能断开
  res.removeHeader('Content-Disposition'); // 进来前已按附件设过，错误响应不该带文件名
  res.status(status).type('text').send(notFound ? 'not found' : 'internal error');
}

function sendDownload(res, abs) {
  noStore(res);
  res.setHeader('Content-Disposition', downloadDisposition(path.basename(abs)));
  // dotfiles:'allow' 与下面的图片分支对齐。send 默认 'ignore' 会把 .env / .gitignore 这类
  // 文件当成"不存在"抛 NotFoundError——文件明明在，取用方却拿到 404，且历史版本还会连带
  // 把堆栈页吐出去（见 sendFileError）。点文件本来就是我们自己签发的，没有理由拒绝。
  res.sendFile(abs, { dotfiles: 'allow', lastModified: false, etag: false, maxAge: 0 }, function (err) {
    if (err) sendFileError(res, err, abs);
  });
}

// 内联图片响应（公网链 GET /p/<id> 的图片分支）：点开链接直接显示，不再被当成附件下载。
// 安卓封装壳 / WebView 对 attachment 一律交系统下载器，图片外链因此“只下载、不打开”；
// inline + 明确的 image/* 才走渲染路径。缓存仍 no-store：/p/<id> 是短命 bearer 链，
// 不该被中间缓存留副本（与下载同语义）。
function sendInlineImage(res, abs, type) {
  noStore(res);
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDisposition(path.basename(abs), 'inline'));
  // SVG 是唯一能带脚本的“图片”，而 /p/ 是匿名同源端点：直接打开会以本应用身份执行脚本。
  // sandbox 不给 allow-scripts，退化成不可执行、无同源权限的文档；<img> 引用本就不执行脚本，不受影响。
  if (type === 'image/svg+xml') res.setHeader('Content-Security-Policy', 'sandbox');
  // dotfiles 显式放行：read_file 的压缩产物在 .imgcache/（点目录），默认策略对其他调用方不保证。
  // 回调同 sendDownload：图片也可能在读盘中途失败（被删/EACCES），不能漏给默认错误处理器。
  res.sendFile(abs, { dotfiles: 'allow', lastModified: false, etag: false, maxAge: 0 }, function (err) {
    if (err) sendFileError(res, err, abs);
  });
}

module.exports = { contentDisposition, downloadDisposition, sendDownload, sendInlineImage, inlineImageType };
