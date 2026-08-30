// 端到端冒烟测试：mock 上游 + 真实 server。
// 覆盖：会话创建/绑定、普通对话、工具调用（write_file）、阶段开关、终止、排队调度、文件 API。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8099';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opt);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) throw new Error(method + ' ' + url + ' -> ' + res.status + ' ' + text.slice(0, 300));
  return json;
}

async function waitSession(id, predicate, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = await api('GET', '/api/sessions/' + id);
    if (predicate(d)) return d;
    await sleep(200);
  }
  throw new Error('等待超时: ' + label);
}

async function main() {
  // 清理旧数据
  fs.rmSync(path.join(ROOT, 'test/tmp'), { recursive: true, force: true });

  const mock = spawn('node', [path.join(ROOT, 'test/mock-upstream.js')], { stdio: 'inherit' });
  const server = spawn('node', [path.join(ROOT, 'server/server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { AGENT_CONFIG: path.join(ROOT, 'test/config.test.yaml') }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; process.stdout.write('[server] ' + d); });
  server.stderr.on('data', d => { serverLog += d; process.stdout.write('[server-err] ' + d); });

  try {
    // 等待健康
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(200);
      try { const h = await api('GET', '/api/health'); up = !!(h && h.ok); } catch (_) {}
    }
    ok(up, '服务器启动');

    // ---- . 普通对话 ----
    console.log('\n[1] 普通对话');
    let s = await api('POST', '/api/sessions', { title: '冒烟-对话' });
    ok(s && s.id && s.status, '创建会话 ' + (s && s.id));
    let d = await waitSession(s.id, x => x.session.status === 'active', 5000, '绑定模型');
    ok(d.session.model_id === 'ds1', '绑定第一个空闲模型 ds1', d.session.model_id);
    await api('POST', '/api/sessions/' + s.id + '/messages', { content: '你好呀' });
    d = await waitSession(s.id, x => x.session.status === 'completed', 8000, 'AI 回复完成');
    const asst = d.messages.filter(m => m.role === 'assistant');
    ok(asst.length === 1 && asst[0].content.includes('你好呀'), 'AI 文本回复流式落库', asst.map(m => m.content).join('|'));
    ok(d.session.model_id === null, '完成后释放模型');

    // ---- 2. 工具调用 write_file ----
    console.log('\n[2] 工具调用');
    s = await api('POST', '/api/sessions', { title: '冒烟-工具' });
    await waitSession(s.id, x => x.session.status === 'active', 5000, '绑定');
    await api('POST', '/api/sessions/' + s.id + '/start');
    await api('POST', '/api/sessions/' + s.id + '/messages', { content: '请写文件' });
    d = await waitSession(s.id, x => x.session.status === 'completed' && x.messages.some(m => m.role === 'tool'), 15000, '工具回合完成');
    const toolMsgs = d.messages.filter(m => m.role === 'tool');
    ok(toolMsgs.length === 1 && toolMsgs[0].name === 'write_file', 'tool 消息落库', JSON.stringify(toolMsgs.map(m => m.name)));
    ok(toolMsgs[0].content.includes('hello.txt'), '工具结果包含文件名', toolMsgs[0].content);
    const files = await api('GET', '/api/sessions/' + s.id + '/files');
    ok(files.some(f => f.filename === 'hello.txt'), '文件列表含 hello.txt');
    const dl = await fetch(BASE + '/api/sessions/' + s.id + '/files/download?path=hello.txt');
    const dlText = await dl.text();
    ok(dlText === 'hello from agent', '下载内容正确', dlText);
    const taskMd = d.messages.find(m => m.role === 'user' && m.content.includes('task.md'));
    ok(!!taskMd, '开始执行自动追加模板消息');
    ok(d.session.phase === 'execution', '阶段切换为 execution');

    // ---- 3. 路径穿越防护 ----
    console.log('\n[3] 路径防护');
    let blocked = false;
    try {
      await fetch(BASE + '/api/sessions/' + s.id + '/files/download?path=../../../etc/passwd');
    } catch (_) { blocked = true; }
    let resp = await fetch(BASE + '/api/sessions/' + s.id + '/files/download?path=..%2F..%2Fetc%2Fpasswd');
    ok(resp.status !== 200, '下载接口拒绝路径穿越 (status=' + resp.status + ')');

    // ---- 4. 终止机制 ----
    console.log('\n[4] 终止');
    s = await api('POST', '/api/sessions', { title: '冒烟-终止' });
    await waitSession(s.id, x => x.session.status === 'active', 5000, '绑定');
    await api('POST', '/api/sessions/' + s.id + '/messages', { content: '慢一点说' });
    await sleep(600);
    await api('POST', '/api/sessions/' + s.id + '/stop');
    d = await waitSession(s.id, x => x.session.status === 'cancelled', 6000, 'cancelled');
    ok(d.session.status === 'cancelled', '终止后状态为 cancelled');
    ok(d.session.model_id === null, '终止后释放模型');

    // ---- 5. 排队调度（ds1/ds2 都占用 → 第三个排队 → 释放后 FIFO 绑定）----
    console.log('\n[5] 排队调度');
    const a = await api('POST', '/api/sessions', { title: 'A' });
    const b = await api('POST', '/api/sessions', { title: 'B' });
    const c = await api('POST', '/api/sessions', { title: 'C' });
    const da = await waitSession(a.id, x => x.session.status === 'active', 5000, 'A active');
    const db = await waitSession(b.id, x => x.session.status === 'active', 5000, 'B active');
    const dc = await api('GET', '/api/sessions/' + c.id);
    ok(da.session.model_id === 'ds1' && db.session.model_id === 'ds2', '两个会话分到不同模型');
    ok(dc.session.status === 'queued' && dc.queue_pos === 1, '第三个会话排队 position 1');
    await api('POST', '/api/sessions/' + a.id + '/stop');
    await waitSession(c.id, x => x.session.status === 'active', 6000, 'C 顶替');
    const dc2 = await api('GET', '/api/sessions/' + c.id);
    ok(dc2.session.model_id != null, '释放后队列会话自动绑定', String(dc2.session.model_id));

    // ---- 6. 会话删除 ----
    console.log('\n[6] 删除');
    await api('DELETE', '/api/sessions/' + b.id + '?delete_dir=true');
    let gone = false;
    try { await api('GET', '/api/sessions/' + b.id); } catch (e) { gone = /404/.test(e.message); }
    ok(gone, '删除后会话 404');
    ok(!fs.existsSync(path.join(ROOT, 'test/tmp/tasks', b.id)), '任务目录被删除');

    // ---- 7. 模型池 API ----
    const pool = await api('GET', '/api/models');
    ok(pool.length === 2, '模型池数量', JSON.stringify(pool));

    // ---- 8. 工具单元：terminal 超时 + grep ----
    console.log('\n[7] terminal 超时');
    const eng = require(path.join(ROOT, 'server/engine.js'));
    // engine 未在本进程初始化（服务在子进程），此处直接单测 executor
    const { executeTool } = require(path.join(ROOT, 'server/tools/executor.js'));
    const ctx = {
      sessionId: 'unit', taskDir: path.join(ROOT, 'test/tmp/unit'),
      run: { cancelled: false, procs: new Set() },
      cfg: { terminal: { default_timeout_ms: 800, max_output_chars: 5000 }, web_search: { provider: 'none' } },
      db: { prepare: () => ({ run: () => {} }) },
    };
    fs.mkdirSync(ctx.taskDir, { recursive: true });
    const t0 = Date.now();
    const tout = await executeTool(ctx, 'terminal', { command: 'sleep 5' });
    ok(Date.now() - t0 < 4000 && tout.includes('超时'), 'terminal 超时终止', tout.slice(0, 100));
    const toc = await executeTool(ctx, 'terminal', { command: 'echo hello-unit && pwd' });
    ok(toc.includes('hello-unit') && toc.includes('exit code: '), 'terminal 正常执行', toc.slice(0, 120));
    await executeTool(ctx, 'write_file', { path: 'g.txt', content: 'alpha\nbeta\n' });
    const gres = await executeTool(ctx, 'grep', { regex: 'et' });
    ok(gres.includes('beta'), 'grep 命中', gres);
    const fpath = await executeTool(ctx, 'find_path', { glob: '*.txt' });
    ok(fpath.includes('g.txt'), 'find_path 命中', fpath);
    const esc = await executeTool(ctx, 'read_file', { path: '../outside.txt' }).catch(e => 'ERR:' + e.message);
    ok(String(esc).includes('越界'), 'read_file 拒绝越界', String(esc));

    console.log('\n========================');
    console.log('通过 ' + pass + ' / 失败 ' + fail);
    process.exit(fail === 0 ? 0 : 2);
  } catch (e) {
    console.log('\n测试异常: ' + (e && e.stack || e));
    console.log('server 日志尾部:\n' + serverLog.slice(-2000));
    process.exit(2);
  } finally {
    server.kill('SIGKILL');
    mock.kill('SIGKILL');
  }
}

main();
