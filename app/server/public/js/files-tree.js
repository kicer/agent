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
  const SVG_VCS = '<svg class="ic sm" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9v1a4 4 0 0 1-4 4H9"/></svg>';
  const SVG_EYE = '<svg class="ic sm" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
  const SVG_DL = '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const SVG_DEL = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  const SVG_REVEAL_SM = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

  let localCapable = false;     // local 启动器：才显示「在 Finder/终端中打开」
  let showHidden = false;
  let expanded = new Set(['']); // 已展开的相对目录（'' = 根）
  let cache = new Map();        // rel -> /tree 响应
  let loading = new Map();      // rel -> Promise（并发去重）
  let gen = 0;                  // 会话切换/刷新时自增，防止旧请求回填到新树的缓存
  // 多选：rel -> 'dir' | 'file'。勾目录表示整个目录（下载打成一个 zip、删除递归），
  // 所以勾目录会吃掉子项，勾子项会把祖先目录降级掉，见 toggleSel。
  let sel = new Map();

  // 失效缓存。gen 自增让在飞的旧请求回来时不再写缓存（否则切会话会闪旧目录）。
  function invalidate(keepExpanded) {
    gen++;
    cache = new Map();
    loading = new Map();
    if (!keepExpanded) { expanded = new Set(['']); sel.clear(); }
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

    // 不画展开箭头：文件夹图标已经说明可以点，点行任意位置都能展开/收起。

    // 勾选框：hover 或已选中时淡入，但占位始终在，避免 hover 时文件名左右跳。
    // 忽略的大目录和软链不参与批量操作（后端也不让删），所以不给勾选框。
    if (!ent.ignored && ent.type !== 'link') {
      const chk = document.createElement('span');
      chk.className = 'tree-check';
      chk.setAttribute('role', 'checkbox');
      chk.setAttribute('aria-label', '选择');
      const on = sel.has(ent.rel);
      chk.setAttribute('aria-checked', on ? 'true' : 'false');
      if (on) row.classList.add('selected');
      row.appendChild(chk);
    }

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
    syncSelUI();
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
      sel.delete(rel);
      invalidate(true);
      renderBody();
    } catch (e) { toast('删除失败：' + e.message); }
  }

  // ---- 多选与批量操作 ----

  // 有效选中：自身被勾，或某个祖先目录被勾（勾目录=整目录）。
  // 注意 UI 上只给 sel 里显式存在的行打勾：目录打勾就代表整目录，子行不再重复显示勾。
  function isSel(rel) {
    if (sel.has(rel)) return true;
    let p = rel;
    while (p.lastIndexOf('/') > 0) {
      p = p.slice(0, p.lastIndexOf('/'));
      if (sel.has(p)) return true;
    }
    return false;
  }

  function toggleSel(rel, type) {
    if (sel.has(rel)) {
      sel.delete(rel);
    } else {
      // 选子项时祖先目录降级为部分选择，否则一个目录会既「全选」又「只选一部分」
      let p = rel;
      while (p.lastIndexOf('/') > 0) {
        p = p.slice(0, p.lastIndexOf('/'));
        sel.delete(p);
      }
      sel.set(rel, type);
    }
    syncSelUI();
  }

  // 当前可见（已展开）的可选行
  function visibleRows() {
    const body = $('tree-body');
    if (!body) return [];
    return Array.from(body.querySelectorAll('.tree-row')).filter(function (r) {
      return !r.classList.contains('is-ignored') && r.dataset.type !== 'link';
    });
  }

  // 提交给后端前折叠：目录已选时，它下面的路径不再单独出现（否则 zip 里会重复）
  function effectiveSel() {
    const keys = Array.from(sel.keys()).sort(function (a, b) {
      return a.split('/').length - b.split('/').length;
    });
    const out = [];
    for (const k of keys) {
      if (!out.some(function (p) { return k.startsWith(p + '/'); })) out.push(k);
    }
    return out;
  }

  function syncSelUI() {
    const body = $('tree-body');
    if (body) {
      body.querySelectorAll('.tree-row').forEach(function (row) {
        const chk = row.querySelector('.tree-check');
        if (!chk) return;
        const on = sel.has(row.dataset.rel);
        chk.setAttribute('aria-checked', on ? 'true' : 'false');
        row.classList.toggle('selected', on);
      });
    }
    const n = sel.size;
    const cnt = $('tree-sel-count'), dl = $('tree-bulk-download'), del = $('tree-bulk-delete');
    if (cnt) cnt.textContent = n ? '已选 ' + n + ' 项' : '未选择';
    if (dl) dl.disabled = !n;
    if (del) del.disabled = !n;
    const all = $('tree-check-all');
    if (all) {
      const rows = visibleRows();
      const every = rows.length > 0 && rows.every(function (r) { return isSel(r.dataset.rel); });
      all.setAttribute('aria-checked', every ? 'true' : (n ? 'mixed' : 'false'));
    }
  }

  function toggleSelAll() {
    const rows = visibleRows();
    const every = rows.length > 0 && rows.every(function (r) { return isSel(r.dataset.rel); });
    sel.clear();
    if (!every) {
      // 浅的先加：父目录已经覆盖的子项不再重复记
      rows.map(function (r) { return [r.dataset.rel, r.dataset.type]; })
        .sort(function (a, b) { return a[0].split('/').length - b[0].split('/').length; })
        .forEach(function (it) { if (!isSel(it[0])) sel.set(it[0], it[1]); });
    }
    syncSelUI();
  }

  async function bulkDownload() {
    if (!sid() || !sel.size) return;
    const paths = effectiveSel();
    const hasDir = paths.some(function (p) { return sel.get(p) === 'dir'; });
    // 含目录 → 后端打成一个 zip；纯文件 → 逐个签名直链。
    // 先把 token 全取完再逐个触发，边取边点会让浏览器把后面的当弹窗拦掉。
    if (hasDir) {
      try {
        const r = await req('GET', '/api/sessions/' + sid() + '/files/zip-token?paths=' +
          encodeURIComponent(JSON.stringify(paths)));
        if (!r || !r.url) throw new Error('未拿到打包链接');
        const a = document.createElement('a');
        a.href = r.url;
        if (r.name) a.download = r.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e) { toast('打包下载失败：' + e.message); }
      return;
    }
    const items = [];
    for (const p of paths) {
      try {
        const r = await req('GET', '/api/sessions/' + sid() + '/files/download-token?path=' +
          encodeURIComponent(p));
        if (r && r.url) items.push({ name: p.split('/').pop(), url: r.url });
      } catch (e) { /* 单个取票失败不拖累其余 */ }
    }
    if (!items.length) { toast('下载失败'); return; }
    items.forEach(function (it, i) {
      setTimeout(function () {
        const a = document.createElement('a');
        a.href = it.url;
        a.download = it.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 250);
    });
  }

  async function bulkDelete() {
    if (!sid() || !sel.size) return;
    const paths = effectiveSel();
    const ok = typeof confirmModal === 'function'
      ? await confirmModal('批量删除', '删除选中的 ' + paths.length + ' 项？文件夹会连同内容一起删除。', '删除', true)
      : true;
    if (!ok) return;
    let done = 0, fail = 0;
    for (const p of paths) {
      try {
        await req('DELETE', '/api/sessions/' + sid() + '/files?path=' + encodeURIComponent(p));
        done++;
      } catch (e) { fail++; }
    }
    // 预览里正开着被删的文件就一起关掉，别留一份已不存在的内容
    if (typeof pvState === 'object' && pvState && pvState.name && typeof pvCloseDoc === 'function') {
      const cur = pvState.name;
      if (paths.some(function (p) { return cur === p || cur.startsWith(p + '/'); })) pvCloseDoc();
    }
    sel.clear();
    invalidate(true);
    renderBody();
    if (fail) toast('已删除 ' + done + ' 项，' + fail + ' 项失败'); // 全成功时列表自己就空了，不弹
  }

  function onTreeClick(e) {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const rel = row.dataset.rel;
    const isDir = row.dataset.type === 'dir';
    // 勾选框只切换选中，不展开、不预览（树里点错行代价大，整行不承担选中）
    if (e.target.closest('.tree-check')) {
      e.stopPropagation();
      toggleSel(rel, row.dataset.type);
      return;
    }
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
    // 本地端文件就在本机，批量下载是多余的，底栏只留删除；服务器端才需要
    const bulkDl = $('tree-bulk-download');
    if (bulkDl) bulkDl.classList.toggle('hidden', localCapable);
    if (localCapable && $('tree-body')) renderBody(); // 行内 reveal 按钮也要重新生成
  }

  function ensureShell() {
    const box = $('files-tree');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    box.innerHTML = '';

    // 头部直接复用预览栏的 .pv-head / .pv-actions / .icon-btn：
    // 两者在桌面上左右并排，尺寸/描边/内边距必须一模一样，否则一眼就看出错位。
    // 不放地址条（路径在 280px 里必然截断，没有信息量）。
    // 操作钮按用途分两组：左边是树内的只读操作（显示隐藏文件 / 刷新 / Git 面板），
    // 右边是拉到外部打开（Finder / 终端，仅本地模式出现）。两组分居两端，连点不易误触。
    const head = document.createElement('header');
    head.className = 'pv-head tree-head';
    head.innerHTML =
      '<span class="pv-actions tree-actions-main">' +
        '<button class="icon-btn" type="button" id="tree-hidden" title="显示隐藏文件" aria-label="显示隐藏文件">' + SVG_EYE + '</button>' +
        '<button class="icon-btn" type="button" id="tree-refresh" title="刷新" aria-label="刷新">' + SVG_REFRESH + '</button>' +
        '<button class="icon-btn" type="button" id="tree-vcs" title="Git 改动与历史" aria-label="Git 改动与历史">' + SVG_VCS + '</button>' +
      '</span>' +
      '<span class="pv-actions tree-actions-ext">' +
        '<button class="icon-btn hidden" type="button" id="tree-reveal" title="在 Finder 中打开" aria-label="在 Finder 中打开">' + SVG_REVEAL + '</button>' +
        '<button class="icon-btn hidden" type="button" id="tree-terminal" title="在终端中打开" aria-label="在终端中打开">' + SVG_TERM + '</button>' +
      '</span>';

    const body = document.createElement('div');
    body.className = 'tree-body';
    body.id = 'tree-body';

    // 底部批量条：全选框、计数、下载/删除。未选时两个按钮禁用。
    const foot = document.createElement('div');
    foot.className = 'tree-foot';
    foot.innerHTML =
      '<span class="tree-check-all" id="tree-check-all" role="checkbox" aria-checked="false" title="全选当前可见" aria-label="全选"></span>' +
      '<span class="tree-sel-count" id="tree-sel-count">未选择</span>' +
      '<button class="tree-foot-btn" type="button" id="tree-bulk-download" title="下载所选" aria-label="下载所选" disabled>' + SVG_DL + '</button>' +
      '<button class="tree-foot-btn danger" type="button" id="tree-bulk-delete" title="删除所选" aria-label="删除所选" disabled>' + SVG_DEL + '</button>';

    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(foot);

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
    head.querySelector('#tree-vcs').addEventListener('click', function () {
      if (typeof window.openVcsPane === 'function') window.openVcsPane();
    });
    foot.querySelector('#tree-check-all').addEventListener('click', toggleSelAll);
    foot.querySelector('#tree-bulk-download').addEventListener('click', bulkDownload);
    foot.querySelector('#tree-bulk-delete').addEventListener('click', bulkDelete);
    body.addEventListener('click', onTreeClick);

    syncLocalButtons();
  }

  // 侧栏底部「文件树」图标 → 切到这个面板（由 files.js 的 setDrawerPane 调用）。
  window.showFileTree = function () {
    ensureShell();
    invalidate(true); // 切回面板一律重拉已展开的目录，不拿上次的缓存糊弄（后台只标脏的也在这里补上）
    renderBody();
  };

  // 会话切换后由 sessions.js 调用，避免树停在旧会话。
  window.refreshFileTree = function () {
    invalidate(false);
    const drawer = $('drawer');
    if (drawer && drawer.classList.contains('drawer-mode-files')) renderBody();
  };

  // 按需刷新（一轮跑完 / 回前台 / 断线重连）：保留展开与勾选，只重拉已展开的目录。
  // 不在文件树面板时只标脏不渲染，等切回来由 showFileTree 重新拉。
  let reloadTimer = 0, reloadAt = 0, reloading = false;
  window.reloadFileTree = function () {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async function () {
      if (Date.now() - reloadAt < 1000) return; // 刚刷过：多路触发(done/visibility/focus/resync)合并掉
      if (reloading) return; // 上一轮还在渲，跳过（它读到的就是刚清过的缓存）
      reloadAt = Date.now();
      invalidate(true);
      const drawer = $('drawer');
      if (!drawer || !drawer.classList.contains('drawer-mode-files')) return;
      reloading = true;
      try { await renderBody(); } finally { reloading = false; }
    }, 250);
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
