// Agent 任务台前端核心(2.0):共享工具函数 + 底部导航路由。
// 页面拆分:core.js(本文件)/ tasks.js / skills.js / models.js / settings.js。
// 约定:各业务文件把自身注册进 window.tabModules[tabName] = { onShow() {...} },
// 路由在对应 Tab 每次显示时调用其 onShow()。
'use strict';

if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });
}

// 全局共享状态(目前主要被 tasks.js 使用;core 仅用 sessionId 处理 Tab 切换时的聊天收尾)
const state = {
  sessionId: null,
  status: '',
  es: null,
  streamEl: null,
  streamText: '',
  toolCards: {},
  filePanelOpen: false,
  pendingDeleteId: null,
  pendingEl: null,
  pendingTimer: null,
  pendingStart: 0,
};

window.tabModules = window.tabModules || {};

// ---------- API ----------
async function req(method, url, body, isForm) {
  const opt = { method, headers: {} };
  if (body && !isForm) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  } else if (body && isForm) {
    opt.body = body;
  }
  const res = await fetch(url, opt);
  if (res.status === 401) { location.href = '/login'; throw new Error('未登录'); }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    const err = new Error(msg);
    err.status = res.status; // 供调用方区分 409(重启保护/重名)等状态
    throw err;
  }
  return res.json();
}

// ---------- 工具函数 ----------
function $(id) { return document.getElementById(id); }
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return (today ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + p(d.getHours()) + ':' + p(d.getMinutes());
}
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ---------- 底部导航路由(hash) ----------
const TABS = ['tasks', 'skills', 'models', 'settings'];

function currentTabFromHash() {
  const m = /^#\/(\w+)/.exec(location.hash || '');
  const t = m && m[1];
  return TABS.indexOf(t) >= 0 ? t : 'tasks';
}

function showTab(name) {
  for (const t of TABS) {
    const el = $('tab-' + t);
    if (el) el.classList.toggle('hidden', t !== name);
  }
  for (const a of document.querySelectorAll('.tab-item')) {
    a.classList.toggle('active', a.dataset.tab === name);
  }
  const mod = window.tabModules[name];
  if (mod && typeof mod.onShow === 'function') {
    try { mod.onShow(); } catch (e) { console.error('[tab ' + name + '] onShow 失败', e); }
  }
}

function initRouter() {
  for (const a of document.querySelectorAll('.tab-item')) {
    a.addEventListener('click', () => {
      // 点当前已激活的 Tab 不会触发 hashchange:若正停在聊天详情,直接返回列表
      if (a.dataset.tab === currentTabFromHash() && state.sessionId && window.ui) ui.backToList();
    });
  }
  window.addEventListener('hashchange', () => {
    // 跨 Tab 导航(含浏览器返回键)时,先收尾打开中的聊天详情
    if (state.sessionId && window.ui) ui.backToList();
    showTab(currentTabFromHash());
  });
}

function boot() {
  initRouter();
  showTab(currentTabFromHash());
}
document.addEventListener('DOMContentLoaded', boot);
