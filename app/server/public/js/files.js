// 输入区 / 任务文件面板 / 上传 / 抽屉与滑动手势(拆自 index.html 内联脚本,纯搬运不改逻辑)
'use strict';
  // ---------- 输入区 ----------
  const ta = $('msg-input');
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }
  ta.addEventListener('input', autosize);
  // 触屏设备(手机/平板)上:Enter 走默认行为(插入 \n),发消息靠发送按钮,
  // 避免软键盘的回车键直接被吞走导致连换行都打不出来。桌面/笔记本继续走 Enter=发送。
  // 用 (hover:none)&&(pointer:coarse) 判定「以触摸为主」的设备,标准且不依赖 UA 字符串。
  const isTouchPrimary = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  ta.addEventListener('keydown', e => {
    // 输入法组合中（包括拼音输入法「确认英文上屏」那次 Enter）不拦截,
    // 让 IME 自行处理。e.isComposing 是标准信号；旧版 Chrome 等环境下
    // keyCode 恒为 229,作为兜底。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Enter') return;
    // 触屏:Enter 走默认(换行),不拦截、不发送。
    if (isTouchPrimary) return;
    // 桌面:Ctrl/⌘/Shift+Enter 在光标处换行;普通 Enter 发送
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      if (!document.execCommand('insertText', false, '\n')) {
        const i = ta.selectionStart;
        ta.setRangeText('\n', i, ta.selectionEnd, 'end');
      }
      autosize();
    } else {
      e.preventDefault();
      send();
    }
  });
  $('send-btn').addEventListener('click', () => send()); // 发送按钮与 Enter 行为一致

  // 深度思考开关：每次发消息随 body 传给后端，后端会合并该模型的 thinking_params
  $('deep-think-btn').addEventListener('click', () => {
    state.deepThink = !state.deepThink;
    $('deep-think-btn').classList.toggle('on', state.deepThink);
    toast(state.deepThink ? '深度思考已开启' : '深度思考已关闭');
  });

  // ---------- 任务文件面板(底部浮层:点输入行右侧文件夹按钮展开,遮罩盖住输入区) ----------
  function setFilesPanel(open) {
    const panel = $('files-panel');
    if (open) {
      filesCurDir = ''; // 每次弹出回到根目录
      filesShowHidden = false; // 隐藏文件彩蛋态不跨次记忆，每次打开从干净视图开始
      applyFilesPanelH(); // 沿用上次拖拽高度(会话内)，无则用 CSS 默认
      loadFiles();
      // 弹出面板时收起软键盘,避免顶起布局
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
    panel.classList.toggle('open', open);
    $('files-mask').classList.toggle('show', open);
    $('files-btn').classList.toggle('active', open);
  }
  async function toggleFilesPanel() {
    const panel = $('files-panel');
    const open = !panel.classList.contains('open');
    if (open && !state.sessionId) {
      // 新建会话页不再静默建档：没有会话就没有任务目录，无从查看文件，只轻提示一下
      toast('尚未开始会话，暂无任务文件可查看');
      return;
    }
    setFilesPanel(open);
  }
  $('files-btn').addEventListener('click', toggleFilesPanel);
  // 附件(回形针)按钮:只弹文件选择器，不预建会话；选中文件后由 change 处理器
  // 写入当前会话任务目录（无会话时先建档再传，见下方）；取消选择则什么都不发生。
  $('attach-btn').addEventListener('click', () => {
    $('file-input').click();
  });
  $('files-mask').addEventListener('click', () => setFilesPanel(false)); // 点遮罩收起

  // ---------- 面板拖拽调高（底部抽屉）：拽顶部手柄上拉放大、下拉缩高，拉到最低后继续下拉→整块下滑收起 ----------
  // CSS 默认高 46%(min 240px / max 85% 视口)；拖拽结果记入 filesPanelH 会话内沿用，重新打开即恢复。
  const FP_MIN_H = 240, FP_MAX_RATIO = 0.85, FP_CLOSE_PULL = 90;
  let filesPanelH = 0; // 0 = 跟随 CSS 默认高度
  function filesPanelMaxH() { return Math.round(window.innerHeight * FP_MAX_RATIO); }
  function applyFilesPanelH() {
    const panel = $('files-panel');
    if (filesPanelH) {
      filesPanelH = Math.min(Math.max(filesPanelH, FP_MIN_H), filesPanelMaxH());
      panel.style.height = filesPanelH + 'px';
    } else {
      panel.style.height = ''; // 回 CSS 默认，切目录高度始终稳定
    }
  }
  (function bindFilesPanelDrag() {
    const panel = $('files-panel');
    const handle = $('files-drag-handle');
    let drag = null; // {startY, startH}
    function endDrag(close) {
      if (!drag) return;
      drag = null;
      panel.style.transition = ''; // 恢复开合动画
      panel.style.transform = '';
      if (close) { filesPanelH = 0; panel.style.height = ''; setFilesPanel(false); }
    }
    handle.addEventListener('pointerdown', e => {
      drag = { startY: e.clientY, startH: panel.offsetHeight };
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      panel.style.transition = 'none'; // 拖拽期间不走 transform 动画，不跟手
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!drag) return;
      const raw = drag.startH + (drag.startY - e.clientY); // 上拉为正 → 变高
      const h = Math.min(Math.max(raw, FP_MIN_H), filesPanelMaxH());
      filesPanelH = h;
      panel.style.height = h + 'px';
      const over = Math.max(0, FP_MIN_H - raw); // 拉过 minHeight → 整块向下跟随，预告即收起
      panel.style.transform = over ? 'translateY(' + over + 'px)' : '';
      if (over > FP_CLOSE_PULL) endDrag(true);
    });
    handle.addEventListener('pointerup', () => endDrag(false));
    handle.addEventListener('pointercancel', () => endDrag(false));
    // 转屏/窗口变化时按新视口重新限制到 min/max 区间
    window.addEventListener('resize', () => {
      if (panel.classList.contains('open')) applyFilesPanelH();
    });
  })();

  // 任务文件面板多选状态：Set 保留当前选中的文件路径；filesAllPaths 保留当前面板所有路径。
  // 文件夹作为整体选中项存储（键加 d: 前缀），下载时由后端打包成 zip。
  const DIR_SEL_PREFIX = 'd:';
  const fileSelected = new Set();
  let filesAllPaths = [];
  let filesTreeRoot = null; // 最近一次拉取构建的目录树（单层列表渲染与全选/有效性计算都基于它）
  let filesDirSizes = new Map(); // 目录路径('' = 根) → 其下文件递归总字节；按未过滤原始列表聚合（含隐藏的 .tmp/.venv）
  let filesCurDir = '';     // 当前浏览目录（相对任务根；'' = 根）。面包屑 + 单层列表的游标
  let filesShowHidden = false; // 彩蛋：点面板标题旁总大小文本切换 dot 项显隐（后端 ?hidden=1，连 .tmp/.venv 一起放出）

  const dirSelKey = p => DIR_SEL_PREFIX + p;
  const isDirSelKey = k => k.startsWith(DIR_SEL_PREFIX);
  const selDirPath = k => k.slice(DIR_SEL_PREFIX.length);
  // 文件是否被整体勾选的祖先目录覆盖
  function isPathInDirSel(p) {
    for (const k of fileSelected) {
      if (isDirSelKey(k) && p.startsWith(selDirPath(k) + '/')) return true;
    }
    return false;
  }
  // 文件是否被选中：自身被勾，或其某个祖先目录被整体勾选
  function isFileEffectivelySelected(p) {
    return fileSelected.has(p) || isPathInDirSel(p);
  }
  // 目录节点内所有文件的相对路径（递归）
  function filesUnderDir(node) {
    let out = node.files.map(f => f.filename);
    for (const d of node.dirs.values()) out = out.concat(filesUnderDir(d));
    return out;
  }
  // 树中全部目录节点（父在前），附各自包含的文件列表
  function collectDirNodes(node, out) {
    out = out || [];
    node = node || filesTreeRoot;
    if (!node) return out;
    for (const d of node.dirs.values()) {
      out.push({ path: d.path, files: filesUnderDir(d) });
      collectDirNodes(d, out);
    }
    return out;
  }
  // 把选中集归一化为执行列表 [{path, isDir}]：
  //  1) 去掉已被整体勾选目录覆盖的单项文件；
  //  2) 目录内文件全部选中时折叠为目录项（父目录优先，避免重复打包）。
  function effectiveSelection() {
    const dirs = []; const files = [];
    for (const k of fileSelected) {
      if (isDirSelKey(k)) dirs.push(selDirPath(k)); else files.push(k);
    }
    const covered = p => dirs.some(d => p.startsWith(d + '/'));
    const kept = files.filter(p => !covered(p));
    for (const dn of collectDirNodes()) { // 父在前
      if (dirs.includes(dn.path)) continue;
      if (dirs.some(d => dn.path.startsWith(d + '/'))) continue; // 祖先已选
      if (dn.files.length && dn.files.every(p => fileSelected.has(p) || covered(p))) {
        for (let i = dirs.length - 1; i >= 0; i--) if (dirs[i].startsWith(dn.path + '/')) dirs.splice(i, 1);
        dirs.push(dn.path);
        for (let i = kept.length - 1; i >= 0; i--) if (kept[i].startsWith(dn.path + '/')) kept.splice(i, 1);
      }
    }
    return dirs.map(path => ({ path, isDir: true })).concat(kept.map(path => ({ path, isDir: false })));
  }

  // 重算面板内（或指定范围内）文件行/目录行勾选框的视觉状态：统一按选中集推导，
  // 避免各处手写 DOM 同步漏掉嵌套目录。目录勾选态 = 显式整选，或内部文件全部被覆盖。
  function refreshFileSelStates(scope) {
    scope = scope || $('files-list');
    scope.querySelectorAll('.file-row').forEach(r => {
      const p = r.dataset.path;
      const sel = !!p && isFileEffectivelySelected(p);
      r.classList.toggle('selected', sel);
      const ck = r.querySelector('.file-check');
      if (ck) ck.setAttribute('aria-checked', sel ? 'true' : 'false');
    });
    scope.querySelectorAll('.file-dir-head').forEach(h => {
      const dp = h.dataset.dir;
      const ck = h.querySelector(':scope > .file-check');
      if (!dp || !ck) return;
      const node = filesNodeAt(dp);
      const under = node ? filesUnderDir(node) : [];
      const sel = fileSelected.has(dirSelKey(dp)) ||
        (under.length > 0 && under.every(isFileEffectivelySelected));
      h.classList.toggle('selected', sel);
      ck.setAttribute('aria-checked', sel ? 'true' : 'false');
    });
  }

  function updateFilesFooter() {
    const n = fileSelected.size;
    const total = filesAllPaths.length;
    const effCount = effectiveSelection().length;
    const countEl = $('files-count');
    const dlBtn = $('files-bulk-download');
    const delBtn = $('files-bulk-delete');
    const togBtn = $('files-toggle-all');
    if (countEl) countEl.textContent = effCount ? '已选择 ' + effCount + ' 项' : '未选择文件';
    if (dlBtn) dlBtn.disabled = n === 0;
    if (delBtn) delBtn.disabled = n === 0;
    // 全选按钮：没有文件时禁用；全部选中=打勾态；部分选中=减号态；都未选=加号态
    if (togBtn) {
      // span 没有 disabled 属性，用 aria-disabled + tabindex 控制交互能力
      const disabled = total === 0;
      togBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      togBtn.tabIndex = disabled ? -1 : 0;
      let state = 'none';
      if (total > 0 && filesAllPaths.every(isFileEffectivelySelected)) state = 'all';
      else if (n > 0) state = 'some';
      togBtn.dataset.state = state;
      togBtn.setAttribute('aria-checked', state === 'all' ? 'true' : (n > 0 ? 'mixed' : 'false'));
      togBtn.title = state === 'all' ? '取消全选' : '全选';
      togBtn.setAttribute('aria-label', state === 'all' ? '取消全选' : '全选');
    }
  }

  // 全选 / 取消全选：依据当前状态决定。全部选中 → 取消；否则 → 选中全部
  function toggleSelectAll() {
    const total = filesAllPaths.length;
    if (total === 0) return;
    const togBtn = $('files-toggle-all');
    if (togBtn && togBtn.getAttribute('aria-disabled') === 'true') return;
    if (filesAllPaths.every(p => fileSelected.has(p))) {
      fileSelected.clear();
    } else {
      for (const p of filesAllPaths) fileSelected.add(p);
    }
    // 同步文件行与目录头勾选框的视觉状态
    refreshFileSelStates();
    updateFilesFooter();
  }

  // ---------- 目录浏览：后端返回扁平列表(路径可含子目录)，前端组树后按「面包屑 + 单层列表」展示 ----------
  // 规则：主体只渲染当前目录的直接子项，目录在上、文件在下；同级目录按名称排序，同级文件按时间倒序(新的在前)。
  // filesCurDir 为当前浏览目录('' = 任务根)；顶部面包屑(/ > a > b)点任意节点回跳，点目录行进一层；无折叠态。

  function fileTimeOf(f) { return f.mtime || f.ctime || 0; }
  function sortFilesByTime(arr) {
    arr.sort(function (a, b) {
      const d = fileTimeOf(b) - fileTimeOf(a); // 时间缺失的排最后，与原逻辑一致
      if (d) return d;
      return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;
    });
    return arr;
  }
  function sortDirsByName(arr) {
    arr.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return arr;
  }

  // 扁平文件列表 → 树节点 { name, path, dirs: Map, files: [] }
  // 目录标记行（?dirs=1：filename 以 '/' 结尾 + dir:true）只沿途铺设路径节点、不入任何 files[]，
  // 不含文件的空夹子因此也能渲染；与同名文件路径铺出的节点经 dirs Map 天然去重。
  function buildFilesTree(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const f of files) {
      const isDir = f.dir === true || /\/$/.test(String(f.filename));
      const name = isDir ? String(f.filename).replace(/\/+$/, '') : String(f.filename);
      if (!name) continue;
      const segs = name.split('/');
      let node = root, rel = '';
      const dirDepth = isDir ? segs.length : segs.length - 1; // 文件：末段是文件名；目录：全是路径段
      for (let i = 0; i < dirDepth; i++) {
        const seg = segs[i];
        rel = rel ? rel + '/' + seg : seg;
        if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, path: rel, dirs: new Map(), files: [] });
        node = node.dirs.get(seg);
      }
      if (!isDir) node.files.push(f);
    }
    return root;
  }

  // 目录(含子目录)内文件总数，用于目录头计数
  function countDirFiles(node) {
    let n = node.files.length;
    for (const d of node.dirs.values()) n += countDirFiles(d);
    return n;
  }

  function fileRowHtml(f) {
    // 预览策略：md/txt/html/pdf + 图片在 fs-viewer 预览（pdf 按 pdfViewerEnabled 页内/下载分流）
    const low = f.filename.toLowerCase();
    const fsPv = /\.(md|txt|html?|pdf|png|jpe?g|gif|webp|svg)$/.test(low);
    const ico = fsPv
      ? '<svg class="file-ico eye" viewBox="0 0 24 24" aria-label="可预览"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
      : '<svg class="file-ico doc" viewBox="0 0 24 24" aria-label="可下载"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
    const name = esc(String(f.filename).split('/').pop() || f.filename);
    const ftime = fmtTime(f.mtime || f.ctime);
    const sel = isFileEffectivelySelected(f.filename);
    return '<div class="file-row' + (fsPv ? ' clickable' : '') + (sel ? ' selected' : '') + '" data-path="' + esc(f.filename) + '" data-preview="' + (fsPv ? '1' : '0') + '">' +
      '<span class="file-check" role="checkbox" aria-checked="' + (sel ? 'true' : 'false') + '" aria-label="选择"></span>' +
      '<div class="file-main">' +
        '<div class="file-name">' + name + '</div>' +
        '<div class="file-meta">' + ico + '<span class="file-size">' + fmtSize(f.size) + '</span>' +
          (ftime ? '<span class="file-time">' + ftime + '</span>' : '') + '</div>' +
      '</div>' +
    '</div>';
  }

  // 目录行（带勾选框）：整个文件夹作为一个选中项（下载时后端打包成 zip）；
  // 点行其余区域进入该目录（单层列表，不再有折叠/展开）。
  function dirRowHtml(node) {
    const under = filesUnderDir(node);
    const checked = fileSelected.has(dirSelKey(node.path)) ||
      (under.length > 0 && under.every(isFileEffectivelySelected));
    return '<div class="file-dir-head' + (checked ? ' selected' : '') + '" data-dir="' + esc(node.path) + '" role="button">' +
      '<span class="file-check" role="checkbox" aria-checked="' + (checked ? 'true' : 'false') + '" aria-label="选择文件夹"></span>' +
      '<svg class="file-dir-ico" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>' +
      '<span class="file-dir-name">' + esc(node.name) + '</span>' +
      '<span class="file-dir-count">' + countDirFiles(node) + ' 个文件</span>' +
      '<svg class="file-dir-go" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
    '</div>';
  }

  // 按相对路径取树节点（'' = 根）；路径不存在（如删除后重拉）返回 null
  function filesNodeAt(path) {
    let node = filesTreeRoot;
    if (!node) return null;
    if (!path) return node;
    for (const seg of String(path).split('/')) {
      node = node.dirs.get(seg);
      if (!node) return null;
    }
    return node;
  }

  // 渲染当前目录：顶部面包屑（根目录(home) › a › b，点任意节点回跳）+ 单层列表（目录在前、文件在后）。
  // 面包屑常显：根目录时只亮「根目录」当前层；进入子目录后逐级铺开。
  function renderFilesDir() {
    const el = $('files-list');
    const crumbEl = $('files-crumbs');
    let node = filesNodeAt(filesCurDir);
    if (!node) { filesCurDir = ''; node = filesNodeAt(''); } // 当前目录已被删除 → 退回根
    const sizeEl = $('files-panel-size');
    if (!node) { el.innerHTML = ''; if (sizeEl) sizeEl.textContent = ''; return; }
    // 标题旁总大小：按未过滤的聚合表取当前目录递归总量（关彩蛋时服务端不返回 dot 项；开彩蛋时含 .imgcache/.tmp/.venv 全计）
    if (sizeEl) {
      const total = filesDirSizes.get(filesCurDir) || 0;
      sizeEl.textContent = total > 0 ? fmtSize(total) : '';
    }
    // 根节点：home 图标 + 「根目录」，比一个孤悬的「/」醒目得多；在根时它是当前层，纯文本不可点
    const homeIc = '<svg class="crumb-ic" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>';
    let html = filesCurDir
      ? '<span class="crumb" data-path="">' + homeIc + '根目录</span>'
      : '<span class="crumb cur">' + homeIc + '根目录</span>';
    if (filesCurDir) {
      let acc = '';
      const segs = filesCurDir.split('/');
      segs.forEach(function (seg, i) {
        acc = acc ? acc + '/' + seg : seg;
        html += '<span class="crumb-sep">›</span>';
        html += (i === segs.length - 1)
          ? '<span class="crumb cur">' + esc(seg) + '</span>' // 当前层纯文本不可点
          : '<span class="crumb" data-path="' + esc(acc) + '">' + esc(seg) + '</span>';
      });
    }
    crumbEl.innerHTML = html;
    crumbEl.classList.remove('hidden');
    const dirs = sortDirsByName(Array.from(node.dirs.values()));
    sortFilesByTime(node.files);
    if (!dirs.length && !node.files.length) {
      el.innerHTML = '<div class="empty-tip">' + (filesCurDir ? '该文件夹为空' : '还没有文件,在对话框上传或让 AI 生成') + '</div>';
      return;
    }
    el.innerHTML = dirs.map(dirRowHtml).join('') + node.files.map(fileRowHtml).join('');
  }

  async function loadFiles() {
    if (!state.sessionId) return;
    // 重新拉取前清空旧选择，避免脏数据遗留
    fileSelected.clear();
    filesAllPaths = [];
    filesTreeRoot = null;
    updateFilesFooter();
    try {
      // 彩蛋开启时后端连 dot 项一起列，且不再滤 .tmp/.venv（全量放出）
      const hiddenQ = filesShowHidden ? '&hidden=1' : '';
      const files = await req('GET', '/api/sessions/' + state.sessionId + '/files?dirs=1' + hiddenQ);
      // 会话级 .tmp（executor 的共享 /tmp 落盘处）与 .venv（Python 虚拟环境）不属于任务产物：默认隐藏（老后端兼容兑底；新版关彩蛋时服务端已不返回 dot 项）
      const shown = filesShowHidden ? files : files.filter(f => !/^(\.tmp|\.venv)(\/|$)/.test(String(f.filename)));
      // 目录标记行不参与选中/全选/计数，只用来铺树（空文件夹可见）
      filesAllPaths = shown.filter(f => !(f.dir === true || /\/$/.test(String(f.filename)))).map(f => f.filename);
      // 重建目录树后只渲染当前目录这一层(后端已按时间倒序,组内再排一次防旧排序缓存)
      filesTreeRoot = buildFilesTree(shown);
      // 总大小按原始列表（含 .tmp/.venv）聚合：目录标记行无字节量跳过；文件把 size 记到每一级祖先目录（根 = ''）
      filesDirSizes = new Map([['', 0]]);
      for (const f of files) {
        if (f.dir === true || /\/$/.test(String(f.filename))) continue;
        const sz = Number(f.size) || 0;
        if (!sz) continue;
        filesDirSizes.set('', (filesDirSizes.get('') || 0) + sz);
        const segs = String(f.filename).split('/');
        segs.pop(); // 末段是文件名，其余是祖先目录
        let acc = '';
        for (const seg of segs) {
          acc = acc ? acc + '/' + seg : seg;
          filesDirSizes.set(acc, (filesDirSizes.get(acc) || 0) + sz);
        }
      }
      renderFilesDir(); // filesCurDir 失效时自动退回根目录
      // 重新渲染后刷新底部计数与按钮状态
      updateFilesFooter();
    } catch (e) { toast('读取文件失败:' + e.message); }
  }
  // 造一个「相对资源 → 任务根相对路径」解析器：以 refPath 所在目录为基准解析 p（md 图片、html 预览共用）。
  // 外链/内联/页面内跳转返回 null（不改写）。
  // 关键：marked 会把 img src 里的中文/空格预先百分号编码成 %XX，这里必须先解码回真实路径，
  // 否则最后 encodeURIComponent 会把 % 再编码成 %25（双重编码），服务端解码一次后得到含字面 %XX
  // 的假文件名 → 磁盘上不存在 → 404（中文/空格文件名图片显示不出来的根因）。
  function makeAssetResolver(refPath) {
    // refPath 所在目录（任务根下无子目录时为 ''）
    const baseSegs = refPath.includes('/') ? refPath.split('/').slice(0, -1) : [];
    return function (p) {
      p = String(p || '').trim();
      if (!p || /^(https?:)?\/\//i.test(p) || /^(data|blob|about|javascript|mailto|tel):/i.test(p)) return null; // 已是外链/内联
      let raw = p;
      try { raw = decodeURIComponent(raw); } catch (_) { /* 文件名本身含裸 % 会抛，保留原文 */ }
      const hash = raw.indexOf('#');
      if (hash >= 0) raw = raw.slice(0, hash); // 资源加载不关心片段锚点
      const segs = raw.startsWith('/') ? [] : baseSegs.slice(); // 以 / 开头视为任务根下
      for (const part of raw.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') { if (segs.length) segs.pop(); continue; }
        segs.push(part);
      }
      return segs.join('/');
    };
  }
  const assetDownloadUrl = function (rel) {
    return '/api/sessions/' + state.sessionId + '/files/download?path=' + encodeURIComponent(rel);
  };
  // 把渲染好的 Markdown HTML 里的相对图片路径重写成下载接口地址：
  // 预览在浏览器里以应用页面为基准解析相对 src，而图片其实在任务目录里，直接写相对路径会 404。
  function rewriteMdImageSrcs(html, mdPath) {
    const resolve = makeAssetResolver(mdPath);
    const host = document.createElement('div');
    host.innerHTML = html;
    host.querySelectorAll('img').forEach(function (im) {
      const rel = resolve(im.getAttribute('src'));
      if (!rel) return;
      im.setAttribute('src', assetDownloadUrl(rel));
    });
    return host.innerHTML;
  }
  // HTML 预览小修：srcdoc 的基准 URL 是 about:srcdoc，相对资源路径全都解析失败。
  // 把 img/script/link(stylesheet)/source 等常见资源引用改写成绝对下载地址；
  // CSS url() 内部、JS fetch 的相对路径覆盖不了（那需要后端目录级 inline 访问，暂不做）。
  function rewriteHtmlDocSrcs(html, filePath) {
    const resolve = makeAssetResolver(filePath);
    const doc = new DOMParser().parseFromString(html, 'text/html'); // 不用 div:保留 head/body 结构
    const fix = function (sel, attr) {
      doc.querySelectorAll(sel).forEach(function (el) {
        const rel = resolve(el.getAttribute(attr));
        if (rel) el.setAttribute(attr, assetDownloadUrl(rel));
      });
    };
    fix('img[src]', 'src');
    fix('script[src]', 'src');
    fix('source[src]', 'src');
    fix('video[src]', 'src');
    fix('video[poster]', 'poster');
    fix('audio[src]', 'src');
    fix('embed[src]', 'src');
    fix('track[src]', 'src');
    fix('input[type="image"][src]', 'src');
    fix('use[href]', 'href');
    doc.querySelectorAll('link[href]').forEach(function (el) {
      if (!/(stylesheet|icon)/i.test(String(el.getAttribute('rel') || ''))) return; // 只动样式/图标，不碰页面跳转
      const rel = resolve(el.getAttribute('href'));
      if (rel) el.setAttribute('href', assetDownloadUrl(rel));
    });
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }
  // 单击可预览文件 → 全屏预览(#fs-viewer)：md 按 markdown 渲染、txt 原文排版、html 用沙箱 iframe、pdf 按 pdfViewerEnabled 页内/下载分流、图片用 <img>
  async function previewInFs(name) {
    try {
      const r = await fetch('/api/sessions/' + state.sessionId + '/files/download?path=' + encodeURIComponent(name));
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
      if (!r.ok) { let msg = 'HTTP ' + r.status; try { msg = (await r.json()).error || msg; } catch (_) {} throw new Error(msg); }
      if (/\.html?$/i.test(name)) {
        const html = await r.text();
        const body = $('fs-body');
        body.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.className = 'fs-html-frame';
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
        iframe.srcdoc = rewriteHtmlDocSrcs(html, name); // 相对资源改写，否则 about:srcdoc 基准下全 404
        body.appendChild(iframe);
        setFsSource(html); // 源码钮可看页面原码
        $('fs-viewer').classList.remove('hidden');
      } else if (/\.pdf$/i.test(name)) {
        // H5 方案 A:navigator.pdfViewerEnabled 是专为「能否内嵌渲染 PDF」设计的检测位
        // (桌面各浏览器/iOS Safari = true;Android Chrome/微信 webview = false)
        if (navigator.pdfViewerEnabled) {
          const blob = await r.blob(); // 响应 Content-Type 即 application/pdf
          const url = URL.createObjectURL(blob);
          if (state.lastPdfBlobUrl) { try { URL.revokeObjectURL(state.lastPdfBlobUrl); } catch (_) {} }
          state.lastPdfBlobUrl = url;
          const body = $('fs-body');
          body.innerHTML = '';
          body.style.zoom = '';
          const frame = document.createElement('iframe');
          frame.className = 'fs-html-frame';
          frame.title = name; // 不加 sandbox:内建查看器插件需要 unrestricted 帧
          frame.src = url;
          body.appendChild(frame);
          setFsSource(null); // 二进制无源码可看,隐藏 eye 钮
          $('fs-viewer').classList.remove('hidden');
        } else {
          // 不支持页内嵌的浏览器:交给既有签名直链下载链路(Android 通知栏用系统查看器打开)
          toast('当前浏览器不支持页内预览 PDF,已开始下载');
          downloadFile(name);
        }
      } else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) {
        // 图片：复用会话里单击图片的全屏查看器（双指缩放+拖动+双击放大），大图也能看完
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        // 上一次的 blob URL 顺手释放；避免反复预览图片泄漏
        if (state.lastImgBlobUrl) { try { URL.revokeObjectURL(state.lastImgBlobUrl); } catch (_) {} }
        state.lastImgBlobUrl = url;
        openImageViewer(url, name);
      } else {
        // md/txt：复用双击气泡的全屏查看器
        const text = await r.text();
        let cls = 'bubble-ai', html;
        if (/\.(md|markdown)$/i.test(name)) {
          const r2 = mdHtml(text);
          html = r2.html;
          if (r2.fmt) {
            cls += ' md';
            html = rewriteMdImageSrcs(html, name);
          }
        } else {
          html = esc(text);
        }
        const wrap = document.createElement('div');
        wrap.className = 'msg other';
        wrap.innerHTML = '<div class="' + cls + '">' + html + '</div>';
        decorateCodePre(wrap); // 先装饰再克隆:按钮随 openFullscreen 的深拷贝进查看器,fs-viewer 已有 .act-copy 委托
        openFullscreen(wrap.firstChild, text); // 文件原文供 eye 钮看源码
      }
    } catch (e) { toast('预览失败:' + e.message); }
  }
  async function downloadFile(name) {
    if (!state.sessionId) return;
    try {
      const r = await req('GET', '/api/sessions/' + state.sessionId + '/files/download-token?path=' + encodeURIComponent(name));
      window.location.href = r.url; // 原生导航下载:同源自动带登录 cookie,文件名不乱
    } catch (e) { toast('下载失败:' + e.message); }
  }
  async function deleteFile(name) {
    if (!await confirmModal('删除文件', '删除文件 ' + name + ' ?', '删除', true)) return;
    try {
      await req('DELETE', '/api/sessions/' + state.sessionId + '/files?path=' + encodeURIComponent(name));
      loadFiles();
    } catch (e) { toast('删除失败:' + e.message); }
  }
  // 列表事件委托（单层列表，目录不再有折叠/展开）：
    //  1) 目录行勾选框：整体选中/取消该文件夹（下载时后端打包成 zip）；点行其余区域：进入该目录；
    //  2) 点击文件行勾选框：仅选中状态，不触发预览/下载；
    //  3) 一旦处于多选模式（Set 非空），整行点击仅切换选中状态，不再预览/下载；
    //  4) 未进入多选模式时，点击文件名/图标根据 row.dataset.preview 决定预览或下载。
    $('files-list').addEventListener('click', e => {
      // 目录行：勾选框切换整选，其余区域进入该目录
      const head = e.target.closest('.file-dir-head');
      if (head) {
        const dp = head.dataset.dir;
        if (!dp || !state.sessionId) return;
        if (e.target.closest('.file-check')) { toggleDirSelect(dp); return; }
        filesCurDir = dp;
        renderFilesDir();
        return;
      }
      const row = e.target.closest('.file-row');
      if (!row || !state.sessionId) return;
      const path = row.dataset.path;
      if (!path) return;
      const isCheck = !!e.target.closest('.file-check');
      // 多选模式下：任何点击（仅选框/文件名/其他）都只切换选中
      if (isCheck || fileSelected.size > 0) {
        // 已被整体勾选文件夹覆盖的行：点选无效，选中与否由文件夹勾选框决定
        if (isPathInDirSel(path)) return;
        if (fileSelected.has(path)) { fileSelected.delete(path); }
        else { fileSelected.add(path); }
        // 同步本行与所在目录链的勾选态（目录可能因内部全选/取消全选而变）
        refreshFileSelStates();
        updateFilesFooter();
        return;
      }
    // 默认模式：依据是否可预览选择预览/下载
      if (row.dataset.preview === '1') previewInFs(path);
      else downloadFile(path);
    });

  // 整体选中/取消一个文件夹：目录作为单条选中项（d: 前缀），行视觉态由 refreshFileSelStates 重算。
  // 整体勾选时取消内部单项/子目录勾选（已被覆盖，避免重复计入）；取消勾选时子项恢复未选。
  function toggleDirSelect(dirPath) {
    const key = dirSelKey(dirPath);
    const on = !fileSelected.has(key);
    if (on) {
      fileSelected.add(key);
      // 整体勾选后，内部单项文件/子目录勾选都被覆盖，直接移除避免重复计入
      const prefix = dirPath + '/';
      for (const k of Array.from(fileSelected)) {
        if (k === key) continue;
        const p = isDirSelKey(k) ? selDirPath(k) : k;
        if (p.startsWith(prefix)) fileSelected.delete(k);
      }
    } else {
      fileSelected.delete(key);
    }
    // 目录行/文件行勾选态统一按选中集重算
    refreshFileSelStates();
    updateFilesFooter();
  }

  // 面包屑点击：回跳到任意祖先层级（当前层节点无 data-path，不可点）
  $('files-crumbs').addEventListener('click', e => {
    const c = e.target.closest('.crumb[data-path]');
    if (!c) return;
    filesCurDir = c.dataset.path;
    renderFilesDir();
  });

  // 彩蛋：点面板标题旁的总大小文本 = 切换隐藏文件（dot 项含 .tmp/.venv）显隐。
  // 故意不加任何光标/文案提示，也不限层级（子目录里点同样生效）。
  $('files-panel-size').addEventListener('click', () => {
    filesShowHidden = !filesShowHidden;
    loadFiles();
  });

    // 批量下载：选中项含文件夹（含全选后整目录被覆盖的情况）时，整个选择交给后端打包成
    // 一个 zip 一次下载；纯文件选择保持逐文件直链下载。zip 同样走签名直链（与单文件同链路）。
    async function bulkZipDownload(paths) {
      try {
        const r = await req('GET', '/api/sessions/' + state.sessionId + '/files/zip-token?paths=' + encodeURIComponent(JSON.stringify(paths)));
        if (!r || !r.url) throw new Error('未拿到打包链接');
        const a = document.createElement('a');
        a.href = r.url;
        a.download = r.name || 'archive.zip';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); } catch (_) {} }, 1000);
      } catch (e) { toast('打包下载失败:' + e.message); }
    }
    // 批量下载：先把所有 download-token 拿完，再用服务器直链逐个触发下载。
    // 两个历史坑：
    //  1) 边拿 token 边 location.href：首个下载导航会打断后续 fetch（第 2 个报失败）；
    //     → 先批量拿完 token 再触发。
    //  2) fetch+blob 方案：手机浏览器不认 blob 文件名（变编号/.bin），
    //     套壳 WebView 不处理 blob: 下载请求（点了没反应）；
    //     → 回到服务器原始直链（文件名跟 Content-Disposition），与单文件下载同一条链路。
    async function bulkDownload() {
      if (!state.sessionId || fileSelected.size === 0) return;
      const eff = effectiveSelection();
      if (eff.some(x => x.isDir)) { bulkZipDownload(eff.map(x => x.path)); return; }
      const names = eff.map(x => x.path);
      // 第一阶段：全部 token 先拿到手（此时还没发生任何导航，fetch 不会被打断）
      const items = [];
      for (const name of names) {
        try {
          const r = await req('GET', '/api/sessions/' + state.sessionId + '/files/download-token?path=' + encodeURIComponent(name));
          if (!r || !r.url) throw new Error('未拿到下载链接');
          items.push({ url: r.url, name: String(name).split('/').pop() || name });
        } catch (e) { toast('下载失败:' + name + ' ' + e.message); }
      }
      // 第二阶段：隐藏 <a> + 服务器直链逐个触发；download 属性作手机端文件名兜底，
      // 小间隔避免移动端拦截连续多次下载
      for (const it of items) {
        const a = document.createElement('a');
        a.href = it.url;
        a.download = it.name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); } catch (_) {} }, 1000);
        await new Promise(res => setTimeout(res, 350));
      }
    }
    async function bulkDelete() {
      if (!state.sessionId || fileSelected.size === 0) return;
      const names = effectiveSelection().map(x => x.path); // 目录整体删除（后端 rm -r，含子项）
      if (!await confirmModal('批量删除', '确认删除选中的 ' + names.length + ' 项（文件夹会连同内部文件一起删除）？', '删除', true)) return;
      let ok = 0, fail = 0;
      for (const name of names) {
        try {
          await req('DELETE', '/api/sessions/' + state.sessionId + '/files?path=' + encodeURIComponent(name));
          ok++;
        } catch (e) { fail++; toast('删除失败:' + name + ' ' + e.message); }
      }
      if (ok) toast('已删除 ' + ok + ' 项');
      loadFiles(); // 重新拉取并重置选中
    }
    $('files-bulk-download').addEventListener('click', bulkDownload);
    $('files-bulk-delete').addEventListener('click', bulkDelete);
    const togEl = $('files-toggle-all');
    togEl.addEventListener('click', toggleSelectAll);
    togEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelectAll(); }
    });
  // ---------- 大图上传前压缩(同步 v1:阈值/参数由 /api/system/status 透出) ----------
  const DEFAULT_UPLOAD_CFG = { image_compress_threshold_kb: 1536, image_max_dim: 2000, image_quality: 0.85, confirm_size_mb: 10 };
  // 后端 multer 单文件硬限（routes/files.js limits.filesize），前端预检对齐它，超了直接拒掉不发起上传
  const UPLOAD_HARD_LIMIT = 50 * 1024 * 1024;
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
  // 上传前逐文件预处理(串行,模态弹窗不能并行)，返回待上传 File 或 null(用户放弃该文件):
  //  1) 大图(>image_compress_threshold_kb)：三选一——「压缩」本地压后传 / 「直接上传」原样传 /
  //     右上 X、点遮罩关闭 = 放弃该文件(不上传，也就不触发建会话)；
  //  2) 最终体积 >50M(后端 multer 硬限)：直接拒掉，不发起上传；
  //  3) 预处理后仍 >confirm_size_mb(默认 10M，不限类型)：二次确认「继续上传」，
  //     取消/X/遮罩一律放弃。
  // 压缩失败/无收益按原文件继续后续流程。
  async function prepareUploadFile(file) {
    const cfg = await getUploadCfg();
    const isImg = /^image\//.test(file.type || '') || /\.(png|jpe?g|gif|bmp|webp)$/i.test(file.name || '');
    const threshold = Number(cfg.image_compress_threshold_kb || 1536) * 1024;
    const maxDim = Number(cfg.image_max_dim || 2000);
    const quality = Number(cfg.image_quality || 0.85);
    if (isImg && file.size > threshold) {
      // confirmModal resolve: true=压缩 / false=直接上传 / null=X或遮罩=放弃
      const ans = await confirmModal('图片文件过大',
        '「' + file.name + '」有 ' + fmtSize(file.size) + '，超过 ' + fmtSize(threshold) +
        '。建议在浏览器本地压缩为 JPEG(长边≤' + maxDim + 'px)后再上传；也可原样直接上传。',
        '压缩', false, { cancelText: '直接上传' });
      if (ans === null) return null;
      if (ans) {
        try {
          const img = await loadImageEl(file);
          const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
          if (!iw || !ih) throw new Error('无法读取图片尺寸');
          const scale = Math.min(1, maxDim / Math.max(iw, ih));
          const w = Math.max(1, Math.round(iw * scale)), h = Math.max(1, Math.round(ih * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          // 透明底(PNG)转 JPEG 前先铺白,避免变黑
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const blob = await new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, 'image/jpeg', quality); });
          if (!blob || blob.size >= file.size) {
            toast('压缩无收益,按原文件上传');
          } else {
            const newName = String(file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
            toast('已压缩 ' + fmtSize(file.size) + ' → ' + fmtSize(blob.size));
            file = new File([blob], newName, { type: 'image/jpeg' });
          }
        } catch (e) {
          toast('压缩失败(' + (e && e.message || e) + '),按原文件上传');
        }
      }
    }
    // 后端 multer 单文件硬限 50M：压缩后仍超限、或选了「直接上传」的超限大图、非图片超限文件，
    // 都在这里拒掉（返回 null，与其他「放弃」同一条路径），免得传完一个 500 才知道原因
    if (file.size > UPLOAD_HARD_LIMIT) {
      toast('「' + file.name + '」有 ' + fmtSize(file.size) + '，超过 50M 上限，无法上传' + (isImg ? '，可尝试选「压缩」后上传' : ''));
      return null;
    }
    // 最终体积仍超大盘阈值的文件(含非图片、含压缩后仍超限)：用户确认后才传
    const bigLimit = Number(cfg.confirm_size_mb || 10) * 1024 * 1024;
    if (file.size > bigLimit) {
      const go = await confirmModal('文件过大',
        '「' + file.name + '」有 ' + fmtSize(file.size) + '，超过 ' + fmtSize(bigLimit) + '。确认继续上传？',
        '继续上传');
      if (go !== true) return null; // 取消/X/遮罩：不传该文件
    }
    return file;
  }

  // ---------- 上传文件卡片(嵌在输入框内部顶端,随卡片数撑高输入框;新卡插最前,图标 + 文件名/类型大小,逐卡上传进度遮罩;过多横向滚动) ----------
  function uploadTypeLabel(name) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
    return m ? m[1].toUpperCase() : '文件';
  }
  function uploadIconSvg(name) {
    // 与文件面板同款图标语言:图片用图、其余用文档
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || '')
      ? '<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>'
      : '<svg class="ic" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
  }
  function addUploadCard(file) {
    const row = $('up-cards');
    row.classList.remove('hidden');
    const card = document.createElement('div');
    card.className = 'up-card';
    card.dataset.name = file.name; // 发送时按名字在正文前拼告知行
    card.innerHTML =
      '<div class="up-ico">' + uploadIconSvg(file.name) + '</div>' +
      '<div class="up-info">' +
        '<div class="up-name" title="' + esc(file.name) + '">' + esc(file.name) + '</div>' +
        '<div class="up-meta">' + uploadTypeLabel(file.name) + ' · ' + fmtSize(file.size) + '</div>' +
      '</div>' +
      '<button class="up-x hidden" title="不再随消息告知该文件" aria-label="移除卡片">' +
        '<svg class="ic" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '</button>' +
      '<div class="up-mask"><span class="up-pct">0%</span></div>';
    const mask = card.querySelector('.up-mask');
    const pctEl = card.querySelector('.up-pct');
    const closeBtn = card.querySelector('.up-x');
    // ×掉卡片 = 从 DOM 移除；send() 按现存 data-done 卡片实时拼告知行，自然不再包含该文件（文件本身仍在任务目录）
    closeBtn.addEventListener('click', () => {
      card.remove();
      if (!row.children.length) row.classList.add('hidden');
    });
    // 倒序:最后上传的排最前;新卡入位后横向滚回左端保证可见
    row.prepend(card);
    row.scrollTo({ left: 0, behavior: 'smooth' });
    return {
      setPct(p) {
        const v = Math.max(0, Math.min(100, Math.round(p)));
        pctEl.textContent = v + '%';
        card.style.setProperty('--up-p', v + '%');
      },
      done() {
        mask.remove();
        card.classList.add('done');
        card.dataset.done = '1'; // 仅成功上传的卡片参与发送时的告知行
        closeBtn.classList.remove('hidden');
      },
      fail() {
        card.classList.add('err');
        mask.innerHTML = '<span class="up-pct">上传失败</span>';
        closeBtn.classList.remove('hidden');
      },
    };
  }
  function clearUploadCards() {
    const row = $('up-cards');
    row.innerHTML = '';
    row.classList.add('hidden');
  }

  // 文件选择统一入口:先逐文件预处理(大图压缩询问/大文件确认,X或遮罩=放弃该文件)，
  // 只要还剩至少一个待传文件才自动建档(welcome 无会话时)并走即传路径(多文件并行上传+总进度条+逐卡进度)；
  // 全部放弃或取消选择都不上传、不新建会话。
  $('file-input').addEventListener('change', async e => {
    const input = e.target;
    const files = Array.prototype.slice.call(input.files || []); // 先快照再清空,FileList 是实时的
    input.value = '';
    if (!files.length) return;
    // 逐个串行预处理(模态弹窗不能并行)
    const ready = [];
    for (const f of files) {
      const r = await prepareUploadFile(f);
      if (r) ready.push(r);
    }
    if (!ready.length) return; // 用户全放弃了:不上传也不建档
    if (!state.sessionId) {
      try {
        await ensureSession();
      } catch (er) {
        toast('创建会话失败:' + er.message);
        return;
      }
    }
    // 每张卡对应一个文件的上传进度(输入区上方;面板内总进度条保留不变)
    const cards = ready.map(f => addUploadCard(f));
    // ---- 并行上传 + 实时进度 ----
    const progWrap = $('fp-progress'), progBar = $('fp-progress-bar'), progPct = $('fp-progress-pct');
    const tot = ready.reduce((s, f) => s + f.size, 0);
    const loaded = { v: 0 }; // 所有文件已上传字节总和
    let done = 0, errCount = 0;
    function paintProg() {
      const pct = tot ? Math.min(100, Math.round(loaded.v / tot * 100)) : 0;
      progBar.style.width = pct + '%';
      progPct.textContent = pct + '%';
    }
    progWrap.classList.remove('hidden');
    paintProg();
    const tasks = ready.map((f, i) => new Promise(resolve => {
      const card = cards[i];
      const fd = new FormData(); fd.append('files', f, f.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/sessions/' + state.sessionId + '/files');
      let lastLoaded = 0;
      xhr.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        // ev.loaded 是本文件累计已发字节,汇总时取本次增量避免多计
        loaded.v += ev.loaded - lastLoaded;
        lastLoaded = ev.loaded;
        paintProg();
        card.setPct(ev.loaded / ev.total * 100);
      };
      xhr.onload = function () {
        if (xhr.status === 200) { done++; card.done(); } else { errCount++; card.fail(); }
        // 终态补齐(可能没收到最后一帧 100%)
        if (lastLoaded < f.size) { loaded.v += f.size - lastLoaded; paintProg(); }
        resolve();
      };
      xhr.onerror = function () { errCount++; card.fail(); resolve(); };
      xhr.send(fd);
    }));
    await Promise.all(tasks);
    paintProg();
    // 全部成功不再弹提示(卡片已完成态即反馈);有失败才提醒
    if (errCount) toast('已上传 ' + done + ' 个，失败 ' + errCount + ' 个');
    loadFiles();
    // 1.2s 后收起进度条
    setTimeout(() => { progWrap.classList.add('hidden'); progBar.style.width = '0%'; }, 1200);
  });


  function renderAttachChips() {
    const row = $('attach-chips');
    row.classList.toggle('hidden', !state.attachments.length);
    row.innerHTML = state.attachments.map((f, i) =>
      '<span class="attach-chip"><span class="name">' + esc(f.name) + '</span>' +
      '<button class="rm" data-i="' + i + '" aria-label="移除附件">' +
      '<svg class="ic sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '</button></span>').join('');
  }
  $('attach-chips').addEventListener('click', e => {
    const rm = e.target.closest('.rm');
    if (rm) { state.attachments.splice(+rm.dataset.i, 1); renderAttachChips(); }
  });

  // ---------- 抽屉 ----------
  // 桌面端(≥960px):侧边栏常驻左侧列(由 body.drawer-open 驱动会话区偏移),不用遮罩;
  // 移动端(<960px):仍为浮层抽屉 + 遮罩。
  const drawerMQ = window.matchMedia('(min-width: 960px)');
  function openDrawer(open) {
    // 清掉手势拖动遗留的内联位移/透明度,改由 CSS transition 负责开合动画
    const drawer = $('drawer'), scrim = $('scrim');
    drawer.style.transform = ''; drawer.style.transition = '';
    scrim.style.opacity = '';
    drawer.classList.toggle('open', open);
    scrim.classList.toggle('show', open && !drawerMQ.matches);
    document.body.classList.toggle('drawer-open', open);
  }
  $('menu-btn').addEventListener('click', () => {
    const open = !$('drawer').classList.contains('open');
    openDrawer(open);
    if (open) loadSessionList();
  });
  $('scrim').addEventListener('click', () => openDrawer(false));

  let searchTimer = null;
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadSessionList, 250);
  });
  $('drawer-list').addEventListener('click', e => {
    // 桌面端 hover 删除按钮:先于打开会话处理,点击弹删除确认 modal
    const delBtn = e.target.closest('.conv-del');
    if (delBtn) { e.stopPropagation(); deleteSession(delBtn.dataset.del); return; }
    const item = e.target.closest('.conv-item');
    if (!item) return;
    openSession(item.dataset.id);
    if (!drawerMQ.matches) openDrawer(false); // 桌面端侧栏常驻,选完会话不收起来
  });

  // ---------- 移动端右滑会话行露出删除按钮(iOS 风格) ----------
  (function bindSwipeToDelete() {
    const list = $('drawer-list');
    const THRESHOLD = 60;  // 滑过这个距离开
    let g = null;          // {x0, y0, t0, wrap, item, horiz, lastX, wasSwiped}
    function onDown(e) {
      if (e.touches.length !== 1) { g = null; return; }
      const t = e.touches[0];
      const item = e.target.closest('.conv-item');
      const wrap = e.target.closest('.conv-wrap');
      if (!item || !wrap) { g = null; return; }
      // 关闭 transform 动画,保证跟手不粘滞
      item.style.transition = 'none';
      g = { x0: t.clientX, y0: t.clientY, t0: Date.now(), wrap, item, horiz: false, lastX: t.clientX };
    }
    function onMove(e) {
      if (!g) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      // 先判断为横向手势才接管
      if (!g.horiz) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx) + 6) { g = null; g.item.style.transition = ''; return; } // 竖向滚动,不接管
        g.horiz = true;
      }
      // 跟手 clamp 到 [-60, 0]:负值左滑,正值右滑
      const off = Math.max(-60, Math.min(0, dx));
      g.item.style.transform = 'translateX(' + off + 'px)';
      g.lastX = t.clientX;
    }
    function onUp(e) {
      if (!g) return;
      const t = (e.changedTouches && e.changedTouches[0]) || null;
      const dx = t ? t.clientX - g.x0 : (g.lastX - g.x0);
      const moved = Math.abs(dx);
      // 恢复 transition(为 snap 提供动画)
      g.item.style.transition = '';
      if (g.horiz) {
        if (moved >= THRESHOLD && dx < 0) {
          // 左滑到位:弹删除确认 modal(不露 conv-del)
          g.wrap.classList.remove('swiped');
          g.item.style.transform = '';
          deleteSession(g.item.dataset.id);
        } else {
          // 右滑到位 或 未达阈值:弹回
          g.wrap.classList.remove('swiped');
          g.item.style.transform = '';
        }
      } else {
        // 未识别为横向:不动(交给 click 委派处理打开)
        g.item.style.transform = '';
      }
      g = null;
    }
    list.addEventListener('touchstart', onDown, { passive: true });
    list.addEventListener('touchmove', onMove, { passive: true });
    list.addEventListener('touchend', onUp, { passive: true });
    list.addEventListener('touchcancel', onUp, { passive: true });
  })();

  // 会话页左缘右滑 → 拉出历史抽屉:跟随手指平移,超过阈值/快速右滑松手即打开。
  (function bindEdgeSwipe() {
    const drawer = $('drawer'), scrim = $('scrim');
    const EDGE = 160;            // 触发识别的左缘宽度(px)
    const MAX_OPACITY = 0.4;     // 与 #scrim.show 背景一致
    let g = null;                // 当前手势 {x0,y0,t0,horiz,cancelled,off}
    function uiBlocked() {
      if (!$('settings-page').classList.contains('hidden')) return true;
      if (!$('img-viewer').classList.contains('hidden')) return true;
      if (!$('fs-viewer').classList.contains('hidden')) return true;
      if ($('files-panel').classList.contains('open')) return true; // 文件面板展开时不响应
      return !!document.querySelector('.modal-overlay:not(.hidden)');
    }
    function reset() {
      drawer.style.transform = ''; drawer.style.transition = '';
      scrim.style.opacity = '';
      drawer.classList.remove('open');
      scrim.classList.remove('show');
    }
    document.addEventListener('touchstart', e => {
      if (drawer.classList.contains('open') || uiBlocked() || e.touches.length !== 1) { g = null; return; }
      const t = e.touches[0];
      if (t.clientX > EDGE) { g = null; return; } // 仅左缘起手
      g = { x0: t.clientX, y0: t.clientY, t0: Date.now(), horiz: false, cancelled: false, off: 0 };
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!g || g.cancelled) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
      if (!g.horiz) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;      // 方向未定,等待
        // 主轴判定带 6px 死区：明确右滑才接管，明确纵向/向左才放弃，模糊时继续观察。
        // 两点教训：
        // 1) 必须用绝对值比较——手指上滑时 dy 为负，有符号的 dy > dx 会把「上滑+几像素
        //    右偏」误判成横向手势并 preventDefault，导致左缘向上滚动被接管卡死；
        // 2) 拇指甩动轨迹天然带弧度，单帧 |dx| 略大不代表横向意图——一锤定音会误抢
        //    斜向上滑动，故模糊区间不表态，等后续位移把方向差拉开再判。
        if (dx > Math.abs(dy) + 6) g.horiz = true;                    // 明确右滑 → 接管
        else if (dx < -6 || Math.abs(dy) > Math.abs(dx) + 6) { g.cancelled = true; return; } // 明确向左/纵向 → 放弃
        else return;                                                   // 死区内，继续观察
      }
      e.preventDefault(); // 手势归属抽屉:阻止页面滚动/系统返回
      const w = drawer.offsetWidth || 300;
      g.off = Math.max(0, Math.min(dx, w));
      if (!drawer.style.transition) drawer.style.transition = 'none'; // 跟手时不走 CSS 动画
      drawer.classList.remove('open');
      scrim.classList.add('show');
      drawer.style.transform = 'translateX(calc(-102% + ' + g.off + 'px))';
      scrim.style.opacity = (g.off / w) * MAX_OPACITY;
    }, { passive: false });
    function endDrag(e, commit) {
      if (!g) return;
      const w = drawer.offsetWidth || 300;
      const dist = g.horiz ? g.off : 0;
      const dt = Date.now() - g.t0;
      const speed = dt > 0 ? dist / dt : 0; // px/ms
      const open = commit && g.horiz && (dist >= 60 || dist / w >= 0.35 || (dist >= 24 && speed > 0.8));
      reset();
      if (open) {
        openDrawer(true);
        loadSessionList();
      }
      g = null;
    }
    document.addEventListener('touchend', e => endDrag(e, true), { passive: true });
    document.addEventListener('touchcancel', e => endDrag(e, false), { passive: true });
  })();

  // 抽屉底部用户区:整行点击 → 设置主页(逻辑见文末「设置区」一节)
  $('drawer-user').addEventListener('click', () => {
    if (!drawerMQ.matches) openDrawer(false); // 桌面端设置页覆盖在会话区上,侧栏保持展开
    showSettings();
  });

  // ---------- 顶栏 ----------
