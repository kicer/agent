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
const wechat = require('./wechat');
const llm = require('./llm');
const mcp = require('./mcp');
const skills = require('./tools/skills');
const log = require('./log');

const cfg = loadConfig(process.env.AGENT_CONFIG);
log.setLevel(cfg.log_level); // 分级日志开关(log.js;config.yml log_level,重启生效)
llm.setPayloadTrim(cfg.agent); // 历史重放的重负载占位裁剪阈值（llm.buildMessages；config agent.trim_*）
const db = initDb(cfg.db_path);
const bus = createBus();

engine.setModelPool(cfg, db, bus);
engine.init();
// 定时任务调度器（scheduler.js）：必须在 engine.init() 之后启动——init 先把会话状态归位
//（active/遗留 queued → held），首轮 tick 才不会看到脏状态。
// 通知面注入：定时轮收尾（完成/投递失败）经 wechat.notifyTask 转递微信（组装见 scheduler.fireNotify）。
// scheduler 不反向 require wechat（engine→executor→scheduler→wechat→engine 成环会拿到半成品 exports），
// 惰性闭包传递；wechat 未启用（无 WXBOT_URL）时 notifyTask 自带 enabled 闸门静默跳。
scheduler.start(engine, p => wechat.notifyTask(p));
// 长期记忆保留窗裁剪（memory.js）：平时追加碎片顺带裁，这里兑底「窗口改小/长期无轮换」的表残留。
require('./memory').prune(db, cfg);

// 微信接入（wechat.js，可选能力）：env WXBOT_URL/WXBOT_TOKEN 未就位 = 全部静默关闭；配了但 wxbot 没起 =
// restore 只留一行日志，不重试不报错（用户在设置页点刷新自愈），不影响 Web 主流程。
wechat.init(cfg, db, bus);

const app = express();
const server = http.createServer(app);

// wxbot 内网回调（/wxhook/inbox|hook）：凭共享服务 token（Bearer）把门，微信用户永远不该直接碰
// 这两个端点（wxbot 只挂内网）。必须挂在全局 express.json(2mb) 之前：媒体 base64 转发体远超 2mb，
// 由 hookRouter 自带的 32mb 解析器先读掉并置 req._body，下游全局 json 解析器自动跳过（同 executor 不冲突）。
app.use('/wxhook', require('./routes/wechat').hookRouter);

app.use(express.json({ limit: '2mb' }));

// 登录认证（cookie 会话）：users 配在 config.yml 的 auth.users；留空则不启用。
// 相比 nginx htpasswd 的 basic auth，cookie 在手机浏览器原生下载时也会自动携带，下载不再失败。
const auth = createAuth(cfg);
app.use(auth.router);      // /login、/logout、/api/login 等免认证端点

// 公网临时文件的取用端点（GET /p/<id>）：匿名可达，必须挂在 auth.middleware 之前。
// 安全性来自“22 字符随机 ID + 服务端过期”，详见 routes/public-files.js 头注释。
app.use('/p', require('./routes/public-files'));

app.use(auth.middleware);  // 其余请求需登录态（cookie 或 Basic 头）

// preview-proxy 前置守卫(见其注释):vendor 预览页用根绝对 '/' 取自身新版 HTML,
// 必须在静态首页拦截之前转发回去;mount() 仍在文件末尾兜底其余路径。
require('./routes/preview-proxy').earlyGuard(app);

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/sessions', require('./routes/messages'));
app.use('/api/sessions', require('./routes/files'));
app.use('/api/skills', require('./routes/skills'));
app.use('/api/config', require('./routes/config'));
app.use('/api/platforms', require('./routes/platforms'));
app.use('/api/system', require('./routes/system'));
// 用户画像（账户设置）：读写按登录用户隔离，逻辑在 user-profile.js
app.use('/api/profile', require('./routes/profile'));
// 长期记忆（日记）只读调试视图：独立页 /memory.html 的供数接口，查表即答零写操作
app.use('/api/memory', require('./routes/memory'));
// 微信绑定管理（设置页→账户→微信绑定），业务在 wechat.js；未配置时接口返回 enabled:false，前端整卡隐藏
app.use('/api/wechat', require('./routes/wechat'));
// 文本命令接入端（IM/CLI 等无 UI 客户端）：命令解析 + (user, channel) 当前会话绑定，见 routes/channel.js
app.use('/api/channel', require('./routes/channel'));
// data-page 技能配套：任务 app/ 子树页面向导 /app/{task_id}/ + 数据 API /api/db/{task_id}/query。
// 随其余业务路由一样挂在 auth.middleware 之后（登录态才能访问）。
app.use(require('./routes/data-page'));
// 通用预览反代（注册表驱动，路由+Referer 兜底一体；挂最末尾，兜底不吃任何现有路径）
require('./routes/preview-proxy').mount(app);

// 模型池状态（前端展示在用会话数/在用会话列表，key 非独占）+ 每模型 token 用量（今日/累计，输入/输出分开）。
// 从生效配置补齐平台维度字段(platform/mid/vision/type + 平台 key 数 key_count):
// model_pool 表只有 id/display_name/last_used_at，会话页「选择模型」弹窗需要按平台分组展示。
// 配置里新增但重启前未进池的模型不在此返回(池才是运行时真相)。
app.get('/api/models', (req, res) => {
  // 池行是平台物理 key（id=「平台#下标」）：key 为共享资源——非独占，多个会话可同时绑同一个 key
  // 并发 looping（调度只是优先级选 key，见 engine.chooseKey）。
  // 「在用」按 sessions 实时算：各平台 key 上绑着的 active/held 会话数（展示用途，无「不可选」语义）。
  const keyRows = db.prepare('SELECT id FROM model_pool').all();
  const totalByPlat = {};
  const sessByPlat = {};
  for (const r of keyRows) {
    const plat = r.id.split('#')[0];
    totalByPlat[plat] = (totalByPlat[plat] || 0) + 1;
  }
  for (const s of db.prepare("SELECT id, model_slot FROM sessions WHERE model_slot IS NOT NULL AND status IN ('active','held')").all()) {
    const plat = String(s.model_slot).split('#')[0];
    (sessByPlat[plat] = sessByPlat[plat] || []).push(s.id);
  }
  // 模型行取自生效配置（cfg 重启生效，与池同步）：按模型 id 去重、保留配置顺序，禁用模型不返回。
  const cfgNow = engine.getConfig();
  const seen = new Set();
  const rows = [];
  for (const m of cfgNow.models || []) {
    if (m.enable === false || seen.has(m.id)) continue;
    seen.add(m.id);
    const total = totalByPlat[m.platform] || 0;
    const using = sessByPlat[m.platform] || [];
    rows.push({
      id: m.id, display_name: m.display_name, platform: m.platform, mid: m.mid,
      vision: !!m.vision, type: m.type, key_count: total,
      profile: m.profile || '', // 模型默认 prompt+tools 组合（model_profiles 名，空 = 全量）
      slots_total: total,
      slots_used: using.length,                  // 在用会话数（active/held，可超 key 数：共享不独占）
      current_session_id: using.join(','),       // 在用会话 id 列表（展示用）
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
//  1) 默认组合：system 消息（模板 + 可用技能段落 + 语言指令）+ tools 数组（内置 + MCP 过滤全局 tools_deny）；
//  2) 每套 model_profiles 一段：按其白名单过滤后的 tools + 自定义 prompt（未配则回落默认模板）。
function dumpPromptBundle() {
  const file = path.join(cfg.data_root, 'prompt.txt');
  const lang = (cfg.agent || {}).language;
  // 默认组合必须走 effectiveTools()（无 profile 分支 = 全局 deny 过滤），与 engine 每轮实际发送同源：
  // 直接 concat 全量会把 lab 这类被 deny 的工具也 dump 进去——模型其实收不到，人工核实时误导。
  const tools = engine.effectiveTools();
  const allCount = engine.TOOL_DEFINITIONS.concat(mcp.toolDefinitions()).length;
  const parts = [
    '# ===== 1. System Prompt（默认组合，system 消息，进程内恒定）=====\n\n' + llm.systemPromptText(lang),
    '\n\n# ===== 2. Tools（默认组合 ' + tools.length + ' 个：内置 + MCP 过滤全局 tools_deny 后，随每次请求的 tools 字段发送）=====\n\n' + JSON.stringify(tools, null, 2),
  ];
  for (const name of Object.keys(cfg.model_profiles || {})) {
    const pTools = engine.effectiveTools(name);
    parts.push(
      '\n\n# ===== profile "' + name + '" =====\n\n' +
      '# --- system prompt ---\n\n' + llm.systemPromptText(lang, name) +
      '\n\n# --- tools（allow/deny 过滤后 ' + pTools.length + ' / 原始全量 ' + allCount + ' 个）---\n\n' + JSON.stringify(pTools, null, 2)
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, parts.join(''), 'utf8');
  log.info('startup', '  prompt_dump=' + file + ' (tools=' + tools.length + '/' + allCount +
    ', profiles=' + (Object.keys(cfg.model_profiles || {}).join(',') || '-') + ')');
}

// 启动时先发现各 MCP 服务的工具（单个服务失败只警告，不阻止启动），
// 并对技能列表做快照（注入 system prompt，见 llm.setSkillListText），完成后开始监听。
mcp.init(cfg).then(async () => {
  // 技能列表快照：模型直接感知已有技能，免先 skill op=list 探索；
  // 此处失败不阻塞启动，skill op=list 仍可做实时兑底。
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
      log.info('startup', '  wxbot=' + (cfg.wxbot.url && cfg.wxbot.token ? cfg.wxbot.url : '(未启用)'));
      log.info('startup', '  log_level=' + cfg.log_level);
      // 微信实例恢复 fire-and-forget：wxbot 没起只留日志，绝不阻塞/抛错影响启动。
      wechat.restore().catch(e => log.warn('wechat', '启动恢复异常：' + (e && e.message || e)));
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
// stop_grace_period（默认 10s）后被 SIGKILL。scheduler 的 timer 已 unref，
// 退出只需收掉监听与 SSE 长连接。
function shutdown(sig) {
  log.info('shutdown', '收到 ' + sig + '，停止服务');
  bus.closeAllSessions(); // 给前端干净的流结束（走重连/回放），而不是 TCP reset
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // 关不掉的连接 3s 后兑底硬退
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
