// 配置读写 API(2.0 阶段 2):设置页管理 config.yml。
// 语义:写 = 校验 → 覆盖文件(无热重载);POST /api/system/restart 后生效。
// 注意:GET 返回的原文已对 api_key 脱敏,避免明文外显;PUT/validate 时按顺序还原。
const express = require('express');
const engine = require('../engine');
const { loadConfigFromText, readConfigText, applyEditsToText, writeConfigText } = require('../config');
const log = require('../log');

const router = express.Router();

function sendErr(res, err) {
  const code = err && err.status_code || 500;
  res.status(code).json({ error: String(err && err.message || err) });
}
function badRequest(res, err) {
  res.status(400).json({ error: String(err && err.message || err) });
}
function wrap(fn) {
  return function (req, res) {
    try { fn(req, res); } catch (err) { sendErr(res, err); }
  };
}

// 对比运行配置与新配置的顶层差异键(前端提示「这些段重启后生效」)
function diffTop(oldCfg, newCfg) {
  const skip = new Set(['config_path']);
  const keys = new Set(Object.keys(oldCfg || {}).concat(Object.keys(newCfg || {})));
  const changed = [];
  for (const k of keys) {
    if (skip.has(k)) continue;
    if (JSON.stringify(oldCfg && oldCfg[k]) !== JSON.stringify(newCfg && newCfg[k])) changed.push(k);
  }
  return changed;
}

function cfgOf() { return engine.getConfig(); }

// api_key 脱敏:与前端 models.js 的 maskKey 保持一致。
function maskKey(k) {
  k = k || '';
  if (k.length > 8) return k.slice(0, 3) + '***' + k.slice(-4);
  if (k.length > 0) return '***' + k.slice(-2);
  return '';
}

// 逐行掩码 config.yml 原文里的 api_key 值(设置页原文编辑器展示用)。
// 行格式如 `    api_key: sk-xxx` 或 `    api_key: "sk-xxx"`(双/单引号)。
// 记录每行是否掩码,便于 restore 时按顺序还原未改动项。
const API_KEY_LINE = /^(\s*api_key:\s*)(["']?)(.+?)\2\s*$/;
function maskApiKeys(text) {
  if (!text) return text;
  return text.split('\n').map(function (line) {
    const m = line.match(API_KEY_LINE);
    if (!m) return line;
    return m[1] + m[2] + maskKey(m[3]) + m[2];
  }).join('\n');
}

// 还原:提交原文中含 *** 的 api_key 行 = 用户未改动,按出现顺序从原文件取回原值。
// 不含 *** 的 = 用户手输的新 key,原样保留。
function restoreApiKeys(submitted, orig) {
  if (!submitted) return submitted;
  const origKeys = [];
  (orig || '').split('\n').forEach(function (line) {
    const m = line.match(API_KEY_LINE);
    if (m) origKeys.push(m[3]);
  });
  let i = 0;
  return submitted.split('\n').map(function (line) {
    const m = line.match(API_KEY_LINE);
    if (!m) return line;
    if (!m[3].includes('***')) return line; // 用户改过,保留
    const origKey = i < origKeys.length ? origKeys[i] : '';
    i++;
    return m[1] + m[2] + origKey + m[2];
  }).join('\n');
}

// 配置原文 + 路径 + 当前生效配置(设置页表单显示当前值;注释原样保留)
// GET 返回的原文对 models[].api_key 脱敏(避免明文外显);PUT/validate 时按顺序还原。
router.get('/', wrap((req, res) => {
  const cfg = cfgOf();
  const text = readConfigText(cfg);
  const shown = text === null ? '' : maskApiKeys(text);
  res.json({ config_path: cfg.config_path || '', exists: text !== null, text: shown, effective: cfg });
}));

// 干跑校验(编辑器保存前预检):body { text }
// 还原脱敏后的 api_key 再校验,避免 diff 误报 models 段变更。
router.post('/validate', wrap((req, res) => {
  const text = req.body && req.body.text;
  if (typeof text !== 'string') return badRequest(res, new Error('body.text 必须是字符串'));
  const origText = readConfigText(cfgOf());
  const restored = restoreApiKeys(text, origText || '');
  try {
    const next = loadConfigFromText(restored, '');
    res.json({ ok: true, changed: diffTop(cfgOf(), next) });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e && e.message || e) });
  }
}));

// 整文件编辑:body { text }
// 还原脱敏后的 api_key 再写入,未改动的项保持原值,用户输入的新 key 原样生效。
router.put('/', wrap((req, res) => {
  const cfg = cfgOf();
  const text = req.body && req.body.text;
  if (typeof text !== 'string') return badRequest(res, new Error('body.text 必须是字符串'));
  const origText = readConfigText(cfg);
  const restored = restoreApiKeys(text, origText || '');
  let next;
  try { next = loadConfigFromText(restored, cfg.config_path); } catch (e) { return badRequest(res, e); }
  writeConfigText(cfg, restored);
  log.info('[config] ' + (req.user || '-') + ' 整文件保存配置，变更段：' + (diffTop(cfg, next).join(',') || '无'));
  res.json({ ok: true, changed: diffTop(cfg, next), restart_required: true });
}));

// 单项修改:body { path: "agent.temperature" | ["models",0,"url"], value, op?: "delete" }
// 用 YAML Document 写回,保留文件注释与排版;数组可整体替换,也可按数字下标改元素。
router.patch('/', wrap((req, res) => {
  const cfg = cfgOf();
  const text = readConfigText(cfg);
  if (text === null) return sendErr(res, Object.assign(new Error('配置文件不存在:' + (cfg.config_path || '(未知路径)')), { status_code: 409 }));
  const body = req.body || {};
  let pathArr;
  if (Array.isArray(body.path)) pathArr = body.path;
  else if (typeof body.path === 'string' && body.path.trim()) pathArr = body.path.split('.').map(s => s.trim()).filter(Boolean);
  else return badRequest(res, new Error('body.path 必填,如 agent.temperature 或 ["models",0,"display_name"]'));
  if (!pathArr.length) return badRequest(res, new Error('body.path 为空'));
  let nextText;
  try {
    nextText = applyEditsToText(text, [{ path: pathArr, value: body.value, delete: body.op === 'delete' }]);
  } catch (e) { return badRequest(res, e); }
  let next;
  try { next = loadConfigFromText(nextText, cfg.config_path); } catch (e) { return badRequest(res, e); }
  writeConfigText(cfg, nextText);
  log.info('[config] ' + (req.user || '-') + ' 修改配置项 ' + pathArr.join('.') + (body.op === 'delete' ? '（删除）' : '') + '，变更段：' + (diffTop(cfg, next).join(',') || '无'));
  res.json({ ok: true, changed: diffTop(cfg, next), restart_required: true });
}));

module.exports = router;
