// 端到端冒烟测试：mock 上游 + 真实 server。
// 覆盖：会话创建/绑定、普通对话、工具调用（write_file）、阶段开关、终止、排队调度、文件 API。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8099';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 端口占用探测:上次运行崩溃可能残留 mock/server,导致本次测试行为错乱,先快速失败
function portInUse(port) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(500);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

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
  for (const p of [9999, 8099]) {
    if (await portInUse(p)) {
      console.error('端口 ' + p + ' 已被占用(可能是上次测试残留的 mock/server),请先清理: pkill -f "test/(mock-upstream|server.js)"');
      process.exit(3);
    }
  }
  // 清理旧数据
  fs.rmSync(path.join(ROOT, 'test/tmp'), { recursive: true, force: true });

  const mock = spawn('node', [path.join(ROOT, 'test/mock-upstream.js')], { stdio: 'inherit' });
  const server = spawn('node', [path.join(ROOT, 'server/server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { AGENT_CONFIG: path.join(ROOT, 'test/config.test.yml') }),
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
    d = await waitSession(s.id, x => x.session.status === 'held', 8000, 'AI 回复完成（held）');
    const asst = d.messages.filter(m => m.role === 'assistant');
    ok(asst.length === 1 && asst[0].content.includes('你好呀'), 'AI 文本回复流式落库', asst.map(m => m.content).join('|'));
    ok(d.session.model_id === 'ds1', '回复完成后模型不释放（held 保持租约）', d.session.model_id);
    // held 期间追问：直接复用已绑模型，不重新排队
    const r2 = await api('POST', '/api/sessions/' + s.id + '/messages', { content: '再来一条' });
    ok(r2 && r2.delivered === 'live', 'held 期间追问直接送达（不排队）', r2 && r2.delivered);
    d = await waitSession(s.id, x => x.session.status === 'held' && x.messages.filter(m => m.role === 'assistant').length >= 2, 8000, '第二次回复');
    ok(d.session.model_id === 'ds1', '追问复用同一模型', d.session.model_id);
    // held 租约到期自动释放（测试配置 idle_release_ms=1500）
    d = await waitSession(s.id, x => x.session.status === 'completed' && x.session.model_id === null, 6000, 'held 租约到期自动释放');

    // ---- 2. 工具调用 write_file ----
    console.log('\n[2] 工具调用');
    s = await api('POST', '/api/sessions', { title: '冒烟-工具' });
    await waitSession(s.id, x => x.session.status === 'active', 5000, '绑定');
    await api('POST', '/api/sessions/' + s.id + '/start');
    await api('POST', '/api/sessions/' + s.id + '/messages', { content: '请写文件' });
    d = await waitSession(s.id, x => x.session.status === 'held' && x.messages.some(m => m.role === 'tool'), 15000, '工具回合完成（held）');
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

    // ---- 2.5 read_file 读图回传（vision）----
    console.log('\n[2.5] 读图回传');
    const sharp = require('sharp');
    const pngBuf = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const si = await api('POST', '/api/sessions', { title: '冒烟-读图' });
    await waitSession(si.id, x => x.session.status === 'active', 5000, '绑定');
    const fdImg = new FormData();
    fdImg.append('files', new Blob([pngBuf], { type: 'image/png' }), 'pic.png');
    const upImg = await fetch(BASE + '/api/sessions/' + si.id + '/files', { method: 'POST', body: fdImg });
    ok(upImg.ok, '上传图片到任务目录');
    await api('POST', '/api/sessions/' + si.id + '/messages', { content: '读图 pic.png' });
    d = await waitSession(si.id, x => x.session.status === 'held' && x.messages.some(m => m.role === 'tool'), 15000, '读图回合完成');
    const imgTool = d.messages.filter(m => m.role === 'tool')
      .map(m => { try { return JSON.parse(m.content); } catch (_) { return null; } })
      .find(j => j && Array.isArray(j.__blocks__));
    ok(!!imgTool && imgTool.__blocks__.some(b =>
      b.type === 'image_url' && String(b.image_url && b.image_url.url).startsWith('data:image/jpeg;base64,')),
      'tool 消息含压缩后的 image_url 内容块',
      imgTool ? JSON.stringify(imgTool.__blocks__.map(b => b.type)) : '无多模态块');

    // ---- 2.8 释放后新消息优先回绑上次模型（last_model_id）----
    console.log('\n[2.8] 优先回绑');
    const sp = await api('POST', '/api/sessions', { title: '冒烟-回绑' });
    let dp = await waitSession(sp.id, x => x.session.status === 'active', 5000, '绑定');
    const m1 = dp.session.model_id;
    await api('POST', '/api/sessions/' + sp.id + '/messages', { content: '回绑测试' });
    dp = await waitSession(sp.id, x => x.session.status === 'held', 8000, '回复完成 held');
    await api('POST', '/api/sessions/' + sp.id + '/release'); // 主动断开：completed + 释放模型
    dp = await waitSession(sp.id, x => x.session.status === 'completed' && !x.session.model_id, 3000, 'release 后释放');
    await api('POST', '/api/sessions/' + sp.id + '/messages', { content: '再来一句' });
    dp = await waitSession(sp.id, x => x.session.status !== 'queued', 5000, '新消息送达');
    ok(dp.session.model_id === m1, '释放后新消息回绑上次模型', dp.session.model_id + ' vs ' + m1);

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
    // 先等模型池全空闲:前节的 held 租约最长还需 idle_release_ms 才释放,
    // 否则本节会话会绑到不同模型,下面「分到不同模型」的断言时机依赖运气
    for (let i = 0; i < 30; i++) {
      const pool0 = await api('GET', '/api/models');
      if (pool0.every(m => !m.is_busy)) break;
      await sleep(200);
    }
    const a = await api('POST', '/api/sessions', { title: 'A' });
    const b = await api('POST', '/api/sessions', { title: 'B' });
    const c = await api('POST', '/api/sessions', { title: 'C' });
    const da = await waitSession(a.id, x => x.session.status === 'active', 5000, 'A active');
    const db = await waitSession(b.id, x => x.session.status === 'active', 5000, 'B active');
    const dc = await api('GET', '/api/sessions/' + c.id);
    ok(da.session.model_id && db.session.model_id && da.session.model_id !== db.session.model_id,
      '两个会话分到不同模型', da.session.model_id + ' vs ' + db.session.model_id);
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
    // read_file 读图：非 vision → 文本提示；vision → {text, image_data_url}（依赖 sharp）
    const unitPng = await require('sharp')({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
    fs.writeFileSync(path.join(ctx.taskDir, 'pic.png'), unitPng);
    const imgNoVision = await executeTool(ctx, 'read_file', { path: 'pic.png' });
    ok(typeof imgNoVision === 'string' && imgNoVision.includes('不支持视觉识别'), 'read_file 非 vision 图片返回文本提示', String(imgNoVision).slice(0, 80));
    const ctxVision = Object.assign({}, ctx, { vision: true });
    const imgVision = await executeTool(ctxVision, 'read_file', { path: 'pic.png' });
    ok(imgVision && typeof imgVision === 'object' && String(imgVision.image_data_url).startsWith('data:image/jpeg;base64,'),
      'read_file vision 图片返回压缩 data URL', imgVision && imgVision.text ? String(imgVision.text).slice(0, 90) : String(imgVision).slice(0, 90));

    // ---- 8. 配置读写 API(阶段 2)----
    console.log('\n[8] 配置读写');
    const cfgPath = path.join(ROOT, 'test/config.test.yml');
    const origText = fs.readFileSync(cfgPath, 'utf8');
    const got = await api('GET', '/api/config');
    ok(got.exists && got.text.includes('models:'), 'GET /api/config 返回原文');
    ok(got.effective && got.effective.agent && got.effective.agent.max_retries === 1 && got.effective.models.length === 2, 'GET 返回生效配置(effective)');
    const patched = await api('PATCH', '/api/config', { path: 'agent.temperature', value: 0.5 });
    ok(patched.ok && patched.changed.includes('agent'), 'PATCH 单项修改');
    const afterPatch = await api('GET', '/api/config');
    ok(/temperature:\s*0\.5/.test(afterPatch.text), 'PATCH 写盘生效');
    ok(afterPatch.text.includes('冒烟测试用短租约'), 'PATCH 保留文件注释');
    let bad400 = false;
    try { await api('PUT', '/api/config', { text: 'models: [unclosed' }); } catch (e) { bad400 = /400/.test(e.message); }
    ok(bad400, 'PUT 非法配置被 400 拒绝');
    ok(fs.readFileSync(cfgPath, 'utf8') === afterPatch.text, '非法写入未动文件');
    const mpatch = await api('PATCH', '/api/config', { path: 'models.0.display_name', value: '改名模型' });
    const mtext = (await api('GET', '/api/config')).text;
    ok(mpatch.ok && mtext.includes('改名模型'), 'PATCH 支持 models[i] 数组下标');
    const restored = await api('PUT', '/api/config', { text: origText });
    ok(restored.ok && fs.readFileSync(cfgPath, 'utf8') === origText, 'PUT 整文件恢复原配置');

    // ---- 9. 会话列表过滤/游标分页/搜索(2.0)----
    console.log('\n[9] 会话列表过滤与搜索');
    const uniqTitle = '冒烟-搜索专用-' + Date.now();
    const fs9 = await api('POST', '/api/sessions', { title: uniqTitle });
    ok(fs9 && fs9.id, '创建搜索专用会话');
    await api('POST', '/api/sessions/' + fs9.id + '/messages', { content: 'zzq-unique 检索内容 12345' });
    // 等到结版(completed 为终态,避免 active/done 归类断言撞上 held→completed 过渡态)
    await waitSession(fs9.id, x => x.session.status === 'completed', 8000, 'AI 回复后租约到期结版,token 用量已落库');
    const st9 = (await api('GET', '/api/sessions/' + fs9.id)).session.status;
    const actSet = await api('GET', '/api/sessions?status=active&limit=200');
    const doneSet = await api('GET', '/api/sessions?status=done&limit=200');
    ok(((st9 === 'completed' || st9 === 'cancelled') ? doneSet : actSet).some(x => x.id === fs9.id), '新会话按状态归入对应过滤', st9);
    ok(!actSet.some(x => x.status === 'completed' || x.status === 'cancelled'), 'active 过滤不含归档会话');
    const withTot = await api('GET', '/api/sessions?status=done&limit=1&with_total=1');
    ok(Array.isArray(withTot.rows) && typeof withTot.total === 'number' && withTot.total >= withTot.rows.length, 'with_total 返回 {rows,total}');
    const pg1 = await api('GET', '/api/sessions?limit=1');
    ok(Array.isArray(pg1) && pg1.length === 1, '默认数组响应兼容旧格式(limit=1)');
    const pg2 = await api('GET', '/api/sessions?limit=1&before=' + encodeURIComponent(pg1[0].updated_at) + '&before_id=' + pg1[0].id);
    ok(Array.isArray(pg2) && pg2.length === 1 && pg2[0].id !== pg1[0].id, '游标翻页取到不同的下一页');
    const qt = await api('GET', '/api/sessions?q=' + encodeURIComponent(uniqTitle));
    ok(qt.some(x => x.id === fs9.id), 'q= 按标题命中');
    const qc = await api('GET', '/api/sessions?q=zzq-unique');
    ok(qc.some(x => x.id === fs9.id), 'q= 按消息内容命中');
    const qnone = await api('GET', '/api/sessions?q=绝无此内容xyzzy-9x7');
    ok(Array.isArray(qnone) && qnone.length === 0, 'q= 无命中返回空');
    // 附件消息:服务端在正文前拼【系统通知】行,与消息一并落库
    await api('POST', '/api/sessions/' + fs9.id + '/messages', { content: '', attachments: [{ name: 'a.png', size: 1536 }, { name: 'b.txt', size: 20 }] });
    const noticePrefix = '【系统通知】用户上传了文件：a.png（大小 1.5 KB）、b.txt（大小 20 B）';
    let attOk = false;
    try {
      await waitSession(fs9.id, x => x.messages.some(m => m.role === 'user' && m.content.indexOf(noticePrefix) === 0), 6000, '附件通知落库');
      attOk = true;
    } catch (_) {}
    ok(attOk, '附件提示词按格式拼接(文件名+大小)');
    // token 用量:model_usage 由 mock 上游的 usage 帧驱动,输入/输出分开统计
    const usagePool = await api('GET', '/api/models');
    const sumP = usagePool.reduce(function (n, m) { return n + (m.today_prompt || 0); }, 0);
    const sumC = usagePool.reduce(function (n, m) { return n + (m.today_completion || 0); }, 0);
    const sumTP = usagePool.reduce(function (n, m) { return n + (m.total_prompt || 0); }, 0);
    ok(sumP > 0 && sumC > 0 && sumTP >= sumP,
      '/api/models 携带今日/累计输入输出 token 用量', '今日输入=' + sumP + ' 今日输出=' + sumC);

    // ---- 10. 技能管理(阶段 3)----
    console.log('\n[10] 技能管理');
    ok((await api('POST', '/api/skills', { name: 'demo-skill', description: '演示技能' })).ok, '创建技能');
    let slist = await api('GET', '/api/skills');
    const demo = slist.find(x => x.name === 'demo-skill');
    ok(demo && demo.has_md && String(demo.description).includes('演示技能'), '列表含新技能与描述');
    let sdet = await api('GET', '/api/skills/demo-skill');
    ok(sdet.skill_md && sdet.skill_md.includes('demo-skill') && sdet.files.some(f => f.filename === 'SKILL.md'), '详情含 SKILL.md');
    await api('PUT', '/api/skills/demo-skill/file', { path: 'sub/run.sh', content: '#!/bin/sh\necho hi\n' });
    const sfr = await api('GET', '/api/skills/demo-skill/file?path=sub%2Frun.sh');
    ok(sfr.content.includes('echo hi'), '文件写入+读取(含子目录)');
    let trav = false;
    try { await api('GET', '/api/skills/demo-skill/file?path=..%2F..%2Fetc%2Fpasswd'); } catch (e) { trav = /400/.test(e.message); }
    ok(trav, '路径穿越被拒 400');
    const mkFd = txt => { const fd = new FormData(); fd.append('file', new Blob([txt]), 'note.txt'); return fd; };
    const up1 = await fetch(BASE + '/api/skills/demo-skill/upload', { method: 'POST', body: mkFd('up\n') });
    const up1j = await up1.json();
    ok(up1.ok && up1j.path === 'note.txt', '上传新文件');
    const up2 = await fetch(BASE + '/api/skills/demo-skill/upload', { method: 'POST', body: mkFd('dup\n') });
    ok(up2.status === 409, '重名上传默认 409');
    const up3 = await fetch(BASE + '/api/skills/demo-skill/upload?overwrite=true', { method: 'POST', body: mkFd('ovr\n') });
    ok(up3.ok, 'overwrite=true 覆盖上传');
    ok((await api('POST', '/api/skills/demo-skill/rename', { newName: 'demo-2' })).ok, '重命名技能');
    await api('DELETE', '/api/skills/demo-2/file?path=sub%2Frun.sh');
    sdet = await api('GET', '/api/skills/demo-2');
    ok(!sdet.files.some(f => f.filename === 'sub/run.sh') && sdet.files.some(f => f.filename === 'note.txt'), '删文件生效');
    ok((await api('DELETE', '/api/skills/demo-2')).ok, '删除整个技能');
    slist = await api('GET', '/api/skills');
    ok(!slist.some(x => x.name.indexOf('demo') === 0), '删除后列表干净');

    // ---- 11. 系统状态与优雅重启(阶段 2;放在最后,服务进程将退出收尾)----
    console.log('\n[11] 优雅重启');
    const st = await api('GET', '/api/system/status');
    ok(st.ok && st.started_at && st.port === 8099, 'GET /api/system/status');
    s = await api('POST', '/api/sessions', { title: '冒烟-重启保护' });
    await waitSession(s.id, x => x.session.status === 'active', 5000, '绑定');
    await api('POST', '/api/sessions/' + s.id + '/messages', { content: '慢一点说' });
    await sleep(400); // 进入慢速流式输出,looping=true
    let guarded = false;
    try { await api('POST', '/api/system/restart'); } catch (e) { guarded = /409/.test(e.message); }
    ok(guarded, '回合执行中 restart 被 409 拦截');
    const rj = await api('POST', '/api/system/restart?force=true');
    ok(rj && rj.restarting, 'force 重启被接受');
    await sleep(800); // 服务在响应后 300ms 退出
    ok(server.exitCode === 0, '服务以退出码 0 结束(交由 Docker 拉起)', 'exitCode=' + server.exitCode);

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
