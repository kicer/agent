// 配置加载：AGENT_CONFIG 指向 config.yml（见 config.example.yml）
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const log = require('./log');

// MCP 单次工具调用（tools/call）的缺省最大等待，与 mcp.js 的 CALL_TIMEOUT_MS 保持一致。
const MCP_CALL_TIMEOUT_MS = 60000;

// MCP 工具名单（tools_allow/tools_deny）归一化：只接受数组，项统一转字符串去空白、丢空项；
// 空数组/非数组视作未配置（返回 undefined），避免「allow: [] 是不是全禁」这种歧义。
function normToolNames(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(x => String(x).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

// profile 的 prompt 文件查找基准目录：与内置模板同处 server/templates/
// （compose 已 bind-mount ./app/server，宿主可直接编辑，无需重建镜像）。
const TEMPLATES_DIR = path.join(__dirname, 'templates');

// model_profiles 归一化：顶层 map {名称: {tools_allow?, system_prompt_file?}}，
// 供 platforms[].models[].profile 引用（同 id 模型跳平台复用时免重复配置）。
// - tools_allow 只按最终发给模型的工具名匹配（内置名 + MCP 名，含冲突时加的 server__ 前缀）。
//   语义与 MCP 的 tools_allow（空数组=未配）有意不同：这里空数组 [] 是有效配置 = 一个工具都不发
//   （纯文本模式，给弱到不会调工具的小模型用）；只有「没写/非数组」才是「不过滤、发全量」。
// - system_prompt_file：相对 templates/（也接受绝对路径），配置加载时一次性读入常驻内存，
//   运行期切换零 IO；缺失/读不到/内容为空直接报校验错——拦在保存/重启预检，不留到运行期降级。
// - 两样都没配 = 不起任何作用，报错误防误配空壳。
function normalizeModelProfiles(rawProfiles) {
  const out = {};
  if (!rawProfiles || typeof rawProfiles !== 'object' || Array.isArray(rawProfiles)) return out;
  for (const [name, p] of Object.entries(rawProfiles)) {
    const key = String(name).trim();
    if (!key) continue;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new Error('model_profiles.' + key + ' 必须是对象 {tools_allow, system_prompt_file}');
    }
    // 不用 normToolNames：那会把空数组吐成 undefined（丢抑「[] = 零工具」语义）；这里只归一字符串项。
    const tools_allow = Array.isArray(p.tools_allow)
      ? p.tools_allow.map(x => String(x).trim()).filter(Boolean)
      : undefined;
    const file = String(p.system_prompt_file || '').trim();
    let prompt = '';
    if (file) {
      const abs = path.isAbsolute(file) ? file : path.join(TEMPLATES_DIR, file);
      try { prompt = fs.readFileSync(abs, 'utf8'); } catch (_) {
        throw new Error('model_profiles.' + key + '.system_prompt_file 读取失败：' + abs);
      }
      prompt = prompt.trim();
      if (!prompt) throw new Error('model_profiles.' + key + '.system_prompt_file 内容为空：' + abs);
    }
    if (!tools_allow && !prompt) {
      throw new Error('model_profiles.' + key + ' 至少需配 tools_allow 或 system_prompt_file 之一');
    }
    out[key] = { name: key, tools_allow, system_prompt_file: file, prompt };
  }
  return out;
}

// 默认配置：与 app/config.example.yml 一一对应（改这里同时改示例，保持同步）。
const DEFAULTS = {
  port: 8090,
  // 任务工作区根目录：AI 的文件操作限制在此（容器内挂 ./tasks → /workspace/tasks）。
  workspace_root: '/workspace/tasks',
  // 数据根目录：SQLite（.agent.db）与启动 prompt dump 放这里（容器内挂 ./data → /workspace/data）。
  data_root: '/workspace/data',
  // 缺省 data_root/.agent.db。
  db_path: '',
  // 命令执行服务：url 非空走远端 executor，留空本地 spawn；留空时回退 env EXECUTOR_URL / EXECUTOR_TOKEN。
  executor: { url: '', token: '' },
  terminal: { default_timeout_ms: 30000, max_output_chars: 10000 },
  // fetch：timeout_ms 覆盖请求发出到 body 读完的全生命周期；max_bytes 为流式抓取字节上限（超限即断开）。
  fetch: { timeout_ms: 30000, max_bytes: 1048576 },
  // auto_compress_tokens：本轮 In token 峰值 ≥ 此值时推送「自动压缩」提议（0=关）。
  agent: { temperature: 1.0, max_tool_iterations: 100, max_retries: 2, language: 'Simplified Chinese', auto_compress_tokens: 60000 },
  // 大图上传预处理（浏览器端 canvas 压缩，参数经 /api/system/status 下发前端）。
  upload: { image_compress_threshold_kb: 1536, image_max_dim: 2000, image_quality: 0.85, confirm_size_mb: 10 },
  // 技能根目录：留空取 workspace_root 同级 skills（/workspace/tasks → /workspace/skills）。
  skills: { skills_root: '', timeout_ms: 120000 },
  // 回合结束后模型保持占用（held）租约：无人观看 idle_release_ms 释放，有人观看最长 active_max_ms，sweep_ms 巡检。
  model_hold: { idle_release_ms: 180000, active_max_ms: 1800000, sweep_ms: 10000 },
  // 日志等级：debug < info < warn < error < none（none=全部静默）。
  log_level: 'info',
  // 模型平台池（无默认值，结构见 config.example.yml）。
  platforms: [],
  // 模型 profile（prompt + tools 白名单组合）：platforms 里的模型用 profile: <名> 引用。
  model_profiles: {
    // 小模型：只留文件/终端/网页等核心工具，省上下文。
    mini: {
      tools_allow: ['read_file', 'write_file', 'edit_file', 'terminal', 'fetch', 'web_search', 'skill'],
      system_prompt_file: 'mini-system.txt',
    },
    // 纯文本对话：一个工具都不发。
    zero: { tools_allow: [], system_prompt_file: 'zero-system.txt' },
  },
  // 登录认证：{users:[{user,password}], secret?, ttl_ms?}；null / users 空 = 不启用。
  auth: null,
  // 外部 MCP 服务列表（无默认值）：{name?, url, headers?, enable?(默认 true), timeout_ms?(默认 60s)}。
  mcp_servers: [],
  // 公网临时链接：base_url 非空才启用 mint_public_link；容器配 VIRTUAL_HOST 时以它为准。
  public_link: { base_url: '', ttl_ms: 1800000 },
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
// 输出新格式:models 在平台层,keys 只含 api_key/concurrency。
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
      p = { name, url, type: 'openai', models: [], keys: [{ api_key: apiKey, concurrency: 1 }] };
      byKey.set(gk, p);
      groups.push(p);
    }
    p.models.push({ id: m.id, display_name: m.display_name || m.id, vision: m.vision === true });
  }
  return groups;
}

// 规范化并校验 platforms 层级：平台(name/url/type) → models(id/display_name/...) + keys(api_key/concurrency)。
// 新版结构：models 提到平台层（与 url/type 同级），所有 key 共用同一份 models；key 数组里只放
// {api_key, concurrency}，不再挂 models。旧版 keys[j].models 写法直接报错，让用户改 YAML。
// 内部唯一键 = 平台名/模型id：不同平台允许同模型 id，同平台内必须唯一（会话/模型池/用量均按该键认模型）。
function normalizePlatforms(rawPlatforms, profileNames) {
  const seen = new Set(); // 已用唯一键（平台名/模型id）
  const out = [];
  for (let pi = 0; pi < rawPlatforms.length; pi++) {
    const p = rawPlatforms[pi] || {};
    if (!p.url) throw new Error('platforms[' + pi + '] 缺少 url（OpenAI 兼容 /v1 地址）');
    // 检测旧格式 keys[j].models：发现则报错,不兼容(改动 3)。
    for (let ki = 0; ki < (p.keys || []).length; ki++) {
      if (Array.isArray(p.keys[ki] && p.keys[ki].models)) {
        throw new Error('platforms[' + pi + '].keys[' + ki + '].models 写法已废弃：' +
          'models 应提到 platforms[' + pi + '].models（与 url/type 同级），所有 key 共用同一份 models。' +
          '请改写 config.yml。');
      }
    }
    const url = String(p.url).replace(/\/+$/, '');
    const name = String(p.name || '').trim() || (hostnameOf(url) || ('p' + (pi + 1)));
    // type 可完全自定义（不校验白名单）；它决定余额查询适配器，由 routes/platforms.js 按类型分发。
    // 缺省取平台 name：用户起名"bigmodel"时不显式配 type 也能命中 bigmodel 适配器；
    // 自定义名（如"zhipu-prod"）若不命中已接入 adapter,查询时返回 400（不静默回退）。
    const type = String(p.type || name).trim();
    // 平台层 models 解析
    const models = [];
    for (let mi = 0; mi < (p.models || []).length; mi++) {
      const m = p.models[mi] || {};
      if (!m || !m.id) throw new Error('平台「' + name + '」的 models[' + mi + '] 缺少 id');
      const uid = name + '/' + String(m.id);
      if (seen.has(uid)) throw new Error('模型重复：平台「' + name + '」下已有模型 id：' + m.id + '（不同平台可同名，同平台内必须唯一）');
      seen.add(uid);
      // 选填：引用顶层 model_profiles 的组合名（tools 白名单 + 自定义 system prompt）；
      // 不配 = 默认全量。引用了不存在的名字直接报错，不静默回退。
      const profile = m.profile ? String(m.profile).trim() : '';
      if (profile && !profileNames.has(profile)) {
        throw new Error('平台「' + name + '」的模型「' + m.id + '」引用了不存在的 profile：' + profile + '（请核对顶层 model_profiles）');
      }
      models.push({
        id: String(m.id),
        display_name: m.display_name ? String(m.display_name) : String(m.id), // 缺省 = id
        vision: m.vision === true, // 支持时 read_file 读图会回传图片内容
        enable: m.enable !== false, // 选填，默认启用；禁用后不进模型池，不参与分配/绑定（重启生效）
        // 选填：模型特有的请求体参数对象。发往上游时整体合并进 body 顶层。
        extra_params: (m.extra_params && typeof m.extra_params === 'object' && !Array.isArray(m.extra_params)) ? m.extra_params : {},
        // 选填：前端启用「深度思考」时合并进 body。可覆盖 extra_params 的同名键。
        thinking_params: (m.thinking_params && typeof m.thinking_params === 'object' && !Array.isArray(m.thinking_params)) ? m.thinking_params : {},
        profile,
      });
    }
    // keys 仅含 api_key/concurrency（不再挂 models）
    const keys = [];
    for (let ki = 0; ki < (p.keys || []).length; ki++) {
      const k = p.keys[ki] || {};
      const concurrency = Math.max(1, parseInt(k.concurrency, 10) || 1);
      keys.push({ api_key: String(k.api_key || ''), concurrency });
    }
    out.push({ name, url, type, models, keys });
  }
  return out;
}

// 校验原始配置文本(启动读文件与网页编辑共用)。configPath 仅记录来源,可为空。
function parseAndValidate(rawText, configPath) {
  let raw = YAML.parse(rawText || '') || {};
  const cfg = deepMerge(DEFAULTS, raw);

  // ---------- 模型配置：platforms 层级（platforms[].models[] + platforms[].keys[]）----------
  // models 提到平台层（与 url/type 同级），多 key 共用同一份 models。
  // cfg.models 为打平后的运行时视图：每个 key 都展开一份（key 数 × models 数），
  // 内部唯一键 = 「平台名/模型id」（key_index 是副本下标，不参与 id 命名空间）；
  // 调用处（池/会话/路由/用量）按 id 认模型，key_index 仅用于按 key 拆余额展示。
  if ((!Array.isArray(raw.platforms) || !raw.platforms.length) && Array.isArray(raw.models) && raw.models.length) {
    raw = Object.assign({}, raw, { platforms: migrateLegacyModels(raw.models) });
    log.info('config', '检测到旧配置 models[] 扁平格式，已自动迁移为 platforms 层级；建议改写 config.yml 为 platforms 格式');
  }
  // platforms 允许为空：可先起服务，再在前端设置页添加平台后重启（无模型时无会话可调度）。
  const rawPlatforms = Array.isArray(raw.platforms) ? raw.platforms : [];
  // 用 deepMerge 后的 cfg.model_profiles（含内置 mini/zero），故 config.yml 不配也有默认组合。
  cfg.model_profiles = normalizeModelProfiles(cfg.model_profiles);
  cfg.platforms = normalizePlatforms(rawPlatforms, new Set(Object.keys(cfg.model_profiles)));
  cfg.models = [];
  cfg.platforms.forEach((p, pi) => p.keys.forEach((k, ki) => p.models.forEach((m, mi) => {
    cfg.models.push({
      // id = 内部唯一键「平台名/模型id」（池/会话/用量/前端均按它认模型，调用处无需区分）；
      // mid = 发给上游的原始模型名（请求体 body.model 用它）。
      // key_index 是 key 副本下标：同 id 在 cfg.models 里会出现 N 次（N=key 数），便于按 key 拆余额。
      id: p.name + '/' + m.id, mid: m.id,
      display_name: m.display_name, vision: m.vision, enable: m.enable,
      extra_params: m.extra_params, thinking_params: m.thinking_params,
      profile: m.profile,
      url: p.url, api_key: k.api_key, platform: p.name, type: p.type, concurrency: k.concurrency,
      platform_index: pi, key_index: ki, model_index: mi,
    });
  })));
  if (!cfg.models.length) {
    log.warn('config', '配置中没有可用模型（platforms 为空或其下模型全被禁用）：可在设置页添加平台后重启。');
  }

  cfg.workspace_root = path.resolve(cfg.workspace_root);
  cfg.data_root = path.resolve(cfg.data_root);
  if (!cfg.db_path) cfg.db_path = path.join(cfg.data_root, '.agent.db');

  // executor 远程执行：配置优先，env 兑底（compose 注入 EXECUTOR_URL/EXECUTOR_TOKEN）；url 去尾部斜杠（拼 /exec 用）。
  if (!cfg.executor || typeof cfg.executor !== 'object') cfg.executor = {};
  cfg.executor.url = String(cfg.executor.url || process.env.EXECUTOR_URL || '').trim().replace(/\/+$/, '');
  cfg.executor.token = String(cfg.executor.token || process.env.EXECUTOR_TOKEN || '').trim();

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

  // MCP 服务规范化：url 必填；name 缺省取主机名首段；headers 为普通键值对象（如 Authorization）；
  // enable 缺省 true，显式 false 时启动不加载该服务的工具（见 mcp.init）；
  // timeout_ms 为该服务单次 tools/call 的最大等待，缺省 60s（长任务服务如视频生成可调大）。
  if (!Array.isArray(cfg.mcp_servers)) cfg.mcp_servers = [];
  for (const s of cfg.mcp_servers) {
    if (!s || !s.url) throw new Error('mcp_servers 每项必须有 url（MCP 服务的 JSON-RPC 端点）');
    if (!s.name) {
      try { s.name = String(new URL(s.url).hostname.split('.')[0]); } catch (_) { s.name = 'mcp'; }
    }
    // 容错 YAML 里写成字符串 "false" / "off" 的情况，统一归一为布尔
    s.enable = !(s.enable === false || s.enable === 'false' || s.enable === 'off' || s.enable === 0);
    const headers = {};
    for (const [k, v] of Object.entries(s.headers || {})) headers[k] = String(v);
    s.headers = headers;
    // 单次工具调用的超时上限：缺省 60s，夹在 [1s, 10min]（一次调用长期占着模型槽位，不允许无限等）。
    // YAML 里写成字符串或写了非法值都回落到缺省。
    s.timeout_ms = Math.min(Math.max(Number(s.timeout_ms) || MCP_CALL_TIMEOUT_MS, 1000), 600000);
    // 工具名单（发现阶段生效，见 mcp.init）：allow 为白名单，deny 在其后叠加生效（deny 优先）。
    s.tools_allow = normToolNames(s.tools_allow);
    s.tools_deny = normToolNames(s.tools_deny);
  }

  normalizePublicLink(cfg);

  cfg.config_path = configPath || '';
  return cfg;
}

// 公网临时链接（public_link）规范化：base_url 去尾斜杠；ttl_ms 夹在 [1min, 24h]——
// 公网链接宁可短不可长（“永久公开”正是这套机制要避免的东西）。
//
// 对外前缀的取值优先级：
//   1) 容器 env 的 VIRTUAL_HOST 非空 → https://<第一个域名>
//      （nginx-proxy 的写法，逗号分隔多域名时取第一个）。只要配了域名 + HTTPS 这一层，
//      返回给外部服务（video_gen 取参考图）的链接就必须走域名，所以 env 优先；
//      反之 config.yml 里那个 init 脚本生成的 http://<IP>:8090 会把这个开关盖住。
//      协议写死 https：前置了 nginx-proxy 一定是 HTTPS（证书由 acme-companion 签）。
//   2) 否则用 config.yml 的 public_link.base_url（纯 IP:端口部署，init 脚本写 http://<IP>:8090）。
function normalizePublicLink(cfg) {
  const pl = cfg.public_link || {};
  const vhost = String(process.env.VIRTUAL_HOST || '').split(',')[0].trim();
  const baseUrl = vhost ? 'https://' + vhost : pl.base_url;
  cfg.public_link = {
    base_url: String(baseUrl || '').trim().replace(/\/+$/, ''),
    ttl_ms: Math.min(Math.max(Number(pl.ttl_ms) || 1800000, 60 * 1000), 24 * 3600 * 1000),
  };
  if (cfg.public_link.base_url && !/^https?:\/\//i.test(cfg.public_link.base_url)) {
    log.warn('config', 'public_link.base_url 看起来不是 http(s) 地址：' + cfg.public_link.base_url);
  }
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
