// 通用技能执行面：POST /api/sessions/:id/skills/:name/run
//
// 与 /api/db 的定位对称：data-page 给了页面「通用数据面」，这里补上「通用执行面」。
// 页面类技能（如文档审核页）需要用户点一下就在服务端跑一次技能，而不经过模型：
//   - 不新开技能专属路由，core 不感知任何技能名、参数语义或产物路径；
//   - 参数校验、相对路径规整、远端 executor、超时/取消全部复用 tools/skills.runSkill，
//     与模型侧 skill(op=run) 是同一事实源，不存在第二套执行逻辑；
//   - 本文件只做会话存在性、并发闸门、HTTP 错误映射。
//
// 认证：挂在 server.js 的 auth.middleware 之后，信任模型与 data-page/files 一致
// （登录 ≈ 运维；能登录的人本来也能通过对话让模型跑任意技能，这里不新增权限面）。
// 刻意不加 CORS：跨站 application/json POST 会被预检挡下。
//
// 并发：同一 (session, skill) 同时只允许一个请求；页面重复点按钮得到 409 而不是双跑。
// 单实例内存 Set 即可（仓库整体就是单进程内存模型，重启即清空）。
//
// 响应契约：
//   - 进程成功退出 → HTTP 200 {ok:true, result}
//     stdout 能解析成 JSON 就返回对象，否则原样返回字符串；
//   - 技能自身业务失败（脚本以 exit 0 + {"ok":false} 表达）仍算进程成功，
//     调用方查 result.ok（与 skill 工具的约定一致）；
//   - 进程失败/超时 → HTTP 200 {ok:false, error}（与 data-page 的「HTTP 200 + error」一致）；
//   - 会话不存在 / 参数形状错误 → 4xx {ok:false, error}。
'use strict';
const express = require('express');
const engine = require('../engine');
const skills = require('../tools/skills');
const log = require('../log');

const router = express.Router();
const inflight = new Set();

function sendErr(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

router.post('/:id/skills/:name/run', async (req, res) => {
  const sessionId = req.params.id;
  const name = String(req.params.name || '').trim();
  if (!engine.getSession(sessionId)) return sendErr(res, 404, '会话不存在');
  if (!name) return sendErr(res, 400, '技能名不能为空');

  const body = req.body || {};
  const args = body.args === undefined ? {} : body.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return sendErr(res, 400, 'args 必须是 JSON 对象');
  }

  const key = sessionId + '\n' + name;
  if (inflight.has(key)) return sendErr(res, 409, '该技能正在执行，请稍候');
  inflight.add(key);
  const t0 = Date.now();
  try {
    const ctx = {
      sessionId,
      taskDir: engine.taskDirOf(sessionId),
      cfg: engine.getConfig(),
    };
    const out = await skills.runSkill(ctx, name, args);
    let result = out;
    try { result = JSON.parse(out); } catch (_) { /* 非 JSON 技能：原样返回字符串 */ }
    log.info('skills', sessionId + ' HTTP 运行 ' + name + ' 完成（' + (Date.now() - t0) + 'ms）');
    res.json({ ok: true, result });
  } catch (err) {
    const msg = String((err && err.message) || err || '技能执行失败');
    if (err && err.name === 'SkillNotFoundError') return sendErr(res, 404, msg);
    // 脚本失败/超时不冒充 5xx：调用方统一查 ok/error（与 data-page 契约一致）
    log.warn('skills', sessionId + ' HTTP 运行 ' + name + ' 失败（' + (Date.now() - t0) + 'ms）：' + msg.split('\n')[0]);
    res.json({ ok: false, error: msg });
  } finally {
    inflight.delete(key);
  }
});

module.exports = router;
