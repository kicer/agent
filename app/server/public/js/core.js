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
  streaming: false, // AI 是否正在输出(用于滚动到底部按钮显示加载提示)
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
  const now = new Date();
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  if (now.toDateString() === d.toDateString()) return hm;
  const md = (d.getMonth() + 1) + '/' + d.getDate();
  // 跨天带日期，跨年再带年份
  return (d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '/' + md) + ' ' + hm;
}
// 剪贴板：WebView/局域网 http 非安全上下文没有 navigator.clipboard，降级 execCommand
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) { /* 落入降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ---------- 统一弹窗(替代原生 confirm/prompt;同屏仅弹一个) ----------
let _dlgResolve = null;
function _dlgSettle(val) {
  $('confirm-modal').classList.add('hidden');
  $('prompt-modal').classList.add('hidden');
  const r = _dlgResolve;
  _dlgResolve = null;
  if (r) r(val);
}
// 确认框:resolve(true/false);danger=true 时确定钮红色
function confirmModal(title, text, okText, danger) {
  return new Promise(resolve => {
    _dlgResolve = resolve;
    $('confirm-title').textContent = title || '请确认';
    $('confirm-text').textContent = text || '';
    const ok = $('confirm-ok-btn');
    ok.textContent = okText || '确定';
    ok.style.background = danger ? 'linear-gradient(135deg,#a3352a,#d2483c)' : '';
    $('confirm-modal').classList.remove('hidden');
  });
}
function confirmClose(v) { _dlgSettle(v); }
// 输入框:resolve(字符串) 或取消 resolve(null);opts.type 可指定 password 等输入类型
function promptModal(title, placeholder, initial, opts) {
  return new Promise(resolve => {
    _dlgResolve = resolve;
    $('prompt-title').textContent = title || '请输入';
    const inp = $('prompt-input');
    inp.placeholder = placeholder || '';
    inp.value = initial || '';
    inp.type = opts && opts.type ? opts.type : 'text';
    $('prompt-modal').classList.remove('hidden');
    setTimeout(() => inp.focus(), 60);
  });
}
function promptOk() { _dlgSettle($('prompt-input').value); }
function promptCancel() { _dlgSettle(null); }
(function () {
  const inp = document.getElementById('prompt-input');
  if (inp) inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); promptOk(); }
  });
})();

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
