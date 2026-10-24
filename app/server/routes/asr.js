// 语音识别代理：浏览器 / 套壳 App 录好的音频 → agent-core → mcp_asr → 文字。
//
// 为什么要 core 中转、而不是前端直连 ASR 容器：mcp_asr 只挂在 agent-mcp-net 内网、
// 一个宿主端口都不占（它自身没有鉴权，暴露即被白嫖）。对外唯一的入口仍是 core，
// 鉴权沿用全局登录态（auth.middleware 已挂在 /api 之前）。
//
// 上游参数全部来自 config.yml 的 mcp_servers 里那条 asr（与 image_task 完全同构）：
//   - name: asr
//     url: "http://mcp_asr:3000/mcp"
//     headers:
//       Authorization: Bearer <key>                # 免鉴权的自建服务可省
//       X-ASR-Base-Url: "https://.../v1"
//       X-ASR-Model: "whisper-1"
// mcp_asr 自己不存任何平台密钥（容器 env 一条都不读），所以要换 ASR 平台只改这个文件对应的
// YAML 段 + 重启 core，不碰 .env、不重建镜像。头名与 mcp/asr/src/server.js 的常量一一对应。
//
// 开关：ASR_URL 为空（未部署 mcp_asr）或配置里没有可用的 asr 段 = 关闭，本路由一律 503，
// 前端据此不显示麦克风。ASR_URL 留在 env 是部署接线（容器地址），不属于平台密钥。
const express = require('express');
const engine = require('../engine');
const log = require('../log');

const router = express.Router();

const ASR_URL = String(process.env.ASR_URL || '').trim().replace(/\/+$/, '');
// 与 mcp_asr 的上限保持一致（60s 的 AAC 约 240KB，这里给长音频留余量）
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 120000;

// 只转发 ASR 约定的三个头：config.yml 里该条目的其它 header 与本服务无关，没必要透传进内网。
const PASS_HEADERS = ['authorization', 'x-asr-base-url', 'x-asr-model'];

// 取当前生效的 asr 配置段。配置冷加载（engine 里那份是启动时解析的），所以这里读到的就是
// 运行中的值；重启前改 config.yml 不会影响已生效的这份，与其它配置项一致。
function asrEntry() {
  let cfg = null;
  try { cfg = engine.getConfig(); } catch (_) { cfg = null; } // 启动早期 engine 还没拿到 cfg
  const list = (cfg && cfg.mcp_servers) || [];
  const s = list.find(function (x) { return x && x.name === 'asr'; });
  // mode: disable = 明确关闭（与模型侧工具同一开关：关了就别给麦克风）
  if (!s || s.mode === 'disable') return null;
  return s;
}

function asrHeaders() {
  const s = asrEntry();
  if (!s) return null;
  const out = {};
  for (const [k, v] of Object.entries(s.headers || {})) {
    if (PASS_HEADERS.indexOf(String(k).toLowerCase()) >= 0) out[k] = String(v);
  }
  return out;
}

// 有没有真的能转写：缺 base_url 就转不了（model 也缺的话 mcp_asr 会给出更具体的报错）。
// 只判 base_url 是为了让「配了但漏填 model」在探测阶段仍显示入口，用户点了能拿到明确提示。
function hasUpstream(headers) {
  return Object.keys(headers || {}).some(function (k) {
    return k.toLowerCase() === 'x-asr-base-url' && String(headers[k] || '').trim();
  });
}

// 只接音频二进制。全局 express.json(2mb) 只解析 application/json，两者不冲突。
// 注意 WebView 可能发 audio/mp4、audio/webm;codecs=opus，统一按 audio/* 接。
const rawAudio = express.raw({
  type: ['audio/*', 'application/octet-stream', 'application/mp4'],
  limit: '20mb',
});

// 前端可用性探测（按钮是否显示）。不碰网络，纯看接线。
router.get('/status', function (req, res) {
  if (!ASR_URL) return res.json({ enabled: false, reason: 'core 未设置 ASR_URL' });
  if (!asrEntry()) return res.json({ enabled: false, reason: 'config.yml 的 mcp_servers 里没有启用的 asr' });
  const headers = asrHeaders();
  if (!hasUpstream(headers)) {
    return res.json({ enabled: false, reason: 'config.yml 的 asr.headers 缺 X-ASR-Base-Url' });
  }
  res.json({ enabled: true, max_bytes: MAX_BYTES });
});

router.post('/transcribe', rawAudio, async function (req, res) {
  if (!ASR_URL) {
    return res.status(503).json({ error: '语音识别未部署（core 未设置 ASR_URL）' });
  }
  const headers = asrHeaders();
  if (!headers || !hasUpstream(headers)) {
    return res.status(503).json({ error: '语音识别未配置上游（config.yml 的 asr.headers 需设 X-ASR-Base-Url / X-ASR-Model）' });
  }
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) {
    return res.status(400).json({ error: '未收到音频数据（Content-Type 需为 audio/*）' });
  }
  try {
    const r = await fetch(ASR_URL + '/transcribe', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': req.headers['content-type'] || 'application/octet-stream' }, headers),
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
    // 原样透传 ASR 的 {text, ms, model}
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
