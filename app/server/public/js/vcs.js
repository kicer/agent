// Git 面板（复用 #pv-pane：预览 / Git 二选一，由 body.pv-mode-vcs 切换）。
// 三个视图：list（提交历史 + 未提交入口）/ detail（提交详情）/ worktree（未提交改动）。
// 后两者共用一个渲染器，区别只在头部有没有 commit 信息。
// 不做自动刷新：打开、切视图、点刷新时才请求。
// 依赖(全局)：state esc toast req pvOpenPane pvHeader pvToolbar pvClearBody pvState pvDesktop openFilePreview
'use strict';
(function () {
  const PAGE = 30;
  // view: list | detail | worktree；cur: 当前详情响应；lastPreview: 进 Git 前预览的文件（切回用）
  const st = { view: 'list', sid: '', repo: null, commits: [], next: null, cur: null, lastPreview: null, seq: 0 };

  function bodyEl() { return document.getElementById('pv-body'); }
  function sid() { return (state && state.sessionId) || ''; }

  function api(p) {
    return req('GET', '/api/sessions/' + encodeURIComponent(sid()) + p);
  }

  // 仓库路径显示在地址条上（地址条是现成的路径位，不另开头部）
  function setAddr(repo) {
    const t = document.getElementById('pv-title');
    if (!t || !repo) return;
    t.value = repo.root || '';
    t.title = (repo.root || '') + (repo.branch ? ' · ' + repo.branch : '');
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  const BADGE = { A: '新增', D: '删除', R: '改名', M: '修改', U: '未跟踪' };

  function errBox(text, retry) {
    bodyEl().innerHTML =
      '<div class="pv-err"><div class="vcs-err-t"></div>' + (retry ? '<button type="button" class="vcs-retry">重试</button>' : '') + '</div>';
    bodyEl().querySelector('.vcs-err-t').textContent = text;
    const b = bodyEl().querySelector('.vcs-retry');
    if (b) b.addEventListener('click', retry);
  }

  function reasonText(reason) {
    if (reason === 'no_git') return '这个环境没有 git 命令。';
    if (reason === 'bad_rev') return '提交不存在，可能已被改写或清理。';
    if (reason === 'timeout') return 'git 执行超时，仓库可能过大。';
    if (reason === 'not_repo') return '未找到 git 仓库：当前会话目录及其上级都不是仓库。';
    return '读取失败：' + (reason || '未知错误');
  }

  // ---------- 列表 ----------
  function renderList() {
    const parts = [];
    parts.push('<div class="vcs-list">');
    if (st.repo) {
      parts.push('<div class="vcs-repo">' + esc(st.repo.root) + (st.repo.branch ? ' · ' + esc(st.repo.branch) : '') + '</div>');
    }
    if (st.worktree && st.worktree.files) {
      parts.push('<div class="vcs-item wt" data-act="worktree">' +
        '<div class="t">未提交的改动</div>' +
        '<div class="m">' + st.worktree.files + ' 个文件有变动</div></div>');
    }
    for (const c of st.commits) {
      parts.push('<div class="vcs-item" data-act="commit" data-id="' + esc(c.id) + '">' +
        '<div class="t">' + esc(c.subject) + '</div>' +
        '<div class="m">' + esc(c.author) + ' · ' + esc(fmtTime(c.time)) + ' · ' + esc(c.short) + '</div></div>');
    }
    if (!st.commits.length && !(st.worktree && st.worktree.files)) {
      parts.push('<div class="vcs-empty">还没有提交记录</div>');
    }
    if (st.next) parts.push('<button type="button" class="vcs-more" data-act="more">加载更多</button>');
    parts.push('</div>');
    bodyEl().innerHTML = parts.join('');
  }

  // ---------- 详情（提交 / 未提交共用）----------
  function lineHtml(cls, oldNo, newNo, text) {
    return '<div class="vcs-line' + (cls ? ' ' + cls : '') + '"><span class="n">' + (oldNo == null ? '' : oldNo) +
      '</span><span class="n">' + (newNo == null ? '' : newNo) + '</span><span class="c">' + esc(text) + '</span></div>';
  }

  // 行号自己推：@@ -a,b +c,d @@ 之后的上下文/+/- 分别推进两个计数器
  function patchHtml(f) {
    if (f.binary) return '<div class="vcs-nodiff">二进制文件，不显示差异</div>';
    if (!f.patch) return '<div class="vcs-nodiff">没有可显示的差异</div>';
    const out = [];
    const lines = String(f.patch).split('\n');
    let oldNo = 0, newNo = 0, inHunk = false, rows = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === lines.length - 1 && line === '') break; // 末尾换行不算内容行
      if (line.slice(0, 2) === '@@') {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); inHunk = true; }
        out.push('<div class="vcs-line h"><span class="n"></span><span class="n"></span><span class="c">' + esc(line) + '</span></div>');
        continue;
      }
      if (!inHunk) continue; // 文件头（diff --git / index / --- / +++）由文件行本身表达，不重复渲染
      if (line.charAt(0) === '\\') { out.push('<div class="vcs-line meta"><span class="n"></span><span class="n"></span><span class="c">' + esc(line) + '</span></div>'); continue; }
      const c = line.charAt(0);
      if (c === '+') out.push(lineHtml('a', null, newNo++, line.slice(1)));
      else if (c === '-') out.push(lineHtml('d', oldNo++, null, line.slice(1)));
      else out.push(lineHtml('', oldNo++, newNo++, line.slice(1)));
      if (++rows > 3000) { out.push('<div class="vcs-nodiff">行数过多，剩余部分已隐藏</div>'); break; }
    }
    return out.join('') || '<div class="vcs-nodiff">仅改名或模式变更，没有内容差异</div>';
  }

  function fileHtml(f, idx, openAll) {
    const open = openAll ? ' open' : '';
    return '<div class="vcs-file' + open + '" data-i="' + idx + '">' +
      '<div class="vcs-fh">' +
        '<span class="vcs-caret"></span>' +
        '<span class="vcs-path">' + esc(f.path) + '</span>' +
        '<span class="vcs-badge ' + esc(String(f.status || '').toLowerCase()) + '">' + esc(BADGE[f.status] || f.status) + '</span>' +
        '<span class="vcs-stat"><b class="a">+' + f.adds + '</b><b class="d">-' + f.dels + '</b></span>' +
      '</div>' +
      '<div class="vcs-fb">' + patchHtml(f) + (f.truncated ? '<div class="vcs-nodiff">差异过大，已截断</div>' : '') + '</div>' +
    '</div>';
  }

  function renderDetail(d) {
    st.cur = d;
    const openAll = d.files.length <= 3; // 少量文件默认展开，多文件默认折叠
    const parts = [];
    parts.push('<div class="vcs-detail">');
    parts.push('<button type="button" class="vcs-back" data-act="back">返回提交列表</button>');
    if (d.commit) {
      parts.push('<div class="vcs-commit">' +
        '<div class="vcs-subject">' + esc(d.commit.subject) + '</div>' +
        '<div class="vcs-meta"><span>' + esc(d.commit.author) + '</span><span>' + esc(fmtTime(d.commit.time)) + '</span>' +
        '<span class="vcs-hash">' + esc(d.commit.short) + '</span>' +
        (d.commit.parents && d.commit.parents.length > 1 ? '<span>合并提交</span>' : '') + '</div>' +
        (d.commit.body ? '<pre class="vcs-msg">' + esc(d.commit.body) + '</pre>' : '') +
        '</div>');
    } else {
      parts.push('<div class="vcs-commit"><div class="vcs-subject">未提交的改动</div>' +
        '<div class="vcs-meta"><span>' + esc(d.repo.branch || 'HEAD') + '</span><span>' + esc(d.repo.root) + '</span></div></div>');
    }
    parts.push('<div class="vcs-sum">' + d.stats.files + ' 个文件 · <b class="a">+' + d.stats.adds + '</b> <b class="d">-' + d.stats.dels + '</b></div>');
    d.files.forEach(function (f, i) { parts.push(fileHtml(f, i, openAll)); });
    if (!d.files.length) parts.push('<div class="vcs-empty">没有文件变动</div>');
    parts.push('</div>');
    bodyEl().innerHTML = parts.join('');
  }

  // ---------- 数据加载 ----------
  async function loadList(more) {
    const seq = ++st.seq;
    const keepTop = more ? bodyEl().scrollTop : 0; // 加载更多是整体重绘，得自己把滚动位置补回去
    st.view = 'list';
    st.sid = sid();
    if (!more) { st.commits = []; st.next = null; bodyEl().innerHTML = '<div class="pv-loading"></div>'; }
    const q = '?limit=' + PAGE + (more && st.next ? '&before=' + encodeURIComponent(st.next) : '');
    let d;
    try { d = await api('/git/commits' + q); }
    catch (e) { if (seq === st.seq) errBox('请求失败：' + (e.message || e), function () { loadList(false); }); return; }
    if (seq !== st.seq) return;
    if (!d || !d.ok) { errBox(reasonText(d && d.reason), function () { loadList(false); }); return; }
    st.repo = d.repo;
    st.worktree = d.worktree;
    st.commits = more ? st.commits.concat(d.commits) : d.commits;
    st.next = d.next;
    setAddr(d.repo);
    renderList();
    if (more) bodyEl().scrollTop = keepTop;
  }

  async function loadDetail(rev) {
    const seq = ++st.seq;
    st.view = rev === 'worktree' ? 'worktree' : 'detail';
    st.sid = sid();
    bodyEl().innerHTML = '<div class="pv-loading"></div>';
    let d;
    try { d = await api('/git/commit/' + encodeURIComponent(rev)); }
    catch (e) {
      if (seq === st.seq) errBox('请求失败：' + (e.message || e), function () { loadDetail(rev); });
      return;
    }
    if (seq !== st.seq) return;
    if (!d || !d.ok) { errBox(reasonText(d && d.reason), function () { loadDetail(rev); }); return; }
    renderDetail(d);
  }

  function refresh() {
    if (st.view === 'list') return loadList(false);
    if (st.view === 'worktree') return loadDetail('worktree');
    if (st.cur && st.cur.commit) return loadDetail(st.cur.commit.id);
    return loadList(false);
  }

  // ---------- 面板开关 ----------
  function syncBtn() {
    const b = document.getElementById('tree-vcs');
    if (b) b.classList.toggle('active', document.body.classList.contains('pv-mode-vcs'));
  }

  function setMode(on) {
    document.body.classList.toggle('pv-mode-vcs', !!on);
    syncBtn();
  }

  function openPane() {
    if (!sid()) { toast('请先打开一个会话'); return; }
    if (typeof pvDesktop === 'function' && !pvDesktop()) { toast('Git 面板仅在桌面端可用'); return; }
    const on = document.body.classList.contains('pv-mode-vcs');
    if (on && st.sid === sid()) { // 再点一次：有上次预览就切回预览，否则关面板
      setMode(false);
      if (st.lastPreview) { openFilePreview(st.lastPreview); return; }
      document.getElementById('pv-close').click();
      return;
    }
    if (!on) st.lastPreview = (typeof pvState === 'object' && pvState && pvState.name) || null;
    if (typeof pvOpenPane === 'function') pvOpenPane();
    setMode(true);
    pvClearBody();
    pvHeader(null); // 清掉预览的文件名与下载钮；地址条下面再写仓库路径
    pvToolbar({ refresh: true, popup: false, reload: refresh });
    loadList(false);
  }

  // 事件委托：pv-body 的内容每次整体重建，逐元素绑定没必要
  document.getElementById('pv-body').addEventListener('click', function (e) {
    if (!document.body.classList.contains('pv-mode-vcs')) return;
    const it = e.target.closest('.vcs-item');
    if (it) {
      if (it.dataset.act === 'worktree') loadDetail('worktree');
      else if (it.dataset.act === 'commit') loadDetail(it.dataset.id);
      return;
    }
    const more = e.target.closest('.vcs-more');
    if (more) { loadList(true); return; }
    const back = e.target.closest('.vcs-back');
    if (back) { loadList(false); return; }
    const fh = e.target.closest('.vcs-fh');
    if (fh) { fh.parentNode.classList.toggle('open'); return; }
  });

  window.openVcsPane = openPane;
  window.vcsSetMode = setMode;
  window.vcsRefresh = refresh;
})();
