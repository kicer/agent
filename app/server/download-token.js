// 临时链接签名（files.js 的浏览器下载链接用）。
//
// 设计要点：
//   - 密钥进程内随机：重启后所有旧链接自动失效。公网链接本来就该短命，这是免费拿到的性质。
//   - 签名覆盖「会话 + 路径 + 过期时间」三项，任何一项被改都会验签失败；
//     验签用 timingSafeEqual，不做按字节比较的旁路。
//   - 这里只提供"怎么签"；"给谁签、能签什么"由调用方决定（见 routes/files.js 的校验）。
'use strict';

const crypto = require('crypto');

const SECRET = crypto.randomBytes(32).toString('hex');

// 浏览器原生下载用：前端拿到后立刻 window.location.href 导航，5 分钟足够
const BROWSER_TTL_MS = 5 * 60 * 1000;

function signPayload(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function sameHex(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'));
  } catch (_) { return false; }
}

function validPayload(payload, expires, t) {
  const exp = Number(expires);
  if (!t || !Number.isFinite(exp) || exp < Date.now()) return false;
  return sameHex(signPayload(payload), t);
}

// 下载链接的报文形状（唯一一份；files.js 签发与验签都走它，避免两边写歪）
function downloadPayload(sessionId, rel, expires) {
  return sessionId + '\n' + rel + '\n' + expires;
}

function signDownload(sessionId, rel, expires) {
  return signPayload(downloadPayload(sessionId, rel, expires));
}

function validDownload(sessionId, rel, expires, t) {
  return validPayload(downloadPayload(sessionId, rel, expires), expires, t);
}

module.exports = { BROWSER_TTL_MS, signPayload, sameHex, validPayload, signDownload, validDownload };
