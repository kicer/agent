// 入口：装配配置、数据库、SSE 总线、路由与静态资源。
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { loadConfig } = require('./config');
const { initDb } = require('./db');
const { createBus } = require('./sse');
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

// 可选 basic auth（若前置 nginx 已做，可不启用）
if (cfg.auth && cfg.auth.user) {
  const expected = 'Basic ' + Buffer.From(cfg.auth.user + ':' + cfg.auth.password).toString('base64');
  app.use((req, res, next) => {
    if (req.headers.authorization === expected) return next();
    res.set('WWW-Authenticate', 'Basic realm="agent"');
    res.status(401).end('需要认证');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/sessions', require('./routes/messages'));
app.use('/api/sessions', require('./routes/files'));

// 模型池状态（前端可展示空闲/占用）
app.get('/api/models', (req, res) => {
  res.json(db.prepare('SELECT id, display_name, is_busy, current_session_id FROM model_pool ORDER BY id').all());
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
  });
});
