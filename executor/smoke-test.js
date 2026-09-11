// agent-executor 冒烟测试：node smoke-test.js（在本目录执行）。
// 覆盖：/health、/exec 流式输出与退出事件、增量下发时序、cwd 白名单拒绝、任务根边界（缺省/恰为任务根 → 400）、DELETE 取消、EXECUTOR_TOKEN 鉴权与子进程 env 剥除、per-task 挂载隔离（含 nsenter /proc/1 逃逸回归、WORKDIR 源码遮蔽）、客户端半路断连不击穿服务。
// 注意：隔离用例需 root/CAP_SYS_ADMIN（unshare+mount），无权限时自动 SKIP 不计失败；其余用例 cwd 故意取任务根外目录，保持非隔离路径可在无权限环境跑。
process.env.PORT = process.env.PORT || '19000';
const SELF = process.env.__SELF_DIR__ || __dirname; // 宿主机测试：白名单取本目录
process.env.EXECUTOR_ROOTS = SELF;
// 任务根改用专用子目录（不建在任务根下）：主套命令的 cwd 传 SELF（任务根外 → 不进 wrapper），
// 同时留出「cwd=任务根 → 400」的可测边界。
const TASK_ROOT = SELF + '/.taskroot';
require('fs').mkdirSync(TASK_ROOT, { recursive: true });
process.env.EXECUTOR_CWD = TASK_ROOT;
delete process.env.EXECUTOR_TOKEN; // 主实例不带 token，鉴权单独测
process.env.EXECUTOR_ALLOW_LOCAL_ORIGIN = '1'; // 本机集成测试：连接必为回环，放行自身来源（生产不设）

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
require('./server.js');

const BASE = 'http://127.0.0.1:' + process.env.PORT;
let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond || !extra ? '' : '  → ' + extra));
  if (!cond) failed++;
}

// 把 SSE 响应解析成事件对象异步流
async function* sse(res) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const msg = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of msg.split('\n')) {
        if (line.startsWith('data: ')) yield JSON.parse(line.slice(6));
      }
    }
  }
}
async function collect(res) { const evs = []; for await (const e of sse(res)) evs.push(e); return evs; }

async function main() {
  // 1. health
  const h = await (await fetch(BASE + '/health')).json();
  check('GET /health', h.ok === true);

  // 2. 基本执行：stdout/stderr/exit，且增量分块下发（a 与 b 之间 sleep，验证非攒到最后）
  const t0 = Date.now();
  const r2 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo a; sleep 0.6; echo b; echo e1 >&2; exit 3', cwd: SELF }) });
  const evs2 = [];
  const marks = [];
  for await (const e of sse(r2)) { evs2.push(e); if (e.type === 'out') marks.push(Date.now() - t0); }
  check('POST /exec start 事件', evs2[0] && evs2[0].type === 'start' && evs2[0].pid > 0);
  check('stdout 增量两条', evs2.filter(e => e.type === 'out').length === 2, JSON.stringify(evs2));
  check('间隔体现流式(>300ms)', marks.length === 2 && marks[1] - marks[0] > 300, 'marks=' + marks);
  check('stderr 事件', evs2.some(e => e.type === 'err' && e.chunk.trim() === 'e1'));
  const exit2 = evs2[evs2.length - 1];
  check('exit 事件带退出码 3', exit2 && exit2.type === 'exit' && exit2.code === 3, JSON.stringify(exit2));

  // 3. cwd 白名单：/etc 必须拒绝
  const r3 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'pwd', cwd: '/etc' }) });
  check('cwd 越权 400', r3.status === 400, 'status=' + r3.status);

  // 3.5 任务根边界：缺省 cwd（落任务根）与显式 cwd=任务根都必须 400——任务根是全部会话目录的父目录，放行会绕过隔离。
  const rb1 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo hi' }) });
  check('cwd 缺省（落任务根）400', rb1.status === 400, 'status=' + rb1.status);
  const rb2 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo hi', cwd: TASK_ROOT }) });
  check('cwd=任务根本身 400', rb2.status === 400, 'status=' + rb2.status);

  // 4. 取消：sleep 30 启动后立即 DELETE
  const r4 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'sleep 30', cwd: SELF }) });
  let id4 = null; const evs4 = [];
  for await (const e of sse(r4)) { evs4.push(e); if (e.type === 'start' && !id4) { id4 = e.id; const k = await fetch(BASE + '/exec/' + id4, { method: 'DELETE' }); check('DELETE /exec/:id 返回 ok', (await k.json()).ok === true); } }
  const exit4 = evs4[evs4.length - 1];
  check('取消后 exit killed_by=cancelled', exit4 && exit4.type === 'exit' && exit4.killed_by === 'cancelled', JSON.stringify(exit4));

  // 5. 超时自杀
  const t5 = Date.now();
  const r5 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'sleep 30', timeout_ms: 600, cwd: SELF }) });
  const evs5 = await collect(r5);
  const exit5 = evs5[evs5.length - 1];
  check('超时 killed_by=timeout', exit5 && exit5.killed_by === 'timeout', JSON.stringify(exit5));
  check('超时耗时接近设定值', Date.now() - t5 < 3000, (Date.now() - t5) + 'ms');

  // 6. 输出截断
  const r6 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'printf x%.0s $(seq 1 500); echo', max_output_chars: 100, cwd: SELF }) });
  const evs6 = await collect(r6);
  const outChars = evs6.filter(e => e.type === 'out').reduce((s, e) => s + e.chunk.length, 0);
  const exit6 = evs6[evs6.length - 1];
  check('输出按 max_output_chars 截断', outChars <= 100 && exit6.truncated === true, 'chars=' + outChars + ' exit=' + JSON.stringify(exit6));

  // 7. 客户端半路断连：持续小输出中 abort 掉 SSE 连接，服务不能崩（write-after-destroy 回归护栏）。
  const ac7 = new AbortController();
  const r7 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac7.signal, body: JSON.stringify({ command: 'while :; do echo x; sleep 0.05; done', cwd: SELF }) });
  for await (const e of sse(r7)) { if (e.type === 'start') break; }
  await new Promise(r => setTimeout(r, 300)); // 让服务端先下发若干 out 帧
  ac7.abort();
  await new Promise(r => setTimeout(r, 800)); // 留给服务端 close→杀进程→finish 走完
  check('客户端半路断连不击穿服务（/health 仍 200）', (await fetch(BASE + '/health')).status === 200);

  // 7.5 per-task 挂载隔离：另起一个实例（端口 19002），任务根放系统 tmp（与 server 代码目录分离，
  // 使 WORKDIR 遮蔽分支真实生效），下放 iso-a / iso-b 两个「会话」目录；cwd 取 iso-a 的深层子目录（模拟 terminal 的 cd），验证：
  //   任务根下只看到 iso-a、cd 兄弟会话被拒、自己文件可读；另验 nsenter /proc/1 逃逸封堵、/proc/sys 只读、
  //   WORKDIR 内 server.js 不可读；及 wrapper 内（新 pid ns、命令即 PID 1）超时杀进程语义；无 mount 权限时整组 SKIP。
  const isoRoot = path.join(require('os').tmpdir(), '.ex-smoke-iso');
  fs.rmSync(isoRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(isoRoot, 'iso-a', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(isoRoot, 'iso-b'), { recursive: true });
  fs.writeFileSync(path.join(isoRoot, 'iso-a', 'a.txt'), 'a');
  fs.writeFileSync(path.join(isoRoot, 'iso-b', 'b.txt'), 'b');
  const isoChild = spawn(process.execPath, [__dirname + '/server.js'], { env: Object.assign({}, process.env, { PORT: '19002', EXECUTOR_ROOTS: isoRoot, EXECUTOR_CWD: isoRoot }), stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));
  const isoCwd = path.join(isoRoot, 'iso-a', 'deep');
  // 分隔符切段便于精确断言；cd 失败信息不走 stderr 上送（含 iso-b 字样会污染 ls 段断言），改用 leaked/blocked 标记区分。
  const evsI = await collect(await fetch('http://127.0.0.1:19002/exec', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'pwd; echo @LS@; ls ../../; echo @CD@; cd ../../iso-b 2>/dev/null && echo leaked || echo blocked; echo @CAT@; cat ../../iso-a/a.txt; echo; echo @NS@; nsenter --mount=/proc/1/ns/mnt ls ' + isoRoot + ' 2>&1; echo @SYS@; echo 1 > /proc/sys/kernel/panic 2>/dev/null && echo sysctl_writable || echo sysctl_ro; echo @APP@; test -f ' + __dirname + '/server.js && echo server_visible || echo server_hidden', cwd: isoCwd, timeout_ms: 5000 }),
  }));
  const outI = evsI.filter(e => e.type === 'out' || e.type === 'err').map(e => e.chunk).join('');
  const exitI = evsI[evsI.length - 1];
  if (!exitI || exitI.code !== 0) {
    console.log('SKIP  per-task 挂载隔离（需 root/CAP_SYS_ADMIN；exit=' + (exitI && exitI.code) + '）');
  } else {
    const lsRegion = outI.split('@LS@')[1].split('@CD@')[0];
    check('隔离: 任务根只见 iso-a', /iso-a/.test(lsRegion) && !/iso-b/.test(lsRegion), 'ls=' + JSON.stringify(lsRegion));
    check('隔离: cd 兄弟会话被拒', /blocked/.test(outI) && !/leaked/.test(outI), 'out=' + JSON.stringify(outI));
    // cat 成功只回显文件内容（a），不含文件名；取 @CAT@…@NS@ 段精确比对。
    check('隔离: 深子目录 pwd 不丢 + 自己文件可读', outI.includes(isoCwd) && outI.split('@CAT@')[1].split('@NS@')[0].trim() === 'a', 'out=' + JSON.stringify(outI));
    // 逃逸回归：/proc/1 已是本 pid ns 的命令自身，借它 nsenter 只能进同一个隔离 ns，看不到 iso-b。
    // 必须绝对路径：nsenter 进 mount ns 后会 chdir("/")，相对路径在新 ns 根下解析会失真。
    const nsRegion = outI.split('@NS@')[1].split('@SYS@')[0];
    check('逃逸: nsenter /proc/1 后仍只见 iso-a', /iso-a/.test(nsRegion) && !/iso-b/.test(nsRegion), 'ns=' + JSON.stringify(nsRegion));
    // 重挂的 proc 必须还原 docker 的 /proc/sys 只读防护（否则 kernel.core_pattern 可写 → 宿主逃逸面）。
    check('逃逸: 新 proc 下 /proc/sys 仍只读', /sysctl_ro/.test(outI) && !/sysctl_writable/.test(outI), 'out=' + JSON.stringify(outI));
    // WORKDIR 遮蔽：iso 实例任务根在系统 tmp，与 server 代码目录不嵌套 → tmpfs 遮蔽分支生效，server.js 不可读。
    check('遮蔽: WORKDIR 内 server.js 不可读', /server_hidden/.test(outI) && !/server_visible/.test(outI), 'out=' + JSON.stringify(outI));
    // wrapper 内超时杀进程：命令已是新 pid ns 的 PID 1，验证杀进程组/超时对 PID 1 同样有效。
    const evsTK = await collect(await fetch('http://127.0.0.1:19002/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'sleep 30', cwd: isoCwd, timeout_ms: 600 }),
    }));
    const exitTK = evsTK[evsTK.length - 1];
    check('隔离: wrapper 内超时杀进程（PID 1 语义）', exitTK && exitTK.killed_by === 'timeout', JSON.stringify(exitTK));
  }
  isoChild.kill('SIGKILL');
  fs.rmSync(isoRoot, { recursive: true, force: true });

  // 8. token 鉴权：另起一个带 EXECUTOR_TOKEN 的实例（子进程，端口 19001）

  // 8. token 鉴权：另起一个带 EXECUTOR_TOKEN 的实例（子进程，端口 19001）
  const child = spawn(process.execPath, [__dirname + '/server.js'], { env: Object.assign({}, process.env, { PORT: '19001', EXECUTOR_TOKEN: 't9' }), stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));
  const noTok = await fetch('http://127.0.0.1:19001/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo hi', cwd: SELF }) });
  check('无 token 401', noTok.status === 401, 'status=' + noTok.status);
  const healthNoTok = await fetch('http://127.0.0.1:19001/health');
  check('带 token 时 /health 仍免鉴权', healthNoTok.status === 200);
  const withTok = await fetch('http://127.0.0.1:19001/exec', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t9' }, body: JSON.stringify({ command: "env | grep -q 'EXECUTOR_TOKEN=' && echo token_leak || echo token_absent", cwd: SELF }) });
  const evs8 = await collect(withTok);
  // 带 token 请求本身正常，且子进程 env 已剥除 EXECUTOR_TOKEN（否则命令里 dump env 就能拿 token 回环绕隔离）。
  check('带 token 正常执行且子进程 env 已剥 EXECUTOR_TOKEN', evs8.some(e => e.type === 'out' && e.chunk.includes('token_absent')) && !evs8.some(e => (e.chunk || '').includes('token_leak')), JSON.stringify(evs8));
  child.kill('SIGKILL');
  fs.rmSync(TASK_ROOT, { recursive: true, force: true });

  console.log(failed ? '\n' + failed + ' 项失败' : '\n全部通过');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
