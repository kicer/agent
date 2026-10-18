// 通用文档预览窗（桌面右侧 #pv-pane / 移动端全屏 #fs-viewer）
//  —— 文件列表的点击一律进预览窗：office 走 /preview 预览网关(固定格式前端自拼)；
//     md/txt/代码/json/csv 等文本渲染；html/pdf/图片专用渲染；其余类型显示文件信息占位 + 下载。
//     桌面打开时自动折叠左侧历史栏让位，关闭恢复；左右边界可拖拽调宽(记忆在 localStorage)。
//  依赖(core.js/chat.js/stream.js/files.js 顶层声明)：state $ esc toast mdHtml decorateCodePre
//     rewriteHtmlDocSrcs rewriteMdImageSrcs openFullscreen setFsSource closeFullscreen
//     openImageViewer downloadFile openDrawer
'use strict';

const PV_OFFICE = /\.(docx|xlsx|pptx)$/i;
const PV_IMG = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const PV_MD = /\.(md|markdown)$/i;
const PV_PLAIN = /\.(txt|log)$/i;
// 常见代码/配置/数据文本扩展名；无扩展名的文件(Dockerfile/LICENSE 等)也按文本尝试，二进制嗅探兜底
const PV_TEXT = /\.(md|markdown|txt|log|csv|tsv|json|jsonl|xml|yml|yaml|toml|ini|conf|cfg|properties|env|py|pyw|js|mjs|cjs|ts|tsx|jsx|java|kt|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|sh|bash|zsh|bat|ps1|sql|lua|r|dart|vue|css|less|scss|srt|vtt)$/i;
const PV_TEXT_MAX = 512 * 1024; // 文本预览截断阈值(字符)，超出提示下载看全文
let pvSeq = 0; // 预览序号：快速连点时旧请求不许再动 DOM
const pvState = { name: null, url: null, blobUrl: null, drawerWasOpen: false, mobilePush: false };

function pvDesktop() { return window.matchMedia('(min-width: 960px)').matches; }

function pvOfficeUrl(rel) {
  return '/preview/' + encodeURIComponent(state.sessionId) + '/' +
    String(rel).split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/';
}

function pvKind(name) {
  const low = String(name).toLowerCase();
  if (/\.html?$/i.test(low)) return 'html';
  if (/\.pdf$/i.test(low)) return 'pdf';
  if (PV_IMG.test(low)) return 'img';
  const base = String(name).split('/').pop();
  if (PV_TEXT.test(base) || !/\.[a-z0-9]{1,8}$/i.test(base)) return 'text';
  return 'none';
}

function pvToolbar(o) {
  document.getElementById('pv-refresh').classList.toggle('hidden', !o.refresh);
  document.getElementById('pv-popup').classList.toggle('hidden', !o.popup);
}

// 每次展示内容都过一遍：标题显示相对路径(子目录可见)，右上角下载钮随文件走
function pvHeader(name, sizeText) {
  pvState.name = name;
  const t = document.getElementById('pv-title');
  t.textContent = String(name || '');
  t.title = sizeText ? name + ' · ' + sizeText : String(name || '');
  document.getElementById('pv-download').classList.toggle('hidden', !name);
}

function pvClearBody() {
  document.getElementById('pv-body').innerHTML = '';
  if (pvState.blobUrl) { try { URL.revokeObjectURL(pvState.blobUrl); } catch (_) {} pvState.blobUrl = null; }
}

function pvLoadingBox() {
  const d = document.createElement('div');
  d.className = 'pv-loading';
  return d;
}

// 占位信息卡：不支持/读不到/缺失 共用。带文件名、大小与下载按钮(点击一律走这里，不再直接下载)
function pvInfoNode(name, sizeText, hint) {
  const box = document.createElement('div');
  box.className = 'pv-none';
  box.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' +
    '<div class="nm"></div><div class="meta"></div><div class="hint"></div>';
  box.querySelector('.nm').textContent = String(name || '');
  box.querySelector('.meta').textContent = sizeText ? sizeText : '';
  box.querySelector('.hint').textContent = String(hint || '');
  const btn = document.createElement('button');
  btn.textContent = '下载文件';
  btn.addEventListener('click', () => { if (typeof downloadFile === 'function') downloadFile(name); });
  box.appendChild(btn);
  return box;
}

function pvOpenPane() {
  if (!document.body.classList.contains('pv-open')) {
    pvState.drawerWasOpen = document.getElementById('drawer').classList.contains('open');
    if (pvState.drawerWasOpen && typeof openDrawer === 'function') openDrawer(false); // 挤压式分栏：折叠左侧让位
    document.body.classList.add('pv-open');
  }
}

function pvCloseDoc() {
  if (!document.body.classList.contains('pv-open')) return;
  document.body.classList.remove('pv-open', 'pv-max');
  pvClearBody();
  pvState.name = null; pvState.url = null;
  if (pvState.drawerWasOpen) {
    pvState.drawerWasOpen = false;
    if (typeof openDrawer === 'function') openDrawer(true); // 恢复打开预览前的折叠态
  }
}

// 移动端全屏承载：把节点塞进 #fs-viewer 并展开
function pvOverlayShow(node) {
  const body = document.getElementById('fs-body');
  body.innerHTML = ''; body.style.zoom = '';
  if (typeof setFsSource === 'function') setFsSource(null);
  body.appendChild(node);
  document.getElementById('fs-viewer').classList.remove('hidden');
}

// ---------- office：iframe 直挂预览网关(HEAD 预探顺便触发冷槽复活) ----------
async function pvOpenOffice(name, sizeText) {
  const url = pvOfficeUrl(name);
  const desk = pvDesktop();
  const my = ++pvSeq;
  let load;
  if (desk) {
    pvOpenPane(); pvClearBody();
    pvHeader(name, sizeText); pvToolbar({ refresh: true, popup: false });
    load = pvLoadingBox();
    document.getElementById('pv-body').appendChild(load); // 开窗即刻可见，冷启动转圈等首帧
  } else {
    load = pvLoadingBox(); load.classList.add('inline');
    pvOverlayShow(load);
    if (!pvState.mobilePush) { try { history.pushState({ pvOffice: 1 }, ''); pvState.mobilePush = true; } catch (_) {} }
  }
  let head = null;
  try { head = await fetch(url, { method: 'HEAD' }); } catch (_) {}
  if (my !== pvSeq) return;
  const missing = head && head.status === 404;
  if (missing) {
    const node = pvInfoNode(name, sizeText, '预览服务中暂无这份文档 —— 只有 AI 在本任务中生成/编辑过的文档才能在线预览(较旧的文档可能已被自动清理)。');
    if (desk) { pvClearBody(); document.getElementById('pv-body').appendChild(node); }
    else { const b = document.getElementById('fs-body'); b.innerHTML = ''; b.appendChild(node); }
    return;
  }
  const fr = document.createElement('iframe');
  fr.className = desk ? 'pv-frame' : 'fs-html-frame';
  fr.title = String(name);
  fr.src = url;
  if (desk) { try { load.remove(); } catch (_) {} document.getElementById('pv-body').appendChild(fr); pvToolbar({ refresh: true, popup: true }); }
  else { const b = document.getElementById('fs-body'); b.innerHTML = ''; b.appendChild(fr); }
  pvState.url = url;
}

// ---------- 统一入口：所有文件点击都走这 ----------
async function openFilePreview(name, sizeText) {
  if (!state.sessionId) return;
  if (PV_OFFICE.test(name)) { try { await pvOpenOffice(name, sizeText); } catch (e) { toast('预览失败：' + e.message); } return; }
  let kind = pvKind(name);
  if (kind === 'pdf' && !navigator.pdfViewerEnabled) kind = 'none'; // WebView 内嵌不了 PDF：给占位卡，不再自动下载
  const desk = pvDesktop();
  const my = ++pvSeq;
  if (desk) {
    pvOpenPane(); pvClearBody(); // 立即开窗 + 转圈，点击零延迟可见
    pvHeader(name, sizeText); pvToolbar({ refresh: false, popup: false });
    document.getElementById('pv-body').appendChild(pvLoadingBox());
  }
  const show = (node, tb) => {
    if (my !== pvSeq) return;
    if (desk) {
      pvClearBody(); pvHeader(name, sizeText);
      document.getElementById('pv-body').appendChild(node);
      if (tb) pvToolbar(tb);
    } else pvOverlayShow(node);
  };
  if (kind === 'none') {
    const low = String(name).toLowerCase();
    const hint = /\.pdf$/i.test(low)
      ? '当前浏览器不支持页内预览 PDF，请下载后用系统查看器打开。'
      : '该格式暂不支持在线预览，可下载后本地打开。';
    show(pvInfoNode(name, sizeText, hint), { refresh: false, popup: false });
    return;
  }
  let r;
  try {
    r = await fetch('/api/sessions/' + state.sessionId + '/files/download?path=' + encodeURIComponent(name));
    if (r.status === 401) { if (my === pvSeq) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
    if (!r.ok) { let msg = 'HTTP ' + r.status; try { msg = (await r.json()).error || msg; } catch (_) {} throw new Error(msg); }
  } catch (e) {
    if (my === pvSeq) { desk ? show(pvInfoNode(name, sizeText, '读取失败：' + e.message), { refresh: false, popup: false }) : (pvCloseOverlayQuiet(), toast('预览失败：' + e.message)); }
    return;
  }
  try {
    if (!desk) { await pvRenderLegacy(name, r, my); return; }
    let node = null, tb = { refresh: false, popup: false };
    if (kind === 'html') {
      const fr = document.createElement('iframe');
      fr.className = 'pv-frame';
      fr.setAttribute('sandbox', 'allow-same-origin allow-scripts');
      fr.srcdoc = rewriteHtmlDocSrcs(await r.text(), name); // 相对资源改写，否则 about:srcdoc 基准下全 404
      node = fr;
    } else if (kind === 'pdf') {
      const u = URL.createObjectURL(await r.blob());
      pvState.blobUrl = u; pvState.url = u;
      const fr = document.createElement('iframe');
      fr.className = 'pv-frame'; fr.title = String(name); fr.src = u; // 不加 sandbox：内建查看器插件需要 unrestricted 帧
      node = fr; tb = { refresh: false, popup: true };
    } else if (kind === 'img') {
      const u = URL.createObjectURL(await r.blob());
      pvState.blobUrl = u; pvState.url = u;
      const im = document.createElement('img');
      im.className = 'pv-img'; im.src = u; im.alt = String(name);
      im.addEventListener('click', () => openImageViewer(u, String(name).split('/').pop()));
      node = im; tb = { refresh: false, popup: true };
    } else { // text/md/代码/json/csv
      node = await pvTextNode(name, sizeText, r);
      if (node.__tb) { tb = node.__tb; delete node.__tb; }
    }
    show(node, tb);
  } catch (e) {
    if (my === pvSeq) desk ? show(pvInfoNode(name, sizeText, '预览失败：' + e.message), { refresh: false, popup: false }) : toast('预览失败：' + e.message);
  }
}
function pvCloseOverlayQuiet() { const fs = document.getElementById('fs-viewer'); if (!fs.classList.contains('hidden') && fs.querySelector('.pv-loading')) closeFullscreen(); }

// 桌面文本渲染：md 走气泡 markdown；txt/log 原文排版；代码/配置/数据等宽 pre；二进制嗅探回退占位卡
async function pvTextNode(name, sizeText, r) {
  const text = await r.text();
  if (text.includes('\u0000')) return pvInfoNode(name, sizeText, '该文件不是文本格式，无法在线预览，请下载后本地打开。');
  const low = String(name).toLowerCase();
  if (PV_MD.test(low)) {
    const q = mdHtml(text);
    let html = q.html;
    let cls = 'bubble-ai' + (q.fmt ? ' md' : '');
    html = rewriteMdImageSrcs(html, name);
    const wrap = document.createElement('div');
    wrap.className = 'msg other';
    wrap.innerHTML = '<div class="' + cls + ' pv-doc">' + html + '</div>';
    decorateCodePre(wrap);
    const n = wrap.firstChild; n.__tb = { refresh: false, popup: false };
    return n;
  }
  if (PV_PLAIN.test(low)) {
    const wrap = document.createElement('div');
    wrap.className = 'msg other';
    wrap.innerHTML = '<div class="bubble-ai pv-doc">' + esc(text) + '</div>';
    const n = wrap.firstChild; n.__tb = { refresh: false, popup: false };
    return n;
  }
  const frag = document.createDocumentFragment();
  let bodyText = text;
  if (text.length > PV_TEXT_MAX) {
    bodyText = text.slice(0, PV_TEXT_MAX);
    const tip = document.createElement('div');
    tip.className = 'pv-trunc';
    tip.textContent = '文件较大，仅预览前 ' + Math.round(PV_TEXT_MAX / 1024) + ' KB，完整内容请下载查看。';
    frag.appendChild(tip);
  }
  const pre = document.createElement('pre');
  pre.className = 'pv-pre';
  pre.textContent = bodyText;
  frag.appendChild(pre);
  const holder = document.createElement('div');
  holder.className = 'pv-plain';
  holder.appendChild(frag);
  holder.__tb = { refresh: false, popup: false };
  return holder;
}

// 移动端非 office：保持原全屏行为(#fs-viewer)
async function pvRenderLegacy(name, r, my) {
  if (/\.html?$/i.test(name)) {
    const html = await r.text();
    const iframe = document.createElement('iframe');
    iframe.className = 'fs-html-frame';
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    iframe.srcdoc = rewriteHtmlDocSrcs(html, name);
    pvOverlayShow(iframe);
    setFsSource(html); // 源码钮可看页面原码
    if (my !== pvSeq) return;
  } else if (/\.pdf$/i.test(name)) {
    const u = URL.createObjectURL(await r.blob());
    if (state.lastPdfBlobUrl) { try { URL.revokeObjectURL(state.lastPdfBlobUrl); } catch (_) {} }
    state.lastPdfBlobUrl = u;
    const frame = document.createElement('iframe');
    frame.className = 'fs-html-frame';
    frame.title = name;
    frame.src = u;
    pvOverlayShow(frame);
  } else if (PV_IMG.test(name)) {
    const u = URL.createObjectURL(await r.blob());
    if (state.lastImgBlobUrl) { try { URL.revokeObjectURL(state.lastImgBlobUrl); } catch (_) {} }
    state.lastImgBlobUrl = u;
    openImageViewer(u, name);
  } else {
    const text = await r.text();
    let cls = 'bubble-ai', html;
    if (PV_MD.test(name)) {
      const q = mdHtml(text);
      html = q.html;
      if (q.fmt) cls += ' md';
      html = rewriteMdImageSrcs(html, name);
    } else {
      html = esc(text);
    }
    const wrap = document.createElement('div');
    wrap.className = 'msg other';
    wrap.innerHTML = '<div class="' + cls + '">' + html + '</div>';
    decorateCodePre(wrap);
    openFullscreen(wrap.firstChild, text); // 文件原文供 eye 钮看源码
  }
}

// ---------- 组件事件 ----------
document.getElementById('pv-close').addEventListener('click', pvCloseDoc);
document.getElementById('pv-download').addEventListener('click', () => {
  if (pvState.name && typeof downloadFile === 'function') downloadFile(pvState.name);
});
document.getElementById('pv-max').addEventListener('click', () => {
  const max = document.body.classList.toggle('pv-max');
  const btn = document.getElementById('pv-max');
  const lbl = max ? '还原' : '放大';
  btn.title = lbl;
  btn.setAttribute('aria-label', lbl);
});
document.getElementById('pv-refresh').addEventListener('click', () => {
  const f = document.getElementById('pv-body').querySelector('iframe');
  if (!f) return;
  try { f.contentWindow.location.reload(); } catch (_) { const s = f.src; f.src = ''; f.src = s; }
});
document.getElementById('pv-popup').addEventListener('click', () => {
  if (pvState.url) window.open(pvState.url, '_blank', 'noopener');
});
// md 代码块复制钮与 fs-viewer 同一委托逻辑
document.getElementById('pv-pane').addEventListener('click', (e) => {
  const b = e.target.closest('.act-copy');
  if (b && typeof onCopyClick === 'function') onCopyClick(e);
});
// 移动端系统返回键：先收起 office 全屏预览
window.addEventListener('popstate', () => {
  pvState.mobilePush = false;
  const fs = document.getElementById('fs-viewer');
  if (!fs.classList.contains('hidden') && fs.querySelector('.fs-html-frame[src^="/preview/"]')) closeFullscreen();
});
// Esc 关闭右栏(未开全屏查看器时)
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('fs-viewer').classList.contains('hidden')) return;
  pvCloseDoc();
});
// 窗口收窄到移动端宽度：右栏收起
window.matchMedia('(min-width: 960px)').addEventListener('change', () => { if (!pvDesktop()) pvCloseDoc(); });

// ---------- 左缘拖拽调宽(预览/会话列边界)：双击复位默认宽度，宽度记在 localStorage ----------
(function bindPvResize() {
  const pane = document.getElementById('pv-pane');
  const saved = Number(localStorage.getItem('pv-w') || 0);
  if (saved > 0) document.documentElement.style.setProperty('--pv-w', saved + 'px');
  const clamp = (w) => Math.max(360, Math.min(w, Math.max(360, window.innerWidth - 420)));
  const h = document.createElement('div');
  h.className = 'pv-resizer';
  pane.appendChild(h);
  let st = null;
  h.addEventListener('pointerdown', (e) => {
    st = { x: e.clientX, w: pane.offsetWidth || clamp(window.innerWidth * 0.5) };
    try { h.setPointerCapture(e.pointerId); } catch (_) {}
    document.body.classList.add('pv-resizing');
  });
  h.addEventListener('pointermove', (e) => {
    if (!st) return;
    document.documentElement.style.setProperty('--pv-w', clamp(st.w + (st.x - e.clientX)) + 'px');
  });
  function end() {
    if (!st) return;
    st = null;
    document.body.classList.remove('pv-resizing');
    const w = pane.offsetWidth;
    if (w) localStorage.setItem('pv-w', String(w));
  }
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--pv-w');
    localStorage.removeItem('pv-w');
  });
})();
