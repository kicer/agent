// 统一 HTTP 错误出口（Express 的四参数错误中间件，必须在所有路由之后注册）。
//
// 存在理由：Express 默认错误处理器只有 NODE_ENV=production 时才回一句干净的 500，
// 其余环境把 err.stack 拼成 HTML 吐给请求方——里面是服务端绝对路径、源码文件名+行号、
// 依赖版本。本地形态 NODE_ENV 通常未设置，等于默认开启。而 /p/<id> 这类端点匿名可达
// （见 routes/public-files.js），一次 sendFile 失败就能把整份栈打到公网。
//
// 策略：状态码照旧透出（body-parser 的 400/413、send 的 404 都靠它，客户端要能区分），
// 正文永远固定一句，栈只进日志。
'use strict';

const log = require('./log');

// 只认 err.status / err.statusCode 里的合法 4xx-5xx；其余（含没状态码的普通 Error）一律 500。
function statusOf(err) {
  const s = Number(err && (err.status || err.statusCode));
  return s >= 400 && s <= 599 ? s : 500;
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = statusOf(err);
  const where = (req && req.method ? req.method + ' ' + (req.originalUrl || req.url || '') : '(unknown)');
  // 5xx = 未预期异常，栈进日志；4xx 是调用方问题，一行 message 足够。
  if (status >= 500) log.error('http', where + ' → ' + status + '：' + ((err && err.stack) || err));
  else log.warn('http', where + ' → ' + status + '：' + ((err && err.message) || err));

  if (res.headersSent) { if (res.destroy) res.destroy(); return; } // 响应已开始，只能断开
  res.removeHeader('Content-Disposition'); // 可能已被 download-send 设过，错误体不该带文件名
  res.status(status).type('text').send(status >= 500 ? 'internal error' : 'request failed');
}

module.exports = { errorHandler, statusOf };
