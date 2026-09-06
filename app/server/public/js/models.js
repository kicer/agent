// 模型 Tab(阶段 5):模型池状态 + 模型增 / 改 / 删(仅写 config.yml,到「设置」页重启才生效)。
// 配置为 platforms 层级（平台 → models + keys）：url/type/models 在平台层，api_key/concurrency 在 Key 层，
// 同一份 models 被该平台下所有 key 共用。模型项 {id, display_name, vision, enable, ...}；id 只需同平台内唯一
// （内部唯一键 = 平台名/模型id，effective.models 的 id 即该键、mid 为原始模型名）。
// 页面 PATCH 用 platforms[i].models[k] 定位（key_index 不进入路径,因为模型与 key 解耦）；
// 新增一律走 append(只动目标数组,脱敏 key 绝不整体回写文件);已有 Key 的 api_key 修改请走配置原文编辑器。
// 展示层暂按「平台名 + 脱敏 Key」分组(cf. models.js modelGroupHtml)：每组都展示该平台下所有 models
// (key 间重复),等后续 UI 重构再去重;余额按 key 拆开,每个 key 一行。
'use strict';

window.tabModules = window.tabModules || {};

let cfgPlatforms = [];          // effective.platforms(服务端已对 api_key 脱敏)
let cfgModels = [];             // 打平后的 effective.models(含 platform_index/key_index/model_index)
                               // 注:同一 (name/id) 在 cfgModels 里出现 N 次(N=key 数),key_index 区分 key 副本
let runtimeById = {};           // 运行池状态,按 id 关联
let modelsPendingRestart = false;
let moeIdx = -1;                // 当前编辑弹窗对应的打平下标;-1 = 新增
let expandedGroups = {};        // 模型池分组展开态,key =「pi-ki」;余额按 key 拆,分组即 Key 槽位,默认折叠
let balanceByGroup = {};        // 余额查询结果缓存,key =「pi-ki」;切 Tab/写配置时清空
let balanceRequested = {};      // 本 Tab 会话内该分组是否已自动查过(首次展开只自动查一次)
let balanceTypes = [];          // 后端已接入余额查询的平台类型(GET /api/config 的 balance_types)

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
  // 首次展开自动查一次余额(mbal 存在 = 该类型已接入);标记随切 Tab 重置,
  // 故每次切到模型 Tab 后,每个分组只自动查一次,反复折叠展开不重复请求
  if (on && !balanceRequested[gk] && $('mbal-' + gk)) {
    const parts = gk.split('-');
    fetchBalance(gk, Number(parts[0]), Number(parts[1]), false);
  }
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

// 余额展示文案与悬停详情(查询成功后才有值,默认 --)
function balText(gk) {
  const b = balanceByGroup[gk];
  if (!b) return '余额 --';
  if (b.error) return '余额 查询失败';
  return '余额 ' + (b.total_balance == null ? '--' : b.total_balance) + (b.currency ? ' ' + esc(b.currency) : '');
}
function balTitle(gk) {
  const b = balanceByGroup[gk];
  if (!b) return '';
  if (b.error) return '查询失败:' + b.error;
  const parts = [];
  if (b.available === false) parts.push('上游报告余额不可用');
  if (b.granted_balance != null) parts.push('赠送 ' + b.granted_balance);
  if (b.topped_up_balance != null) parts.push('充值 ' + b.topped_up_balance);
  return parts.join(' · ');
}

async function fetchBalance(gk, pi, ki, manual) {
  balanceRequested[gk] = true; // 无论成败,本 Tab 会话不再自动重查(手动刷新不受限)
  const btn = $('mbrg-' + gk);
  if (btn) btn.classList.add('spin');
  const el = $('mbal-' + gk);
  if (el) el.textContent = '余额 …';
  try {
    const r = await req('GET', '/api/platforms/balance?pi=' + pi + '&ki=' + ki);
    const b = r.balance || {};
    balanceByGroup[gk] = {
      total_balance: b.total_balance, currency: b.currency,
      granted_balance: b.granted_balance, topped_up_balance: b.topped_up_balance,
      available: b.is_available,
    };
  } catch (e) {
    balanceByGroup[gk] = { error: e.message };
    if (manual) toast('查余额失败:' + e.message); // 自动查询失败只落悬停详情,不打扰
  }
  if (btn) btn.classList.remove('spin');
  const el2 = $('mbal-' + gk);
  if (el2) { el2.textContent = balText(gk); el2.title = balTitle(gk); }
}

// 点刷新图标:无视「本轮已查过」标记,总是重新请求
function refreshBalance(ev, pi, ki) {
  if (ev) ev.stopPropagation(); // 冒泡到分组头会误触折叠/展开
  fetchBalance(pi + '-' + ki, pi, ki, true);
}

// 余额行刷新图标(环形箭头)
const BAL_REFRESH_SVG = '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';

function modelGroupHtml(pi, ki) {
  const p = cfgPlatforms[pi] || {};
  const k = (p.keys || [])[ki] || {};
  const gk = pi + '-' + ki;
  // 该平台下所有 models(不按 key_index 过滤;key 间会重复展示,等后续 UI 重构再去重)
  const models = cfgModels.filter(m => m.platform_index === pi && m.key_index === ki);
  // 同 id 在 cfgModels 里出现 N 次(每个 key 副本),卡片只画一次以避免视觉重复;
  // 取该 key 副本下首条即可(同 id 字段相同,渲染无差异)。
  const seen = new Set();
  const dedup = [];
  for (const m of models) { if (!seen.has(m.id)) { seen.add(m.id); dedup.push(m); } }
  const open = !!expandedGroups[gk];
  // 仅已接入余额查询的类型显示余额行(未接入的显示出来也只会是报错,不如不显示)
  const hasBal = balanceTypes.indexOf(String(p.type || '')) >= 0;
  return '<div class="model-group' + (open ? ' open' : '') + '" id="mgrp-' + gk + '">' +
    '<div class="model-group-head" onclick="modelsUI.toggleGroup(\'' + gk + '\')">' +
      '<svg class="model-group-caret" viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"></polyline></svg>' +
      '<span class="model-group-name">' + esc(p.name || ('平台' + pi)) + '</span>' +
      '<span class="model-group-key">' + esc(k.api_key ? maskKey(k.api_key) : '无 key') + '</span>' +
      '<span class="model-group-meta">' + dedup.length + ' 模型</span>' +
    '</div>' +
    '<div class="model-group-body' + (open ? '' : ' hidden') + '">' +
      (hasBal ?
        '<div class="model-group-bal">' +
          '<span id="mbal-' + gk + '" title="' + esc(balTitle(gk)) + '">' + balText(gk) + '</span>' +
          '<button class="mbal-refresh" id="mbrg-' + gk + '" title="重新查询余额" onclick="modelsUI.refreshBalance(event,' + pi + ',' + ki + ')">' + BAL_REFRESH_SVG + '</button>' +
        '</div>' : '') +
      (dedup.length ? dedup.map(modelCardHtml).join('') : '<div class="model-group-empty">该 Key 下暂无模型</div>') +
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
    balanceTypes = cg.balance_types || [];
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
        : '<div class="empty-tip">token 格式为「输入 / 输出」;余额在分组首次展开时自动查询,点刷新图标可重查;改动写入 config.yml,重启服务后生效。</div>');
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
  balanceByGroup = {};      // 配置变了,旧余额不再对应现有 pi/ki 槽位
  balanceRequested = {};
  toast('已写入 config.yml,到「设置」页重启后生效');
  loadModelCards();
}

// ---------- 编辑/新增弹窗 ----------
// Key 标签:「平台名 · sk-***1234」;下拉里用它标识可挂模型的目标 Key(新增模式下展示,实际模型与 key 解耦,
// 所有 key 都共享 platforms.models)。
function keyLabel(pi, ki) {
  const p = cfgPlatforms[pi] || {};
  const k = (p.keys || [])[ki] || {};
  return (p.name || ('平台' + pi)) + ' · ' + (k.api_key ? maskKey(k.api_key) : '无 key');
}

function targetOptions() {
  let html = '';
  cfgPlatforms.forEach((p, pi) => {
    const n = (p.models || []).length;
    html += '<option value="plat:' + pi + '">' +
      esc(p.name || ('平台' + pi)) + '(' + n + ' 模型)</option>';
  });
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
    // 编辑时锁定目标为本模型所属平台(模型与 key 解耦后,移动模型 = 改 platforms[pi],已不支持)
    const p = cfgPlatforms[m.platform_index] || {};
    tgt.innerHTML = '<option value="plat:' + m.platform_index + '">' + esc(p.name || ('平台' + m.platform_index)) + '</option>';
    tgt.disabled = true;
  }
  tgt.onchange = onTargetChange;
  onTargetChange(); // add 模式默认 plat:0 → 两组附加字段都隐藏
  $('moe-del-btn').classList.toggle('hidden', add);
  $('model-edit-modal').classList.remove('hidden');
}
function closeModelEditor() { $('model-edit-modal').classList.add('hidden'); }

async function saveModelEditor() {
  const id = $('moe-id').value.trim();
  if (!id) return toast('请填写 id');
  // 模型项本身只含 id/display_name/vision;url/type 在平台层,api_key/concurrency 在 Key 层,这里不动。
  const model = {
    id,
    display_name: $('moe-name').value.trim() || id,
    vision: $('moe-vision').checked,
  };
  const add = moeIdx < 0;
  let body;
  if (!add) {
    // 编辑:改到 platforms[pi].models[mi](与 key 解耦,所有 key 共享同一份 models)
    const m = cfgModels[moeIdx];
    body = { path: ['platforms', m.platform_index, 'models', m.model_index], value: model };
  } else {
    const t = $('moe-target').value;
    // id 唯一性只看同平台（内部键 = 平台名/模型id）；不同平台可同名。
    let platIdx = -1;
    if (t === 'newkey') platIdx = parseInt($('moe-nk-plat').value, 10);
    else if (t.indexOf('plat:') === 0) platIdx = Number(t.split(':')[1]);
    if (platIdx >= 0) {
      const p = cfgPlatforms[platIdx] || {};
      if (cfgModels.some(x => x.platform === p.name && x.mid === id)) {
        return toast('平台「' + (p.name || '') + '」下已有模型 id：' + id);
      }
    }
    if (t === 'newplat') {
      const url = $('moe-np-url').value.trim().replace(/\/+$/, '');
      if (!url) return toast('请填写平台上游地址');
      // append 一整个新平台:含一份 models 和一个 key;key 明文只在此时输入一次。
      body = { op: 'append', path: ['platforms'], value: {
        name: $('moe-np-name').value.trim(),
        url,
        type: $('moe-np-type').value.trim(),
        models: [model],
        keys: [{ api_key: $('moe-np-key').value.trim(), concurrency: parseInt($('moe-np-con').value, 10) || 1 }],
      } };
    } else if (t === 'newkey') {
      if (!(platIdx >= 0)) return toast('请选择平台');
      // append 一个新 Key 到已有平台(models 与 key 解耦,这里只追加 key,不重复 model)
      body = { op: 'append', path: ['platforms', platIdx, 'keys'], value: {
        api_key: $('moe-nk-key').value.trim(), concurrency: parseInt($('moe-nk-con').value, 10) || 1 } };
      // 紧接着把模型 append 到 platforms[platIdx].models
      await req('PATCH', '/api/config', body);
      try {
        await req('PATCH', '/api/config', { op: 'append', path: ['platforms', platIdx, 'models'], value: model });
      } catch (e) { throw e; }
      closeModelEditor();
      afterWrite();
      return;
    } else {
      // plat:pi → append 模型到 platforms[pi].models
      body = { op: 'append', path: ['platforms', platIdx, 'models'], value: model };
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
  // 唯一性:同 id 在 cfgModels 里出现 N 次(N=key 数);删之前确认至少还剩一个平台的模型数 > 0
  const otherIds = new Set(cfgModels.filter(x => x.id !== m.id).map(x => x.id));
  if (otherIds.size < 1) return toast('至少要保留一个模型');
  const ok = await confirmModal('删除模型', '删除模型「' + (m.display_name || m.id) + '」?将从 platforms 中移除该模型项（该平台下所有 key 都不再可用此模型）。', '删除', true);
  if (!ok) return;
  try {
    // delete 到 platforms[pi].models[mi](与 key 解耦);YAML 数组删项会自动收紧,不影响其他行注释。
    await req('PATCH', '/api/config', { path: ['platforms', m.platform_index, 'models', m.model_index], op: 'delete' });
    SET.deletedModels[m.id] = true; // 重启前后端仍会返回该模型,本地标记隐藏
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
  refreshBalance: refreshBalance,
};

tabModules.models = {
  // 每次切到模型 Tab:余额结果与「本 Tab 已自动查过」标记一并重置,
  // 分组首次点开时重新自动查一次(对应需求:每次切 Tab 后只首次点开自动更新)
  onShow() { balanceByGroup = {}; balanceRequested = {}; loadModelCards(); },
};
