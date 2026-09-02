// 模型 Tab(阶段 5):模型池状态 + 模型增 / 改 / 删(仅写 config.yml,到「设置」页重启才生效)。
// 配置为 platforms 层级（平台 → Key → 模型）：url/type 在平台层，api_key/concurrency 在 Key 层，
// 模型项只有 {id, display_name, vision}；id 只需同平台内唯一（内部唯一键 = 平台名/模型id，
// effective.models 的 id 即该键、mid 为原始模型名）。页面 PATCH 用 platforms[i].keys[j].models[k] 嵌套下标定位；
// 新增一律走 append(只动目标数组,脱敏 key 绝不整体回写文件);已有 Key 的 api_key 修改请走配置原文编辑器。
// 展示层:模型池按「平台名 + 脱敏 Key」分组(余额由二者决定),父级 Key、子级模型,默认折叠。
'use strict';

window.tabModules = window.tabModules || {};

let cfgPlatforms = [];          // effective.platforms(服务端已对 api_key 脱敏)
let cfgModels = [];             // 打平后的 effective.models(含 platform_index/key_index/model_index)
let runtimeById = {};           // 运行池状态,按 id 关联
let modelsPendingRestart = false;
let moeIdx = -1;                // 当前编辑弹窗对应的打平下标;-1 = 新增
let expandedGroups = {};        // 模型池分组展开态,key =「pi-ki」;余额由 name+key 决定,分组即 Key 槽位,默认折叠

// api_key 脱敏显示:sk-***1234 样式。后端 GET effective 已脱敏,这里仅兜底(幂等)。
function maskKey(k) {
  k = k || '';
  if (k.includes('***')) return k;
  if (k.length > 8) return k.slice(0, 3) + '***' + k.slice(-4);
  if (k.length > 0) return '***' + k.slice(-2);
  return '';
}

// token 用量紧凑显示：1.2k / 9.1M 这种 human-friendly 量级，一眼看出多少。
// <1000 原样；1k~1M 用 k(1 位小数,去尾零)；≥1M 用 M。0 显示为 0。
function fmtTok(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) { const v = (n / 1000).toFixed(1).replace(/\.0$/, ''); return v + 'k'; }
  const v = (n / 1000000).toFixed(1).replace(/\.0$/, '');
  return v + 'M';
}

// ---------- 模型池卡片:按「平台 + Key」分组 ----------
// 余额由 platform.name + key 决定,故父级 = 平台名 · 脱敏 key,子级 = 该 Key 下的模型;默认折叠。

function toggleModelGroup(gk) {
  const on = !expandedGroups[gk];
  expandedGroups[gk] = on;
  const el = $('mgrp-' + gk);
  if (!el) return;
  el.classList.toggle('open', on);
  const body = el.querySelector('.model-group-body');
  if (body) body.classList.toggle('hidden', !on);
}

// 单个模型的子卡片;余额是 Key 级概念,统一在分组头显示,模型卡不再重复。
function modelCardHtml(m) {
  const run = runtimeById[m.id];
  // 运行池里没有 = 配置新增但还没重启生效
  const stateHtml = run
    ? '<span class="model-card-state ' + (run.is_busy ? 'busy' : 'idle') + '">' + (run.is_busy ? '占用中' : '空闲') + '</span>'
    : '<span class="model-card-state pending">待重启</span>';
  return '<div class="model-card">' +
    '<div class="model-card-head">' +
      '<span class="model-card-name" title="点击编辑" onclick="modelsUI.openEdit(\'' + encodeURIComponent(m.id) + '\')">' + esc(m.display_name || m.mid || m.id) + '</span>' +
      // 模型 id / 会话号紧跟名字同行,卡片更紧凑
      '<span class="model-card-meta">' + esc(m.mid || m.id) +
        (run && run.is_busy && run.current_session_id ? ' · 会话 ' + esc(run.current_session_id) : '') + '</span>' +
      stateHtml +
    '</div>' +
    // token 紧凑显示:输入 / 输出
    '<div class="cfg-kv"><label>今日 token</label><b title="输入 / 输出">' + (run ? fmtTok(run.today_prompt) + ' / ' + fmtTok(run.today_completion) : '--') + '</b></div>' +
    '<div class="cfg-kv"><label>累计 token</label><b title="输入 / 输出">' + (run ? fmtTok(run.total_prompt) + ' / ' + fmtTok(run.total_completion) : '--') + '</b></div>' +
  '</div>';
}

function modelGroupHtml(pi, ki) {
  const p = cfgPlatforms[pi] || {};
  const k = (p.keys || [])[ki] || {};
  const gk = pi + '-' + ki;
  const models = cfgModels.filter(m => m.platform_index === pi && m.key_index === ki);
  const open = !!expandedGroups[gk];
  return '<div class="model-group' + (open ? ' open' : '') + '" id="mgrp-' + gk + '">' +
    '<div class="model-group-head" onclick="modelsUI.toggleGroup(\'' + gk + '\')">' +
      '<svg class="model-group-caret" viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"></polyline></svg>' +
      '<span class="model-group-name">' + esc(p.name || ('平台' + pi)) + '</span>' +
      '<span class="model-group-key">' + esc(k.api_key ? maskKey(k.api_key) : '无 key') + '</span>' +
      '<span class="model-group-meta">余额 -- · ' + models.length + ' 模型</span>' +
    '</div>' +
    '<div class="model-group-body' + (open ? '' : ' hidden') + '">' +
      (models.length ? models.map(modelCardHtml).join('') : '<div class="model-group-empty">该 Key 下暂无模型</div>') +
    '</div>' +
  '</div>';
}

async function loadModelCards() {
  const el = $('model-cards');
  if (!el) return;
  try {
    const [rt, cg] = await Promise.all([req('GET', '/api/models'), req('GET', '/api/config')]);
    runtimeById = {};
    for (const m of rt || []) runtimeById[m.id] = m;
    cfgPlatforms = (cg.effective && cg.effective.platforms) || [];
    cfgModels = (cg.effective && cg.effective.models) || [];
    if (!cfgModels.length) {
      el.innerHTML = '<div class="empty-tip">尚未配置模型,点右上角 + 添加。</div>';
      return;
    }
    let html = '';
    cfgPlatforms.forEach((p, pi) => (p.keys || []).forEach((k, ki) => {
      html += modelGroupHtml(pi, ki);
    }));
    el.innerHTML = html +
      (modelsPendingRestart
        ? '<div class="empty-tip">已写入 config.yml,到「设置」页重启服务后生效。</div>'
        : '<div class="empty-tip">token 格式为「输入 / 输出」;余额按平台名+Key 统计,需对接模型提供方 API,暂未实现;改动写入 config.yml,重启服务后生效。</div>');
  } catch (e) {
    el.innerHTML = '<div class="empty-tip">加载失败:' + esc(e.message) + '</div>';
  }
}

function idxOf(id) {
  for (let i = 0; i < cfgModels.length; i++) if (cfgModels[i].id === id) return i;
  return -1;
}
function afterWrite() {
  modelsPendingRestart = true;
  toast('已写入 config.yml,到「设置」页重启后生效');
  loadModelCards();
}

// ---------- 编辑/新增弹窗 ----------
// Key 标签:「平台名 · sk-***1234」;下拉里用它标识可挂模型的目标 Key。
function keyLabel(pi, ki) {
  const p = cfgPlatforms[pi] || {};
  const k = (p.keys || [])[ki] || {};
  return (p.name || ('平台' + pi)) + ' · ' + (k.api_key ? maskKey(k.api_key) : '无 key');
}

function targetOptions() {
  let html = '';
  cfgPlatforms.forEach((p, pi) => (p.keys || []).forEach((k, ki) => {
    html += '<option value="exist:' + pi + ':' + ki + '">' +
      esc(keyLabel(pi, ki)) + '(' + ((k.models || []).length) + ' 模型)</option>';
  }));
  html += '<option value="newkey">＋ 在已有平台下新增 Key</option>';
  html += '<option value="newplat">＋ 新增平台</option>';
  return html;
}

// 切换「新增 Key / 新增平台」时显隐对应字段。
function onTargetChange() {
  const t = $('moe-target').value || '';
  $('moe-newkey-wrap').classList.toggle('hidden', t !== 'newkey');
  $('moe-newplat-wrap').classList.toggle('hidden', t !== 'newplat');
}

function fillNewKeyPlatforms() {
  $('moe-nk-plat').innerHTML = cfgPlatforms.map((p, i) =>
    '<option value="' + i + '">' + esc(p.name || ('平台' + i)) + '</option>').join('');
}

function openModelEditor(rawId) {
  const add = rawId == null;
  moeIdx = add ? -1 : idxOf(decodeURIComponent(rawId));
  if (!add && moeIdx < 0) return toast('模型不存在');
  const m = add ? null : cfgModels[moeIdx];
  $('moe-title').textContent = add ? '添加模型' : '编辑模型';
  const idIn = $('moe-id');
  idIn.value = m ? (m.mid || m.id) : '';
  idIn.disabled = !add; // 编辑时禁改 id（历史会话按「平台名/模型id」绑定，改 id 等于换模型）
  $('moe-name').value = m ? (m.display_name || '') : '';
  $('moe-vision').checked = m ? !!m.vision : false;
  const tgt = $('moe-target');
  if (add) {
    tgt.disabled = false;
    tgt.innerHTML = targetOptions();
    fillNewKeyPlatforms();
  } else {
    // 编辑时锁定目标为本模型所属 Key(移动模型 = 删除后重建,不支持就地挪)
    tgt.innerHTML = '<option value="exist:' + m.platform_index + ':' + m.key_index + '">' + esc(keyLabel(m.platform_index, m.key_index)) + '</option>';
    tgt.disabled = true;
  }
  tgt.onchange = onTargetChange;
  onTargetChange(); // add 模式默认 exist → 两组附加字段都隐藏
  $('moe-del-btn').classList.toggle('hidden', add);
  $('model-edit-modal').classList.remove('hidden');
}
function closeModelEditor() { $('model-edit-modal').classList.add('hidden'); }

async function saveModelEditor() {
  const id = $('moe-id').value.trim();
  if (!id) return toast('请填写 id');
  // 模型项本身只含 id/display_name/vision;url/key/concurrency 在平台/Key 层,这里不动。
  const model = {
    id,
    display_name: $('moe-name').value.trim() || id,
    vision: $('moe-vision').checked,
  };
  const add = moeIdx < 0;
  let body;
  if (!add) {
    // 编辑：精确改到 platforms[pi].keys[ki].models[mi]
    const m = cfgModels[moeIdx];
    body = { path: ['platforms', m.platform_index, 'keys', m.key_index, 'models', m.model_index], value: model };
  } else {
    const t = $('moe-target').value;
    // id 唯一性只看同平台（内部键 = 平台名/模型id）；不同平台可同名。
    let platName = '';
    if (t === 'newkey') platName = (cfgPlatforms[parseInt($('moe-nk-plat').value, 10)] || {}).name || '';
    else if (t.indexOf('exist:') === 0) platName = (cfgPlatforms[Number(t.split(':')[1])] || {}).name || '';
    if (platName && cfgModels.some(x => x.platform === platName && x.mid === id)) return toast('平台「' + platName + '」下已有模型 id：' + id);
    if (t === 'newplat') {
      const url = $('moe-np-url').value.trim().replace(/\/+$/, '');
      if (!url) return toast('请填写平台上游地址');
      // append 一整个新平台:含一个新 Key + 这个模型;key 明文只在此时输入一次。
      body = { op: 'append', path: ['platforms'], value: {
        name: $('moe-np-name').value.trim(),
        url,
        type: $('moe-np-type').value || 'openai',
        keys: [{ api_key: $('moe-np-key').value.trim(), concurrency: parseInt($('moe-np-con').value, 10) || 1, models: [model] }],
      } };
    } else if (t === 'newkey') {
      const pi = parseInt($('moe-nk-plat').value, 10);
      if (!(pi >= 0)) return toast('请选择平台');
      // append 一个新 Key 到已有平台;模型挂在它下面。
      body = { op: 'append', path: ['platforms', pi, 'keys'], value: {
        api_key: $('moe-nk-key').value.trim(), concurrency: parseInt($('moe-nk-con').value, 10) || 1, models: [model] } };
    } else {
      // exist:pi:ki → append 模型到已有 Key 的 models 数组
      const parts = t.split(':');
      body = { op: 'append', path: ['platforms', Number(parts[1]), 'keys', Number(parts[2]), 'models'], value: model };
    }
  }
  try {
    await req('PATCH', '/api/config', body);
    closeModelEditor();
    afterWrite();
  } catch (e) { toast('保存失败:' + e.message); }
}

async function delModelFromModal() {
  if (moeIdx < 0) return;
  const m = cfgModels[moeIdx];
  closeModelEditor();
  if (cfgModels.length <= 1) return toast('至少要保留一个模型');
  const ok = await confirmModal('删除模型', '删除模型「' + (m.display_name || m.id) + '」?将从 platforms 中移除该模型项。', '删除', true);
  if (!ok) return;
  try {
    // delete 到 platforms[pi].keys[ki].models[mi];YAML 数组删项会自动收紧,不影响其他行注释。
    await req('PATCH', '/api/config', { path: ['platforms', m.platform_index, 'keys', m.key_index, 'models', m.model_index], op: 'delete' });
    afterWrite();
  } catch (e) { toast('删除失败:' + e.message); }
}

window.modelsUI = {
  openAdd: function () { openModelEditor(null); },
  openEdit: openModelEditor,
  close: closeModelEditor,
  save: saveModelEditor,
  del: delModelFromModal,
  onTargetChange: onTargetChange,
  toggleGroup: toggleModelGroup,
};

tabModules.models = {
  onShow() { loadModelCards(); },
};
