// 系统状态与优雅重启(2.0 阶段 2)。
// 重启机制:确认 config.yml 仍能通过启动校验 → process.exit(0) → Docker 按
// restart 策略(unless-stopped)自动拉起。不依赖 docker.sock、无需提权。
// 非 docker 运行(如 npm start)时进程直接退出,不会自动重启,需自行启动。
const express = require('express');
const engine = require('../engine');
const { loadConfig } = require('../config');
const versionInfo = require('../version');

const router = express.Router();

const STARTED_AT = Date.now();
let VERSION = '2.0.0';
try { VERSION = require('../../package.json').version || VERSION; } catch (_) {}
// git 提交号单独返回(提交时 post-commit 钩子自动生成),前端只显示简洁版本号
const VERSION_COMMIT = versionInfo.commit || '';

function sendErr(res, err) {
  const code = err && err.status_code || 500;
  res.status(code).json({ error: String(err && err.message || err) });
}
function wrap(fn) {
  return function (req, res) {
    try { fn(req, res); } catch (err) { sendErr(res, err); }
  };
}

// 运行状态:设置页展示 + 前端重启后轮询等待恢复
router.get('/status', wrap((req, res) => {
  const cfg = engine.getConfig();
  res.json({
    ok: true,
    version: VERSION,
    version_commit: VERSION_COMMIT,
    version_date: versionInfo.date,
    pid: process.pid,
    node: process.version,
    started_at: STARTED_AT,
    uptime_ms: Date.now() - STARTED_AT,
    config_path: cfg.config_path || '',
    workspace_root: cfg.workspace_root,
    skills_root: cfg.skills_root,
    db_path: cfg.db_path,
    port: cfg.port,
    auth_enabled: !!(cfg.auth && cfg.auth.users && cfg.auth.users.length),
    running_sessions: engine.activeRuns(),
  });
}));

// 优雅重启:有 AI 回合执行中时默认 409 拒绝(force=true 才打断)。
router.post('/restart', wrap((req, res) => {
  const cfg = engine.getConfig();
  const force = req.query.force === 'true' || !!(req.body && req.body.force);
  const running = engine.activeRuns();
  if (running.length && !force) {
    return res.status(409).json({
      error: '有 ' + running.length + ' 个任务会话执行中,重启将打断它们',
      running_sessions: running,
    });
  }
  // 防重启崩溃循环:文件可能被容器外改成不合法,那样新进程将起不来,先拒绝重启
  try { loadConfig(cfg.config_path); } catch (e) {
    return res.status(409).json({ error: '配置文件当前内容不合法,重启将无法启动:' + String(e && e.message || e) });
  }
  console.log('[system] 收到重启请求(force=' + force + ',打断 ' + running.length + ' 个回合),进程退出,等待 Docker 拉起');
  res.json({ ok: true, restarting: true });
  // 稍候再退出,确保响应已发出;容器由 Docker restart 策略自动重启
  setTimeout(() => process.exit(0), 300);
}));

module.exports = router;
