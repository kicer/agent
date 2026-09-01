// 设置 Tab(阶段 5):账号 / 服务状态与重启 / config.yml 表单化单项编辑 / 原文编辑器。
// 语义:所有写入 = 服务端校验 → 写盘;多数改动需「重启服务」生效(本项目不做热重载)。
// 表单值展示的是「当前生效值」;改完未重启前显示旧值属正常,卡片顶部会提示待生效段。
'use strict';

window.tabModules = window.tabModules || {};

let effCfg = null;              // 当前生效配置(GET /api/config 的 effective)
let cfgOrig = '';               // 原文编辑器打开/上次保存内容(脏检测)
const pendingKeys = new Set();  // 本次会话已写盘、但尚未通过重启生效的顶层段

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getByPath(obj, p) {
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function fmtUptime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return d + ' 天 ' + h + ' 小时';
  if (h) return h + ' 小时 ' + m + ' 分';
  if (m) return m + ' 分 ' + (s % 60) + ' 秒';
  return s + ' 秒';
}
function dispVal(v) {
  if (v === undefined || v === null || v === '') return '(未设置)';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

// ---------- 表单 schema:path 点分路径;type:str|int|float ----------
const CFG_FORM = [
  { group: '通用', items: [
    { path: 'port', label: '端口', type: 'int' },
    { path: 'workspace_root', label: '工作区目录', type: 'str' },
    { path: 'db_path', label: '数据库路径', type: 'str' },
  ] },
  { group: 'Agent 回合', items: [
    { path: 'agent.temperature', label: '温度 temperature', type: 'float' },
    { path: 'agent.max_tool_iterations', label: '单回合最大工具轮次', type: 'int' },
    { path: 'agent.max_retries', label: '上游失败重试次数', type: 'int' },
  ] },
  { group: '终端工具', items: [
    { path: 'terminal.default_timeout_ms', label: '命令默认超时(ms)', type: 'int' },
    { path: 'terminal.max_output_chars', label: '输出最大字符数', type: 'int' },
  ] },
  { group: '技能', items: [
    { path: 'skills.skills_root', label: '技能目录', type: 'str' },
    { path: 'skills.timeout_ms', label: '技能执行超时(ms)', type: 'int' },
  ] },
  { group: '模型租约(回合结束后的保持)', items: [
    { path: 'model_hold.idle_release_ms', label: '无人观看释放(ms)', type: 'int' },
    { path: 'model_hold.active_max_ms', label: '最长保持(ms)', type: 'int' },
    { path: 'model_hold.sweep_ms', label: '巡检间隔(ms)', type: 'int' },
  ] },
];

// ---------- 渲染 ----------
function kvPlain(label, v) {
  return '<div class="cfg-kv"><label>' + esc(label) + '</label><b>' + esc(dispVal(v)) + '</b></div>';
}
function kvBtn(label, vDisp, call) {
  return '<div class="cfg-kv"><label>' + esc(label) + '</label><b>' + vDisp + '</b>' +
    '<button class="file-act" onclick="' + call + '">改</button></div>';
}

function svcCard(st) {
  let html = '<div class="settings-card"><h4>服务状态' +
    (pendingKeys.size ? ' <span class="badge held">待重启生效</span>' : '') + '</h4>';
  html += kvPlain('版本 / Node', st.version + ' / ' + st.node);
  html += kvPlain('已运行', fmtUptime(st.uptime_ms) + '(启动于 ' + new Date(st.started_at).toLocaleString() + ')');
  html += kvPlain('端口', st.port);
  html += kvPlain('运行中回合', (st.running_sessions || []).length);
  html += kvPlain('配置文件', st.config_path);
  html += kvPlain('工作区', st.workspace_root);
  html += kvPlain('技能目录', st.skills_root);
  if (pendingKeys.size) html += kvPlain('待生效改动', Array.from(pendingKeys).join(', '));
  html += '<button class="primary-btn" id="restart-btn" style="width:100%;margin-top:8px" onclick="cfgUI.restart()">重启服务</button>' +
    '<div class="cfg-note">配置改动重启后生效;重启约需十几秒,期间页面暂不可用。非 Docker 部署不会自动拉起。</div></div>';
  return html;
}

function formCard() {
  let html = '';
  for (const g of CFG_FORM) {
    html += '<div class="settings-card"><h4>' + esc(g.group) + '</h4>';
    for (const it of g.items) {
      const call = "cfgUI.edit('" + it.path + "','" + it.label + "','" + it.type + "')";
      html += kvBtn(it.label, esc(dispVal(getByPath(effCfg, it.path))), call);
    }
    html += '</div>';
  }
  return html;
}

function modelsCard() {
  const ms = (effCfg && effCfg.models) || [];
  let html = '<div class="settings-card"><h4>模型池(' + ms.length + ')</h4>';
  html += ms.map((m, i) =>
    '<div class="model-card" style="margin-top:8px">' +
      '<div class="model-card-head"><span class="model-card-name">' + esc(m.display_name || m.id) + '</span>' +
        '<button class="file-act del" onclick="cfgUI.modelDel(' + i + ')">删除</button></div>' +
      kvPlain('id(改 id 请用原文编辑)', m.id) +
      kvBtn('上游地址 url', esc(m.url), "cfgUI.modelEdit(" + i + ",'url')") +
      kvBtn('api_key', m.api_key ? '已设置(••••' + esc(String(m.api_key).slice(-4)) + ')' : '(未设置)', "cfgUI.modelEdit(" + i + ",'api_key')") +
      kvBtn('支持图片 vision', esc(dispVal(!!m.vision)), "cfgUI.modelVision(" + i + ")") +
    '</div>').join('');
  html += '<button class="ghost-btn" style="width:100%;margin-top:8px" onclick="cfgUI.modelAdd()">+ 添加模型</button>' +
    '<div class="cfg-note">添加/删除会整体重写 models 段(其中的注释会丢失);精细调整请用配置文件原文编辑。</div></div>';
  return html;
}

function authCard() {
  const a = effCfg && effCfg.auth;
  let html = '<div class="settings-card"><h4>登录账号</h4>';
  if (a && a.users && a.users.length) {
    html += a.users.map(u => kvPlain('用户名', u.user)).join('');
    html += '<div class="cfg-note">增删账号或改密码:请用下方「配置文件原文」编辑 auth.users 后重启。</div>';
  } else {
    html += '<div class="cfg-note">未启用认证:能访问本地址的人可直接使用。如需登录,在配置文件 auth.users 中添加 {user, password} 并重启。</div>';
  }
  return html + '</div>';
}

function mcpCard() {
  const list = (effCfg && effCfg.mcp_servers) || [];
  let html = '<div class="settings-card"><h4>MCP 服务(' + list.length + ')</h4>';
  html += list.length
    ? list.map(s => kvPlain(s.name || 'mcp', s.url)).join('')
    : '<div class="cfg-note">未配置外部 MCP 服务。</div>';
  return html + '<div class="cfg-note">headers 含密钥,不在页面展示;请用配置文件原文编辑。</div></div>';
}

function fileCard(cg) {
  return '<div class="settings-card"><h4>配置文件</h4>' +
    kvPlain('路径', cg.config_path) +
    (cg.exists ? '' : '<div class="cfg-note">配置文件当前不存在,原文保存时将创建。</div>') +
    '<button class="ghost-btn" style="width:100%;margin-top:6px" onclick="cfgUI.open()">编辑原文(YAML)</button>' +
    '<div class="cfg-note">保存前自动校验,不合法不落盘;注释与排版原样保留。</div></div>';
}

async function loadSettings() {
  refreshUser();
  const el = $('cfg-sections');
  if (!el) return;
  el.innerHTML = '<div class="empty-tip">加载中…</div>';
  try {
    const [st, cg] = await Promise.all([
      req('GET', '/api/system/status'),
      req('GET', '/api/config'),
    ]);
    effCfg = cg.effective || {};
    el.innerHTML = svcCard(st) + formCard() + modelsCard() + authCard() + mcpCard() + fileCard(cg);
  } catch (e) {
    el.innerHTML = '<div class="empty-tip">加载失败:' + esc(e.message) + '</div>';
  }
}

// 显示登录用户(沿用 1.0 逻辑;未启用认证时静默跳过)
async function refreshUser() {
  try {
    const me = await req('GET', '/api/me');
    const who = $('whoami');
    if (who && me && me.user) {
      who.textContent = me.user;
      who.classList.remove('hidden');
    }
    const out = $('logout-btn');
    if (out) out.classList.toggle('hidden', !(me && me.user));
  } catch (_) { /* 未启用认证 */ }
}

// ---------- 写操作 ----------
function afterWrite(r) {
  (r.changed || []).forEach(k => pendingKeys.add(k));
  const ch = (r.changed || []).join(', ');
  toast('已写入 config.yml' + (ch ? ';段 [' + ch + '] 重启后生效' : ';与当前生效值一致,无需重启'));
  loadSettings();
}

async function editCfgItem(p, label, type) {
  const cur = getByPath(effCfg, p);
  let v = prompt(label + ' 新值:', cur == null ? '' : String(cur));
  if (v == null) return;
  v = v.trim();
  let val = v;
  if (type === 'int' || type === 'float') {
    val = Number(v);
    if (v === '' || !isFinite(val)) { toast('请输入数字'); return; }
  }
  try {
    const r = await req('PATCH', '/api/config', { path: p, value: val });
    afterWrite(r);
  } catch (e) { toast('保存失败:' + e.message); }
}

async function modelEdit(i, field) {
  const m = ((effCfg || {}).models || [])[i] || {};
  const label = field === 'url' ? '上游地址(OpenAI 兼容 /v1,不带尾斜杠)' : 'API Key(留空则不带鉴权头)';
  // api_key 不回填旧值,避免密钥长时间展示在输入框
  const cur = field === 'url' ? (m.url || '') : '';
  const v = prompt(label + ':', cur);
  if (v == null) return;
  try {
    const r = await req('PATCH', '/api/config', { path: ['models', i, field], value: v.trim() });
    afterWrite(r);
  } catch (e) { toast('保存失败:' + e.message); }
}

async function modelVision(i) {
  const ms = (effCfg && effCfg.models) || [];
  const m = ms[i] || {};
  const nv = !m.vision;
  if (!confirm('模型「' + (m.display_name || m.id) + '」支持图片输入(vision)?\n确定=开启,取消=关闭')) return;
  try {
    const r = await req('PATCH', '/api/config', { path: ['models', i, 'vision'], value: nv });
    afterWrite(r);
  } catch (e) { toast('保存失败:' + e.message); }
}

async function modelAdd() {
  const ms = (effCfg && effCfg.models) || [];
  const id = (prompt('新模型 id(唯一,如 ds3):') || '').trim();
  if (!id) return;
  if (ms.some(m => m.id === id)) { toast('id 已存在:' + id); return; }
  const url = (prompt('上游地址(OpenAI 兼容 /v1):') || '').trim();
  if (!url) return;
  try {
    // 整体替换 models 数组(setIn 数组下标只适合改字段,增删只能整段重写)
    const r = await req('PATCH', '/api/config', { path: 'models', value: ms.concat([{ id, display_name: id, url }]) });
    afterWrite(r);
  } catch (e) { toast('添加失败:' + e.message); }
}

async function modelDel(i) {
  const ms = (effCfg && effCfg.models) || [];
  const m = ms[i] || {};
  if (ms.length <= 1) { toast('至少要保留一个模型'); return; }
  if (!confirm('删除模型「' + (m.display_name || m.id) + '」?将整体重写 models 段(注释可能丢失)。')) return;
  try {
    const r = await req('PATCH', '/api/config', { path: 'models', value: ms.filter((_, j) => j !== i) });
    afterWrite(r);
  } catch (e) { toast('删除失败:' + e.message); }
}

// ---------- 重启 ----------
async function restart() {
  if (!confirm('重启服务使新配置生效?正在执行的 AI 回合会被打断。')) return;
  try {
    await req('POST', '/api/system/restart');
  } catch (e) {
    if (e.status === 409 && /回合执行中/.test(e.message)) {
      // 仅「有回合在跑」值得二次确认强打;配置不合法等 409 强打也无法启动,直接报给用户
      if (!confirm(e.message + '\n\n仍要强制重启?')) return;
      try { await req('POST', '/api/system/restart?force=true'); }
      catch (e2) { toast('重启失败:' + e2.message); return; }
    } else { toast('重启失败:' + e.message); return; }
  }
  const btn = $('restart-btn');
  if (btn) { btn.disabled = true; btn.textContent = '重启中,请勿关闭页面…'; }
  toast('服务重启中…');
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    try { const r = await fetch('/api/health'); if (r.ok) { location.reload(); return; } } catch (_) {}
  }
  toast('90 秒内未恢复,请检查容器状态(非 Docker 部署需手动启动)');
  if (btn) { btn.disabled = false; btn.textContent = '重启服务'; }
}

// ---------- config.yml 原文编辑器 ----------
async function openCfgEditor() {
  try {
    const cg = await req('GET', '/api/config');
    cfgOrig = cg.text;
    $('cfg-editor-area').value = cg.text;
    $('cfg-editor-err').classList.add('hidden');
    $('cfg-editor').classList.remove('hidden');
  } catch (e) { toast('读取失败:' + e.message); }
}
async function saveCfgEditor() {
  const text = $('cfg-editor-area').value;
  const errEl = $('cfg-editor-err');
  errEl.classList.add('hidden');
  try {
    await req('POST', '/api/config/validate', { text }); // 先干跑,错误信息更友好
    const r = await req('PUT', '/api/config', { text });
    cfgOrig = text;
    afterWrite(r);
  } catch (e) {
    errEl.textContent = '校验失败:' + e.message;
    errEl.classList.remove('hidden');
    toast('配置不合法,未写入');
  }
}
function closeCfgEditor() {
  if ($('cfg-editor-area').value !== cfgOrig && !confirm('有未保存的修改,确定关闭?')) return;
  $('cfg-editor').classList.add('hidden');
}

window.cfgUI = {
  edit: editCfgItem,
  restart: restart,
  modelEdit: modelEdit,
  modelVision: modelVision,
  modelAdd: modelAdd,
  modelDel: modelDel,
  open: openCfgEditor,
  save: saveCfgEditor,
  close: closeCfgEditor,
};

tabModules.settings = {
  onShow() { loadSettings(); },
};
