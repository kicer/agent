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
  models: [],
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

// 校验原始配置文本(启动读文件与网页编辑共用)。configPath 仅记录来源,可为空。
function parseAndValidate(rawText, configPath) {
  const raw = YAML.parse(rawText || '') || {};
  const cfg = deepMerge(DEFAULTS, raw);

  if (!Array.isArray(cfg.models) || cfg.models.length === 0) {
    throw new Error('配置缺少 models：至少需要一个模型 {id, url, display_name}')
  }
  // 每个模型独立配置上游：url 必填（OpenAI 兼容 /v1 地址），api_key 选填（留空则不带鉴权头）
  for (const m of cfg.models) {
    if (!m || !m.id) throw new Error('models 中每项必须有 id');
    if (!m.url) throw new Error('models.' + m.id + ' 缺少 url（每个模型独立配置上游 /v1 地址）');
    if (!m.display_name) m.display_name = m.id;
    m.url = String(m.url).replace(/\/+$/, '');
    m.api_key = m.api_key || '';
    // 模型是否支持 vision（图片内容回传）；默认 false，会话上下文中会告知 AI
    m.vision = m.vision === true;
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
    log.info('[config] 检测到旧配置 web_search.*，已自动转为一条 mcp_servers；建议更新 config.yml 为 mcp_servers 格式');
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

// 单项编辑:[{path:[...], value}] 或 [{path:[...], delete:true}]。
// 用 YAML Document 写回,保留注释与排版;路径段为纯数字时按数组下标处理(如 ["models",0,"url"])。
function applyEditsToText(text, edits) {
  const doc = YAML.parseDocument(text || '');
  for (const e of edits || []) {
    if (!e || !Array.isArray(e.path) || !e.path.length) throw new Error('配置项 path 必须是非空数组');
    const docPath = e.path.map(s => (typeof s === 'string' && /^\d+$/.test(s)) ? Number(s) : s);
    if (e.delete) doc.deleteIn(docPath);
    else doc.setIn(docPath, e.value);
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
