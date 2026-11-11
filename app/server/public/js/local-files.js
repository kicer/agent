// 本地端左栏文件树（只读）。仅在 local 启动器下启用：
// 后端 /api/local/info 拿得到才显示侧栏底部的「文件树」图标与树，服务器/手机形态完全不受影响。
// 设计要点：
//   - 目录是用户的真实项目，可能含 node_modules 等大目录，所以「展开才请求、一次一层」；
//   - 树只负责看：点文件进右侧既有预览（#pv-pane），不提供删除/新建/重命名；
//   - 「在 Finder/终端中打开」走 /api/local/reveal|terminal（后端已做会话目录内校验）。
'use strict';
(function () {
  const SVG_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const SVG_FILE = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
  const SVG_LINK = '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>';
  const SVG_REVEAL = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';
  const SVG_REFRESH = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg>';
  const SVG_TERM = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>';
  const SVG_EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';

  let enabled = false;
  let showHidden = false;
  let expanded = new Set(['']); // 已展开的相对目录（'' = 根）
  let cache = new Map();        // rel -> /tree 响应
  let loading = new Map();      // rel -> Promise（并发去重）
  let gen = 0;                 // 会话切换/刷新时自增，防止旧请求回填到新树的缓存

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
    const url = '/api/local/tree?session=' + encodeURIComponent(sid()) +
      '&dir=' + encodeURIComponent(rel) + (showHidden ? '&hidden=1' : '');
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
    } else {
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'tree-act';
      act.dataset.act = 'reveal';
      act.title = '在 Finder 中显示';
      act.innerHTML = SVG_REVEAL;
      row.appendChild(act);
    }
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
    const titleEl = $('tree-title');
    if (titleEl) titleEl.textContent = (state && (state.sessionTitle || state.sessionId)) || '文件';
    if (!sid()) { body.innerHTML = ''; tip(body, '尚未开始会话'); return; }
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
    if (!sid()) { toast('尚未开始会话'); return; }
    try {
      await req('POST', '/api/local/' + kind, { session: sid(), path: rel });
    } catch (e) {
      toast((kind === 'reveal' ? '打开目录失败：' : '打开终端失败：') + e.message);
    }
  }

  async function onTreeClick(e) {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const act = e.target.closest('[data-act="reveal"]');
    if (act) {
      e.stopPropagation();
      localAction('reveal', row.dataset.rel);
      return;
    }
    const type = row.dataset.type;
    const rel = row.dataset.rel;
    if (row.classList.contains('is-ignored') || type === 'link') return;
    if (type === 'dir') {
      if (expanded.has(rel)) expanded.delete(rel); else expanded.add(rel);
      await renderBody();
    } else if (type === 'file') {
      if (typeof openFilePreview === 'function') openFilePreview(rel, '');
    }
  }

  function ensureShell() {
    const box = $('files-tree');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    box.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'tree-head';
    head.innerHTML =
      '<span class="tree-title" id="tree-title">文件</span>' +
      '<span class="tree-actions">' +
        '<button class="tree-hbtn" type="button" id="tree-hidden" title="显示隐藏文件">' + SVG_EYE + '</button>' +
        '<button class="tree-hbtn" type="button" id="tree-refresh" title="刷新">' + SVG_REFRESH + '</button>' +
        '<button class="tree-hbtn" type="button" id="tree-reveal" title="在 Finder 中打开">' + SVG_REVEAL + '</button>' +
        '<button class="tree-hbtn" type="button" id="tree-terminal" title="在终端中打开">' + SVG_TERM + '</button>' +
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
  }

  // 侧栏底部「文件树」图标 → 切到这个面板（由 files.js 的 setDrawerPane 调用）。
  // 面板切换本身由 CSS 的 drawer-mode-files 控制，这里只负责首次建壳 + 拉一层目录。
  // 只在确认是本地模式后挂到 window 上：files.js 用它是否存在来判断「文件树」按钮可不可用。
  function exposeShowFileTree() {
    window.showFileTree = function () {
      ensureShell();
      renderBody();
    };
  }

  // 会话切换后由 sessions.js 调用，避免树停在旧会话。
  window.refreshFileTree = function () {
    if (!enabled) return;
    invalidate(false);
    const drawer = $('drawer');
    // 只在实际显示「文件」页时才去拉取，避免后台白跑一层目录请求。
    if (drawer && drawer.classList.contains('drawer-mode-files')) renderBody();
  };

  (function init() {
    if (!$('drawer-actions')) return;
    req('GET', '/api/local/info').then(function (info) {
      if (!info || !info.enabled) return;
      enabled = true;
      document.body.classList.add('local-mode');
      $('files-tree').classList.remove('hidden');
      $('da-files').classList.remove('hidden'); // 本地才有文件树
      exposeShowFileTree();
    }).catch(function () { /* 服务器形态：接口 404，保持原样 */ });
  })();
})();
