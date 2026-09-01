// 模型 Tab:模型池卡片。
// 阶段 1 先用现有 /api/models 渲染状态占位卡片,验证 Tab 数据链路;
// 阶段 4 补充 token 用量、费用统计与按天曲线。
'use strict';

window.tabModules = window.tabModules || {};

async function loadModelCards() {
  const el = $('model-cards');
  if (!el) return;
  try {
    const rows = await req('GET', '/api/models');
    if (!rows.length) {
      el.innerHTML = '<div class="empty-tip">未配置模型</div>';
      return;
    }
    el.innerHTML = rows.map(m =>
      '<div class="model-card">' +
        '<div class="model-card-head">' +
          '<span class="model-card-name">' + esc(m.display_name || m.id) + '</span>' +
          '<span class="model-card-state ' + (m.is_busy ? 'busy' : 'idle') + '">' + (m.is_busy ? '占用中' : '空闲') + '</span>' +
        '</div>' +
        '<div class="model-card-meta">' + esc(m.id) +
          (m.is_busy && m.current_session_id ? ' · 会话 ' + esc(m.current_session_id) : '') +
        '</div>' +
      '</div>').join('') +
      '<div class="empty-tip">token 用量与费用统计在阶段 4 上线。</div>';
  } catch (e) {
    el.innerHTML = '<div class="empty-tip">加载失败:' + esc(e.message) + '</div>';
  }
}

tabModules.models = {
  onShow() { loadModelCards(); },
};
