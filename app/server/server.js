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
const scheduler = require('./scheduler');
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
// 定时任务调度器（scheduler.js）：必须在 engine.init() 之后启动——init 先把 active
// 退回队列 / held 结版归位，首轮 tick 才不会看到脏状态。
scheduler.start(engine);

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));

// 登录认证（cookie 会话）：users 配在 config.yml 的 auth.users；留空则不启用。
// 相比 nginx htpasswd 的 basic auth，cookie 在手机浏览器原生下载时也会自动携带，下载不再失败。
const auth = createAuth(cfg);
app.use(auth.router);      // /login、/logout、/api/login 等免认证端点

// 公网临时文件的取用端点（GET /p/<id>）：匿名可达，必须挂在 auth.middleware 之前。
// 安全性来自“22 字符随机 ID + 服务端过期”，详见 routes/public-files.js 头注释。
app.use('/p', require('./routes/public-files'));

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
  // 池行是平台物理 key（id=「平台#下标」）：key 为平台下模型共享资源，
  // 按模型聚合返回：slots_total/slots_busy = 平台 key 总数/被占数，is_busy = 平台 key 全满（其下所有模型都不可选）。
  const keyRows = db.prepare('SELECT id, is_busy, current_session_id FROM model_pool').all();
  const totalByPlat = {};
  const busyByPlat = {};
  const sessByPlat = {};
  for (const r of keyRows) {
    const plat = r.id.split('#')[0];
    totalByPlat[plat] = (totalByPlat[plat] || 0) + 1;
    if (r.is_busy) {
      busyByPlat[plat] = (busyByPlat[plat] || 0) + 1;
      if (r.current_session_id) (sessByPlat[plat] = sessByPlat[plat] || []).push(r.current_session_id);
    }
  }
  // 模型行取自生效配置（cfg 重启生效，与池同步）：按模型 id 去重、保留配置顺序，禁用模型不返回。
  const cfgNow = engine.getConfig();
  const seen = new Set();
  const rows = [];
  for (const m of cfgNow.models || []) {
    if (m.enable === false || seen.has(m.id)) continue;
    seen.add(m.id);
    const total = totalByPlat[m.platform] || 0;
    const busy = busyByPlat[m.platform] || 0;
    rows.push({
      id: m.id, display_name: m.display_name, platform: m.platform, mid: m.mid,
      vision: !!m.vision, type: m.type, key_count: total,
      profile: m.profile || '', // 模型默认 prompt+tools 组合（model_profiles 名，空 = 全量）
      slots_total: total, slots_busy: busy,
      is_busy: total > 0 && busy >= total ? 1 : 0,
      current_session_id: (sessByPlat[m.platform] || []).join(','),
    });
  }
  const stats = engine.modelUsageStats();
  for (const r of rows) {
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

// 启动成功后把模型实际收到的各部分 dump 到文件方便人工核对（data_root 默认 ./data，
// 宿主机对应 <repo>/data/prompt.txt，已被 gitignore）。包含：
//  1) 默认组合：system 消息（模板 + 可用技能段落 + 语言指令）+ tools 数组（内置 + MCP）；
//  2) 每套 model_profiles 一段：按其白名单过滤后的 tools + 自定义 prompt（未配则回落默认模板）。
function dumpPromptBundle() {
  const file = path.join(cfg.data_root, 'prompt.txt');
  const lang = (cfg.agent || {}).language;
  const tools = engine.TOOL_DEFINITIONS.concat(mcp.toolDefinitions());
  const parts = [
    '# ===== 1. System Prompt（默认组合，system 消息，进程内恒定）=====\n\n' + llm.systemPromptText(lang),
    '\n\n# ===== 2. Tools（默认组合 ' + tools.length + ' 个：内置 + MCP，随每次请求的 tools 字段发送）=====\n\n' + JSON.stringify(tools, null, 2),
  ];
  for (const name of Object.keys(cfg.model_profiles || {})) {
    const pTools = engine.effectiveTools(name);
    parts.push(
      '\n\n# ===== profile "' + name + '" =====\n\n' +
      '# --- system prompt ---\n\n' + llm.systemPromptText(lang, name) +
      '\n\n# --- tools（白名单过滤后 ' + pTools.length + ' / 全量 ' + tools.length + ' 个）---\n\n' + JSON.stringify(pTools, null, 2)
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, parts.join(''), 'utf8');
  log.info('startup', '  prompt_dump=' + file + ' (tools=' + tools.length +
    ', profiles=' + (Object.keys(cfg.model_profiles || {}).join(',') || '-') + ')');
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
      log.info('startup', '  public_link=' + ((cfg.public_link || {}).base_url || '未配置（mint_public_link 不可用）'));
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

// 优雅退出（照抄 executor/server.js 的 shutdown 形态）：node 在容器里是 PID 1，
// 不显式注册监听时 SIGTERM 会被直接忽略，docker stop/restart 只能白等满
// stop_grace_period（默认 10s）后被 SIGKILL。scheduler/holdSweeper 的 timer
// 均已 unref，退出只需收掉监听与 SSE 长连接。
function shutdown(sig) {
  log.info('shutdown', '收到 ' + sig + '，停止服务');
  bus.closeAllSessions(); // 给前端干净的流结束（走重连/回放），而不是 TCP reset
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // 关不掉的连接 3s 后兑底硬退
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
