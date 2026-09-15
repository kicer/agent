// 入口：装配配置、数据库、SSE 总线、路由与静态资源。
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { loadConfig } = require('./config');
const { initDb } = require('./db');
const { createBus } = require('./sse');
const { createAuth } = require('./auth');
const engine = require('./engine');
const llm = require('./llm');
const mcp = require('./mcp');
const skills = require('./tools/skills');
const log = require('./log');

const cfg = loadConfig(process.env.AGENT_CONFIG);
log.setLevel(cfg.log_level); // 分级日志开关(log.js;config.yml log_level,重启生效)
const db = initDb(cfg.db_path);
const bus = createBus();

engine.setModelPool(cfg, db, bus);
engine.init();

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));

// 登录认证（cookie 会话）：users 配在 config.yml 的 auth.users；留空则不启用。
// 相比 nginx htpasswd 的 basic auth，cookie 在手机浏览器原生下载时也会自动携带，下载不再失败。
const auth = createAuth(cfg);
app.use(auth.router);      // /login、/logout、/api/login 等免认证端点
app.use(auth.middleware);  // 其余请求需登录态（cookie 或 Basic 头）

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/sessions', require('./routes/messages'));
app.use('/api/sessions', require('./routes/files'));
app.use('/api/skills', require('./routes/skills'));
app.use('/api/config', require('./routes/config'));
app.use('/api/platforms', require('./routes/platforms'));
app.use('/api/system', require('./routes/system'));

// 模型池状态(前端可展示空闲/占用)+ 每模型 token 用量(今日/累计,输入/输出分开)。
// 从生效配置补齐平台维度字段(platform/mid/vision/type + 平台 key 数 key_count):
// model_pool 表只有 id/display_name/占用态,会话页「选择模型」弹窗需要按平台分组展示。
// 配置里新增但重启前未进池的模型不在此返回(池才是运行时真相)。
app.get('/api/models', (req, res) => {
  const rows = db.prepare('SELECT id, display_name, is_busy, current_session_id FROM model_pool ORDER BY id').all();
  const stats = engine.modelUsageStats();
  // 配置视图:模型唯一键 → 平台/原始 id/vision;平台名 → key 数(cfg.models 含 key 副本,不能直接拿来用)
  const cfgNow = engine.getConfig();
  const infoById = {};
  const keyCountByPlat = {};
  for (const p of cfgNow.platforms || []) {
    keyCountByPlat[p.name] = (p.keys || []).length;
    for (const m of p.models || []) {
      infoById[p.name + '/' + m.id] = { platform: p.name, mid: m.id, vision: !!m.vision, type: p.type };
    }
  }
  for (const r of rows) {
    const info = infoById[r.id] || {};
    r.platform = info.platform || '';
    r.mid = info.mid || '';
    r.vision = info.vision || false;
    r.type = info.type || '';
    r.key_count = keyCountByPlat[r.platform] || 0;
    const s = stats[r.id] || {};
    r.today_prompt = s.today_prompt || 0;
    r.today_completion = s.today_completion || 0;
    r.today_cached = s.today_cached || 0;
    r.total_prompt = s.total_prompt || 0;
    r.total_completion = s.total_completion || 0;
    r.total_cached = s.total_cached || 0;
  }
  res.json(rows);
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

const PORT = process.env.PORT || cfg.port;

// 公网临时链接的【签发】端口：只在容器内监听、**不映射到宿主机**（compose 也不 publish），
// 所以外部连不上，于是这条接口不需要任何凭据 —— executor 里的 AI 命令可以 curl 它换一条
// 短命的公网链接（见 routes/public-link.js 头注释）。未配 public_link.base_url 则不启动。
const PUBLIC_LINK_PORT = Number(process.env.PUBLIC_LINK_PORT) || 8081;

function startPublicLinkServer() {
  const pl = cfg.public_link || {};
  if (!pl.base_url) {
    log.info('startup', '  public_link=未配置（public_link.base_url 为空），不启动签发端口');
    return;
  }
  const plApp = express();
  plApp.use(require('./routes/public-link'));
  plApp.listen(PUBLIC_LINK_PORT, () => {
    log.info('startup', '  public_link=' + pl.base_url + ' (签发端口 :' + PUBLIC_LINK_PORT + ' 仅内网，未映射宿主机)');
  });
}

// 启动成功后把模型实际收到的各部分 dump 到文件方便人工核对（data_root 默认 ./data，
// 宿主机对应 <repo>/data/prompt.txt，已被 gitignore）。包含两部分：
//  1) system 消息：模板 + 可用技能段落 + 语言指令（进程内恒定，仅技能增删时变）；
//  2) tools 数组：内置 definitions.json + 启动时发现的 MCP 工具，与每次请求的 tools 字段一致。
function dumpPromptBundle() {
  const file = path.join(cfg.data_root, 'prompt.txt');
  const tools = engine.TOOL_DEFINITIONS.concat(mcp.toolDefinitions());
  const parts = [
    '# ===== 1. System Prompt（system 消息，进程内恒定）=====\n\n' + llm.systemPromptText((cfg.agent || {}).language),
    '\n\n# ===== 2. Tools（' + tools.length + ' 个：内置 + MCP，随每次请求的 tools 字段发送）=====\n\n' + JSON.stringify(tools, null, 2),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, parts.join(''), 'utf8');
  log.info('startup', '  prompt_dump=' + file + ' (tools=' + tools.length + ')');
}

// 启动时先发现各 MCP 服务的工具（单个服务失败只警告，不阻止启动），
// 并对技能列表做快照（注入 system prompt，见 llm.setSkillListText），完成后开始监听。
mcp.init(cfg).then(async () => {
  // 技能列表快照：模型直接感知已有技能，免先 list_skills 探索；
  // 此处失败不阻塞启动，list_skills 仍可做实时兑底。
  try {
    const list = await skills.listSkills({ cfg });
    llm.setSkillListText(skills.formatSkillListForPrompt(list));
    log.info('startup', '  skills=' + (list.length ? list.map(s => s.name).join(', ') : '(none)'));
  } catch (e) {
    log.warn('startup', '技能列表生成失败：' + e.message);
  }
  server.listen(PORT, () => {
      log.info('startup', 'Agent server listening on ' + PORT);
      startPublicLinkServer();
      log.info('startup', '  workspace_root=' + cfg.workspace_root);
      log.info('startup', '  data_root=' + cfg.data_root);
      log.info('startup', '  models=' + cfg.models.map(m => m.id + '@' + m.url).join(', '));
      const mcpList = (cfg.mcp_servers || []).map(s => s.name + '@' + s.url + (s.enable === false ? '(禁用)' : '')).join(', ');
      log.info('startup', '  mcp_servers=' + (mcpList || '(none)'));
      log.info('startup', '  auth=' + (auth.enabled ? 'login: ' + cfg.auth.users.map(u => u.user).join(', ') : '(disabled)'));
      log.info('startup', '  log_level=' + cfg.log_level);
      // prompt dump 失败不影响服务：只是核对用产物。
      try {
        dumpPromptBundle();
      } catch (e) {
        log.warn('startup', 'prompt dump 失败：' + e.message);
      }
    });
});
