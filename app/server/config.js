// 配置加载：AGENT_CONFIG 指向 config.yml（见 config.example.yml）
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DEFAULTS = {
  port: 8080,
  workspace_root: './data/tasks',
  db_path: '', // 默认为 workspace_root/.agent.db
  terminal: { default_timeout_ms: 30000, max_output_chars: 10000 },
  agent: { temperature: 1.0, max_tool_iterations: 50, max_retries: 2 },
  // 回合结束后模型保持占用（held）的租约：页内无人观看超过 idle_release_ms 则释放；
  // 即便一直有人观看，最长也只保持 active_max_ms；sweep_ms 为巡检间隔。
  // 「绑定模型但闲置」的会话（从未发言、无未回应消息）同样按此租约释放，防建而不用霸占模型。
  model_hold: { idle_release_ms: 180000, active_max_ms: 1800000, sweep_ms: 10000 },
  models: [],
  auth: null, // { user, password }，为空则不启用内置 basic auth（可交给 nginx-proxy）
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

function loadConfig(configPath) {
  const p = configPath || process.env.AGENT_CONFIG || path.join(__dirname, '..', 'config.yml');
  let raw = {};
  if (fs.existsSync(p)) {
    raw = YAML.parse(fs.readFileSync(p, 'utf8')) || {};
  }
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
  }

  cfg.workspace_root = path.resolve(cfg.workspace_root);
  if (!cfg.db_path) cfg.db_path = path.join(cfg.workspace_root, '.agent.db');

  // 兼容旧配置：顶层 web_search.{url,authorization} 自动转为一条 mcp_servers（authorization 即一条 header）
  if (raw.web_search && raw.web_search.url && !raw.mcp_servers) {
    const ws = raw.web_search;
    cfg.mcp_servers = [{
      name: 'web-search',
      url: ws.url,
      headers: ws.authorization ? { Authorization: ws.authorization } : {},
    }];
    console.log('[config] 检测到旧配置 web_search.*，已自动转为一条 mcp_servers；建议更新 config.yml 为 mcp_servers 格式');
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

  cfg.config_path = p;
  return cfg;
}

module.exports = { loadConfig };
