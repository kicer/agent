// 集成测试：core 的 terminal 工具 / runSkill 走远端 executor（同机起 executor 于 19000）。
// 需要 Linux + CAP_SYS_ADMIN：executor 隔离用 unshare/mount，macOS 上无法运行。
//
// 拓扑模拟两个容器共享同一份宿主机任务目录：
//   REAL (/ISO/<sid>)          —— 宿主机真实会话数据（等价 compose 的 ./tasks/<sid>）
//   VIRT (ROOTS/tasks/<sid>)   —— core 与 executor ns 里看到的虚拟会话路径
// session 模式下 wrapper 会遮 ROOTS/tasks 再把 REAL bind 到 VIRT，故断言写盘要查 REAL。
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..'); // agent 仓库根
const TMP = path.join(ROOT, 'app/test/tmp/remote-exec');
const ROOTS = path.join(TMP, 'ws');           // EXECUTOR_ROOTS
const TASKS = path.join(ROOTS, 'tasks');      // EXECUTOR_CWD（虚拟任务根）
const SKILLS = path.join(ROOTS, 'skills');
const SID = 'sess1';
const VIRT = path.join(TASKS, SID);           // core 侧会话目录（虚拟路径）
// ISOLATION_BASE 与 ROOTS 无父子关系；其父目录 MNTROOT 是独立目录，遮盖不会波及 ROOTS/系统 /tmp。
const ISOROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-exec-iso-'));
const ISO = path.join(ISOROOT, 'host-tasks');
const REAL = path.join(ISO, SID);             // 宿主机真实会话数据

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(VIRT, { recursive: true });
fs.mkdirSync(REAL, { recursive: true });
fs.mkdirSync(path.join(SKILLS, 'echo'), { recursive: true });
fs.writeFileSync(path.join(SKILLS, 'echo/SKILL.md'), '---\ndescription: 回显参数\n---\n回显\n');
fs.writeFileSync(path.join(SKILLS, 'echo/run.sh'), '#!/bin/sh\necho "payload=$1"\necho "pp=$PYTHONPATH"\n');
// 文件读写技能：验证技能进程在会话隔离视图里能按 absolutizeArgs 产出的绝对路径读/写会话数据。
fs.mkdirSync(path.join(SKILLS, 'fileio'), { recursive: true });
fs.writeFileSync(path.join(SKILLS, 'fileio/SKILL.md'), '---\ndescription: 文件读写\n---\n');
fs.writeFileSync(path.join(SKILLS, 'fileio/run.sh'),
  '#!/bin/sh\nPAYLOAD="$1" node -e \'const fs=require("fs");const a=JSON.parse(process.env.PAYLOAD);' +
  'fs.writeFileSync(a.output,fs.readFileSync(a.input,"utf8").toUpperCase());console.log("OK "+a.output);\'\n');

// 1) executor 服务进程内启动
process.env.PORT = '19000';
process.env.EXECUTOR_ROOTS = ROOTS;
process.env.EXECUTOR_CWD = TASKS;
process.env.EXECUTOR_ISOLATION_BASE = ISO;
process.env.EXECUTOR_SKILLS_DIR = SKILLS;
delete process.env.EXECUTOR_URL; delete process.env.EXECUTOR_TOKEN;
delete process.env.EXECUTOR_LOG_LEVEL;
// 本机集成测试：core 与 executor 同机，连接必为回环，需放行容器自身来源（生产不设）。
process.env.EXECUTOR_ALLOW_LOCAL_ORIGIN = '1';
require(path.join(ROOT, 'executor/server.js'));

// 2) core 侧模块
const { loadConfigFromText } = require(path.join(ROOT, 'app/server/config'));
const toolExec = require(path.join(ROOT, 'app/server/tools/executor'));
const skills = require(path.join(ROOT, 'app/server/tools/skills'));

const yml = (extra) => 'platforms:\n  - url: https://a.com/v1\n    keys:\n      - models:\n          - id: m1\nexecutor:\n  url: "http://127.0.0.1:19000"\n' + extra;
function mkCtx(cfgExtra) {
  const cfg = loadConfigFromText(yml(cfgExtra), '');
  return { cfg, sessionId: SID, taskDir: VIRT, run: { cancelled: false, procs: new Set(), abortController: null, looping: false } };
}
let failed = 0;
const check = (n, c, e) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (c || !e ? '' : '  → ' + e)); if (!c) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await sleep(200);

  // --- terminal：基本输出 / 退出码 / 文件落在真实会话目录（隔离视图写穿回宿主机）---
  let ctx = mkCtx('');
  check('executor.url 生效', ctx.cfg.executor.url === 'http://127.0.0.1:19000', ctx.cfg.executor.url);
  let r = await toolExec.executeTool(ctx, 'terminal', { command: 'echo 远程ok; pwd; echo data > out.txt' });
  check('输出含远端结果且 cwd 为虚拟会话路径', r.includes('远程ok') && r.includes(VIRT) && r.includes('[exit code: 0]'), r);
  check('文件写入真实会话目录', fs.existsSync(path.join(REAL, 'out.txt')));
  check('虚拟路径本身未被写穿（隔离生效）', !fs.existsSync(path.join(VIRT, 'out.txt')));

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

  // --- runSkill：入口脚本 + JSON payload 引号 + PYTHONPATH（cwd 落在会话目录）---
  ctx = mkCtx('skills:\n  skills_root: "' + SKILLS + '"\n');
  const msg = "带 空格 和'单引号' 与\"双引号\"及中文";
  let sr = await skills.runSkill(ctx, 'echo', { msg });
  const want = 'payload=' + JSON.stringify({ msg });
  check('runSkill 远端执行成功', sr.includes(want), sr);
  check('PYTHONPATH 指向共享 deps', sr.includes('pp=' + path.join(SKILLS, 'deps')), sr);

  // --- runSkill 文件读写：绝对路径在会话隔离视图里可用（修复的核心回归点）---
  fs.writeFileSync(path.join(REAL, 'in.txt'), 'hello');
  sr = await skills.runSkill(ctx, 'fileio', { input: 'in.txt', output: 'out.txt' });
  check('技能读到会话输入文件并成功执行', sr.includes('OK ' + path.join(VIRT, 'out.txt')), sr);
  check('技能输出写回真实会话目录且内容正确',
    fs.existsSync(path.join(REAL, 'out.txt')) && fs.readFileSync(path.join(REAL, 'out.txt'), 'utf8') === 'HELLO');

  // --- 传输失败：executor 不可达 ---
  const ymlBad = 'platforms:\n  - url: https://a.com/v1\n    keys:\n      - models:\n          - id: m1\nexecutor:\n  url: "http://127.0.0.1:19999"\n';
  const cfgBad = loadConfigFromText(ymlBad, '');
  const ctxBad = { cfg: cfgBad, sessionId: SID, taskDir: VIRT, run: { cancelled: false, procs: new Set(), abortController: null, looping: false } };
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
