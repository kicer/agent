// 系统状态与优雅重启(2.0 阶段 2)。
// 重启机制:确认 config.yml 仍能通过启动校验 → process.exit(0) → Docker 按
// restart 策略(unless-stopped)自动拉起。不依赖 docker.sock、无需提权。
// 非 docker 运行(如 npm start)时进程直接退出,不会自动重启,需自行启动。
const express = require('express');
const fs = require('fs');
const os = require('os');
const engine = require('../engine');
const { loadConfig } = require('../config');
const versionInfo = require('../version');
const log = require('../log');

const router = express.Router();

const STARTED_AT = Date.now();
// 版本以本文件字面量为准：容器部署只挂载 app/server，镜像里的 package.json 可能是旧的，
// 读它会一直显示发版时的版本号（之前 2.1.0 改完仍显 2.0.0 即此因）。发版时记得同步这里。
const VERSION = '2.3.0';
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

// ---------- 运行负载采集 ----------
// 内存读 /proc/meminfo（主机口径，容器内同样可见）；CPU 配额优先读 cgroup 拿本容器自己的限制。
function readCgroup(...paths) {
  for (const p of paths) {
    try { const s = fs.readFileSync(p, 'utf8').trim(); if (s) return s; } catch (_) {}
  }
  return null;
}
function collectMem() {
  // 「空闲内存」用 MemAvailable（含可回收 cache，符合直觉且贴近能用多少），
  // 而非 MemFree/cgroup 配额减法：后者会把容器视角的几百 MB 空闲误报成上 GB。
  // 读不到 /proc/meminfo（如 mac 本地调试）退回 os.*。
  let total = null, avail = null;
  try {
    const t = fs.readFileSync('/proc/meminfo', 'utf8');
    const mt = t.match(/MemTotal:\s+(\d+)\s*kB/);
    const ma = t.match(/MemAvailable:\s+(\d+)\s*kB/);
    if (mt) total = parseInt(mt[1], 10) * 1024;
    if (ma) avail = parseInt(ma[1], 10) * 1024;
  } catch (_) {}
  return {
    total_bytes: total || os.totalmem(),
    avail_bytes: avail != null ? avail : os.freemem(),
    rss_bytes: process.memoryUsage.rss(), // 本进程占用，供判断大头是不是自己
  };
}
function collectCpu() {
  let quota = null; // 配额换算核数（docker --cpus）；无限制为 null
  const v2 = readCgroup('/sys/fs/cgroup/cpu.max'); // "<quota> <period>" 或 "max <period>"
  if (v2 != null) {
    const [q, p] = v2.split(/\s+/);
    if (q && q !== 'max') {
      const qq = parseInt(q, 10), pp = parseInt(p, 10);
      if (qq > 0 && pp > 0) quota = qq / pp;
    }
  } else {
    const q = parseInt(readCgroup('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') || '', 10);
    const p = parseInt(readCgroup('/sys/fs/cgroup/cpu/cpu.cfs_period_us') || '', 10);
    if (q > 0 && p > 0) quota = q / p;
  }
  const load = os.loadavg();
  const r2 = v => Math.round(v * 100) / 100;
  return { cores: os.cpus().length, quota_cores: quota != null ? r2(quota) : null, load1: r2(load[0]), load5: r2(load[1]), load15: r2(load[2]) };
}
// 数据盘容量（只统计 data_root：tasks 与工作区同盘或关系不大，用户明确不要 tasks 行）；目录异常则返回空数组
function collectDisks(cfg) {
  const out = [];
  try {
    const s = fs.statfsSync(cfg.data_root);
    out.push({ path: cfg.data_root, total_bytes: s.blocks * s.bsize, free_bytes: s.bavail * s.bsize });
  } catch (_) {}
  return out;
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
    data_root: cfg.data_root,
    skills_root: cfg.skills_root,
    db_path: cfg.db_path,
    executor_url: (cfg.executor && cfg.executor.url) || '',
    port: cfg.port,
    // 服务器负载（设置页服务卡片）：内存/CPU 优先容器限额口径，磁盘为 data/workspace 所在盘
    sys: { mem: collectMem(), cpu: collectCpu(), disks: collectDisks(cfg) },
    auth_enabled: !!(cfg.auth && cfg.auth.users && cfg.auth.users.length),
    running_sessions: engine.activeRuns(),
    // 曾有的 model_profiles 可用名单字段已删：前端手动切换模式入口全部移除，名单再无消费方
    //（组合只经模型配置 profile: <名> 引用，见 engine.resolveProfileName）。
    // 前端上传预处理参数（大图压缩阈值/尺寸/质量、大文件确认阈值），避免前端写死
    upload: cfg.upload || {},
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
  log.info('system', '收到重启请求(force=' + force + ',打断 ' + running.length + ' 个回合),进程退出,等待 Docker 拉起');
  res.json({ ok: true, restarting: true });
  // 稍候再退出,确保响应已发出;容器由 Docker restart 策略自动重启
  setTimeout(() => process.exit(0), 300);
}));

module.exports = router;
