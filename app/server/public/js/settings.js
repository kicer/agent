// 设置 Tab:用户信息 + config.yml 管理。
// 阶段 1 先注册模块占位并显示登录用户;阶段 5 实现配置编辑与重启。
'use strict';

window.tabModules = window.tabModules || {};

// 显示当前登录用户(沿用 1.0 逻辑;未启用认证时静默跳过)
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

tabModules.settings = {
  onShow() {
    refreshUser();
  },
};
