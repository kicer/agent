// 配置读写 API(2.0 阶段 2):设置页管理 config.yml。
// 语义:写 = 校验 → 覆盖文件(无热重载);POST /api/system/restart 后生效。
// 注意:GET 返回的原文含密钥,接口与设置页同受 auth 中间件保护(自用场景)。
const express = require('express');
const engine = require('../engine');
const { loadConfigFromText, readConfigText, applyEditsToText, writeConfigText } = require('../config');

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

// 配置原文 + 路径 + 当前生效配置(设置页表单显示当前值;注释原样保留)
router.get('/', wrap((req, res) => {
  const cfg = cfgOf();
  const text = readConfigText(cfg);
  res.json({ config_path: cfg.config_path || '', exists: text !== null, text: text === null ? '' : text, effective: cfg });
}));

// 干跑校验(编辑器保存前预检):body { text }
router.post('/validate', wrap((req, res) => {
  const text = req.body && req.body.text;
  if (typeof text !== 'string') return badRequest(res, new Error('body.text 必须是字符串'));
  try {
    const next = loadConfigFromText(text, '');
    res.json({ ok: true, changed: diffTop(cfgOf(), next) });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e && e.message || e) });
  }
}));

// 整文件编辑:body { text }
router.put('/', wrap((req, res) => {
  const cfg = cfgOf();
  const text = req.body && req.body.text;
  if (typeof text !== 'string') return badRequest(res, new Error('body.text 必须是字符串'));
  let next;
  try { next = loadConfigFromText(text, cfg.config_path); } catch (e) { return badRequest(res, e); }
  writeConfigText(cfg, text);
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
  res.json({ ok: true, changed: diffTop(cfg, next), restart_required: true });
}));

module.exports = router;
