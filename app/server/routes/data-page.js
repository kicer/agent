// data-page 技能的服务端承载，两条通道（配套 skills/data-page/SKILL.md 的契约）：
// 1. GET  /app/{task_id}/...      —— 静态托管任务目录的 .app/ 子树（index.html 兑底，不给列目录）；
//                                    目录名刻意带点：任务文件面板默认隐藏（?hidden=1 才列）；
//                                    只暴露 .app/ 而非整个任务目录，其余任务文件不从 URL 泄漏；
//                                    允许符号链接（技能页面链回技能目录，不必每会话复制），
//                                    但 realpath 必须落在会话目录或技能根目录内。
// 2. POST /api/db/{task_id}/query —— 任务 data.db 的 SQL API（页面前端 fetch 调）：任意单语句，
//                                    执行核心与 db 工具共用 runTaskSql（executor.js），语义单一事实源。
// 认证：挂在 server.js 的 auth.middleware 之后——信任模型与 files 路由一致（登录 ≈ 运维，可跨会话）。
// 刻意不加任何 CORS 头：跨站 application/json POST 会被预检挡下，不带 cookie 的匿名页也调不动。
// 响应契约（SKILL.md 原文）：SELECT→行数组；写→{rowsAffected,lastInsertRowid}；DDL→{ok:true}；
// 失败→HTTP 200 + {error}（前端统一查 error 字段）。会话/路径级错误才用 4xx。
const express = require('express');
const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const { resolveInTask, runTaskSql } = require('../tools/executor');
const { skillsRoot } = require('../tools/skills');

// 页面忘写 LIMIT 的服务端兜底：iterate 到量即停（不全量物化），超限报错引导分页。
const API_MAX_ROWS = 2000;

const router = express.Router();

function notFound(res, msg) {
  res.status(404).json({ error: msg });
}

// 符号链接白名单：技能页面不必每个会话复制一份，发布时链回技能目录（见各技能的 run.py）。
// 链接只是字符串：executor 里看不到的目标也能被链上，而解析发生在 core 的命名空间
// （例如 core 把 ./config.yml 挂在 /app/config.yml），所以 realpath 后必须落在
// 「本会话目录」或「技能根目录」内，其余一律 404。
function realInside(abs, roots) {
  let real;
  try { real = fs.realpathSync(abs); } catch (_) { return null; }
  for (const root of roots) {
    if (real === root || real.startsWith(root + path.sep)) return real;
  }
  return null;
}

// ---------- /app/{task_id}/...：任务 .app/ 子树静态托管（URL 路径与目录名解耦）----------
router.use('/app', (req, res) => {
  try {
    const segs = req.path.replace(/^\/+/, '').split('/');
    const sessionId = segs[0];
    if (!sessionId) return notFound(res, '会话不存在');
    if (!engine.getSession(sessionId)) return notFound(res, '会话不存在');
    const appRoot = path.join(engine.taskDirOf(sessionId), '.app');
    let abs;
    try {
      abs = resolveInTask(appRoot, segs.slice(1).join('/') || 'index.html'); // 越界即挡，限 .app/ 子树
    } catch (_) {
      return notFound(res, '非法路径');
    }
    let st;
    try { st = fs.statSync(abs); } catch (_) { return notFound(res, '页面不存在'); }
    if (st.isDirectory()) {
      abs = path.join(abs, 'index.html'); // 目录请求补 index.html，仍无则 404
      try { st = fs.statSync(abs); } catch (_) { return notFound(res, '页面不存在'); }
    }
    if (!st.isFile()) return notFound(res, '页面不存在');
    const candidates = [engine.taskDirOf(sessionId)];
    try { candidates.push(skillsRoot({ cfg: engine.getConfig() })); } catch (_) {}
    const roots = [];
    for (const dir of candidates) {
      try { roots.push(fs.realpathSync(dir)); } catch (_) {}
    }
    const real = realInside(abs, roots);
    if (!real) return notFound(res, '页面不存在');
    res.sendFile(real, err => {
      if (err && !res.headersSent) notFound(res, '页面不存在');
    });
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: (err && err.message) || String(err) });
  }
});

// ---------- POST /api/db/{task_id}/query：任务 data.db 的 SQL API ----------
router.post('/api/db/:id/query', (req, res) => {
  if (!engine.getSession(req.params.id)) return notFound(res, '会话不存在');
  const body = req.body || {};
  let r;
  try {
    r = runTaskSql(engine.taskDirOf(req.params.id), String(body.sql || ''), body.params, 'any', API_MAX_ROWS);
  } catch (err) {
    // SQL 语义错误走 200 + {error}（SKILL.md 契约：前端只查 error 字段，不分状态码）
    return res.json({ error: (err && err.message) || String(err) });
  }
  if (r.kind === 'read') {
    if (r.overflow) return res.json({ error: '结果超过 ' + API_MAX_ROWS + ' 行，请加 LIMIT/OFFSET 分页' });
    return res.json(r.rows);
  }
  return res.json(r.out);
});

module.exports = router;
