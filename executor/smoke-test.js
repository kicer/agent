// agent-executor 冒烟测试：node smoke-test.js（在本目录执行）。
// 覆盖：/health、/exec 流式输出与退出事件、增量下发时序、cwd 白名单拒绝、DELETE 取消、EXECUTOR_TOKEN 鉴权。
process.env.PORT = process.env.PORT || '19000';
process.env.EXECUTOR_ROOTS = process.env.__SELF_DIR__ || __dirname; // 宿主机测试：白名单取本目录
process.env.EXECUTOR_CWD = process.env.__SELF_DIR__ || __dirname;
delete process.env.EXECUTOR_TOKEN; // 主实例不带 token，鉴权单独测

const { spawn } = require('child_process');
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
  const r2 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo a; sleep 0.6; echo b; echo e1 >&2; exit 3' }) });
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

  // 4. 取消：sleep 30 启动后立即 DELETE
  const r4 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'sleep 30' }) });
  let id4 = null; const evs4 = [];
  for await (const e of sse(r4)) { evs4.push(e); if (e.type === 'start' && !id4) { id4 = e.id; const k = await fetch(BASE + '/exec/' + id4, { method: 'DELETE' }); check('DELETE /exec/:id 返回 ok', (await k.json()).ok === true); } }
  const exit4 = evs4[evs4.length - 1];
  check('取消后 exit killed_by=cancelled', exit4 && exit4.type === 'exit' && exit4.killed_by === 'cancelled', JSON.stringify(exit4));

  // 5. 超时自杀
  const t5 = Date.now();
  const r5 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'sleep 30', timeout_ms: 600 }) });
  const evs5 = await collect(r5);
  const exit5 = evs5[evs5.length - 1];
  check('超时 killed_by=timeout', exit5 && exit5.killed_by === 'timeout', JSON.stringify(exit5));
  check('超时耗时接近设定值', Date.now() - t5 < 3000, (Date.now() - t5) + 'ms');

  // 6. 输出截断
  const r6 = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'printf x%.0s $(seq 1 500); echo', max_output_chars: 100 }) });
  const evs6 = await collect(r6);
  const outChars = evs6.filter(e => e.type === 'out').reduce((s, e) => s + e.chunk.length, 0);
  const exit6 = evs6[evs6.length - 1];
  check('输出按 max_output_chars 截断', outChars <= 100 && exit6.truncated === true, 'chars=' + outChars + ' exit=' + JSON.stringify(exit6));

  // 7. 未知路由
  check('未知路由 404', (await fetch(BASE + '/nope')).status === 404);

  // 8. token 鉴权：另起一个带 EXECUTOR_TOKEN 的实例（子进程，端口 19001）
  const child = spawn(process.execPath, [__dirname + '/server.js'], { env: Object.assign({}, process.env, { PORT: '19001', EXECUTOR_TOKEN: 't9' }), stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));
  const noTok = await fetch('http://127.0.0.1:19001/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo hi' }) });
  check('无 token 401', noTok.status === 401, 'status=' + noTok.status);
  const healthNoTok = await fetch('http://127.0.0.1:19001/health');
  check('带 token 时 /health 仍免鉴权', healthNoTok.status === 200);
  const withTok = await fetch('http://127.0.0.1:19001/exec', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t9' }, body: JSON.stringify({ command: 'echo hi' }) });
  const evs8 = await collect(withTok);
  check('带 token 正常执行', evs8.some(e => e.type === 'out' && e.chunk.trim() === 'hi'), JSON.stringify(evs8));
  child.kill('SIGKILL');

  console.log(failed ? '\n' + failed + ' 项失败' : '\n全部通过');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
