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
const mcp = require('./mcp');

const cfg = loadConfig(process.env.AGENT_CONFIG);
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
app.use('/api/system', require('./routes/system'));

// 模型池状态（前端可展示空闲/占用）+ 每模型 token 用量（今日/累计）
app.get('/api/models', (req, res) => {
  const rows = db.prepare('SELECT id, display_name, is_busy, current_session_id FROM model_pool ORDER BY id').all();
  const stats = engine.modelUsageStats();
  for (const r of rows) {
    const s = stats[r.id] || { today_tokens: 0, total_tokens: 0 };
    r.today_tokens = s.today_tokens;
    r.total_tokens = s.total_tokens;
  }
  res.json(rows);
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

const PORT = process.env.PORT || cfg.port;

// 启动时先发现各 MCP 服务的工具（单个服务失败只警告，不阻止启动），发现完成后再开始监听。
mcp.init(cfg).then(() => {
  server.listen(PORT, () => {
    console.log('Agent server listening on ' + PORT);
    console.log('  workspace_root=' + cfg.workspace_root);
    console.log('  models=' + cfg.models.map(m => m.id + '@' + m.url).join(', '));
    const mcpList = (cfg.mcp_servers || []).map(s => s.name + '@' + s.url).join(', ');
    console.log('  mcp_servers=' + (mcpList || '(none)'));
    console.log('  auth=' + (auth.enabled ? 'login (' + cfg.auth.users.map(u => u.user).join(', ') + ')' : '(disabled)'));
  });
});
