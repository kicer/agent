// 公网临时链接签发（只在【内网监听】的端口上，见 server.js 里 PUBLIC_LINK_PORT 那段）。
//
// 用途：把任务目录里的文件变成一条短命的公网 URL，交给外部服务去取。第一个消费者是
// MCP video_gen：智谱服务器生成视频前要自己来拉参考图，它不带 cookie、不带 Authorization，
// 所以必须给它一条「不可猜 + 会过期」的链接。
// 产出的形态是一个不透明短 ID（见 public-files.js 为什么不用签名 URL）：
//     http://<IP>:8090/p/9fQ2mZ7xK4tR1vBn
// 这解决的是：**沙箱里的 AI 怎么拿到一条公网链接**（签发接口要登录，executor 里没有凭据）。
//
// 为什么单独一个端口、且不映射到宿主机：
//   这条接口没法用凭据保护（AI 的命令带不了凭据），那就干脆让外部**连都连不上**。
//   鉴权靠网络边界（不 publish），不靠密钥 —— 比任何 token 都可靠，也不会把密钥漏到会话记录里。
//
// 边界（改这里务必保持）：
//   1. 只接受绝对路径，且必须落在 workspace_root 内；再反查会话表确认会话真实存在。
//   2. 取 realpath 复核仍在任务根内：挡住“先 ln -s 一个外泄目标，再签它的链接”。
//   3. 只签“已存在且是文件”的路径；取用侧（routes/public-files.js）会再复核一次目录边界。
//   4. 返回 text/plain 而不是 JSON：AI 用 `curl -s` 拿到的 stdout 就是现成 URL，免解析。
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const engine = require('../engine');
const publicFiles = require('../public-files');
const log = require('../log');

const router = express.Router();

function bad(res, status, msg) {
  return res.status(status).type('text/plain').send('ERROR: ' + msg + '\n');
}

router.get('/public-link', function (req, res) {
  const cfg = engine.getConfig();
  const pl = cfg.public_link || {};
  if (!pl.base_url) return bad(res, 503, 'public_link.base_url 未配置，无法签发公网链接');

  const raw = String(req.query.path || '').trim();
  if (!raw) return bad(res, 400, '缺少 path 参数（要文件的绝对路径，如 /workspace/tasks/<会话>/foo.png）');
  if (!path.isAbsolute(raw)) return bad(res, 400, 'path 必须是绝对路径（与你在命令里看到的路径一致）');

  const root = path.resolve(cfg.workspace_root);
  const abs = path.normalize(raw);
  if (abs !== root && abs.indexOf(root + path.sep) !== 0) {
    return bad(res, 400, 'path 必须位于任务根目录内：' + root);
  }

  const rel = path.relative(root, abs);
  const sid = rel.split(path.sep)[0];
  const fileRel = rel.slice(sid.length + 1);
  if (!sid || !fileRel) return bad(res, 400, 'path 要指向会话目录下的某个文件，不能是目录本身');
  if (!engine.getSession(sid)) return bad(res, 404, '会话不存在：' + sid);

  let real;
  try {
    if (!fs.statSync(abs).isFile()) return bad(res, 400, '不是文件：' + raw);
    real = fs.realpathSync(abs);
  } catch (_) {
    return bad(res, 404, '文件不存在：' + raw);
  }
  if (real !== abs && real.indexOf(fs.realpathSync(root) + path.sep) !== 0) {
    return bad(res, 400, 'path 经符号链接指向了任务根之外，拒绝签发');
  }

  const id = publicFiles.mint({ sessionId: sid, rel: fileRel, ttlMs: pl.ttl_ms });
  const url = pl.base_url + '/p/' + id;

  log.info('public-link', sid + ' 签发公网链接（' + Math.round(pl.ttl_ms / 60000) + ' 分钟）：' + fileRel + ' → /p/' + id);
  res.type('text/plain').send(url + '\n');
});

module.exports = router;
