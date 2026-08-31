// 配置加载：AGENT_CONFIG 指向 config.yml（见 config.example.yml）
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DEFAULTS = {
  port: 8080,
  upstream_url: '',
  api_key: '',
  workspace_root: './data/tasks',
  db_path: '', // 默认为 workspace_root/.agent.db
  terminal: { default_timeout_ms: 30000, max_output_chars: 10000 },
  agent: { temperature: 1.0, max_tool_iterations: 50, max_retries: 2 },
  // 回合结束后模型保持占用（held）的租约：页内无人观看超过 idle_release_ms 则释放；
  // 即便一直有人观看，最长也只保持 active_max_ms；sweep_ms 为巡检间隔。
  model_hold: { idle_release_ms: 180000, active_max_ms: 1800000, sweep_ms: 10000 },
  models: [],
  auth: null, // { user, password }，为空则不启用内置 basic auth（可交给 nginx-proxy）
  // web_search 工具：内网 MCP 服务（JSON-RPC over HTTP，无状态）
  web_search: {
    url: 'https://web-search.ai.foresh.com/',
    authorization: 'Basic a2ljZXI6USF3MmUzcjQ=',
  },
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
    throw new Error('配置缺少 models：至少需要一个模型 {id, display_name}');
  }
  for (const m of cfg.models) {
    if (!m.id) throw new Error('models 中每项必须有 id');
    if (!m.display_name) m.display_name = m.id;
  }
  if (!cfg.upstream_url) throw new Error('配置缺少 upstream_url（cli-proxy-api 的 /v1 地址）');
  cfg.upstream_url = cfg.upstream_url.replace(/\/+$/, '');

  cfg.workspace_root = path.resolve(cfg.workspace_root);
  if (!cfg.db_path) cfg.db_path = path.join(cfg.workspace_root, '.agent.db');
  cfg.config_path = p;
  return cfg;
}

module.exports = { loadConfig };
