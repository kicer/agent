// 设置 Tab(阶段 5):账号 / 服务状态与重启 / config.yml 表单化编辑。
// 语义:所有写入 = 服务端校验 → 写盘;多数改动需「重启服务」生效(本项目不做热重载)。
// 表单值展示的是「当前生效值」;改完未重启前显示旧值属正常,保存按钮统一写盘。
// 模型池 / 登录账号 / MCP / 路径类配置不在本页编辑,请用顶栏「配置文件」图标改原文。
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
// 属性上下文转义(esc 不处理引号)
function att(s) { return esc(s).replace(/"/g, '&quot;'); }

// ---------- 表单 schema:path 点分路径;type:int|float ----------
const CFG_FORM = [
  { group: 'Agent 会话', items: [
    { path: 'agent.temperature', label: '温度 temperature', type: 'float' },
    { path: 'agent.max_tool_iterations', label: '单会话最大工具轮次', type: 'int' },
    { path: 'agent.max_retries', label: '上游失败重试次数', type: 'int' },
  ] },
  { group: '终端工具', items: [
    { path: 'terminal.default_timeout_ms', label: '命令默认超时(ms)', type: 'int' },
    { path: 'terminal.max_output_chars', label: '输出最大字符数', type: 'int' },
  ] },
  { group: '技能', items: [
    { path: 'skills.timeout_ms', label: '技能执行超时(ms)', type: 'int' },
  ] },
  { group: '模型租约(会话结束后的保持)', items: [
    { path: 'model_hold.idle_release_ms', label: '无人观看释放(ms)', type: 'int' },
    { path: 'model_hold.active_max_ms', label: '最长保持(ms)', type: 'int' },
    { path: 'model_hold.sweep_ms', label: '巡检间隔(ms)', type: 'int' },
  ] },
];

// ---------- 渲染 ----------
function kvPlain(label, v) {
  return '<div class="cfg-kv"><label>' + esc(label) + '</label><b>' + esc(dispVal(v)) + '</b></div>';
}

function svcCard(st) {
  let html = '<div class="settings-card"><h4>服务状态' +
    (pendingKeys.size ? ' <span class="badge held">待重启生效</span>' : '') + '</h4>';
  html += kvPlain('版本 / Node', st.version + ' / ' + st.node);
  html += kvPlain('已运行', fmtUptime(st.uptime_ms) + '(启动于 ' + new Date(st.started_at).toLocaleString() + ')');
  html += kvPlain('端口', st.port);
  html += kvPlain('配置文件', st.config_path);
  html += kvPlain('工作区', st.workspace_root);
  html += kvPlain('技能目录', st.skills_root);
  if (pendingKeys.size) html += kvPlain('待生效改动', Array.from(pendingKeys).join(', '));
  html += '<button class="primary-btn" id="restart-btn" style="width:100%;margin-top:8px" onclick="cfgUI.restart()">重启服务</button>' +
    '<div class="cfg-note">配置改动重启后生效;重启约需十几秒,期间页面暂不可用。非 Docker 部署不会自动拉起。</div></div>';
  return html;
}

function cfgInput(it) {
  const cur = getByPath(effCfg, it.path);
  const v = cur == null ? '' : String(cur);
  const step = it.type === 'float' ? ' step="any"' : ' step="1"';
  return '<div class="cfg-kv"><label>' + esc(it.label) + '</label>' +
    '<input class="cfg-input" type="number"' + step +
    ' inputmode="decimal"' +
    ' data-path="' + att(it.path) + '" data-type="' + it.type + '" data-label="' + att(it.label) + '" data-orig="' + att(v) + '"' +
    ' value="' + att(v) + '"></div>';
}

function formCard() {
  let html = '';
  for (const g of CFG_FORM) {
    html += '<div class="settings-card"><h4>' + esc(g.group) + '</h4>';
    html += g.items.map(cfgInput).join('');
    html += '</div>';
  }
  html += '<button class="primary-btn" id="cfg-save-btn" style="width:100%" onclick="cfgUI.saveForm()">更新配置</button>' +
    '<div class="cfg-note" style="margin-bottom:12px">更新即写入 config.yml(注释保留);多数配置需重启服务后生效。' +
    '模型、账号、MCP 等请用右上角配置文件编辑。</div>';
  return html;
}

async function loadSettings() {
  refreshUser();
  bindDirtyMark();
  const el = $('cfg-sections');
  if (!el) return;
  el.innerHTML = '<div class="empty-tip">加载中…</div>';
  try {
    const [st, cg] = await Promise.all([
      req('GET', '/api/system/status'),
      req('GET', '/api/config'),
    ]);
    effCfg = cg.effective || {};
    el.innerHTML = svcCard(st) + formCard();
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

// 未保存改动标红:委托监听(#cfg-sections 容器常驻,innerHTML 重建不影响)
let dirtyBound = false;
function bindDirtyMark() {
  if (dirtyBound) return;
  const box = $('cfg-sections');
  if (!box) return;
  dirtyBound = true;
  box.addEventListener('input', function (ev) {
    const inp = ev.target;
    if (inp.classList && inp.classList.contains('cfg-input')) {
      inp.classList.toggle('cfg-dirty', inp.value.trim() !== inp.dataset.orig);
    }
  });
}

// ---------- 表单保存(收集与打开时不同的项,逐项 PATCH) ----------
async function saveForm() {
  const inputs = document.querySelectorAll('#cfg-sections .cfg-input');
  const edits = [];
  for (const inp of inputs) {
    const v = inp.value.trim();
    if (v === inp.dataset.orig) continue;
    let val = v;
    if (inp.dataset.type === 'int' || inp.dataset.type === 'float') {
      val = Number(v);
      if (v === '' || !isFinite(val)) { toast('「' + inp.dataset.label + '」需填数字'); return; }
      if (inp.dataset.type === 'int' && !Number.isInteger(val)) { toast('「' + inp.dataset.label + '」需为整数'); return; }
    }
    edits.push({ path: inp.dataset.path, value: val });
  }
  if (!edits.length) { toast('没有改动'); return; }
  const btn = $('cfg-save-btn');
  if (btn) btn.disabled = true;
  let lastChanged = [];
  try {
    for (const e of edits) {
      const r = await req('PATCH', '/api/config', { path: e.path, value: e.value });
      lastChanged = r.changed || [];
      lastChanged.forEach(k => pendingKeys.add(k));
    }
    toast('已保存 ' + edits.length + ' 项' + (lastChanged.length ? ',重启后生效' : ''));
  } catch (e) {
    toast('保存失败:' + e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
  loadSettings();
}

// ---------- 重启 ----------
async function restart() {
  if (!await confirmModal('重启服务', '重启服务使新配置生效?正在执行的 AI 会话会被打断。', '重启')) return;
  try {
    await req('POST', '/api/system/restart');
  } catch (e) {
    if (e.status === 409 && /个任务.*执行中/.test(e.message)) {
      // 仅「有会话在跑」值得二次确认强打;配置不合法等 409 强打也无法启动,直接报给用户
      if (!await confirmModal('有任务在跑', e.message, '强制重启', true)) return;
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

// ---------- config.yml 原文编辑器(顶栏图标打开) ----------
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
    (r.changed || []).forEach(k => pendingKeys.add(k));
    toast('配置已保存');
    $('cfg-editor').classList.add('hidden');
    loadSettings(); // 保存成功直接退出编辑页
  } catch (e) {
    errEl.textContent = '校验失败:' + e.message;
    errEl.classList.remove('hidden');
    toast('配置不合法,未写入');
  }
}
async function closeCfgEditor() {
  if ($('cfg-editor-area').value !== cfgOrig &&
      !await confirmModal('未保存的修改', '有未保存的修改,确定关闭并丢弃?', '关闭', true)) return;
  $('cfg-editor').classList.add('hidden');
  loadSettings(); // 原文可能改了生效值相关的显示,回到本页时刷新
}

window.cfgUI = {
  saveForm: saveForm,
  restart: restart,
  open: openCfgEditor,
  save: saveCfgEditor,
  close: closeCfgEditor,
};

tabModules.settings = {
  onShow() { loadSettings(); },
};
