// 模型 Tab(阶段 5):模型池状态 + 增 / 改 / 删(仅写 config.yml,到「设置」页重启才生效)。
// 卡片默认只展示:名称 / id / 运行状态 + 余额占位 + 今日/累计 token 用量(model_usage 表统计)。
// 编辑走统一弹窗(新增复用同一弹窗);id 不可页面修改(会话按 id 绑定,改 id 走配置文件原文)。
'use strict';

window.tabModules = window.tabModules || {};

let cfgModels = [];             // 配置里的模型数组(下标即 PATCH 下标)
let runtimeById = {};           // 运行池状态,按 id 关联
let modelsPendingRestart = false;
let moeIdx = -1;                // 当前编辑弹窗对应的下标;-1 = 新增

function fmtTok(n) {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

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
          '<span class="model-card-name" title="点击编辑" onclick="modelsUI.openEdit(\'' + encodeURIComponent(m.id) + '\')">' + esc(m.display_name || m.id) + '</span>' +
          stateHtml +
        '</div>' +
        '<div class="model-card-meta">' + esc(m.id) +
          (run && run.is_busy && run.current_session_id ? ' · 会话 ' + esc(run.current_session_id) : '') + '</div>' +
        '<div class="cfg-kv"><label>余额</label><b>--</b></div>' +
        // token 紧凑显示:输入 / 输出
        '<div class="cfg-kv"><label>今日 token</label><b title="输入 / 输出">' + (run ? fmtTok(run.today_prompt) + ' / ' + fmtTok(run.today_completion) : '--') + '</b></div>' +
        '<div class="cfg-kv"><label>累计 token</label><b title="输入 / 输出">' + (run ? fmtTok(run.total_prompt) + ' / ' + fmtTok(run.total_completion) : '--') + '</b></div>' +
      '</div>';
    }).join('') +
      (modelsPendingRestart
        ? '<div class="empty-tip">已写入 config.yml,到「设置」页重启服务后生效。</div>'
        : '<div class="empty-tip">token 格式为「输入 / 输出」;余额需对接模型提供方 API,暂未实现;改动写入 config.yml,重启服务后生效。</div>');
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
function openModelEditor(rawId) {
  const add = rawId == null;
  moeIdx = add ? -1 : idxOf(decodeURIComponent(rawId));
  if (!add && moeIdx < 0) return toast('模型不存在');
  const m = add ? { display_name: '', id: '', url: '', api_key: '', vision: false } : cfgModels[moeIdx];
  $('moe-title').textContent = add ? '添加模型' : '编辑模型';
  $('moe-name').value = m.display_name || '';
  const idIn = $('moe-id');
  idIn.value = m.id || '';
  idIn.disabled = !add; // 编辑时禁改 id(历史会话按 id 绑定)
  $('moe-url').value = m.url || '';
  $('moe-key').value = m.api_key || '';
  $('moe-vision').checked = !!m.vision;
  $('moe-del-btn').classList.toggle('hidden', add);
  $('model-edit-modal').classList.remove('hidden');
}
function closeModelEditor() { $('model-edit-modal').classList.add('hidden'); }

async function saveModelEditor() {
  const add = moeIdx < 0;
  const id = $('moe-id').value.trim();
  const url = $('moe-url').value.trim().replace(/\/+$/, '');
  if (!id) return toast('请填写 id');
  if (!url) return toast('请填写上游地址');
  const obj = {
    id,
    display_name: $('moe-name').value.trim() || id,
    url,
    api_key: $('moe-key').value.trim(),
    vision: $('moe-vision').checked,
  };
  let body;
  if (add) {
    if (idxOf(id) >= 0) return toast('id 已存在:' + id);
    body = { path: 'models', value: cfgModels.concat([obj]) };
  } else {
    // 整项替换;key 顺序固定,保持配置文件观感一致
    body = { path: ['models', moeIdx], value: obj };
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
  const ok = await confirmModal('删除模型', '删除模型「' + (m.display_name || m.id) + '」?将整体重写 models 段(注释可能丢失)。', '删除', true);
  if (!ok) return;
  try {
    await req('PATCH', '/api/config', { path: 'models', value: cfgModels.filter(x => x.id !== m.id) });
    afterWrite();
  } catch (e) { toast('删除失败:' + e.message); }
}

window.modelsUI = {
  openAdd: function () { openModelEditor(null); },
  openEdit: openModelEditor,
  close: closeModelEditor,
  save: saveModelEditor,
  del: delModelFromModal,
};

tabModules.models = {
  onShow() { loadModelCards(); },
};
