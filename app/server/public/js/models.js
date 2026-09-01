// 模型 Tab(阶段 5):模型池状态 + 增 / 改 / 删(仅写 config.yml,到「设置」页重启才生效)。
// 状态(忙/闲)来自运行中的模型池 /api/models;配置(名称/地址/key/vision)来自 /api/config effective。
// 说明:删除/新增按整段替换 models(该段注释会丢失);id 不提供页面修改(会话按 id 绑定,改 id 属危险操作)。
'use strict';

window.tabModules = window.tabModules || {};

// 配置里的模型数组(下标即 PATCH 下标);运行态按 id 关联
let cfgModels = [];
let runtimeById = {};
let modelsPendingRestart = false;

async function loadModelCards() {
  const el = $('model-cards');
  if (!el) return;
  try {
    const [rt, cg] = await Promise.all([req('GET', '/api/models'), req('GET', '/api/config')]);
    runtimeById = {};
    for (const m of rt || []) runtimeById[m.id] = m;
    cfgModels = (cg.effective && cg.effective.models) || [];
    if (!cfgModels.length) {
      el.innerHTML = '<div class="empty-tip">尚未配置模型,点右上角 + 添加。</div>';
      return;
    }
    el.innerHTML = cfgModels.map(m => {
      const run = runtimeById[m.id];
      // 运行池里没有 = 配置新增但还没重启生效
      const stateHtml = run
        ? '<span class="model-card-state ' + (run.is_busy ? 'busy' : 'idle') + '">' + (run.is_busy ? '占用中' : '空闲') + '</span>'
        : '<span class="model-card-state pending">待重启</span>';
      return '<div class="model-card">' +
        '<div class="model-card-head">' +
          '<span class="model-card-name">' + esc(m.display_name || m.id) + '</span>' + stateHtml +
        '</div>' +
        '<div class="model-card-meta">' + esc(m.id) +
          (run && run.is_busy && run.current_session_id ? ' · 会话 ' + esc(run.current_session_id) : '') + '</div>' +
        '<div class="cfg-kv"><label>地址</label><b>' + esc(m.url) + '</b>' +
          '<button class="file-act" onclick="modelsUI.edit(\'' + encodeURIComponent(m.id) + '\',\'url\')">改</button></div>' +
        '<div class="cfg-kv"><label>api_key</label><b>' + (m.api_key ? '已设置(••••' + esc(String(m.api_key).slice(-4)) + ')' : '(未设置)') + '</b>' +
          '<button class="file-act" onclick="modelsUI.edit(\'' + encodeURIComponent(m.id) + '\',\'api_key\')">改</button></div>' +
        '<div class="cfg-kv"><label>支持图片</label><b>' + (m.vision ? '是' : '否') + '</b>' +
          '<button class="file-act" onclick="modelsUI.toggleVision(\'' + encodeURIComponent(m.id) + '\')">' + (m.vision ? '关' : '开') + '</button></div>' +
        '<div class="model-card-foot"><button class="file-act" onclick="modelsUI.rename(\'' + encodeURIComponent(m.id) + '\')">改显示名</button>' +
          '<button class="file-act del" onclick="modelsUI.del(\'' + encodeURIComponent(m.id) + '\')">删除模型</button></div>' +
      '</div>';
    }).join('') +
      (modelsPendingRestart
        ? '<div class="empty-tip">已写入 config.yml,到「设置」页重启服务后生效。</div>'
        : '<div class="empty-tip">改动写入 config.yml,重启服务后生效。token 用量统计在阶段 4 上线。</div>');
  } catch (e) {
    el.innerHTML = '<div class="empty-tip">加载失败:' + esc(e.message) + '</div>';
  }
}

function idxOf(id) {
  for (let i = 0; i < cfgModels.length; i++) if (cfgModels[i].id === id) return i;
  return -1;
}
function afterWrite(r) {
  modelsPendingRestart = true;
  toast('已写入 config.yml,到「设置」页重启后生效');
  loadModelCards();
}

// ---------- 增 ----------
function openAddModel() {
  ['model-new-id', 'model-new-name', 'model-new-url', 'model-new-key'].forEach(i => { $(i).value = ''; });
  $('model-new-vision').checked = false;
  $('model-add-modal').classList.remove('hidden');
  $('model-new-id').focus();
}
function closeAddModel() { $('model-add-modal').classList.add('hidden'); }

async function addModel() {
  const id = $('model-new-id').value.trim();
  const url = $('model-new-url').value.trim();
  if (!id) { toast('请填写 id'); return; }
  if (idxOf(id) >= 0) { toast('id 已存在:' + id); return; }
  if (!url) { toast('请填写上游地址'); return; }
  const m = {
    id,
    display_name: $('model-new-name').value.trim() || id,
    url,
    api_key: $('model-new-key').value.trim(),
    vision: $('model-new-vision').checked,
  };
  try {
    const r = await req('PATCH', '/api/config', { path: 'models', value: cfgModels.concat([m]) });
    closeAddModel();
    afterWrite(r);
  } catch (e) { toast('添加失败:' + e.message); }
}

// ---------- 改 ----------
async function patchModel(id, field, value) {
  const i = idxOf(id);
  if (i < 0) return toast('模型不存在:' + id);
  try {
    const r = await req('PATCH', '/api/config', { path: ['models', i, field], value });
    afterWrite(r);
  } catch (e) { toast('保存失败:' + e.message); }
}

async function editModel(rawId, field) {
  const id = decodeURIComponent(rawId);
  const m = cfgModels[idxOf(id)] || {};
  const label = field === 'url' ? '上游地址(OpenAI 兼容 /v1,不带尾斜杠)' : 'API Key(留空则不带鉴权头)';
  // api_key 不回填旧值,避免密钥展示在输入框
  const v = prompt(label + ':', field === 'url' ? (m.url || '') : '');
  if (v == null) return;
  await patchModel(id, field, v.trim());
}

async function renameModel(rawId) {
  const id = decodeURIComponent(rawId);
  const m = cfgModels[idxOf(id)] || {};
  const v = prompt('显示名:', m.display_name || '');
  if (v == null) return;
  const name = v.trim();
  if (!name) return toast('显示名不能为空');
  await patchModel(id, 'display_name', name);
}

async function toggleVision(rawId) {
  const id = decodeURIComponent(rawId);
  const m = cfgModels[idxOf(id)] || {};
  if (!confirm('模型「' + (m.display_name || id) + '」支持图片输入(vision)?\n确定=开启,取消=关闭')) return;
  await patchModel(id, 'vision', !m.vision);
}

// ---------- 删(整段替换 models,会丢该段注释) ----------
async function delModel(rawId) {
  const id = decodeURIComponent(rawId);
  const i = idxOf(id);
  if (i < 0) return;
  const m = cfgModels[i];
  if (cfgModels.length <= 1) return toast('至少要保留一个模型');
  if (!confirm('删除模型「' + (m.display_name || id) + '」?将整体重写 models 段(注释可能丢失)。')) return;
  try {
    const r = await req('PATCH', '/api/config', { path: 'models', value: cfgModels.filter(x => x.id !== id) });
    afterWrite(r);
  } catch (e) { toast('删除失败:' + e.message); }
}

window.modelsUI = {
  openAdd: openAddModel,
  closeAdd: closeAddModel,
  add: addModel,
  edit: editModel,
  rename: renameModel,
  toggleVision: toggleVision,
  del: delModel,
};

tabModules.models = {
  onShow() { loadModelCards(); },
};
