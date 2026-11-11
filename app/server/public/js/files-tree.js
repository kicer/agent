// 桌面端左栏文件树：会话文件的唯一浏览入口（服务器形态与 local 形态共用）。
//   · 懒加载：一次只请求一层目录，展开才拉下一层；node_modules 这类大目录后端只回标记、不展开，
//     避免旧的整棵递归接口在单线程 core 上卡死；
//   · 点文件 → 中间预览栏（文件树 | 预览 | 会话）；行内 hover 出「下载 / 删除 / 在 Finder 中显示」；
//   · 「在 Finder / 终端中打开」只在 local 启动器下可用（服务器上这些动作没有意义），
//     靠 /api/local/info 探测，拿不到就隐藏这两个按钮。
// 手机端不启用（收纳在抽屉里体验太差），仍走输入行右侧的旧文件面板。
// 依赖(全局)：state $ req toast downloadFile confirmModal openFilePreview
'use strict';
(function () {
  const SVG_FOLDER = '<svg class="ic sm" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const SVG_FILE = '<svg class="ic sm" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
  const SVG_LINK = '<svg class="ic sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>';
  const SVG_REVEAL = '<svg class="ic sm" viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';
  const SVG_REFRESH = '<svg class="ic sm" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg>';
  const SVG_TERM = '<svg class="ic sm" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>';
  const SVG_EYE = '<svg class="ic sm" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
  const SVG_DL = '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const SVG_DEL = '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  const SVG_REVEAL_SM = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

  let localCapable = false;     // local 启动器：才显示「在 Finder/终端中打开」
  let showHidden = false;
  let expanded = new Set(['']); // 已展开的相对目录（'' = 根）
  let cache = new Map();        // rel -> /tree 响应
  let loading = new Map();      // rel -> Promise（并发去重）
  let gen = 0;                  // 会话切换/刷新时自增，防止旧请求回填到新树的缓存

  // 失效缓存。gen 自增让在飞的旧请求回来时不再写缓存（否则切会话会闪旧目录）。
  function invalidate(keepExpanded) {
    gen++;
    cache = new Map();
    loading = new Map();
    if (!keepExpanded) expanded = new Set(['']);
  }

  function sid() { return (state && state.sessionId) || ''; }

  function tip(parent, text, cls) {
    const el = document.createElement('div');
    el.className = cls || 'tree-empty';
    el.textContent = text;
    parent.appendChild(el);
  }

  function openDir(rel) {
    if (cache.has(rel)) return Promise.resolve(cache.get(rel));
    if (loading.has(rel)) return loading.get(rel);
    if (!sid()) return Promise.resolve(null);
    const url = '/api/sessions/' + encodeURIComponent(sid()) + '/tree?dir=' +
      encodeURIComponent(rel) + (showHidden ? '&hidden=1' : '');
    const myGen = gen;
    const p = req('GET', url).then(function (data) {
      if (myGen === gen) { cache.set(rel, data); loading.delete(rel); }
      return data;
    }, function (e) {
      if (myGen === gen) loading.delete(rel);
      throw e;
    });
    loading.set(rel, p);
    return p;
  }

  function actBtn(act, title, svg, danger) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tree-act' + (danger ? ' danger' : '');
    b.dataset.act = act;
    b.title = title;
    b.innerHTML = svg;
    return b;
  }

  function rowFor(ent, depth) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.rel = ent.rel;
    row.dataset.type = ent.type;
    row.style.paddingLeft = (6 + depth * 14) + 'px';
    row.title = ent.rel;
    if (ent.type === 'dir') {
      row.classList.add('is-dir');
      if (expanded.has(ent.rel)) row.classList.add('open');
    }
    if (ent.type === 'link') row.classList.add('is-link');
    if (ent.ignored) row.classList.add('is-ignored');

    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    row.appendChild(caret);

    const ico = document.createElement('span');
    ico.className = 'tree-ico';
    ico.innerHTML = ent.type === 'dir' ? SVG_FOLDER : (ent.type === 'link' ? SVG_LINK : SVG_FILE);
    row.appendChild(ico);

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = ent.name;
    row.appendChild(name);

    if (ent.ignored) {
      row.title = ent.rel + '（已忽略的大目录/构建产物）';
      return row;
    }
    // 行内动作：服务器形态给「下载 / 删除」；local 本就跑在同一台机器上，
    // 「下载」到本地是多余的（用 Finder 直接看原文件更顺），所以换成「在 Finder 中显示」。
    if (ent.type === 'file' && !localCapable) row.appendChild(actBtn('download', '下载', SVG_DL, false));
    if (localCapable) row.appendChild(actBtn('reveal', '在 Finder 中显示', SVG_REVEAL_SM, false));
    row.appendChild(actBtn('delete', '删除', SVG_DEL, true));
    return row;
  }

  async function renderDirInto(container, rel, depth) {
    container.innerHTML = '';
    const data = await openDir(rel);
    if (!data) return;
    const frag = document.createDocumentFragment();
    const list = data.entries || [];
    if (!list.length) tip(frag, '（空目录）');
    for (const ent of list) {
      frag.appendChild(rowFor(ent, depth));
      if (ent.type === 'dir' && !ent.ignored && expanded.has(ent.rel)) {
        const kids = document.createElement('div');
        kids.className = 'tree-children';
        frag.appendChild(kids);
        renderDirInto(kids, ent.rel, depth + 1).catch(function () {}); // 异步填充子层
      }
    }
    if (data.capped) tip(frag, '仅显示前 ' + list.length + ' 项（共 ' + data.total + ' 项）', 'tree-more');
    container.appendChild(frag);
  }

  async function renderBody() {
    const body = $('tree-body');
    if (!body) return;
    // 没有会话就没有任务目录：不写提示，直接把侧栏退回会话列表。
    // 这条会兜住「在文件页里点了新建会话 / 删掉了当前会话」——那时卡片不该停在一个空树里。
    if (!sid()) {
      body.innerHTML = '';
      if (typeof setDrawerPane === 'function') setDrawerPane(false);
      return;
    }
    const sc = body.scrollTop;
    body.innerHTML = '';
    const root = document.createElement('div');
    body.appendChild(root);
    try {
      await renderDirInto(root, '', 0);
    } catch (e) {
      root.innerHTML = '';
      tip(root, '加载失败：' + e.message);
    }
    body.scrollTop = sc;
  }

  async function localAction(kind, rel) {
    if (!localCapable) return;
    if (!sid()) { toast('尚未开始会话'); return; }
    try {
      await req('POST', '/api/local/' + kind, { session: sid(), path: rel });
    } catch (e) {
      toast((kind === 'reveal' ? '打开目录失败：' : '打开终端失败：') + e.message);
    }
  }

  async function deleteNode(rel, isDir) {
    if (!sid()) return;
    const name = rel.split('/').pop();
    const ok = typeof confirmModal === 'function'
      ? await confirmModal('删除' + (isDir ? '文件夹' : '文件'),
          '删除「' + name + '」' + (isDir ? '（含其中全部内容）' : '') + '？', '删除', true)
      : true;
    if (!ok) return;
    try {
      await req('DELETE', '/api/sessions/' + sid() + '/files?path=' + encodeURIComponent(rel));
      // 预览里正开着被删的文件 → 一起关掉，别留一份已不存在的内容
      if (typeof pvState === 'object' && pvState && pvState.name === rel && typeof pvCloseDoc === 'function') pvCloseDoc();
      invalidate(true);
      renderBody();
      toast('已删除');
    } catch (e) { toast('删除失败：' + e.message); }
  }

  function onTreeClick(e) {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const rel = row.dataset.rel;
    const isDir = row.dataset.type === 'dir';
    const act = e.target.closest('.tree-act');
    if (act) {
      e.stopPropagation();
      const a = act.dataset.act;
      if (a === 'download') { if (typeof downloadFile === 'function') downloadFile(rel); }
      else if (a === 'delete') deleteNode(rel, isDir);
      else if (a === 'reveal') localAction('reveal', rel);
      return;
    }
    if (row.classList.contains('is-ignored') || row.dataset.type === 'link') return;
    if (isDir) {
      if (expanded.has(rel)) expanded.delete(rel); else expanded.add(rel);
      renderBody();
    } else if (typeof openFilePreview === 'function') {
      openFilePreview(rel, '');
      // 窄屏的预览是全屏浮层：点完把抽屉收起（同点会话的行为），否则关预览后还压在抽屉上
      if (typeof openDrawer === 'function' && !window.matchMedia('(min-width: 960px)').matches) openDrawer(false);
    }
  }

  // local 能力探测结果回来后才把「在 Finder/终端中打开」露出来（服务器形态永远隐藏）
  function syncLocalButtons() {
    const rv = $('tree-reveal'), tm = $('tree-terminal');
    if (rv) rv.classList.toggle('hidden', !localCapable);
    if (tm) tm.classList.toggle('hidden', !localCapable);
    if (localCapable && $('tree-body')) renderBody(); // 行内 reveal 按钮也要重新生成
  }

  function ensureShell() {
    const box = $('files-tree');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    box.innerHTML = '';

    // 头部直接复用预览栏的 .pv-head / .pv-actions / .icon-btn：
    // 两者在桌面上左右并排，尺寸/描边/内边距必须一模一样，否则一眼就看出错位。
    // 不放地址条（路径在 280px 里必然截断，没有信息量），所以只剩右侧操作钮。
    const head = document.createElement('header');
    head.className = 'pv-head tree-head';
    head.innerHTML =
      '<span class="pv-actions">' +
        '<button class="icon-btn" type="button" id="tree-hidden" title="显示隐藏文件" aria-label="显示隐藏文件">' + SVG_EYE + '</button>' +
        '<button class="icon-btn" type="button" id="tree-refresh" title="刷新" aria-label="刷新">' + SVG_REFRESH + '</button>' +
        '<button class="icon-btn hidden" type="button" id="tree-reveal" title="在 Finder 中打开" aria-label="在 Finder 中打开">' + SVG_REVEAL + '</button>' +
        '<button class="icon-btn hidden" type="button" id="tree-terminal" title="在终端中打开" aria-label="在终端中打开">' + SVG_TERM + '</button>' +
      '</span>';

    const body = document.createElement('div');
    body.className = 'tree-body';
    body.id = 'tree-body';

    box.appendChild(head);
    box.appendChild(body);

    head.querySelector('#tree-hidden').addEventListener('click', function () {
      showHidden = !showHidden;
      invalidate(false);
      this.classList.toggle('active', showHidden);
      renderBody();
    });
    head.querySelector('#tree-refresh').addEventListener('click', function () {
      invalidate(true);
      renderBody();
    });
    head.querySelector('#tree-reveal').addEventListener('click', function () { localAction('reveal', ''); });
    head.querySelector('#tree-terminal').addEventListener('click', function () { localAction('terminal', ''); });
    body.addEventListener('click', onTreeClick);

    syncLocalButtons();
  }

  // 侧栏底部「文件树」图标 → 切到这个面板（由 files.js 的 setDrawerPane 调用）。
  window.showFileTree = function () {
    ensureShell();
    renderBody();
  };

  // 会话切换后由 sessions.js 调用，避免树停在旧会话。
  window.refreshFileTree = function () {
    invalidate(false);
    const drawer = $('drawer');
    if (drawer && drawer.classList.contains('drawer-mode-files')) renderBody();
  };

  (function init() {
    if (!$('drawer-actions') || !$('files-tree')) return;
    req('GET', '/api/local/info').then(function (info) {
      if (!info || !info.enabled) return;
      localCapable = true;
      syncLocalButtons();
    }).catch(function () { /* 服务器形态：接口 404，保持纯服务器行为 */ });
  })();
})();
