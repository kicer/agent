// 配置读写 API(2.0 阶段 2):设置页管理 config.yml。
// 语义:写 = 校验 → 覆盖文件(无热重载);POST /api/system/restart 后生效。
// 注意:GET 返回的原文已对 api_key / auth password / mcp headers 值脱敏,避免明文外显;PUT/validate 时按顺序还原。
const express = require('express');
const engine = require('../engine');
const { loadConfigFromText, readConfigText, applyEditsToText, writeConfigText } = require('../config');
const balance = require('../balance');
const log = require('../log');

const router = express.Router();

// 平台 / MCP 预设：设置页「新增平台」「添加内置 MCP」的模板来源（纯静态，无密钥）。
// 文件写坏时降级为空预设：通用表单仍可用，不影响其它功能。
const MCP_MODES = ['advertise', 'skill', 'disable'];
function checkPresetList(list, kind, bad) {
  const seen = new Set();
  (list || []).forEach((x, i) => {
    const at = kind + '[' + i + ']';
    if (!x || typeof x !== 'object') { bad.push(at + ' 必须是对象'); return; }
    if (!x.key || !x.url) { bad.push(at + ' 缺 key/url'); return; }
    if (seen.has(x.key)) { bad.push(at + ' key 重复：' + x.key); return; }
    seen.add(x.key);
    if (kind === 'platforms') {
      if (!x.type) bad.push(at + ' 缺 type');
      if (x.model_defaults != null && typeof x.model_defaults !== 'object') {
        bad.push(at + '.model_defaults 必须是对象');
      }
      return;
    }
    if (x.mode != null && MCP_MODES.indexOf(x.mode) < 0) {
      bad.push(at + '.mode 只能是 ' + MCP_MODES.join(' / '));
    }
    if (x.fields != null && !Array.isArray(x.fields)) { bad.push(at + '.fields 必须是数组'); return; }
    (x.fields || []).forEach((f, fi) => {
      if (!f || !f.header) bad.push(at + '.fields[' + fi + '] 缺 header');
    });
  });
}

function loadPresets() {
  const p = require('../presets.json') || {};
  const bad = [];
  checkPresetList(p.platforms, 'platforms', bad);
  checkPresetList(p.mcp, 'mcp', bad);
  if (bad.length) throw new Error(bad.join('；'));
  return { platforms: p.platforms || [], mcp: p.mcp || [] };
}

let PRESETS = { platforms: [], mcp: [] };
try {
  PRESETS = loadPresets();
} catch (e) {
  log.warn('config', 'presets.json 无效，设置页将没有预设：' + String((e && e.message) || e));
}

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

// 逐行掩码配置原文里的 api_key 值(设置页原文编辑器展示用)。
// 行格式如 `    api_key: sk-xxx` / `    api_key: "sk-xxx"` / `    - api_key: sk-xxx`(platforms.keys 列表项写法)。
// 值用 (.*) 而非 (.+?)：允许空串（`api_key: ""`），否则引号可选组回退会把 `""` 误捕成值 `"` 而被掩码成 `***"`。
// 记录每行是否掩码,便于 restore 时按顺序还原未改动项。
const API_KEY_LINE = /^(\s*(?:-\s+)?api_key:\s*)(["']?)(.*)\2\s*$/;
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

// password 脱敏(思路同 api_key):auth.users 密码在原文编辑器里统一显示 ******。
// 行格式如 `      password: "xxx"` / `      password: xxx`(auth.users 列表项写法)。
const PASSWORD_LINE = /^(\s*(?:-\s+)?password:\s*)(["']?)(.*)\2\s*$/;
const PASSWORD_MASK = '******';
function maskPassword(p) { return p ? PASSWORD_MASK : ''; }
function maskPasswords(text) {
  if (!text) return text;
  return text.split('\n').map(function (line) {
    const m = line.match(PASSWORD_LINE);
    if (!m) return line;
    return m[1] + m[2] + maskPassword(m[3]) + m[2];
  }).join('\n');
}

// 还原:提交原文中值恰为 ****** 的 password 行 = 用户未改动,按出现顺序从原文件取回原值;
// 其他值(含用户新输的密码)原样保留。空密码不会被掩码,自然不会进入还原分支。
function restorePasswords(submitted, orig) {
  if (!submitted) return submitted;
  const origPws = [];
  (orig || '').split('\n').forEach(function (line) {
    const m = line.match(PASSWORD_LINE);
    if (m) origPws.push(m[3]);
  });
  let i = 0;
  return submitted.split('\n').map(function (line) {
    const m = line.match(PASSWORD_LINE);
    if (!m) return line;
    if (m[3] !== PASSWORD_MASK) return line; // 用户改过,保留手输新密码
    const origPw = i < origPws.length ? origPws[i] : '';
    i++;
    return m[1] + m[2] + origPw + m[2];
  }).join('\n');
}

// MCP header 值脱敏(等同密码):统一固定短掩码 *****(不泄露长度),原文编辑器与 effective 视图共用。
// headers 行 = `headers:` 块内比它更深缩进的键值行(如 `      Authorization: Bearer sk-xxx`,引号可选)。
// 局限:块标量(|/>)续行内容无法逐行识别,与 api_key/password 的行级掩码同一量级的取舍。
const MCP_HEADER_MASK = '*****';
const HEADERS_BLOCK_LINE = /^(\s*)headers:\s*(?:#.*)?$/;
const MCP_HEADER_LINE = /^(\s*(?:-\s+)?[\w.-]+:\s*)(["']?)(.*)\2\s*$/;
function maskHeaderValue(v) { return v ? MCP_HEADER_MASK : ''; }
// 遍历 headers 块内的键值行,fn(line, match) 返回替换后的行;块边界按缩进判定。
function mapMcpHeaderLines(text, fn) {
  if (!text) return text;
  let blockIndent = -1;
  return text.split('\n').map(function (line) {
    if (!line.trim()) return line; // 空行不改变块归属
    const indent = (line.match(/^\s*/)[0] || '').length;
    if (blockIndent >= 0 && indent <= blockIndent) blockIndent = -1; // 缩进回收 → 离开块(本行可能是下一项)
    if (blockIndent < 0) {
      const hb = line.match(HEADERS_BLOCK_LINE);
      if (hb) blockIndent = hb[1].length;
      return line;
    }
    const m = line.match(MCP_HEADER_LINE);
    return m ? fn(line, m) : line;
  }).join('\n');
}
function maskMcpHeaders(text) {
  return mapMcpHeaderLines(text, function (line, m) {
    return m[1] + m[2] + maskHeaderValue(m[3]) + m[2];
  });
}
// 还原:提交原文中值恰为 ***** 的 header 行 = 用户未改动,按出现顺序从原文件取回原值;其他值原样保留。
function restoreMcpHeaders(submitted, orig) {
  if (!submitted) return submitted;
  const origVals = [];
  mapMcpHeaderLines(orig || '', function (line, m) { origVals.push(m[3]); return line; });
  let i = 0;
  return mapMcpHeaderLines(submitted, function (line, m) {
    if (m[3] !== MCP_HEADER_MASK) return line; // 用户改过,保留手输新值
    const ov = i < origVals.length ? origVals[i] : '';
    i++;
    return m[1] + m[2] + ov + m[2];
  });
}
// PATCH 细粒度编辑的 headers 还原:值=掩码占位时按键名找回原值(前端只持有脱敏视图,改不动真值)。
// 找不到可还原的原值(新增服务/用户改了 header 名)则报错,绝不把占位符写进配置。
function restoreHeaderMasks(headers, origHeaders) {
  for (const k of Object.keys(headers || {})) {
    if (headers[k] !== MCP_HEADER_MASK) continue;
    const ov = origHeaders && origHeaders[k];
    if (ov === undefined || ov === '') throw new Error('Header「' + k + '」的值为脱敏占位且找不到原值,请填写真实值');
    headers[k] = ov;
  }
}
function restoreMaskedHeaderEdit(e, curCfg) {
  if (e.delete) return;
  const p = e.path;
  if (p[0] !== 'mcp_servers') return;
  if (e.append) { // 新增服务没有“原值”可言,出现占位即拒绝
    if (e.value && e.value.headers) restoreHeaderMasks(e.value.headers, null);
    return;
  }
  if (p.length === 3 && p[2] === 'headers' && e.value && typeof e.value === 'object') {
    const orig = (((curCfg || {}).mcp_servers || [])[Number(p[1])] || {}).headers || {};
    restoreHeaderMasks(e.value, orig);
  }
}

// 生效配置的脱敏副本:api_key/password/mcp headers 在前端仅展示用(模型卡片/Key 下拉标签等),真值不会回写文件。
function maskEffective(cfg) {
  const c = Object.assign({}, cfg);
  c.platforms = (cfg.platforms || []).map(p => Object.assign({}, p, {
    keys: (p.keys || []).map(k => Object.assign({}, k, { api_key: maskKey(k.api_key) })),
  }));
  c.mcp_servers = (cfg.mcp_servers || []).map(s => {
    const headers = {};
    for (const [k, v] of Object.entries(s.headers || {})) headers[k] = maskHeaderValue(v);
    return Object.assign({}, s, { headers });
  });
  c.models = (cfg.models || []).map(m => Object.assign({}, m, { api_key: maskKey(m.api_key) }));
  if (c.auth && Array.isArray(c.auth.users)) {
    c.auth = Object.assign({}, c.auth, {
      users: c.auth.users.map(u => Object.assign({}, u, { password: maskPassword(u.password) })),
    });
  }
  return c;
}

// 配置原文 + 路径 + 当前生效配置(设置页表单显示当前值;注释原样保留)
// GET 返回的原文与生效配置均对 api_key / password 脱敏;PUT/validate 时按顺序还原。
// effective 优先按文件内容重新解析返回(而非运行态):页面无热重载,重启前运行态是旧配置,
// 而后续按下标定位的 PATCH 改的是文件——两者错位会让平台编辑弹窗二次保存时删错/改错行。
// 文件解析失败(手改坏等极端情况)退回运行态配置。
router.get('/', wrap((req, res) => {
  const cfg = cfgOf();
  const text = readConfigText(cfg);
  const shown = text === null ? '' : maskMcpHeaders(maskPasswords(maskApiKeys(text)));
  let eff = maskEffective(cfg);
  if (text !== null) {
    try { eff = maskEffective(loadConfigFromText(text, cfg.config_path)); } catch (_) { /* 保持运行态兑底 */ }
  }
  // balance_types:已接入余额查询的平台类型,前端据此决定是否展示余额行
  res.json({ config_path: cfg.config_path || '', exists: text !== null, text: shown, effective: eff, balance_types: balance.types() });
}));

// 预设模板（前端新增平台 / 添加内置 MCP 用）
router.get('/presets', wrap((req, res) => { res.json(PRESETS); }));

// 干跑校验(编辑器保存前预检):body { text }
// 还原脱敏后的 api_key/password 再校验,避免 diff 误报变更。
router.post('/validate', wrap((req, res) => {
  const text = req.body && req.body.text;
  if (typeof text !== 'string') return badRequest(res, new Error('body.text 必须是字符串'));
  const origText = readConfigText(cfgOf()) || '';
  const restored = restoreApiKeys(restorePasswords(restoreMcpHeaders(text, origText), origText), origText);
  try {
    const next = loadConfigFromText(restored, '');
    res.json({ ok: true, changed: diffTop(cfgOf(), next) });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e && e.message || e) });
  }
}));

// 整文件编辑:body { text }
// 还原脱敏后的 api_key/password 再写入,未改动的项保持原值,用户输入的新 key/密码原样生效。
router.put('/', wrap((req, res) => {
  const cfg = cfgOf();
  const text = req.body && req.body.text;
  if (typeof text !== 'string') return badRequest(res, new Error('body.text 必须是字符串'));
  const origText = readConfigText(cfg) || '';
  const restored = restoreApiKeys(restorePasswords(restoreMcpHeaders(text, origText), origText), origText);
  let next;
  try { next = loadConfigFromText(restored, cfg.config_path); } catch (e) { return badRequest(res, e); }
  writeConfigText(cfg, restored);
  log.info('config', (req.user || '-') + ' 整文件保存配置，变更段：' + (diffTop(cfg, next).join(',') || '无'));
  res.json({ ok: true, changed: diffTop(cfg, next), restart_required: true });
}));

// 单项修改:body { path: "agent.temperature" | ["platforms",0,"models",1], value, op?: "delete"|"append" }
// 或批量修改:body { edits: [{ path, value, op? }, ...] } —— 同一次读文/写回/校验/落盘,原子生效
// (平台编辑弹窗一次要改 name/url/type + 多个模型 + 增删 Key,逐条 PATCH 会留半写状态)。
// 用 YAML Document 写回,保留文件注释与排版;数组可整体替换,可按数字下标改/删元素,
// 也可 append 向数组追加一项(新增平台/Key/模型;前端只持有脱敏 key,绝不能整体替换含 key 的数组)。
function normEdit(e) {
  if (!e) throw new Error('配置项编辑不能为空');
  let pathArr;
  if (Array.isArray(e.path)) pathArr = e.path;
  else if (typeof e.path === 'string' && e.path.trim()) pathArr = e.path.split('.').map(s => s.trim()).filter(Boolean);
  else throw new Error('配置项 path 必填,如 agent.temperature 或 ["platforms",0,"models",1]');
  if (!pathArr.length) throw new Error('配置项 path 为空');
  return { path: pathArr, value: e.value, delete: e.op === 'delete', append: e.op === 'append' };
}
router.patch('/', wrap((req, res) => {
  const cfg = cfgOf();
  // 文件缺失（或曾被 Docker 误建成空目录）不阻塞：以空文档继续，写入时由 writeConfigText 创建。
  // 前提是父目录可写（容器里 /app 可写）；否则 fs.writeFileSync 会报错并在下面回 500。
  const text = readConfigText(cfg) || '';
  const body = req.body || {};
  let edits;
  try {
    if (Array.isArray(body.edits) && body.edits.length) edits = body.edits.map(normEdit);
    else if (body.path != null) edits = [normEdit(body)];
    else return badRequest(res, new Error('body.path 或 body.edits 必填'));
  } catch (e) { return badRequest(res, e); }
  // headers 编辑里的掩码占位先按键名还原为原值(以文件当前内容为准,而非运行态,与 GET 视图对齐)
  try {
    let curCfg = null;
    try { curCfg = loadConfigFromText(text, cfg.config_path); } catch (_) { /* 原文已损坏时交给后续统一校验报错 */ }
    edits.forEach(e => restoreMaskedHeaderEdit(e, curCfg));
  } catch (e) { return badRequest(res, e); }
  let nextText;
  try {
    nextText = applyEditsToText(text, edits);
  } catch (e) { return badRequest(res, e); }
  let next;
  try { next = loadConfigFromText(nextText, cfg.config_path); } catch (e) { return badRequest(res, e); }
  writeConfigText(cfg, nextText);
  log.info('config', (req.user || '-') + ' 修改配置项 ' + edits.map(e => e.path.join('.') + (e.delete ? '（删除）' : e.append ? '（追加）' : '')).join('；') + '，变更段：' + (diffTop(cfg, next).join(',') || '无'));
  res.json({ ok: true, changed: diffTop(cfg, next), restart_required: true });
}));

module.exports = router;
