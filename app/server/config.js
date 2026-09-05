// 配置加载：AGENT_CONFIG 指向 config.yml（见 config.example.yml）
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const log = require('./log');

const DEFAULTS = {
  port: 8080,
  workspace_root: './data/tasks',
  db_path: '', // 默认为 workspace_root/.agent.db
  terminal: { default_timeout_ms: 30000, max_output_chars: 10000 },
  agent: { temperature: 1.0, max_tool_iterations: 50, max_retries: 2, language: '中文' },
  // 大图上传预处理：图片文件超过 threshold_kb 时，浏览器端询问用户后用 canvas 压缩
  // （长边 ≤ max_dim，JPEG quality）再上传，减轻服务器带宽与存储压力。参数经 /api/system/status 下发给前端。
  upload: { image_compress_threshold_kb: 1536, image_max_dim: 2000, image_quality: 0.85 },
  // 技能（Skill Manager）：skills_root 为技能根目录，所有任务/会话共享（容器内挂我 ./skills → /workspace/skills）；
  // 缺省取 workspace_root 的同级目录 skills（如 /workspace/tasks → /workspace/skills）。timeout_ms 为单个技能执行超时，默认 120000。
  skills: { skills_root: '', timeout_ms: 120000 },
  // 回合结束后模型保持占用（held）的租约：页内无人观看超过 idle_release_ms 则释放；
    // 即便一直有人观看，最长也只保持 active_max_ms；sweep_ms 为巡检间隔。
    // 「绑定模型但闲置」的会话（从未发言、无未回应消息）同样按此租约释放，防建而不用霸占模型。
    model_hold: { idle_release_ms: 180000, active_max_ms: 1800000, sweep_ms: 10000 },
    // 日志等级:debug < info < warn < error < none,只输出 >= 阈值等级的日志;none=全部静默。
    log_level: 'info',
    // 上下文压缩：顶栏「压缩」按钮触发时把这段 prompt 作为 user 消息发给 AI，
    // 要求它回顾整段对话并生成结构化总结；收到回复后由前端弹窗询问是否物理清空历史，
    // 仅保留这条总结作为后续对话的唯一上下文，省 token。可按需改写 prompt（中文/英文均可）。
    compress: {
      prompt: '请基于以上全部对话历史，生成一段结构化总结，作为之后继续对话的唯一上下文。要求：\n' +
              '1) 提炼关键事实、决定、约束、待办；\n' +
              '2) 保留用户的偏好与命名约定；\n' +
              '3) 忽略寒暄与已完成的工具调用细节；\n' +
              '4) 中文输出，简洁。\n' +
              '直接输出总结正文即可，不要加前言/标题/列表前缀。',
    },
  platforms: [],
  // 登录认证：{ users: [{user, password}], secret?, ttl_ms? }，密码明文存配置（自用场景）。
  // users 为空则不启用认证（可交给前置 nginx-proxy，但手机浏览器原生下载不带 Basic 头，不推荐）。
  auth: null,
  // MCP 服务列表：每项 {name?, url, headers?}；启动时发现其工具并追加到内置工具之后。
  // 注意与内置工具（definitions.json）严格分离：这里只配外部 MCP 服务。
  mcp_servers: [],
};

function deepMerge(base, extra) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function hostnameOf(url) {
  try { return new URL(url).hostname.split('.')[0]; } catch (_) { return ''; }
}

// 旧版扁平 models[]（每模型自带 url/api_key）自动迁移为 platforms 层级：同 url+api_key 归为同一平台同一 key。
function migrateLegacyModels(models) {
  const groups = [];
  const byKey = new Map();
  for (const m of models) {
    if (!m || !m.id) continue;
    const url = String(m.url || '').replace(/\/+$/, '');
    const apiKey = String(m.api_key || '');
    const gk = url + '\n' + apiKey;
    let p = byKey.get(gk);
    if (!p) {
      // 平台名 = 主机名首段;同名(如只 path 不同)自动加序号，避免「平台名/模型id」唯一键碰撞。
      let name = hostnameOf(url) || ('p' + (groups.length + 1));
      for (let n = 2; groups.some(g => g.name === name); n++) name = (hostnameOf(url) || 'p') + '-' + n;
      p = { name, url, type: 'openai', keys: [{ api_key: apiKey, concurrency: 1, models: [] }] };
      byKey.set(gk, p);
      groups.push(p);
    }
    p.keys[0].models.push({ id: m.id, display_name: m.display_name || m.id, vision: m.vision === true });
  }
  return groups;
}

// 规范化并校验 platforms 层级：平台(name/url/type) → keys(api_key/concurrency) → models(id/display_name/vision/enable)。
// 内部唯一键 = 平台名/模型id：不同平台允许同模型 id，同平台内必须唯一（会话/模型池/用量均按该键认模型）；
// 允许键/列表为空（便于页面增删）。
function normalizePlatforms(rawPlatforms) {
  const seen = new Set(); // 已用唯一键（平台名/模型id）
  const out = [];
  for (let pi = 0; pi < rawPlatforms.length; pi++) {
    const p = rawPlatforms[pi] || {};
    if (!p.url) throw new Error('platforms[' + pi + '] 缺少 url（OpenAI 兼容 /v1 地址）');
    const url = String(p.url).replace(/\/+$/, '');
    const name = String(p.name || '').trim() || (hostnameOf(url) || ('p' + (pi + 1)));
    // type 可完全自定义（不校验白名单）；它决定余额查询适配器，由 routes/platforms.js 按类型分发（当前仅 deepseek 已接入，其余类型查询时返回不支持）。
    const type = String(p.type || 'openai').trim();
    const keys = [];
    for (let ki = 0; ki < (p.keys || []).length; ki++) {
      const k = p.keys[ki] || {};
      const concurrency = Math.max(1, parseInt(k.concurrency, 10) || 1);
      const models = [];
      for (let mi = 0; mi < (k.models || []).length; mi++) {
        const m = k.models[mi] || {};
        if (!m || !m.id) throw new Error('平台「' + name + '」key#' + (ki + 1) + ' 的 models[' + mi + '] 缺少 id');
        const uid = name + '/' + String(m.id);
        if (seen.has(uid)) throw new Error('模型重复：平台「' + name + '」下已有模型 id：' + m.id + '（不同平台可同名，同平台内必须唯一）');
        seen.add(uid);
        models.push({
          id: String(m.id),
          display_name: m.display_name ? String(m.display_name) : String(m.id),
          vision: m.vision === true, // 支持时 read_file 读图会回传图片，会话上下文会告知 AI
          enable: m.enable !== false, // 选填，默认启用；禁用后不进模型池，不参与分配/绑定（重启生效）
          // 选填：模型特有的请求体参数对象。发往上游时整体合并进 body 顶层。
          extra_params: (m.extra_params && typeof m.extra_params === 'object' && !Array.isArray(m.extra_params)) ? m.extra_params : {},
          // 选填：前端启用「深度思考」时合并进 body。可覆盖 extra_params 的同名键。
          thinking_params: (m.thinking_params && typeof m.thinking_params === 'object' && !Array.isArray(m.thinking_params)) ? m.thinking_params : {},
        });
      }
      keys.push({ api_key: String(k.api_key || ''), concurrency, models });
    }
    out.push({ name, url, type, keys });
  }
  return out;
}

// 校验原始配置文本(启动读文件与网页编辑共用)。configPath 仅记录来源,可为空。
function parseAndValidate(rawText, configPath) {
  let raw = YAML.parse(rawText || '') || {};
  const cfg = deepMerge(DEFAULTS, raw);

  // ---------- 模型配置：platforms 层级（platforms[].keys[].models[]）----------
  // 旧版扁平 models[]（每模型自带 url/api_key）自动迁移；cfg.models 为打平后的运行时视图，
  // 每项继承所属平台的 url/type 与 key 的 api_key/concurrency，并携带位置下标（前端 PATCH 定位用）。
  if ((!Array.isArray(raw.platforms) || !raw.platforms.length) && Array.isArray(raw.models) && raw.models.length) {
    raw = Object.assign({}, raw, { platforms: migrateLegacyModels(raw.models) });
    log.info('config', '检测到旧配置 models[] 扁平格式，已自动迁移为 platforms 层级；建议改写 config.yml 为 platforms 格式');
  }
  if (!Array.isArray(raw.platforms) || !raw.platforms.length) {
    throw new Error('配置缺少 platforms：至少需要一个平台 {name, url, keys:[{api_key, models:[{id}]}]}')
  }
  cfg.platforms = normalizePlatforms(raw.platforms);
  cfg.models = [];
  cfg.platforms.forEach((p, pi) => p.keys.forEach((k, ki) => k.models.forEach((m, mi) => {
    cfg.models.push({
      // id = 内部唯一键「平台名/模型id」（池/会话/用量/前端均按它认模型，调用处无需区分）；
      // mid = 发给上游的原始模型名（请求体 body.model 用它）。
      id: p.name + '/' + m.id, mid: m.id,
      display_name: m.display_name, vision: m.vision, enable: m.enable,
      extra_params: m.extra_params, thinking_params: m.thinking_params,
      url: p.url, api_key: k.api_key, platform: p.name, type: p.type, concurrency: k.concurrency,
      platform_index: pi, key_index: ki, model_index: mi,
    });
  })));
  if (!cfg.models.length) {
    throw new Error('platforms 下没有任何可用模型：keys[].models 至少需要一个 {id}')
  }

  cfg.workspace_root = path.resolve(cfg.workspace_root);
  if (!cfg.db_path) cfg.db_path = path.join(cfg.workspace_root, '.agent.db');

  // 日志等级:只认 debug/info/warn/error/none(off 是 none 别名),非法值按 info(不影响启动)
  cfg.log_level = String(cfg.log_level || 'info').trim().toLowerCase();
  if (cfg.log_level === 'off') cfg.log_level = 'none';
  if (['debug', 'info', 'warn', 'error', 'none'].indexOf(cfg.log_level) < 0) cfg.log_level = 'info';

  // 技能根目录：显式配置优先；缺省取 workspace_root 的同级 skills 目录（容器内 /workspace/tasks → /workspace/skills）。
  if (!cfg.skills || !cfg.skills.skills_root) {
    cfg.skills_root = path.resolve(cfg.workspace_root, '..', 'skills');
  } else {
    cfg.skills_root = path.resolve(cfg.skills.skills_root);
  }
  if (cfg.skills) {
    cfg.skills.timeout_ms = (cfg.skills.timeout_ms == null) ? 120000 : cfg.skills.timeout_ms;
  }

  // auth 规范化：多用户 auth.users: [{user, password}]；兼容旧的单用户 auth.{user,password}
  if (cfg.auth && !Array.isArray(cfg.auth.users)) {
    cfg.auth.users = cfg.auth.user ? [{ user: cfg.auth.user, password: cfg.auth.password }] : [];
  }
  if (cfg.auth && Array.isArray(cfg.auth.users)) {
    cfg.auth.users = cfg.auth.users
      .filter(u => u && u.user)
      .map(u => ({ user: String(u.user), password: String(u.password == null ? '' : u.password) }));
    if (!cfg.auth.users.length) cfg.auth = null;
  }

  // 兼容旧配置：顶层 web_search.{url,authorization} 自动转为一条 mcp_servers（authorization 即一条 header）
  if (raw.web_search && raw.web_search.url && !raw.mcp_servers) {
    const ws = raw.web_search;
    cfg.mcp_servers = [{
      name: 'web-search',
      url: ws.url,
      headers: ws.authorization ? { Authorization: ws.authorization } : {},
    }];
    log.info('config', '检测到旧配置 web_search.*，已自动转为一条 mcp_servers；建议更新 config.yml 为 mcp_servers 格式');
  }

  // MCP 服务规范化：url 必填；name 缺省取主机名首段；headers 为普通键值对象（如 Authorization）
  if (!Array.isArray(cfg.mcp_servers)) cfg.mcp_servers = [];
  for (const s of cfg.mcp_servers) {
    if (!s || !s.url) throw new Error('mcp_servers 每项必须有 url（MCP 服务的 JSON-RPC 端点）');
    if (!s.name) {
      try { s.name = String(new URL(s.url).hostname.split('.')[0]); } catch (_) { s.name = 'mcp'; }
    }
    const headers = {};
    for (const [k, v] of Object.entries(s.headers || {})) headers[k] = String(v);
    s.headers = headers;
  }

  cfg.config_path = configPath || '';
  return cfg;
}

function loadConfig(configPath) {
  const p = configPath || process.env.AGENT_CONFIG || path.join(__dirname, '..', 'config.yml');
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  return parseAndValidate(text, p);
}

// 从文本校验一份配置(页面编辑试运行 / 写盘前校验),返回完整生效 cfg。
function loadConfigFromText(text, configPath) {
  return parseAndValidate(text, configPath || '');
}

// ---------- 配置读写(2.0:设置页管理 config.yml;无热重载,写盘后重启生效) ----------
// 读当前配置文件原文(保留注释);文件不存在返回 null。
function readConfigText(cfg) {
  const p = cfg && cfg.config_path;
  if (!p || !fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

// 单项编辑:[{path:[...], value}] 或 [{path:[...], delete:true}] 或 [{path:[...], value, append:true}]。
// 用 YAML Document 写回,保留注释与排版;路径段为纯数字时按数组下标处理(如 ["platforms",0,"keys",1,"models",0])。
// append:向目标数组追加一项(新增平台/Key/模型用);目标不存在时创建新数组。
function applyEditsToText(text, edits) {
  const doc = YAML.parseDocument(text || '');
  for (const e of edits || []) {
    if (!e || !Array.isArray(e.path) || !e.path.length) throw new Error('配置项 path 必须是非空数组');
    const docPath = e.path.map(s => (typeof s === 'string' && /^\d+$/.test(s)) ? Number(s) : s);
    if (e.delete) doc.deleteIn(docPath);
    else if (e.append) {
      const target = doc.getIn(docPath, true);
      if (target && typeof target.add === 'function') target.add(e.value);
      else if (target === null || target === undefined) doc.setIn(docPath, [e.value]);
      else throw new Error('配置项 ' + docPath.join('.') + ' 不是数组，无法追加');
    } else doc.setIn(docPath, e.value);
  }
  return doc.toString();
}

// 校验通过才写盘(不合法直接抛错、不动文件)。
// 注意:不用「临时文件 + rename」原子写:容器里 config.yml 是单文件 bind mount,
// rename 替换该路径会 EBUSY;写坏风险已由“先校验后写”兑底。
function writeConfigText(cfg, text) {
  const p = cfg && cfg.config_path;
  if (!p) throw Object.assign(new Error('配置文件路径未知(config.yml 可能不存在),无法写入'), { status_code: 409 });
  parseAndValidate(text, p);
  fs.writeFileSync(p, text, 'utf8');
}

module.exports = { loadConfig, loadConfigFromText, readConfigText, applyEditsToText, writeConfigText };
