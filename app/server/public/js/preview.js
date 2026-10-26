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
// reload: 当前内容的"重新载入"动作(文本类无 iframe，按名重开)；为 null 时回退到 reload iframe
const pvState = { name: null, url: null, blobUrl: null, reload: null, drawerWasOpen: false, mobilePush: false };

function pvDesktop() { return window.matchMedia('(min-width: 960px)').matches; }

function pvOfficeUrl(rel) {
  return '/preview/' + encodeURIComponent(state.sessionId) + '/' +
    String(rel).split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/';
}

// 图片预览派生地址：服务端按 w 生成并缓存 WebP，<img> 直连可边下边画；原图只留给“下载”。
function pvPreviewUrl(rel, w) {
  return '/api/sessions/' + encodeURIComponent(state.sessionId) +
    '/files/preview?path=' + encodeURIComponent(rel) + '&w=' + w;
}

// PDF 预览直连：让内建查看器自己发 Range 请求，不必先 fetch 整包转 blob。
function pvPdfUrl(rel) {
  return '/api/sessions/' + encodeURIComponent(state.sessionId) +
    '/files/inline?path=' + encodeURIComponent(rel);
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

// 文件面板「当前目录」里的图片作为一组，供查看器左右滑动切换。
// 同组直接用预览派生直链（2048px），不必逐张取原图/blob，滑动的预取也不会打满带宽。
// 依赖 files.js 的 filesNodeAt / filesCurDir（同为全局，加载顺序在前）。
function pvImgGroup(name) {
  try {
    if (typeof filesNodeAt !== 'function') return null;
    const node = filesNodeAt(typeof filesCurDir === 'string' ? filesCurDir : '');
    if (!node) return null;
    const paths = node.files.map(f => f.filename).filter(p => PV_IMG.test(p));
    if (paths.length < 2) return null;
    return {
      list: paths.map(p => ({ src: pvPreviewUrl(p, 2048), alt: p.split('/').pop() })),
      at: paths.indexOf(name),
    };
  } catch (_) { return null; }
}

// 刷新/新窗口两个钮对**所有**预览类型统一开放：
//   refresh → pvState.reload（各类型都注入「按同一路径重开」，与地址条回车同一条路）
//   popup   → pvState.url（office=预览网关；图片/PDF=inline 直链；
//             文本/HTML=blob URL；不支持的类型=下载地址）
// 下载接口是 attachment，直接导航只会触发下载；图片/PDF 走各自的 inline 路由可直接开新窗口。
function pvToolbar(o) {
  document.getElementById('pv-refresh').classList.toggle('hidden', !o.refresh);
  document.getElementById('pv-popup').classList.toggle('hidden', !o.popup);
  pvState.reload = typeof o.reload === 'function' ? o.reload : null;
  pvState.url = o.url === undefined ? null : o.url;
}

// 每次展示内容都过一遍：标题显示相对路径(子目录可见)，右上角下载钮随文件走
function pvHeader(name, sizeText) {
  pvState.name = name;
  const t = document.getElementById('pv-title');
  t.value = String(name || '');
  t.title = sizeText ? name + ' · ' + sizeText : String(name || '');
  document.getElementById('pv-download').classList.toggle('hidden', !name);
}

function pvClearBody() {
  document.getElementById('pv-body').innerHTML = '';
  pvState.reload = null; // 换内容/关窗后旧的刷新动作立即失效
  pvState.url = null;    // 新窗口地址同理：不清会残留上一份内容的 blob/网关 URL
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
  if (typeof pvSetMaxUI === 'function') pvSetMaxUI(false); // 收起时复位放大钮图标(函数声明提升，定义在后亦可)
  pvClearBody();
  pvState.name = null; pvState.url = null;
  if (pvState.drawerWasOpen) {
    pvState.drawerWasOpen = false;
    if (typeof openDrawer === 'function') openDrawer(true); // 恢复打开预览前的折叠态
  }
}

// 移动端全屏承载：把节点塞进 #fs-viewer 并展开
// opts.bar    → 文件预览沉浸模式：顶部独立操作条，内容全宽占满剩余空间
// opts.name   → 操作条左侧的文件名（仅 bar 模式可见）
// opts.source → 源文本，交给 eye / 复制钮（未传则两者隐藏）
function pvOverlayShow(node, opts) {
  opts = opts || {};
  const viewer = document.getElementById('fs-viewer');
  const body = document.getElementById('fs-body');
  viewer.classList.toggle('fs-bar', !!opts.bar);
  const nm = document.getElementById('fs-file-name');
  nm.textContent = opts.name ? String(opts.name) : '';
  nm.title = nm.textContent;
  body.innerHTML = ''; body.style.zoom = '';
  if (typeof setFsSource === 'function') setFsSource(opts.source == null ? null : opts.source);
  body.appendChild(node);
  viewer.classList.remove('hidden');
}

// ---------- office：iframe 直挂预览网关(HEAD 预探顺便触发冷槽复活) ----------
async function pvOpenOffice(name, sizeText) {
  const url = pvOfficeUrl(name);
  const desk = pvDesktop();
  const my = ++pvSeq;
  let load;
  if (desk) {
    pvOpenPane(); pvClearBody();
    pvHeader(name, sizeText); pvToolbar({ refresh: true, popup: true, reload: () => openFilePreview(name, sizeText), url });
    load = pvLoadingBox();
    document.getElementById('pv-body').appendChild(load); // 开窗即刻可见，冷启动转圈等首帧
  } else {
    load = pvLoadingBox(); load.classList.add('inline');
    pvOverlayShow(load, { bar: true, name: name });
    if (!pvState.mobilePush) { try { history.pushState({ pvOffice: 1 }, ''); pvState.mobilePush = true; } catch (_) {} }
  }
  let head = null;
  try { head = await fetch(url, { method: 'HEAD' }); } catch (_) {}
  if (my !== pvSeq) return;
  // 404 = 预览服务里没有这份文档。文件可能正被 AI 的写盘链路整体替换（rename 瞬间找不到），
  // 探针给一次短重试再落占位卡——比让用户自己反复点刷新更接近「多刷几次就出来了」的实情。
  if (head && head.status === 404) {
    await new Promise((r) => setTimeout(r, 600));
    if (my !== pvSeq) return;
    try { head = await fetch(url, { method: 'HEAD' }); } catch (_) {}
    if (my !== pvSeq) return;
  }
  const missing = head && head.status === 404;
  if (missing) {
    const node = pvInfoNode(name, sizeText, '预览服务中暂无这份文档 —— 文件可能已被删除、改名，或不在本任务目录下。');
    if (desk) {
      // pvClearBody 会清掉 reload/url：占位卡仍要保留刷新/新窗口，否则按钮可见但点了没反应
      pvClearBody(); document.getElementById('pv-body').appendChild(node);
      const dl = '/api/sessions/' + encodeURIComponent(state.sessionId) + '/files/download?path=' + encodeURIComponent(name);
      pvToolbar({ refresh: true, popup: true, reload: () => openFilePreview(name, sizeText), url: dl });
    } else { const b = document.getElementById('fs-body'); b.innerHTML = ''; b.appendChild(node); }
    return;
  }
  const fr = document.createElement('iframe');
  fr.className = desk ? 'pv-frame' : 'fs-html-frame';
  fr.title = String(name);
  fr.src = url;
  if (desk) { try { load.remove(); } catch (_) {} document.getElementById('pv-body').appendChild(fr); pvToolbar({ refresh: true, popup: true, reload: () => openFilePreview(name, sizeText), url }); }
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
  // 工具栏两动作全局统一：刷新 = 按同一路径重开（与地址条回车同一条路），
  // 新窗口 = 打开当前内容；没有可打开的 URL 时（不支持预览/读失败）退回下载地址。
  const reload = () => openFilePreview(name, sizeText);
  const downloadUrl = '/api/sessions/' + encodeURIComponent(state.sessionId) + '/files/download?path=' + encodeURIComponent(name);
  const tbAll = { refresh: true, popup: true, reload, url: downloadUrl };
  if (desk) {
    pvOpenPane(); pvClearBody(); // 立即开窗 + 转圈，点击零延迟可见
    pvHeader(name, sizeText);
    pvToolbar(tbAll);
    document.getElementById('pv-body').appendChild(pvLoadingBox());
  }
  const show = (node, tb) => {
    if (my !== pvSeq) return;
    if (desk) {
      pvClearBody(); pvHeader(name, sizeText);
      document.getElementById('pv-body').appendChild(node);
      pvToolbar(tb || tbAll);
    } else pvOverlayShow(node, { bar: true, name: name });
  };
  if (kind === 'none') {
    const low = String(name).toLowerCase();
    const hint = /\.pdf$/i.test(low)
      ? '当前浏览器不支持页内预览 PDF，请下载后用系统查看器打开。'
      : '该格式暂不支持在线预览，可下载后本地打开。';
    show(pvInfoNode(name, sizeText, hint), tbAll);
    return;
  }
  // 图片走服务端派生预览：<img> 直连边下边画，不再 fetch 整包转 blob；原图只在“下载”时取。
  // SVG 保留原路径（移动端还要展示源码），其余图片统一交给 /files/preview。
  if (kind === 'img' && !/\.svg$/i.test(name)) {
    const alt = String(name).split('/').pop();
    const g = pvImgGroup(name);
    if (desk) {
      const im = document.createElement('img');
      im.className = 'pv-img'; im.alt = String(name); im.decoding = 'async';
      // 面板宽度约半屏，交给浏览器按 DPR 选 640/1280/2048，手机不会去拉大图
      im.sizes = '(min-width: 960px) 50vw, 100vw';
      im.srcset = [640, 1280, 2048].map(w => pvPreviewUrl(name, w) + ' ' + w + 'w').join(',');
      const url = pvPreviewUrl(name, 2048);
      im.src = url;
      im.addEventListener('click', () => openImageViewer(url, alt, g && g.list, g && g.at));
      im.addEventListener('error', () => {
        if (my !== pvSeq) return;
        show(pvInfoNode(name, sizeText, '图片读取失败：文件可能已被删除，或格式无法解码。'), tbAll);
      });
      show(im, Object.assign({}, tbAll, { url }));
    } else {
      openImageViewer(pvPreviewUrl(name, 2048), alt, g && g.list, g && g.at);
    }
    return;
  }
  // PDF 直连 inline 路由：桌面面板与窄窗口（全屏 overlay）都让内建查看器按 Range 取字节，
  // 不再 fetch 整包转 blob。show() 会按 desk 自动落到右侧面板或 #fs-viewer。
  if (kind === 'pdf') {
    const url = pvPdfUrl(name);
    const fr = document.createElement('iframe');
    fr.className = desk ? 'pv-frame' : 'fs-html-frame';
    fr.title = String(name); fr.src = url;
    show(fr, Object.assign({}, tbAll, { url }));
    return;
  }
  let r;
  try {
    r = await fetch('/api/sessions/' + state.sessionId + '/files/download?path=' + encodeURIComponent(name));
    if (r.status === 401) { if (my === pvSeq) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
    if (!r.ok) { let msg = 'HTTP ' + r.status; try { msg = (await r.json()).error || msg; } catch (_) {} throw new Error(msg); }
  } catch (e) {
    if (my === pvSeq) { desk ? show(pvInfoNode(name, sizeText, '读取失败：' + e.message), tbAll) : (pvCloseOverlayQuiet(), toast('预览失败：' + e.message)); }
    return;
  }
  try {
    if (!desk) { await pvRenderLegacy(name, r, my); return; }
    let node = null, tb = tbAll;
    // blob URL 不能在此登记到 pvState：show() 内部先调 pvClearBody()，那会把"刚建的"这个也一并撤销，
    // 于是 img/iframe 真正去取时 URL 已失效（Chrome 报 net::ERR_FILE_NOT_FOUND；Safari 撤回更宽松才没暴露）。
    // 统一等 show() 之后登记，陈旧序号则立即撤销防泄漏。
    let newBlobUrl = null;
    if (kind === 'html') {
      const src = rewriteHtmlDocSrcs(await r.text(), name); // 相对资源改写，否则 about:srcdoc/blob 基准下全 404
      const fr = document.createElement('iframe');
      fr.className = 'pv-frame';
      fr.setAttribute('sandbox', 'allow-same-origin allow-scripts');
      fr.srcdoc = src;
      newBlobUrl = URL.createObjectURL(new Blob([src], { type: 'text/html;charset=utf-8' }));
      tb = Object.assign({}, tbAll, { url: newBlobUrl }); // 新窗口=改写后的页面（与面板里同一份）
      node = fr;
    } else if (kind === 'pdf') {
      const u = URL.createObjectURL(await r.blob());
      newBlobUrl = u;
      const fr = document.createElement('iframe');
      fr.className = 'pv-frame'; fr.title = String(name); fr.src = u; // 不加 sandbox：内建查看器插件需要 unrestricted 帧
      node = fr; tb = Object.assign({}, tbAll, { url: u });
    } else if (kind === 'img') {
      const u = URL.createObjectURL(await r.blob());
      newBlobUrl = u;
      const im = document.createElement('img');
      im.className = 'pv-img'; im.src = u; im.alt = String(name);
      const g = pvImgGroup(name);
      im.addEventListener('click', () => openImageViewer(u, String(name).split('/').pop(), g && g.list, g && g.at));
      node = im; tb = Object.assign({}, tbAll, { url: u });
    } else { // text/md/代码/json/csv
      node = await pvTextNode(name, sizeText, r);
      if (node.__tb) {
        tb = Object.assign({}, tbAll, node.__tb); delete node.__tb;
        if (/^blob:/.test(tb.url || '')) newBlobUrl = tb.url;
      }
    }
    show(node, tb);
    if (newBlobUrl) {
      if (my === pvSeq) pvState.blobUrl = pvState.url = newBlobUrl;
      else { try { URL.revokeObjectURL(newBlobUrl); } catch (_) {} }
    }
  } catch (e) {
    if (my === pvSeq) desk ? show(pvInfoNode(name, sizeText, '预览失败：' + e.message), tbAll) : toast('预览失败：' + e.message);
  }
}
function pvCloseOverlayQuiet() { const fs = document.getElementById('fs-viewer'); if (!fs.classList.contains('hidden') && fs.querySelector('.pv-loading')) closeFullscreen(); }

// 文本类「新窗口」承载：md 用面板同一份渲染 HTML（图片已改写成绝对下载地址），
// 其余按 text/plain 原样打开——服务端文件响应一律 attachment，直接导航只会触发下载。
// md 里原样透传的 <script> 在面板(innerHTML)本就不执行，但 blob 文档会执行，故先剔除以保持一致。
function pvMdDoc(html, name) {
  const css =
    'body{margin:0;padding:24px 32px 48px;max-width:900px;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2328;background:#fff}' +
    'img{max-width:100%;height:auto}pre{background:#f6f8fa;padding:12px 14px;border-radius:8px;overflow:auto}' +
    'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}' +
    'table{border-collapse:collapse}th,td{border:1px solid #d8dee4;padding:6px 10px}' +
    'blockquote{margin:0;padding:0 14px;color:#57606a;border-left:3px solid #d8dee4}' +
    'a{color:#0969da}';
  const title = esc(String(name || '').split('/').pop() || '预览');
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>' + css + '</style></head><body>' +
    html.replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '') + '</body></html>';
}
function pvTextUrl(text) { return URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); }

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
    const n = wrap.firstChild;
    // q.fmt=false 表示 marked 不可用、面板就是原文排版：新窗口也按纯文本开，避免空白被折叠
    n.__tb = q.fmt
      ? { popup: true, url: URL.createObjectURL(new Blob([pvMdDoc(html, name)], { type: 'text/html;charset=utf-8' })) }
      : { popup: true, url: pvTextUrl(text) };
    return n;
  }
  if (PV_PLAIN.test(low)) {
    const wrap = document.createElement('div');
    wrap.className = 'msg other';
    wrap.innerHTML = '<div class="bubble-ai pv-doc">' + esc(text) + '</div>';
    const n = wrap.firstChild; n.__tb = { popup: true, url: pvTextUrl(text) };
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
  holder.__tb = { popup: true, url: pvTextUrl(text) }; // 新窗口用全文，不受面板截断影响
  return holder;
}

// 移动端非 office：统一走 #fs-viewer 沉浸式（顶部操作条 + 全宽内容）
async function pvRenderLegacy(name, r, my) {
  if (/\.html?$/i.test(name)) {
    const html = await r.text();
    const iframe = document.createElement('iframe');
    iframe.className = 'fs-html-frame';
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    iframe.srcdoc = rewriteHtmlDocSrcs(html, name);
    pvOverlayShow(iframe, { bar: true, name: name, source: html }); // 全宽沉浸，源码可看/可复制
    if (my !== pvSeq) return;
  } else if (/\.pdf$/i.test(name)) {
    // 正常路径已在 openFilePreview 用 /files/inline 直连；这里仅作旧路径兜底。
    const u = URL.createObjectURL(await r.blob());
    if (state.lastPdfBlobUrl) { try { URL.revokeObjectURL(state.lastPdfBlobUrl); } catch (_) {} }
    state.lastPdfBlobUrl = u;
    const frame = document.createElement('iframe');
    frame.className = 'fs-html-frame';
    frame.title = name;
    frame.src = u;
    pvOverlayShow(frame, { bar: true, name: name });
  } else if (/\.svg$/i.test(name)) {
    // SVG 当图片显示（<img> 不执行内嵌脚本），同时保留源码给 eye/复制钮
    const text = await r.text();
    const u = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
    if (state.lastImgBlobUrl) { try { URL.revokeObjectURL(state.lastImgBlobUrl); } catch (_) {} }
    state.lastImgBlobUrl = u;
    const im = document.createElement('img');
    im.className = 'fs-img-frame'; im.src = u; im.alt = String(name);
    im.addEventListener('click', () => openImageViewer(u, String(name).split('/').pop()));
    pvOverlayShow(im, { bar: true, name: name, source: text });
  } else if (PV_IMG.test(name)) {
    const u = URL.createObjectURL(await r.blob());
    if (state.lastImgBlobUrl) { try { URL.revokeObjectURL(state.lastImgBlobUrl); } catch (_) {} }
    state.lastImgBlobUrl = u;
    const g = pvImgGroup(name);
    openImageViewer(u, name, g && g.list, g && g.at);
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
    pvOverlayShow(wrap.firstChild, { bar: true, name: name, source: text }); // 全宽沉浸，eye/复制看原文
  }
}

// ---------- 组件事件 ----------
document.getElementById('pv-close').addEventListener('click', pvCloseDoc);
document.getElementById('pv-download').addEventListener('click', () => {
  if (pvState.name && typeof downloadFile === 'function') downloadFile(pvState.name);
});
// 放大/还原钮双图标与 title 同步：退出全屏(pvCloseDoc)时也要复位
function pvSetMaxUI(max) {
  const btn = document.getElementById('pv-max');
  const lbl = max ? '还原' : '放大';
  btn.title = lbl;
  btn.setAttribute('aria-label', lbl);
  btn.querySelectorAll('svg').forEach((s) => s.classList.toggle('hidden')); // 双图标互切
}
document.getElementById('pv-max').addEventListener('click', () => {
  const max = document.body.classList.toggle('pv-max');
  pvSetMaxUI(max);
});
document.getElementById('pv-refresh').addEventListener('click', () => {
  if (typeof pvState.reload === 'function') { pvState.reload(); return; }
  const f = document.getElementById('pv-body').querySelector('iframe');
  if (!f) return;
  try { f.contentWindow.location.reload(); } catch (_) { const s = f.src; f.src = ''; f.src = s; }
});
document.getElementById('pv-popup').addEventListener('click', () => {
  if (pvState.url) window.open(pvState.url, '_blank', 'noopener');
});
// 地址条：点击/聚焦全选——长路径被截断时可选中看全文、直接 Ctrl+C 复制
document.getElementById('pv-title').addEventListener('focus', (e) => e.target.select());
// 地址条回车跳转：http(s) 网址新标签打开，其余按任务目录相对路径进预览
function pvClean(s) { return String(s || '').trim().replace(/^["']+|["']+$/g, ''); }
function pvAddrGo(v) {
  if (/^https?:\/\//i.test(v)) { window.open(v, '_blank', 'noopener'); return; }
  document.getElementById('pv-title').blur();
  openFilePreview(v);
}
// ---------- 地址条文件名补全：候选取自 files.js 缓存的目录树(filesNodeAt)，零请求 ----------
const pvSugBox = document.getElementById('pv-suggest');
const pvSug = { items: [], idx: -1 }; // items: [{ name, full, dir }]
function pvSugHide() { pvSugBox.classList.add('hidden'); pvSugBox.innerHTML = ''; pvSug.items = []; pvSug.idx = -1; }
function pvSugMark() {
  const kids = pvSugBox.children;
  for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('sel', i === pvSug.idx);
}
function pvSugFill(i) {
  const it = pvSug.items[i];
  const t = document.getElementById('pv-title');
  if (!it) return;
  t.value = it.full;
  t.focus();
  if (it.dir) { pvSugUpdate(t); return; } // 目录：回填后继续列它的内容
  const cut = it.full.lastIndexOf('/') + 1;
  t.setSelectionRange(cut, it.full.length); // 选中末段，接着打字继续筛
  pvSugHide();
}
function pvSugUpdate(t) {
  const v = t.value;
  pvSug.items = [];
  pvSug.idx = -1;
  if (!/^https?:\/\//i.test(v.trim())) {
    const slash = v.lastIndexOf('/');
    const dir = v.slice(0, slash + 1); // 末斜杠前当目录；无斜杠则 dir='' 列根目录
    const frag = v.slice(slash + 1).toLowerCase();
    const node = typeof filesNodeAt === 'function' ? filesNodeAt(dir.replace(/\/$/, '')) : null;
    if (node) {
      const out = [];
      for (const d of node.dirs.values()) out.push({ name: d.name + '/', full: dir + d.name + '/', dir: true });
      for (const f of node.files) {
        const nm = String(f.filename).split('/').pop();
        if (nm) out.push({ name: nm, full: dir + nm, dir: false });
      }
      // 前缀匹配；已输入与候选全等时不再提示该条
      pvSug.items = out.filter((it) => it.name.toLowerCase().startsWith(frag) && it.name.toLowerCase() !== frag).slice(0, 8);
    }
  }
  pvSugBox.innerHTML = '';
  if (!pvSug.items.length) { pvSugBox.classList.add('hidden'); return; }
  pvSug.items.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'it';
    d.textContent = it.name;
    d.addEventListener('mousedown', (e) => e.preventDefault()); // 保持输入框焦点
    d.addEventListener('click', () => pvSugFill(i));
    pvSugBox.appendChild(d);
  });
  pvSugBox.classList.remove('hidden');
}
// 地址条按键：↑↓选、Tab 补全、Enter 打开(高亮文件直接开，目录仅补全)、Esc 先收下拉；组字回车不触发
document.getElementById('pv-title').addEventListener('input', (e) => pvSugUpdate(e.target));
document.getElementById('pv-title').addEventListener('blur', pvSugHide);
document.getElementById('pv-title').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Escape' && !pvSugBox.classList.contains('hidden')) { pvSugHide(); e.stopPropagation(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && pvSug.items.length) {
    e.preventDefault();
    const n = pvSug.items.length;
    if (e.key === 'ArrowDown') pvSug.idx = (pvSug.idx + 1) % n;
    else pvSug.idx = pvSug.idx <= 0 ? n - 1 : pvSug.idx - 1;
    pvSugMark();
    return;
  }
  if (e.key === 'Tab' && pvSug.items.length) { pvSugFill(pvSug.idx >= 0 ? pvSug.idx : 0); e.preventDefault(); return; }
  if (e.key !== 'Enter') return;
  if (pvSug.idx >= 0) {
    const it = pvSug.items[pvSug.idx];
    if (it.dir) { pvSugFill(pvSug.idx); return; }
    pvSugHide();
    pvAddrGo(it.full);
    return;
  }
  const v = pvClean(e.target.value);
  if (v) pvAddrGo(v);
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
  if (document.activeElement && document.activeElement.id === 'pv-title') { document.activeElement.blur(); return; } // 地址条聚焦时:先退框不关栏
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

// —— 通用 UI 卡片（stream.js 转发 SSE ui_card；任何 MCP 服务/工具回包附 type:"ui_card" 块即可产出）——
// 产生方契约 {action, arg, title?, note?}；新交互在动作注册表加一条即可，未知 action 忽略（向前兼容）。
// 图标由前端统一持有（与 pv-none 同一枚文档 SVG），产生方不提供图形，只给数据。
const UI_CARD_ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
const UI_CARD_ACTIONS = {
  // arg = 相对会话目录的文件路径，点击 = openFilePreview（office 走预览网关，其余类型走文本/图片渲染）
  open_preview: { go: '预览 ›', hint: '点击打开预览', icon: UI_CARD_ICON_DOC, run: (d) => openFilePreview(d.arg) },
};
function appendUiCard(d) {
  const act = d && UI_CARD_ACTIONS[d.action];
  if (!act || !d.arg) { if (d && d.action) console.warn('[ui_card] unknown action:', d.action); return; }
  const cv = document.getElementById('chat-view');
  if (!cv) return;
  const el = document.createElement('div');
  el.className = 'ui-card';
  el.innerHTML =
    '<span class="ico">' + act.icon + '</span>' +
    '<span class="main"><span class="name">' + esc(d.title || d.arg) + '</span>' +
    '<span class="sub">' + (d.note ? esc(d.note) + ' · ' : '') + act.hint + '</span></span>' +
    '<span class="go">' + act.go + '</span>';
  el.addEventListener('click', () => { act.run(d); });
  cv.appendChild(el);
  maybeAutoScroll();
}
