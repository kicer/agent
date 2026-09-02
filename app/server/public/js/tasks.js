// 任务 Tab:会话列表 / 聊天(SSE 流式)/ 文件管理 / 阶段开关。
// 交互沿用 1.0:移动优先,聊天详情为全屏覆盖页(盖住底部导航),右滑返回列表。
'use strict';

// ---------- 工具摘要(工具卡片用) ----------
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
function toolArgsFull(argsStr) {
  try { return JSON.stringify(JSON.parse(argsStr || '{}'), null, 2); }
  catch (_) { return argsStr || ''; }
}

// ---------- 聊天详情覆盖页进出(底部导航随之隐藏/恢复) ----------
function showChat() {
  $('tabbar').classList.add('hidden');
  const cp = $('chat-page');
  cp.classList.remove('hidden');
  cp.classList.add('off-right');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => cp.classList.remove('off-right'));
  });
}
function showList() {
  const cp = $('chat-page');
  cp.classList.add('off-right');
  setTimeout(() => cp.classList.add('hidden'), 50);
  $('tabbar').classList.remove('hidden');
}

// 滑动切换:聊天页右滑返回列表
(function bindSwipe() {
  let x0 = null, y0 = null;
  const cp = $('chat-page');
  if (!cp) return;
  cp.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  cp.addEventListener('touchend', e => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (dx > 70 && Math.abs(dy) < 60) ui.backToList();
  }, { passive: true });
})();

// ---------- 会话列表(活跃 + 归档分页 + 搜索) ----------
const DONE_PAGE = 10; // 归档每页条数
let activeRows = [];        // 当前活跃会话(含排队/保持)
let searchMode = false;     // 搜索模式:列表区显示搜索结果
let doneRows = [];          // 已加载的归档行
let doneTotal = 0;          // 归档总数
let doneCursor = null;      // 下一页游标 {updated_at, id}
let doneLoading = false;

// 单张会话卡片(活跃/归档/搜索结果共用)
function sessionCard(s) {
  const st = { queued: '排队中', active: '活跃中', held: '保持中', completed: '已完成', cancelled: '已终止' }[s.status] || s.status;
  const badge = '<span class="badge ' + s.status + '">' + st + (s.status === 'queued' && s.queue_pos ? ' #' + s.queue_pos : '') + '</span>';
  return '<div class="session-card" onclick="ui.openSession(\'' + s.id + '\')">' +
    '<div class="session-main">' +
      '<div class="session-name">' + esc(s.title || s.id) + '</div>' +
      '<div class="session-meta"><span>' + esc(s.id) + '</span>' + badge +
      (s.model_id ? '<span>' + esc(s.model_id) + '</span>' : '') + '</div>' +
    '</div>' +
    '<button class="card-act del" onclick="event.stopPropagation();ui.deleteSession(\'' + s.id + '\')">删除</button>' +
  '</div>';
}

function renderSessionList() {
  const el = $('session-list');
  let html = activeRows.map(sessionCard).join('');
  html += doneRows.map(sessionCard).join('');
  if (!activeRows.length && !doneTotal) {
    html += '<div class="empty-tip">还没有任务,点右上角 + 新建</div>';
  }
  const remain = doneTotal - doneRows.length;
  if (remain > 0) {
    // 括号内是剩余未展示的归档数,如总共 100、已显 10 则显示「加载更多(90)」
    html += '<button class="load-more" onclick="ui.loadMoreDone()"' + (doneLoading ? ' disabled' : '') + '>加载更多(' + remain + ')</button>';
  }
  el.innerHTML = html;
}

async function loadSessions() {
  if (searchMode) return doSearch();
  try {
    const lists = await Promise.all([
      req('GET', '/api/sessions?status=active&limit=100'),
      req('GET', '/api/sessions?status=done&limit=' + DONE_PAGE + '&with_total=1'),
    ]);
    activeRows = lists[0];
    doneRows = lists[1].rows;
    doneTotal = lists[1].total;
    const last = doneRows[doneRows.length - 1];
    doneCursor = last ? { updated_at: last.updated_at, id: last.id } : null;
    renderSessionList();
  } catch (e) { toast('加载会话失败:' + e.message); }
}

async function loadMoreDone() {
  if (doneLoading || !doneCursor) return;
  doneLoading = true;
  renderSessionList(); // 按钮置灰
  try {
    const r = await req('GET', '/api/sessions?status=done&limit=' + DONE_PAGE + '&with_total=1' +
      '&before=' + encodeURIComponent(doneCursor.updated_at) + '&before_id=' + encodeURIComponent(doneCursor.id));
    doneRows = doneRows.concat(r.rows);
    doneTotal = r.total;
    const last = r.rows[r.rows.length - 1];
    if (last) doneCursor = { updated_at: last.updated_at, id: last.id };
    else doneTotal = doneRows.length; // 防御:数据变少导致翻页空转,直接隐藏按钮
  } catch (e) { toast('加载更多失败:' + e.message); }
  doneLoading = false;
  renderSessionList();
}

function toggleSearch() {
  searchMode = !searchMode;
  $('search-bar').classList.toggle('hidden', !searchMode);
  const input = $('search-input');
  if (searchMode) {
    input.focus();
    if (input.value.trim()) doSearch();
  } else {
    input.value = '';
    loadSessions();
  }
}

async function doSearch() {
  const q = $('search-input').value.trim();
  if (!q) return loadSessions();
  try {
    const r = await req('GET', '/api/sessions?q=' + encodeURIComponent(q) + '&limit=50&with_total=1');
    const el = $('session-list');
    if (!r.rows.length) {
      el.innerHTML = '<div class="empty-tip">没有找到包含「' + esc(q) + '」的任务</div>';
      return;
    }
    el.innerHTML = '<div class="search-tip">找到 ' + r.total + ' 个相关任务</div>' + r.rows.map(sessionCard).join('');
  } catch (e) { toast('搜索失败:' + e.message); }
}

// ---------- 待发送附件 ----------
// 选定文件后立即传到任务目录,但**不通知 AI**;下一条用户消息发送时,
// 由服务端在正文前拼【系统通知】一并送达(见 routes/messages.js)。
let pendingFiles = []; // { name, size, pct, status: 'up'|'ok'|'err', xhr? }

function renderAttach() {
  const row = $('attach-row');
  if (!row) return;
  row.classList.toggle('hidden', !pendingFiles.length);
  row.innerHTML = pendingFiles.map(function (f, i) {
    const st = f.status === 'up' ? (f.pct + '%') : f.status === 'ok' ? '✓' : '失败';
    return '<span class="attach-chip' + (f.status === 'err' ? ' err' : '') + '">' +
      '<span class="nm">' + esc(f.name) + '</span><span class="st">' + st + '</span>' +
      '<button class="x" onclick="ui.removeAttach(' + i + ')">×</button></span>';
  }).join('');
  // 输入框里的回形针图标在上传中换成总进度百分比
  const lb = document.getElementById('attach-btn');
  const pctEl = $('up-pct');
  if (lb && pctEl) {
    const ups = pendingFiles.filter(function (f) { return f.status === 'up'; });
    lb.classList.toggle('uploading', ups.length > 0);
    if (ups.length) {
      let done = 0, tot = 0;
      for (const f of pendingFiles) { if (f.status === 'err') continue; done += f.size * f.pct / 100; tot += f.size; }
      pctEl.textContent = (tot ? Math.round(done / tot * 100) : 0) + '%';
    }
  }
}

// ---------- 大图上传前压缩 ----------
// 阈值/参数由服务端下发（config.upload，经 /api/system/status 透出）。超过阈值的图片
// 先询问用户，同意后在浏览器端 canvas 压缩再上传，减轻服务器带宽与存储压力。
const DEFAULT_UPLOAD_CFG = { image_compress_threshold_kb: 1536, image_max_dim: 2000, image_quality: 0.85 };
let uploadCfgCache = null;
async function getUploadCfg() {
  if (!uploadCfgCache) {
    uploadCfgCache = Object.assign({}, DEFAULT_UPLOAD_CFG);
    try {
      const s = await req('GET', '/api/system/status');
      uploadCfgCache = Object.assign(uploadCfgCache, (s && s.upload) || {});
    } catch (_) { /* 取不到配置就用默认阈值 */ }
  }
  return uploadCfgCache;
}
function loadImageEl(file) {
  return new Promise(function (resolve, reject) {
    const fr = new FileReader();
    fr.onload = function () {
      const im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('图片解码失败')); };
      im.src = fr.result;
    };
    fr.onerror = function () { reject(new Error('读取文件失败')); };
    fr.readAsDataURL(file);
  });
}
// 返回待上传的 File：需要时询问并压缩；取消/失败/无收益都按原文件上传。
async function maybeCompressImage(file) {
  const cfg = await getUploadCfg();
  const isImg = /^image\//.test(file.type || '') || /\.(png|jpe?g|gif|bmp|webp)$/i.test(file.name || '');
  const threshold = Number(cfg.image_compress_threshold_kb || 1536) * 1024;
  if (!isImg || file.size <= threshold) return file;
  const maxDim = Number(cfg.image_max_dim || 2000);
  const quality = Number(cfg.image_quality || 0.85);
  const ok = await confirmModal('图片文件过大',
    '「' + file.name + '」有 ' + fmtSize(file.size) + '，超过 ' + fmtSize(threshold) +
    '。建议在浏览器本地压缩为 JPEG（长边≤' + maxDim + 'px）后再上传。是否压缩？', '压缩后上传');
  if (!ok) return file;
  try {
    const img = await loadImageEl(file);
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) throw new Error('无法读取图片尺寸');
    const scale = Math.min(1, maxDim / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale)), h = Math.max(1, Math.round(ih * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    // 透明底（PNG）转 JPEG 前先铺白，避免变黑
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, 'image/jpeg', quality); });
    if (!blob || blob.size >= file.size) {
      toast('压缩无收益，已按原文件上传');
      return file;
    }
    const newName = String(file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
    toast('已压缩 ' + fmtSize(file.size) + ' → ' + fmtSize(blob.size));
    return new File([blob], newName, { type: 'image/jpeg' });
  } catch (e) {
    toast('压缩失败(' + (e && e.message || e) + ')，按原文件上传');
    return file;
  }
}

function startUpload(file) {
  if (!state.sessionId) return;
  const item = { name: file.name, size: file.size, pct: 0, status: 'up' };
  pendingFiles.push(item);
  renderAttach();
  const fd = new FormData();
  fd.append('files', file);
  const xhr = new XMLHttpRequest();
  item.xhr = xhr;
  xhr.open('POST', '/api/sessions/' + state.sessionId + '/files');
  xhr.upload.onprogress = function (e) {
    if (e.lengthComputable) { item.pct = Math.min(99, Math.round(e.loaded / e.total * 100)); renderAttach(); }
  };
  xhr.onload = function () {
    let r = {};
    try { r = JSON.parse(xhr.responseText); } catch (_) {}
    if (xhr.status === 200 && r.uploaded && r.uploaded[0]) {
      item.name = r.uploaded[0].filename; // 以服务端清洗/重命名后的文件名为准
      item.size = r.uploaded[0].size;
      item.pct = 100;
      item.status = 'ok';
    } else {
      item.status = 'err';
      toast('上传失败:' + (r.error || xhr.status));
    }
    item.xhr = null;
    renderAttach();
  };
  xhr.onerror = function () { item.status = 'err'; item.xhr = null; renderAttach(); toast('上传失败:网络错误'); };
  xhr.send(fd);
}

function removeAttach(i) {
  const f = pendingFiles[i];
  if (!f) return;
  if (f.xhr) { try { f.xhr.abort(); } catch (_) {} }
  else if (f.status === 'ok' && state.sessionId) {
    // 已传完成的附件被移除:连带删掉已落盘的文件,避免任务目录里残留孤儿文件
    req('DELETE', '/api/sessions/' + state.sessionId + '/files?path=' + encodeURIComponent(f.name)).catch(function () {});
  }
  pendingFiles.splice(i, 1);
  renderAttach();
}

// 历史消息里的【系统通知】行:展示层拆成附件胶囊行 + 用户原文
function parseUploadNotice(content) {
  const m = /^【系统通知】用户上传了文件：([^\n]*)(?:\n([\s\S]*))?$/.exec(content || '');
  if (!m) return { text: content || '', files: null };
  const files = m[1].split('、').map(function (s) { return s.replace(/（大小[^）]*）$/, '').trim(); }).filter(Boolean);
  return { text: m[2] || '', files: files };
}

function attachBubbleLine(names) {
  return names && names.length ? '<div class="msg-files">📎 ' + names.map(esc).join('　') + '</div>' : '';
}

// ---------- 消息渲染 ----------
function md(text) {
  if (typeof marked === 'undefined') return esc(text);
  try { return marked.parse(text || ''); } catch (_) { return esc(text); }
}

function renderToolCard(id, name, argsStr, createdAt) {
  const div = document.createElement('div');
  div.className = 'tool-card';
  div.id = 'tool-' + id;
  div.innerHTML =
    '<details><summary><span class="spin">◌</span>' +
    '<span class="tool-name">' + esc(name) + '</span>' +
    '<span class="tool-args">' + esc(toolArgsSummary(name, argsStr)) + '</span></summary>' +
    '<pre class="tool-args-full">' + esc(toolArgsFull(argsStr)) + '</pre>' +
    '<pre class="tool-result">执行中…</pre>' +
    // 时间行/复制按钮在折叠体内：展开卡片才可见
    '<div class="msg-time tool-time">' + fmtTime(createdAt || Date.now()) + '</div></details>';
  return div;
}

// tool 消息 content：纯文本，或含图片时的哨兵 JSON {"__blocks__":[...]}（read_file 读图回传，见 llm.js）
function parseToolContent(content) {
  if (typeof content === 'string' && content.startsWith('{"__blocks__":')) {
    try {
      const blocks = JSON.parse(content).__blocks__ || [];
      const img = blocks.find(b => b.type === 'image_url');
      return {
        text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
        imageUrl: img && img.image_url && img.image_url.url || null,
      };
    } catch (_) { /* 解析失败按原文显示 */ }
  }
  return { text: content, imageUrl: null };
}

function fillToolResult(id, content, isError, liveImageUrl) {
  const card = document.getElementById('tool-' + id);
  if (!card) return;
  if (isError) card.classList.add('error');
  card.querySelector('.spin').textContent = isError ? '✕' : '✓';
  const parsed = parseToolContent(content);
  const pre = card.querySelector('.tool-result');
  if (!pre) return;
  pre.textContent = parsed.text || '(空)';
  // 结果就绪后在卡片时间行补复制按钮（复制工具输出）
  const timeRow = card.querySelector('.tool-time');
  if (timeRow && !timeRow.querySelector('.copy-btn')) {
    timeRow.insertAdjacentHTML('beforeend', copyBtnHtml(parsed.text || ''));
  }
  const img = liveImageUrl || parsed.imageUrl;
  if (img && !card.querySelector('.tool-img')) {
    const el = document.createElement('img');
    el.className = 'tool-img';
    el.src = img;
    el.title = '点击查看详情';
    el.onclick = () => window.open(el.src);
    pre.insertAdjacentElement('afterend', el);
  }
}

// 每条消息的复制按钮：原文存 Map（内容可能含引号/换行，不适合嵌进属性），按钮只带自增 id。
// renderDetail 重建列表时清空，防长会话累积。
const COPY_SVG = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const copyMap = new Map();
let copySeq = 0;
function copyBtnHtml(text) {
  if (!text) return '';
  const id = ++copySeq;
  copyMap.set(id, text);
  return '<button class="copy-btn" title="复制本条" onclick="ui.copyMsg(' + id + ',this)">' + COPY_SVG + '</button>';
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
    const p = parseUploadNotice(m.content);
    wrap.className = 'msg me';
    wrap.innerHTML = '<div class="msg-user">我</div>' +
      '<div class="msg-bubble">' + attachBubbleLine(p.files) + esc(p.text) + '</div>' +
      '<div class="msg-time">' + fmtTime(m.created_at) + copyBtnHtml(p.text) + '</div>';
    return wrap;
  }
  if (m.role === 'assistant') {
    wrap.className = 'msg other';
    const gray = state.status === 'queued' ? ' gray' : '';
    let inner = '<div class="msg-user"><span class="ai-avatar' + gray + '"></span>AI' +
      (m.model_tag ? ' · ' + esc(m.model_tag) : '') + '</div>';
    if (m.content) inner += '<div class="msg-bubble">' + md(m.content) + '</div>';
    inner += '<div class="msg-time">' + fmtTime(m.created_at) + copyBtnHtml(m.content) + '</div>';
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
    if (state.toolCards[id]) continue; // tool_call 事件已经建过同一张卡,不重复创建
    const card = renderToolCard(id, c.function.name, c.function.arguments, m.created_at);
    container.appendChild(card);
    state.toolCards[id] = card;
  }
}

async function renderDetail(detail) {
  const box = $('messages');
  box.innerHTML = '';
  removePendingBubble();
  state.streamEl = null;
  state.streamText = '';
  state.toolCards = {};
  copyMap.clear(); copySeq = 0;
  const s = detail.session;
  state.status = s.status;
  updatePhaseUI({ model_id: s.model_id, queue_pos: detail.queue_pos });
  $('chat-title').textContent = s.title || s.id;
  for (const m of detail.messages) {
    const node = msgNode(m, state.toolCards);
    if (node) box.appendChild(node);
    if (m.role === 'assistant') appendToolCardsFromAssistant(m, box);
  }
  if (!detail.messages.length) {
    box.innerHTML = '<div class="empty-tip">描述你的需求,AI 会和你讨论并直接干活。</div>';
  }
  scrollBottom();
  loadFiles();
}

function scrollBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

// ---------- AI 处理中占位 ----------
// 发送后立即挂一个「思考中 + 秒计时」占位气泡,首个增量/回复/工具卡到达时移除,
// 避免上游慢时长时间无反馈像卡死。
function addPendingBubble() {
  removePendingBubble();
  const wrap = document.createElement('div');
  wrap.className = 'msg other';
  const box = $('messages');
  const tip = box.querySelector('.empty-tip');
  if (tip) tip.remove();
  wrap.innerHTML = '<div class="msg-user"><span class="ai-avatar"></span>AI</div>' +
    '<div class="msg-bubble pending-bubble">思考中<span class="pending-dots"><i></i><i></i><i></i></span>' +
    '<span class="pending-timer">0s</span></div>';
  box.appendChild(wrap);
  state.pendingEl = wrap;
  state.pendingStart = Date.now();
  state.pendingTimer = setInterval(() => {
    const t = state.pendingEl && state.pendingEl.querySelector('.pending-timer');
    if (t) t.textContent = Math.floor((Date.now() - state.pendingStart) / 1000) + 's';
  }, 500);
  scrollBottom();
}

function removePendingBubble() {
  if (state.pendingTimer) { clearInterval(state.pendingTimer); state.pendingTimer = null; }
  if (state.pendingEl) { state.pendingEl.remove(); state.pendingEl = null; }
}

// ---------- SSE ----------
function connectStream() {
  if (state.es) { state.es.close(); state.es = null; }
  const es = new EventSource('/api/sessions/' + state.sessionId + '/stream');
  state.es = es;
  es.addEventListener('status', ev => {
    const d = JSON.parse(ev.data);
    state.status = d.status;
    updatePhaseUI(d);
  });
  es.addEventListener('assistant_delta', ev => {
    const d = JSON.parse(ev.data);
    removePendingBubble();
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
    removePendingBubble();
    if (state.streamEl) {
      const bubble = state.streamEl;
      bubble.innerHTML = md(d.content || '');
      state.streamEl = null;
      state.streamText = '';
      if (d.content) {
        const timeEl = document.createElement('div');
        timeEl.className = 'msg-time';
        timeEl.innerHTML = fmtTime(Date.now()) + copyBtnHtml(d.content);
        bubble.parentElement.appendChild(timeEl);
      }
    } else if (d.content) {
      const box = $('messages');
      const wrap = document.createElement('div');
      wrap.className = 'msg other';
      wrap.innerHTML = '<div class="msg-user"><span class="ai-avatar"></span>AI</div>' +
        '<div class="msg-bubble">' + md(d.content) + '</div>' +
        '<div class="msg-time">' + fmtTime(Date.now()) + copyBtnHtml(d.content) + '</div>';
      box.appendChild(wrap);
    }
    if (d.tool_calls) {
      appendToolCardsFromAssistant({ tool_calls: d.tool_calls }, $('messages'));
      scrollBottom();
    }
  });
  es.addEventListener('tool_call', ev => {
    const d = JSON.parse(ev.data);
    removePendingBubble(); // 工具卡出现也算即时反馈
    if (state.toolCards[d.id]) return; // assistant_message 已建卡(含完整参数),不重复创建
    const card = renderToolCard(d.id, d.name, d.arguments, Date.now());
    $('messages').appendChild(card);
    state.toolCards[d.id] = card;
    scrollBottom();
  });
  es.addEventListener('tool_result', ev => {
    const d = JSON.parse(ev.data);
    fillToolResult(d.tool_call_id, d.content, d.is_error, d.image_url);
    scrollBottom();
  });
  es.addEventListener('done', ev => {
    removePendingBubble(); // 本轮结束,占位兼终止(如模型报错无回复)
    loadSessions();
  });
  es.addEventListener('error', ev => {
    removePendingBubble();
    try {
      const d = JSON.parse(ev.data);
      if (d && d.message) toast('错误:' + d.message);
    } catch (_) { /* EventSource 连接错误,自动重连 */ }
  });
}

// ---------- 任务状态 ----------
function updatePhaseUI(d) {
  const pill = $('status-pill');
  const stMap = { queued: '排队中', active: '活跃中', held: '保持中', completed: '已完成', cancelled: '已终止' };
  let text = stMap[state.status] || state.status || '--';
  if (d && d.queue_pos) text += '(第 ' + d.queue_pos + ' 位)';
  // active/held 时附带当前占用的模型
  if ((state.status === 'active' || state.status === 'held') && d && d.model_id) {
    text += ' · ' + d.model_id;
  }
  pill.textContent = text;
  // 状态胶囊配色:活跃中绿(执行中)、保持中黄(已答完、保持模型中)等;状态栏整体同步染色
  pill.className = 'status-pill ' + (state.status || '');
  $('phase-bar').className = 'phase-bar ' + (state.status || '');
  // 活跃中提供「终止」;保持中改为「断开」(主动放弃保持租约,会话结为已完成)
  const btn = $('stop-btn');
  const actionable = state.status === 'active' || state.status === 'held';
  btn.classList.toggle('hidden', !actionable);
  btn.textContent = state.status === 'held' ? '断开' : '终止';
  btn.classList.toggle('muted', state.status === 'held');
  // 已完成/已终止时提供「选择模型」,手动指定空闲模型后继续对话
  const msBtn = $('model-switch-btn');
  if (msBtn) msBtn.classList.toggle('hidden', !(state.sessionId && (state.status === 'completed' || state.status === 'cancelled')));
}

// ---------- 文件 ----------
// 下载:先换一枚短时效签名链接,再 window.location.href 交给浏览器原生下载。
// (fetch+blob 在移动端浏览器会被改名 uuid.bin;原生导航下载按服务端
// Content-Disposition 保留原名,同源自动携带登录 cookie。)
async function downloadFile(name) {
  if (!state.sessionId) return;
  try {
    const r = await req('GET', '/api/sessions/' + state.sessionId + '/files/download-token?path=' + encodeURIComponent(name));
    window.location.href = r.url;
  } catch (e) {
    toast('下载失败:' + e.message);
  }
}

async function loadFiles() {
  if (!state.sessionId) return;
  try {
    const files = await req('GET', '/api/sessions/' + state.sessionId + '/files');
    const el = $('files-list');
    if (!files.length) {
      el.innerHTML = '<div class="empty-tip">还没有文件。上传文件或在对话中让 AI 生成。</div>';
      return;
    }
    el.innerHTML = files.map(f => {
      return '<div class="file-row"><span class="file-name">' + esc(f.filename.split('/').pop() || f.filename) + '</span>' +
        '<span class="file-size">' + fmtSize(f.size) + '</span>' +
        '<button class="file-act" onclick="ui.downloadFile(\'' + esc(f.filename) + '\')">下载</button>' +
        '<button class="file-act del" onclick="ui.deleteFile(\'' + esc(f.filename).replace(/'/g, '%27') + '\')">删</button></div>';
    }).join('');
  } catch (e) { toast('读取文件失败:' + e.message); }
}

// ---------- 主逻辑 ----------
const ui = {
  downloadFile(name) { return downloadFile(name); },
  async openCreate() {
    // 每次打开时刷新一次空闲模型列表
    const sel = $('new-model');
    try {
      const rows = await req('GET', '/api/models');
      const free = rows.filter(m => !m.is_busy);
      sel.innerHTML = free.length
        ? '<option value="">自动分配</option>' + free.map(m =>
            '<option value="' + esc(m.id) + '">' + esc(m.display_name || m.id) + '</option>').join('')
        : '<option value="">排队等待</option>';
    } catch (_) { /* 保留默认选项 */ }
    $('create-modal').classList.remove('hidden');
    $('new-title').focus();
  },
  closeCreate() { $('create-modal').classList.add('hidden'); },
  openFullscreen(el) {
    const body = $('fs-body');
    body.innerHTML = '';
    body.style.zoom = '';
    // 深拷贝并去掉 id：保留原类名使气泡/工具卡样式在查看器内照常生效，且避免 id 重复
    const clone = el.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
    // 全屏查看直接展开参数/结果，方便观看
    clone.querySelectorAll('details').forEach(function (d) { d.open = true; });
    body.appendChild(clone);
    $('fs-viewer').classList.remove('hidden');
  },
  closeFullscreen() { $('fs-viewer').classList.add('hidden'); },
  async copyMsg(id, btn) {
    const t = copyMap.get(Number(id));
    if (t == null) return;
    if (await copyText(t)) {
      // 图标短暂变绿作反馈
      const svg = btn && btn.querySelector && btn.querySelector('svg');
      if (svg) { svg.classList.add('copied'); setTimeout(function () { svg.classList.remove('copied'); }, 1200); }
      toast('已复制');
    } else toast('复制失败');
  },
  async renameSession() {
    if (!state.sessionId) return;
    const cur = $('chat-title').textContent;
    const t = await promptModal('重命名会话', '输入新的会话名称', cur === state.sessionId ? '' : cur);
    if (t === null) return; // 取消
    try {
      await req('PATCH', '/api/sessions/' + state.sessionId, { title: t });
      toast('已重命名');
      $('chat-title').textContent = t.trim();
      loadSessions();
    } catch (e) { toast('重命名失败:' + e.message); }
  },
  async openModelSwitch() {
    if (!state.sessionId) return;
    const list = $('bind-model-list');
    list.innerHTML = '<div class="empty-tip">加载中…</div>';
    $('bind-model-modal').classList.remove('hidden');
    try {
      const rows = await req('GET', '/api/models');
      if (!rows.length) {
        list.innerHTML = '<div class="empty-tip">还没有配置模型。</div>';
        return;
      }
      list.innerHTML = rows.map(m => m.is_busy
        ? '<button class="ghost-btn" disabled>' + esc(m.display_name || m.id) + ' · 占用中</button>'
        : '<button class="primary-btn" onclick="ui.bindModel(\'' + esc(m.id) + '\')">' + esc(m.display_name || m.id) + '</button>').join('');
    } catch (e) {
      list.innerHTML = '<div class="empty-tip">读取模型列表失败:' + e.message + '</div>';
    }
  },
  closeModelSwitch() { $('bind-model-modal').classList.add('hidden'); },
  async bindModel(modelId) {
    if (!state.sessionId) return;
    try {
      await req('POST', '/api/sessions/' + state.sessionId + '/bind', { model_id: modelId });
      toast('已绑定模型 ' + modelId);
      this.closeModelSwitch();
    } catch (e) { toast('绑定失败:' + e.message); }
    // 无论成败都刷新状态(失败多为并发占用,状态可能已变)
    try { await renderDetail(await req('GET', '/api/sessions/' + state.sessionId)); } catch (_) {}
  },
  async createSession() {
    try {
      const title = $('new-title').value.trim();
      const model_id = $('new-model') ? $('new-model').value : '';
      const s = await req('POST', '/api/sessions', { title, model_id });
      this.closeCreate();
      $('new-title').value = '';
      await loadSessions();
      this.openSession(s.id);
    } catch (e) { toast('创建失败:' + e.message); }
  },
  deleteSession(id) {
    state.pendingDeleteId = id;
    $('del-dir-check').checked = true;
    $('delete-modal-text').textContent = '确定删除会话 ' + id + '?';
    $('delete-modal').classList.remove('hidden');
  },
  closeDelete() {
    $('delete-modal').classList.add('hidden');
    state.pendingDeleteId = null;
  },
  async confirmDelete() {
    const id = state.pendingDeleteId;
    if (!id) { this.closeDelete(); return; }
    const delDir = $('del-dir-check').checked;
    this.closeDelete();
    try {
      await req('DELETE', '/api/sessions/' + id + '?delete_dir=' + (delDir ? 'true' : 'false'));
      if (state.sessionId === id) this.backToList();
      loadSessions();
    } catch (e) { toast('删除失败:' + e.message); }
  },
  async openSession(id) {
    state.sessionId = id;
    // 待发送附件属于上一个会话的语境,切会话时清空展示(文件已落盘,可在文件面板查看)
    pendingFiles = [];
    renderAttach();
    showChat();
    try {
      const detail = await req('GET', '/api/sessions/' + id);
      await renderDetail(detail);
      connectStream();
    } catch (e) { toast('打开会话失败:' + e.message); }
  },
  backToList() {
    if (state.es) { state.es.close(); state.es = null; }
    removePendingBubble();
    state.sessionId = null;
    showList();
    loadSessions();
  },
  async send() {
    const ta = $('msg-input');
    const content = ta.value.trim();
    if (!state.sessionId) return;
    if (pendingFiles.some(f => f.status === 'up')) { toast('附件上传中,请稍候'); return; }
    const atts = pendingFiles.filter(f => f.status === 'ok').map(f => ({ name: f.name, size: f.size }));
    if (!content && !atts.length) return;
    ta.value = '';
    ta.style.height = 'auto';
    const box = $('messages');
    const tip = box.querySelector('.empty-tip');
    if (tip) tip.remove();
    try {
      const body = { content };
      if (atts.length) body.attachments = atts;
      const r = await req('POST', '/api/sessions/' + state.sessionId + '/messages', body);
      const wrap = document.createElement('div');
      wrap.className = 'msg me';
      wrap.innerHTML = '<div class="msg-user">我' + (r.delivered === 'queued' ? '(排队中,暂存)' : '') + '</div>' +
        '<div class="msg-bubble">' + attachBubbleLine(atts.map(a => a.name)) + esc(content) + '</div>';
      box.appendChild(wrap);
      // 发送成功后附件已随消息告知 AI;失败的保留,由用户决定重试或移除
      pendingFiles = pendingFiles.filter(f => f.status === 'err');
      renderAttach();
      // 立即给出回馈:占位气泡 + 等待计时,首个增量/回复到达时移除并填充内容
      if (r.delivered !== 'queued') addPendingBubble();
      scrollBottom();
    } catch (e) { toast('发送失败:' + e.message); }
  },
  toggleFiles(ev) {
    // 阻断冒泡,避免开启面板的同一次点击被「点外部自动关闭」监听器立刻关掉
    if (ev) ev.stopPropagation();
    state.filePanelOpen = !state.filePanelOpen;
    $('files-panel').classList.toggle('hidden', !state.filePanelOpen);
    if (state.filePanelOpen) loadFiles();
  },
  async stopSession() {
    if (!state.sessionId) return;
    const held = state.status === 'held';
    try {
      if (held) {
        await req('POST', '/api/sessions/' + state.sessionId + '/release');
        toast('已断开,模型已释放');
      } else {
        await req('POST', '/api/sessions/' + state.sessionId + '/stop');
        toast('已发送终止指令');
      }
    } catch (e) { toast((held ? '断开失败:' : '终止失败:') + e.message); }
  },
  async uploadFiles(ev) {
    const input = ev.target;
    // 必须先快照成数组再清空 input:input.files 是实时 FileList,
    // input.value='' 会把它同步掏空(Chrome/Safari),直接 return 导致点了没反应。
    const files = Array.prototype.slice.call(input.files || []);
    input.value = '';
    if (!files.length || !state.sessionId) return;
    // 大图逐个串行询问压缩（模态弹窗不能并行），完成后再并行上传
    const ready = [];
    for (const f of files) ready.push(await maybeCompressImage(f));
    for (const f of ready) startUpload(f); // 多个文件并行上传,进度在回形针图标上汇总
  },
  removeAttach(i) { removeAttach(i); },
  async deleteFile(name) {
    if (!await confirmModal('删除文件', '删除文件 ' + name + ' ?', '删除', true)) return;
    try {
      await req('DELETE', '/api/sessions/' + state.sessionId + '/files?path=' + encodeURIComponent(name));
      loadFiles();
    } catch (e) { toast('删除失败:' + e.message); }
  },
  logout() { location.href = '/logout'; },
  toggleSearch() { toggleSearch(); },
  doSearch() { doSearch(); },
  loadMoreDone() { return loadMoreDone(); },
};

// 文件面板展开时,点击面板以外的区域自动关闭
document.addEventListener('click', e => {
  if (!state.filePanelOpen) return;
  if ($('files-panel').contains(e.target)) return;
  state.filePanelOpen = false;
  $('files-panel').classList.add('hidden');
});

// ---------- 输入框行为 ----------
document.addEventListener('input', e => {
  if (e.target.id === 'msg-input') {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  }
});
document.addEventListener('keydown', e => {
  if (e.target.id !== 'msg-input' || e.key !== 'Enter') return;
  if (e.isComposing) return; // 中文输入法候选中,回车不拦截
  // 桌面:Ctrl/⌘/⌥+Enter 发送;其余 Enter(含手机软键盘)保持默认换行,发送用右侧按钮
  if (e.ctrlKey || e.metaKey || e.altKey) {
    e.preventDefault();
    ui.send();
  }
});

// 搜索框:回车触发搜索;清空后退回普通列表
document.addEventListener('keydown', e => {
  if (e.target.id === 'search-input' && e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    doSearch();
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'search-input' && !e.target.value.trim()) loadSessions();
});

// 双击消息气泡/工具卡全屏查看（长回复/代码更好读）
document.getElementById('messages').addEventListener('dblclick', function (e) {
  if (e.target.closest('#fs-viewer')) return;
  if (e.target.closest('.copy-btn')) return; // 双击复制按钮不触发全屏
  const el = e.target.closest('.msg-bubble, .tool-card');
  if (el) ui.openFullscreen(el);
});

// 全屏查看器双指缩放：页面 viewport 是 user-scalable=no（原生捏合被禁），
// 在查看器内接管双指手势，用 CSS zoom 缩放内容（1~4 倍，关闭时重置）。
(function () {
  const viewer = document.getElementById('fs-viewer');
  if (!viewer) return;
  let startDist = 0, startZoom = 1, pinching = false;
  const tdist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  viewer.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 2) { pinching = false; return; }
    pinching = true;
    startDist = tdist(e.touches) || 1;
    startZoom = Number($('fs-body').style.zoom) || 1;
  }, { passive: true });
  viewer.addEventListener('touchmove', function (e) {
    if (!pinching || e.touches.length < 2) return;
    e.preventDefault(); // 双指期间阻止滚动，手势归缩放
    $('fs-body').style.zoom = Math.min(4, Math.max(1, startZoom * tdist(e.touches) / startDist)) || '';
  }, { passive: false });
  viewer.addEventListener('touchend', function (e) { if (e.touches.length < 2) pinching = false; }, { passive: true });
  viewer.addEventListener('touchcancel', function () { pinching = false; }, { passive: true });
})();

// ---------- Tab 注册 ----------
window.tabModules = window.tabModules || {};
tabModules.tasks = {
  onShow() {
    loadSessions();
  },
};
