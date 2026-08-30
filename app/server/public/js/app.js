// Agent 任务台前端：会话列表 / 聊天（SSE 流式）/ 文件管理 / 阶段开关
// 交互风格参考 ai-xiaocai（移动优先、左右滑动切页）。
'use strict';

if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });
}

const state = {
  sessionId: null,
  phase: 'planning',
  status: '',
  es: null,
  streamEl: null,
  streamText: '',
  toolCards: {},
  filePanelOpen: false,
};

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
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
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
function toolArgsSummary(name, argsStr) {
  let s = '';
  try {
    const o = JSON.parse(argsStr || '{}');
    const key = ['path', 'command', 'regex', 'glob', 'url', 'query', 'source_path', 'destination_path'];
    for (const k of key) if (o[k]) { s = String(o[k]); break; }
    if (!s) s = argsStr || '';
  } catch (_) { s = argsStr || ''; }
  if (s.length > 80) s = s.slice(0, 80) + '…';
  return s;
}

// ---------- 页面切换 ----------
function showChat() {
  $('list-page').classList.add('off-left');
  $('chat-page').classList.remove('hidden');
  $('chat-page').classList.add('off-right');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => $('chat-page').classList.remove('off-right'));
  });
}
function showList() {
  $('chat-page').classList.add('off-right');
  setTimeout(() => {
    $('chat-page').classList.add('hidden');
    $('list-page').classList.remove('off-left');
  }, 50);
}

// 滑动切换：聊天页右滑返回列表
(function bindSwipe() {
  let x0 = null, y0 = null;
  $('chat-page').addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  $('chat-page').addEventListener('touchend', e => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (dx > 70 && Math.abs(dy) < 60) ui.backToList();
  }, { passive: true });
})();

// ---------- 会话列表 ----------
async function loadSessions() {
  try {
    const rows = await req('GET', '/api/sessions');
    const el = $('session-list');
    if (!rows.length) {
      el.innerHTML = '<div class="empty-tip">还没有任务，点右上角 + 新建</div>';
      return;
    }
    el.innerHTML = rows.map(s => {
      const st = { queued: '排队中', active: '活跃中', completed: '已完成', cancelled: '已终止' }[s.status] || s.status;
      const badge = '<span class="badge ' + s.status + '">' + st + (s.status === 'queued' && s.queue_pos ? ' #' + s.queue_pos : '') + '</span>';
      const phase = s.phase === 'execution' ? '<span class="badge execution">执行中阶段</span>' : '';
      return '<div class="session-card" onclick="ui.openSession(\'' + s.id + '\')">' +
        '<div class="session-main">' +
          '<div class="session-name">' + esc(s.title || s.id) + '</div>' +
          '<div class="session-meta"><span>' + esc(s.id) + '</span>' + badge + phase +
          (s.model_id ? '<span>' + esc(s.model_id) + '</span>' : '') + '</div>' +
        '</div>' +
        '<button class="session-del" onclick="event.stopPropagation();ui.deleteSession(\'' + s.id + '\')">删除</button>' +
      '</div>';
    }).join('');
  } catch (e) { toast('加载会话失败：' + e.message); }
}

async function loadModels() {
  try {
    const rows = await req('GET', '/api/models');
    $('model-strip').innerHTML = rows.map(m =>
      '<span class="model-chip ' + (m.is_busy ? 'busy' : '') + '">' +
      esc(m.display_name || m.id) + (m.is_busy ? ' 忙' : ' 空闲') + '</span>').join('');
  } catch (_) {}
}

// ---------- 消息渲染 ----------
function md(text) {
  if (typeof marked === 'undefined') return esc(text);
  try { return marked.parse(text || ''); } catch (_) { return esc(text); }
}

function renderToolCard(id, name, argsStr) {
  const div = document.createElement('div');
  div.className = 'tool-card';
  div.id = 'tool-' + id;
  div.innerHTML =
    '<details><summary><span class="spin">◌</span>' +
    '<span class="tool-name">' + esc(name) + '</span>' +
    '<span class="tool-args">' + esc(toolArgsSummary(name, argsStr)) + '</span></summary>' +
    '<pre>执行中…</pre></details>';
  return div;
}

function fillToolResult(id, content, isError) {
  const card = document.getElementById('tool-' + id);
  if (!card) return;
  if (isError) card.classList.add('error');
  card.querySelector('.spin').textContent = isError ? '✕' : '✓';
  card.querySelector('pre').textContent = content || '（空）';
}

function msgNode(m, cardMap) {
  if (m.role === 'tool') {
    if (m.tool_call_id && cardMap && cardMap[m.tool_call_id]) {
      fillToolResult(m.tool_call_id, m.content, false);
    }
    return null;
  }
  const wrap = document.createElement('div');
  if (m.role === 'user') {
    wrap.className = 'msg me';
    wrap.innerHTML = '<div class="msg-user">我</div>' +
      '<div class="msg-bubble">' + esc(m.content) + '</div>' +
      '<div class="msg-time">' + fmtTime(m.created_at) + '</div>';
    return wrap;
  }
  if (m.role === 'assistant') {
    wrap.className = 'msg other';
    const gray = state.status === 'queued' ? ' gray' : '';
    let inner = '<div class="msg-user"><span class="ai-avatar' + gray + '"></span>AI' +
      (m.model_tag ? ' · ' + esc(m.model_tag) : '') + '</div>';
    if (m.content) inner += '<div class="msg-bubble">' + md(m.content) + '</div>';
    inner += '<div class="msg-time">' + fmtTime(m.created_at) + '</div>';
    wrap.innerHTML = inner;
    return wrap;
  }
  return null;
}

function appendToolCardsFromAssistant(m, container) {
  if (!m.tool_calls) return;
  let calls;
  try { calls = typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls; } catch (_) { return; }
  for (const c of calls) {
    const id = c.id || ('c' + Math.random().toString(36).slice(2, 10));
    const card = renderToolCard(id, c.function.name, c.function.arguments);
    container.appendChild(card);
    state.toolCards[id] = card;
  }
}

async function renderDetail(detail) {
  const box = $('messages');
  box.innerHTML = '';
  state.streamEl = null;
  state.streamText = '';
  state.toolCards = {};
  const s = detail.session;
  state.phase = s.phase;
  state.status = s.status;
  updatePhaseUI();
  $('chat-title').textContent = s.title || s.id;
  for (const m of detail.messages) {
    const node = msgNode(m, state.toolCards);
    if (node) box.appendChild(node);
    if (m.role === 'assistant') appendToolCardsFromAssistant(m, box);
  }
  if (!detail.messages.length) {
    box.innerHTML = '<div class="empty-tip">描述你的需求，AI 会先和你讨论（规划阶段）。</div>';
  }
  scrollBottom();
  loadFiles();
}

function scrollBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

// ---------- SSE ----------
function connectStream() {
  if (state.es) { state.es.close(); state.es = null; }
  const es = new EventSource('/api/sessions/' + state.sessionId + '/stream');
  state.es = es;
  es.addEventListener('status', ev => {
    const d = JSON.parse(ev.data);
    state.status = d.status;
    state.phase = d.phase;
    updatePhaseUI(d);
  });
  es.addEventListener('phase', ev => {
    state.phase = JSON.parse(ev.data).phase;
    updatePhaseUI();
  });
  es.addEventListener('assistant_delta', ev => {
    const d = JSON.parse(ev.data);
    if (!state.streamEl) {
      const wrap = document.createElement('div');
      wrap.className = 'msg other';
      wrap.innerHTML = '<div class="msg-user"><span class="ai-avatar"></span>AI</div>' +
        '<div class="msg-bubble"></div>';
      state.streamEl = wrap.querySelector('.msg-bubble');
      state.streamText = '';
      $('messages').appendChild(wrap);
    }
    state.streamText += d.text;
    state.streamEl.textContent = state.streamText;
    scrollBottom();
  });
  es.addEventListener('assistant_message', ev => {
    const d = JSON.parse(ev.data);
    if (state.streamEl) {
      const bubble = state.streamEl;
      bubble.innerHTML = md(d.content || '');
      state.streamEl = null;
      state.streamText = '';
    } else if (d.content) {
      const box = $('messages');
      const wrap = document.createElement('div');
      wrap.className = 'msg other';
      wrap.innerHTML = '<div class="msg-user"><span class="ai-avatar"></span>AI</div>' +
        '<div class="msg-bubble">' + md(d.content) + '</div>';
      box.appendChild(wrap);
    }
    if (d.tool_calls) {
      appendToolCardsFromAssistant({ tool_calls: d.tool_calls }, $('messages'));
      scrollBottom();
    }
  });
  es.addEventListener('tool_call', ev => {
    const d = JSON.parse(ev.data);
    const card = renderToolCard(d.id, d.name, d.arguments);
    $('messages').appendChild(card);
    state.toolCards[d.id] = card;
    scrollBottom();
  });
  es.addEventListener('tool_result', ev => {
    const d = JSON.parse(ev.data);
    fillToolResult(d.tool_call_id, d.content, d.is_error);
    scrollBottom();
  });
  es.addEventListener('done', ev => {
    loadSessions();
    loadModels();
  });
  es.addEventListener('error', ev => {
    try {
      const d = JSON.parse(ev.data);
      if (d && d.message) toast('错误：' + d.message);
    } catch (_) { /* EventSource 连接错误，自动重连 */ }
  });
}

// ---------- 阶段开关 ----------
function updatePhaseUI(d) {
  const btn = $('phase-switch');
  const pill = $('status-pill');
  const stMap = { queued: '排队中', active: '活跃中', completed: '已完成', cancelled: '已终止' };
  let text = stMap[state.status] || state.status || '--';
  if (d && d.queue_pos) text += '（第 ' + d.queue_pos + ' 位）';
  if (state.status === 'active') {
    const run = d && d.running;
    text = '活跃中 · ' + (state.phase === 'execution' ? '执行' : '规划') + (d && d.model_id ? ' · ' + d.model_id : '');
  }
  pill.textContent = text;
  if (state.phase === 'execution') {
    btn.textContent = '■ 终止';
    btn.className = 'phase-switch execution';
  } else {
    btn.textContent = '▶ 开始执行';
    btn.className = 'phase-switch planning';
  }
}

// ---------- 文件 ----------
async function loadFiles() {
  if (!state.sessionId) return;
  try {
    const files = await req('GET', '/api/sessions/' + state.sessionId + '/files');
    const el = $('files-list');
    if (!files.length) {
      el.innerHTML = '<div class="empty-tip">还没有文件。上传文件或在执行阶段让 AI 生成。</div>';
      return;
    }
    el.innerHTML = files.map(f => {
      const url = '/api/sessions/' + state.sessionId + '/files/download?path=' + encodeURIComponent(f.filename);
      return '<div class="file-row"><span class="file-name">' + esc(f.filename) + '</span>' +
        '<span class="file-size">' + fmtSize(f.size) + '</span>' +
        '<a class="file-act" href="' + url + '">下载</a>' +
        '<button class="file-act del" onclick="ui.deleteFile(\'' + esc(f.filename).replace(/'/g, '%27') + '\')">删</button></div>';
    }).join('');
  } catch (e) { toast('读取文件失败：' + e.message); }
}

// ---------- 主逻辑 ----------
const ui = {
  openCreate() { $('create-modal').classList.remove('hidden'); $('new-title').focus(); },
  closeCreate() { $('create-modal').classList.add('hidden'); },
  async createSession() {
    try {
      const title = $('new-title').value.trim();
      const s = await req('POST', '/api/sessions', { title });
      this.closeCreate();
      $('new-title').value = '';
      await loadSessions();
      this.openSession(s.id);
    } catch (e) { toast('创建失败：' + e.message); }
  },
  async deleteSession(id) {
    if (!confirm('删除会话？')) return;
    const delDir = confirm('同时删除任务目录（文件将不可恢复）？\n取消 = 仅删除会话记录');
    try {
      await req('DELETE', '/api/sessions/' + id + '?delete_dir=' + (delDir ? 'true' : 'false'));
      if (state.sessionId === id) this.backToList();
      loadSessions();
    } catch (e) { toast('删除失败：' + e.message); }
  },
  async openSession(id) {
    state.sessionId = id;
    showChat();
    try {
      const detail = await req('GET', '/api/sessions/' + id);
      await renderDetail(detail);
      connectStream();
    } catch (e) { toast('打开会话失败：' + e.message); }
  },
  backToList() {
    if (state.es) { state.es.close(); state.es = null; }
    state.sessionId = null;
    showList();
    loadSessions();
    loadModels();
  },
  async send() {
    const ta = $('msg-input');
    const content = ta.value.trim();
    if (!content || !state.sessionId) return;
    ta.value = '';
    ta.style.height = 'auto';
    const box = $('messages');
    const tip = box.querySelector('.empty-tip');
    if (tip) tip.remove();
    try {
      const r = await req('POST', '/api/sessions/' + state.sessionId + '/messages', { content });
      const wrap = document.createElement('div');
      wrap.className = 'msg me';
      wrap.innerHTML = '<div class="msg-user">我' + (r.delivered === 'queued' ? '（排队中，暂存）' : '') + '</div>' +
        '<div class="msg-bubble">' + esc(content) + '</div>';
      box.appendChild(wrap);
      scrollBottom();
    } catch (e) { toast('发送失败：' + e.message); }
  },
  async togglePhase() {
    if (!state.sessionId) return;
    try {
      if (state.phase === 'planning') {
        await req('POST', '/api/sessions/' + state.sessionId + '/start');
        state.phase = 'execution';
        updatePhaseUI();
        const box = $('messages');
        const wrap = document.createElement('div');
        wrap.className = 'msg me';
        wrap.innerHTML = '<div class="msg-user">我（开始执行）</div>' +
          '<div class="msg-bubble">我说完了，你可以开始干活了。先把我上面说的需求整理成 task.md 文件写入任务目录，然后按照 task.md 开始执行。</div>';
        box.appendChild(wrap);
        scrollBottom();
      } else {
        await req('POST', '/api/sessions/' + state.sessionId + '/stop');
        toast('已发送终止指令');
      }
    } catch (e) { toast('操作失败：' + e.message); }
  },
  toggleFiles() {
    state.filePanelOpen = !state.filePanelOpen;
    $('files-panel').classList.toggle('hidden', !state.filePanelOpen);
    if (state.filePanelOpen) loadFiles();
  },
  async uploadFiles(ev) {
    const input = ev.target;
    const files = input.files;
    if (!files || !files.length || !state.sessionId) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    input.value = '';
    try {
      const r = await req('POST', '/api/sessions/' + state.sessionId + '/files', fd, true);
      toast('已上传 ' + r.uploaded.length + ' 个文件');
      loadFiles();
    } catch (e) { toast('上传失败：' + e.message); }
  },
  async deleteFile(name) {
    if (!confirm('删除文件 ' + name + '？')) return;
    try {
      await req('DELETE', '/api/sessions/' + state.sessionId + '/files?path=' + encodeURIComponent(name));
      loadFiles();
    } catch (e) { toast('删除失败：' + e.message); }
  },
};

// ---------- 输入框行为 ----------
document.addEventListener('input', e => {
  if (e.target.id === 'msg-input') {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  }
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'msg-input' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ui.send();
  }
});

// ---------- 启动 ----------
showList();
loadSessions();
loadModels();
setInterval(loadSessions, 8000);
