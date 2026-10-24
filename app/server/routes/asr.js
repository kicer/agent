// 语音识别代理：浏览器 / 套壳 App 录好的音频 → agent-core → mcp_asr → 文字。
//
// 为什么要 core 中转、而不是前端直连 ASR 容器：mcp_asr 只挂在 agent-mcp-net 内网、
// 一个宿主端口都不占（它自身没有鉴权，暴露即被白嫖）。对外唯一的入口仍是 core，
// 鉴权沿用全局登录态（auth.middleware 已挂在 /api 之前）。
//
// 开关：core 的 ASR_URL 为空 = 未部署语音识别，本路由一律 503，前端据此不显示麦克风。
const express = require('express');
const log = require('../log');

const router = express.Router();

const ASR_URL = String(process.env.ASR_URL || '').trim().replace(/\/+$/, '');
// 与 mcp_asr 的上限保持一致（60s 的 AAC 约 240KB，这里给长音频留余量）
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 120000;

// 只接音频二进制。全局 express.json(2mb) 只解析 application/json，两者不冲突。
// 注意 WebView 可能发 audio/mp4、audio/webm;codecs=opus，统一按 audio/* 接。
const rawAudio = express.raw({
  type: ['audio/*', 'application/octet-stream', 'application/mp4'],
  limit: '20mb',
});

// 前端可用性探测（按钮是否显示）。不碰网络，纯看接线。
router.get('/status', function (req, res) {
  res.json({ enabled: !!ASR_URL, max_bytes: MAX_BYTES });
});

router.post('/transcribe', rawAudio, async function (req, res) {
  if (!ASR_URL) {
    return res.status(503).json({ error: '语音识别未配置（core 未设置 ASR_URL）' });
  }
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) {
    return res.status(400).json({ error: '未收到音频数据（Content-Type 需为 audio/*）' });
  }
  try {
    const r = await fetch(ASR_URL + '/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
      body: buf,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    if (!r.ok) {
      // ASR 服务回的是 {error:string}：解出来再转，不然前端会看到两层套嵌的 JSON
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error || msg; } catch (_) { /* 非 JSON 保留原文 */ }
      log.warn('asr', '识别失败 HTTP ' + r.status + '：' + msg);
      // 4xx（静音 / 坏音频 / 过载）原样透传；5xx 统一当上游故障
      const code = r.status >= 400 && r.status < 500 ? r.status : 502;
      return res.status(code).json({ error: msg });
    }
    // 原样透传 ASR 的 {text, ms, backend}
    res.type('application/json').send(text);
  } catch (e) {
    log.warn('asr', '调用 ASR 服务失败：' + String(e && e.message || e));
    res.status(502).json({ error: '语音识别服务不可用：' + String(e && e.message || e) });
  }
});

// express.raw 超限时抛 entity.too.large，默认会回 HTML；这里翻成前端能读的 JSON。
router.use(function (err, req, res, next) {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: '音频过大（上限 ' + Math.round(MAX_BYTES / 1048576) + 'MB）' });
  }
  next(err);
});

module.exports = router;
