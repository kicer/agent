// 集成测试：core 的 terminal 工具 / runSkill 走远端 executor（同机起 executor 于 19000）。
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..'); // agent 仓库根
const TMP = path.join(ROOT, 'app/test/tmp/remote-exec');
const TASK = path.join(TMP, 'task');
const SKILLS = path.join(TMP, 'skills');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TASK, { recursive: true });
fs.mkdirSync(path.join(SKILLS, 'echo'), { recursive: true });
fs.writeFileSync(path.join(SKILLS, 'echo/SKILL.md'), '---\ndescription: 回显参数\n---\n回显\n');
fs.writeFileSync(path.join(SKILLS, 'echo/run.sh'), '#!/bin/sh\necho "payload=$1"\necho "pp=$PYTHONPATH"\n');

// 1) executor 服务进程内启动
process.env.PORT = '19000';
process.env.EXECUTOR_ROOTS = TMP;
process.env.EXECUTOR_CWD = TASK;
delete process.env.EXECUTOR_URL; delete process.env.EXECUTOR_TOKEN;
require(path.join(ROOT, 'executor/server.js'));

// 2) core 侧模块
const { loadConfigFromText } = require(path.join(ROOT, 'app/server/config'));
const toolExec = require(path.join(ROOT, 'app/server/tools/executor'));
const skills = require(path.join(ROOT, 'app/server/tools/skills'));

const yml = (extra) => 'platforms:\n  - url: https://a.com/v1\n    keys:\n      - models:\n          - id: m1\nexecutor:\n  url: "http://127.0.0.1:19000"\n' + extra;
function mkCtx(cfgExtra) {
  const cfg = loadConfigFromText(yml(cfgExtra), '');
  return { cfg, taskDir: TASK, run: { cancelled: false, procs: new Set(), abortController: null, looping: false } };
}
let failed = 0;
const check = (n, c, e) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (c || !e ? '' : '  → ' + e)); if (!c) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await sleep(200);

  // --- terminal：基本输出 / 退出码 / 文件落在共享目录 ---
  let ctx = mkCtx('');
  check('executor.url 生效', ctx.cfg.executor.url === 'http://127.0.0.1:19000', ctx.cfg.executor.url);
  let r = await toolExec.executeTool(ctx, 'terminal', { command: 'echo 远程ok; pwd; echo data > out.txt' });
  check('输出含远端结果', r.includes('远程ok') && r.includes(TASK) && r.includes('[exit code: 0]'), r);
  check('文件写入共享目录', fs.existsSync(path.join(TASK, 'out.txt')));

  // --- 非零退出码 ---
  r = await toolExec.executeTool(ctx, 'terminal', { command: 'exit 7' });
  check('退出码透传', r.includes('[exit code: 7]'), r);

  // --- head_lines 选段 ---
  r = await toolExec.executeTool(ctx, 'terminal', { command: 'printf "l1\\nl2\\nl3\\n"', head_lines: 1 });
  check('head_lines 生效', r.startsWith('l1\n[exit code: 0]'), JSON.stringify(r));

  // --- 超时 ---
  const t0 = Date.now();
  r = await toolExec.executeTool(ctx, 'terminal', { command: 'sleep 20', timeout_ms: 800 });
  check('远端超时文案', r.includes('命令超时 800ms'), r);
  check('超时耗时受控(<5s)', Date.now() - t0 < 5000, (Date.now() - t0) + 'ms');

  // --- 取消：模拟 engine 轮询/stop ---
  ctx = mkCtx('');
  const p = toolExec.executeTool(ctx, 'terminal', { command: 'sleep 20', timeout_ms: 15000 });
  await sleep(400);
  check('运行中注册 procs 句柄', ctx.run.procs.size === 1, ctx.run.procs.size);
  // 同 engine.killRunProcs 对新句柄的处理（proc.remoteKill）：
  for (const proc of ctx.run.procs) if (typeof proc.remoteKill === 'function') proc.remoteKill();
  r = await p;
  check('取消后返回且文案一致', r.includes('用户终止任务'), r);
  check('取消后 procs 清空', ctx.run.procs.size === 0);
  const h = await (await fetch('http://127.0.0.1:19000/health')).json();
  check('executor 无残留进程', h.running.length === 0, JSON.stringify(h.running));

  // --- runSkill：入口脚本 + JSON payload 引号 + PYTHONPATH ---
  ctx = mkCtx('skills:\n  skills_root: "' + SKILLS + '"\n');
  const msg = "带 空格 和'单引号' 与\"双引号\"及中文";
  let sr = await skills.runSkill(ctx, 'echo', { msg });
  const want = 'payload=' + JSON.stringify({ msg });
  check('runSkill 远端执行成功', sr.includes(want), sr);
  check('PYTHONPATH 指向共享 deps', sr.includes('pp=' + path.join(SKILLS, 'deps')), sr);

  // --- 传输失败：executor 不可达 ---
  const ymlBad = 'platforms:\n  - url: https://a.com/v1\n    keys:\n      - models:\n          - id: m1\nexecutor:\n  url: "http://127.0.0.1:19999"\n';
  const cfgBad = loadConfigFromText(ymlBad, '');
  const ctxBad = { cfg: cfgBad, taskDir: TASK, run: { cancelled: false, procs: new Set(), abortController: null, looping: false } };
  let threw = '';
  try { await toolExec.executeTool(ctxBad, 'terminal', { command: 'echo x' }); } catch (e) { threw = e.message; }
  check('不可达时报错而非静默', threw.includes('executor 调用失败'), threw);

  // --- env 兜底：YAML 不配 url，靠 EXECUTOR_URL ---
  process.env.EXECUTOR_URL = 'http://127.0.0.1:19000/';
  const cfgEnv = loadConfigFromText('platforms:\n  - url: https://a.com/v1\n    keys:\n      - models:\n          - id: m1\n', '');
  check('EXECUTOR_URL env 兜底+去尾斜杠', cfgEnv.executor.url === 'http://127.0.0.1:19000', cfgEnv.executor.url);

  console.log(failed ? '\n' + failed + ' 项失败' : '\n全部通过');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
