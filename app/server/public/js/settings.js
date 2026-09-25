// 设置区(页面栈/账户/服务/config/技能/模型池/MCP)+ 全局初始化(必须最后加载,初始化段在文件尾)
'use strict';
      $('new-chat-btn').addEventListener('click', newChat);

  // ============================================================================
  // 设置区(侧边栏用户区点击进入;页面搬自 index.html,接口全部复用既有 /api)
  // ----------------------------------------------------------------------------
  // · 覆盖层 #settings-page:顶栏「左返回 + 中标题 + 右操作」,风格与对话页一致;
  //   导航走 SET.stack 页面栈,返回弹一层、栈空即关闭;不再有底部导航。
  // · 页面:home 设置主页卡片 / account 账户 / service 服务(状态+配置) /
  //        cfg-editor config.yml 原文 / skills 列表 / skill-detail 详情 /
  //        skill-editor 技能文件编辑 / models 模型池。
  // ============================================================================

  const SET = {
    stack: [],
    snaps: {},                        // 页名 → 静态快照 HTML(setPush 时刷新;右滑返回垫底用)
    pendingKeys: new Set(),           // 已写盘、尚未重启生效的顶层配置段
    effCfg: null, cfgOrig: '',
    curSkill: null,                   // 技能详情/编辑视图对应的技能名
    editorPath: null, editorOrig: '', editorText: '', editorLabel: '',
    // 模型池(搬自 models.js)
    cfgPlatforms: [], cfgModels: [], runtimeById: {}, modelsPendingRestart: false,
    pendingEnable: {},              // 已写盘但重启前 effective 仍是旧值的 enable 覆盖(id → bool),防卡片回弹
    deletedModels: {},              // 已从 config.yml 删除、重启前后端仍会返回的模型(id → true):前端隐藏防回弹
    expandedGroups: {}, balanceByGroup: {}, balanceRequested: {}, balanceTypes: [], // 平台编辑弹窗工作态见 pfEdit(模块级变量)
    // MCP 服务页:cfgMcp 缓存当前列表;改动待重启生效时置位,顶部常驻重启横幅
    cfgMcp: [], mcpPendingRestart: false,
  };
  let setTok = 0;                     // 异步渲染防竞态令牌

  // ---------- 通用小工具(搬自 core.js / settings.js) ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function att(s) { return esc(s).replace(/"/g, '&quot;'); } // 属性上下文转义(esc 不处理引号)
  function getByPath(obj, p) {
    return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function fmtUptime(ms) {
    const s = Math.floor((ms || 0) / 1000);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + ' 天 ' + h + ' 小时';
    if (h) return h + ' 小时 ' + m + ' 分';
    if (m) return m + ' 分 ' + (s % 60) + ' 秒';
    return s + ' 秒';
  }
  function dispVal(v) {
    if (v === undefined || v === null || v === '') return '(未设置)';
    if (typeof v === 'boolean') return v ? '是' : '否';
    return String(v);
  }

  // ---------- 统一确认/输入弹窗(搬自 core.js;会话删除仍用原生 confirm) ----------
  let _dlgResolve = null;
  function _dlgSettle(val) {
    $('confirm-modal').classList.add('hidden');
    $('prompt-modal').classList.add('hidden');
    const r = _dlgResolve;
    _dlgResolve = null;
    if (r) r(val);
  }
  // confirmModal(title, text, okText, danger, opts?)
  // opts.checkbox = {label, default=true} 可选:展示一个默认勾选状态可改的复选框
  // opts.cancelText 可选:改左键文案(如「直接上传」)，缺省「取消」
  // resolve: true=确定 / false=取消 / null=右上 X 或点遮罩关闭（对只认布尔的旧调用方等同取消）
  // 确认/取消后在 state._confirmChecked 读出勾选状态(不破坏现有调用方签名)
  function confirmModal(title, text, okText, danger, opts) {
    state._confirmChecked = !!(opts && opts.checkbox); // 未传 opts 时 reset 为 false
    $('confirm-cancel-btn').textContent = (opts && opts.cancelText) || '取消';
    const wrap = $('confirm-check-wrap');
    if (opts && opts.checkbox) {
      $('confirm-check-label').textContent = opts.checkbox.label;
      $('confirm-check').checked = opts.checkbox.default !== false;
      state._confirmChecked = $('confirm-check').checked;
      wrap.classList.remove('hidden');
    } else {
      wrap.classList.add('hidden');
    }
    $('confirm-check').onchange = function () { state._confirmChecked = this.checked; };
    return new Promise(resolve => {
      _dlgResolve = resolve;
      $('confirm-title').textContent = title || '请确认';
      // bodyHtml: 需要加粗/加附加说明时传 HTML 字符串；缺省仍走 textContent 防 XSS
      const body = $('confirm-text');
      if (opts && opts.bodyHtml) body.innerHTML = text || '';
      else body.textContent = text || '';
      const ok = $('confirm-ok-btn');
      ok.textContent = okText || '确定';
      ok.style.background = danger ? 'linear-gradient(135deg,#a3352a,#d2483c)' : '';
      $('confirm-modal').classList.remove('hidden');
    });
  }
  // 调用方语义见 confirmModal：true=确定 / false=取消 / null=X、遮罩
  function confirmClose(v) { _dlgSettle(v); }
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
  $('prompt-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); promptOk(); }
  });

  // ---------- 页面栈与顶栏 ----------
  function setTop() { return SET.stack[SET.stack.length - 1] || 'home'; }
  function setUnderHide() {
    const u = $('set-under');
    u.classList.remove('show'); u.innerHTML = '';
  }
  function showSettings() {
    SET.stack = ['home']; SET.snaps = {}; setUnderHide();
    // 桌面端:打开设置时收起侧边栏让设置页占满窗口,关闭时恢复之前的展开态
    if (drawerMQ.matches) { drawerWasOpenBeforeSet = document.body.classList.contains('drawer-open'); openDrawer(false); }
    $('settings-page').classList.remove('hidden'); renderSetPage();
  }
  let drawerWasOpenBeforeSet = false;
  function closeSettings() {
    SET.stack = []; SET.snaps = {}; setUnderHide();
    // 退回会话页才重置模型池状态:平台卡全部折叠、余额清空,下次进入重新自动查
    SET.expandedGroups = {}; SET.balanceByGroup = {}; SET.balanceRequested = {};
    $('settings-page').classList.add('hidden');
    if (drawerMQ.matches && drawerWasOpenBeforeSet) { openDrawer(true); drawerWasOpenBeforeSet = false; }
  }
  // 当前页静态快照(顶栏+正文):右滑返回时垫底,呈现原生导航栈的视差感。
  // 快照里的 id 全部剥除,防止重复 id 干扰 $('…') 查找;仅作动画背景,滑完由 renderSetPage 重渲染真页。
  function snapSetPage() {
    const box = document.createElement('div');
    box.innerHTML = '<header class="header"><button class="icon-btn" tabindex="-1"><svg class="ic" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"></polyline></svg></button>' +
      '<div class="header-center"><div class="header-title">' + esc($('set-title').textContent) + '</div></div>' +
      '<div class="header-right">' + $('set-actions').innerHTML + '</div></header>' +
      '<div class="set-under-body">' + $('set-body').innerHTML + '</div>';
    box.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    return box.innerHTML;
  }
  function setPush(p) {
    const prev = setTop();
    if (prev) SET.snaps[prev] = snapSetPage(); // 垫底快照跟随最新渲染结果刷新
    SET.stack.push(p); renderSetPage();
  }
  function setPopRaw() { SET.stack.pop(); renderSetPage(); }
  function onSetBack() {
    const p = setTop();
    if (p === 'skill-editor') return sUI.closeEditor();
    if (p === 'cfg-editor') return sUI.closeCfg();
    if (SET.stack.length > 1) setPopRaw(); else closeSettings();
  }
  $('set-back-btn').addEventListener('click', onSetBack);

  // 设置区任意页内：从左向右滑 → 返回上级（等同顶栏返回：子页弹栈/主页收起设置）。
  // 可编辑控件(输入框/文本域/下拉/启停开关)上不发起；方向锁定后才接管(不抢纵向滚动)。
  // 子页返回：只平移当前页层，底下垫父页静态快照(原生导航栈观感)；
  // 设置主页无父页：保持整层滑出，底下露出的就是主聊天页，观感本就正确。
  (function bindSettingsBackSwipe() {
    const page = $('settings-page');
    const topLayer = $('set-top');
    const under = $('set-under');
    let g = null;        // {x0,y0,t0,horiz,off,under}
    let exiting = false; // 右滑退场动画中：忽略新触摸
    function blocked() {
      if (exiting || page.classList.contains('hidden')) return true;
      if ($('drawer').classList.contains('open')) return true;
      return !!document.querySelector('.modal-overlay:not(.hidden)');
    }
    page.addEventListener('touchstart', e => {
      if (blocked() || e.touches.length !== 1) { g = null; return; }
      if (e.target.closest('textarea, input, select, .model-en-sw')) { g = null; return; }
      const t = e.touches[0];
      page.style.transition = '';
      topLayer.style.transition = '';
      g = { x0: t.clientX, y0: t.clientY, t0: Date.now(), horiz: false, off: 0, under: false };
    }, { passive: true });
    page.addEventListener('touchmove', e => {
      if (!g) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
      if (!g.horiz) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // 方向未定，等待
        if (Math.abs(dy) >= Math.abs(dx)) { g = null; return; } // 纵向滚动，不接管
        g.horiz = true;
        // 子页且父页快照存在(setPush 时已刷新) → 垫底，后续只平移当前页层
        const par = SET.stack[SET.stack.length - 2];
        if (par && SET.snaps[par]) {
          g.under = true;
          under.innerHTML = SET.snaps[par];
          under.classList.add('show');
        }
      }
      e.preventDefault(); // 横向手势归返回：屏蔽滚动/选择
      const tgt = g.under ? topLayer : page;
      const w = page.offsetWidth || 360;
      g.off = Math.max(0, Math.min(dx, w));
      tgt.style.transform = 'translateX(' + g.off + 'px)';
      tgt.style.opacity = String(1 - 0.25 * (g.off / w));
    }, { passive: false });
    function end(commit) {
      if (!g) return;
      const tgt = g.under ? topLayer : page;
      const w = page.offsetWidth || 360;
      const dist = g.horiz ? g.off : 0;
      const dt = Date.now() - g.t0;
      const speed = dt > 0 ? dist / dt : 0;
      const back = commit && g.horiz && (dist >= 60 || dist / w >= 0.3 || (dist >= 24 && speed > 0.8));
      g = null;
      if (back) {
        // 先滑出再执行与顶栏一致的返回(编辑器页会路由到放弃确认)
        exiting = true;
        tgt.style.transition = 'transform .16s ease-in, opacity .16s ease-in';
        tgt.style.transform = 'translateX(100%)';
        tgt.style.opacity = '0';
        setTimeout(() => {
          onSetBack(); // 重渲染父页，替换垫底快照
          tgt.style.transition = 'none';
          tgt.style.transform = '';
          tgt.style.opacity = '';
          setUnderHide();
          exiting = false;
        }, 160);
      } else {
        tgt.style.transition = 'transform .18s ease-out, opacity .18s ease-out';
        tgt.style.transform = '';
        tgt.style.opacity = '';
        setTimeout(() => { if (!g && !exiting) tgt.style.transition = ''; setUnderHide(); }, 200);
      }
    }
    page.addEventListener('touchend', () => end(true), { passive: true });
    page.addEventListener('touchcancel', () => end(false), { passive: true });
  })();

  function setTitle(t) { $('set-title').textContent = t; }
  function setActions(html) { $('set-actions').innerHTML = html || ''; }
  function setBody(html) { $('set-body').innerHTML = html; }

  function renderSetPage() {
    const tok = ++setTok;
    const p = setTop();
    const ctx = () => tok === setTok && setTop() === p; // 异步回包时页面可能已切走
    if (p === 'home') return setPageHome(ctx);
    if (p === 'account') return setPageAccount(ctx);
    if (p === 'service') return setPageService(ctx);
    if (p === 'cfg-editor') return setPageCfgEditor(ctx);
    if (p === 'skills') return setPageSkills(ctx);
    if (p === 'skill-detail') return setPageSkillDetail(ctx);
    if (p === 'skill-editor') return setPageSkillEditor(ctx);
    if (p === 'models') return setPageModels(ctx);
    if (p === 'mcp') return setPageMcp(ctx);
  }
  // 主页卡片跳转与配置表单脏值标红(容器常驻,各自委托一次)
  $('set-body').addEventListener('click', e => {
    const card = e.target.closest('.set-card');
    if (card && card.dataset.go) setPush(card.dataset.go);
  });
  $('set-body').addEventListener('input', e => {
    const inp = e.target;
    if (inp.classList && inp.classList.contains('cfg-input')) {
      inp.classList.toggle('cfg-dirty', inp.value.trim() !== inp.dataset.orig);
    }
  });

  // ---------- 页:设置主页(卡片入口) ----------
  const SET_CARDS = [
    { go: 'account', name: '账户', desc: '修改密码 · 用户画像 · 退出登录',
      icon: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4 4-6 8-6s8 2 8 6"></path></svg>' },
    { go: 'service', name: '服务', desc: '服务状态 · 系统配置',
      icon: '<svg class="ic" viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>' },
    { go: 'skills', name: '技能', desc: '技能管理 · 技能文件编辑',
      icon: '<svg class="ic" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>' },
    { go: 'models', name: '模型', desc: '模型池状态 · 增删改',
      icon: '<svg class="ic" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>' },
    { go: 'mcp', name: 'MCP', desc: 'MCP 服务 · 增删改',
      icon: '<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="3" y1="10" x2="21" y2="10"></line><circle cx="7" cy="15" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="17" cy="15" r="1.2" fill="currentColor" stroke="none"></circle></svg>' },
  ];
  function setPageHome(ctx) {
    setTitle('设置');
    setActions('');
    setBody('<div class="set-scroll set-home">' + SET_CARDS.map(c =>
      '<button class="set-card" data-go="' + c.go + '">' +
        '<span class="set-ico">' + c.icon + '</span>' +
        '<span class="set-tt"><span class="set-name">' + c.name + '</span>' +
        '<span class="set-desc">' + c.desc + '</span></span>' +
        '<svg class="ic sm set-arrow" viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"></polyline></svg>' +
      '</button>').join('') + '</div>');
  }

  // ---------- 页:账户(修改密码 / 退出登录) ----------
  const AVATAR_COLORS = ['#4285F4', '#EA4335', '#FBBC05', '#34A853', '#5C6BC0', '#00897B', '#8E24AA', '#F4511E'];
  function userInitials(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    const two = s.slice(0, 2);
    return two.charAt(0).toUpperCase() + (two.length > 1 ? two.charAt(1).toLowerCase() : '');
  }
  function avatarColor(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  // 侧边栏底部用户区:展示真实登录用户名,头像样式与设置页 user-card 一致(按用户名取色+首两字)。
  // 启动校验已经拉到登录用户时直接传入，避免同一次加载重复请求 /api/me；未传入时自拉兜底。
  async function loadDrawerUser(knownUser) {
    const av = $('drawer-avatar'), un = $('drawer-user-name');
    if (!av || !un) return;
    let name = knownUser ? String(knownUser) : '';
    if (!name) {
      try {
        const r = await req('GET', '/api/me');
        name = r && r.user ? String(r.user) : '';
      } catch (_) { return; /* 未启用认证时无 /api/me,保留默认占位 */ }
    }
    if (!name) return; // 未登录态(理论上不会出现,401 已自动跳登录页)
    av.textContent = userInitials(name);
    av.style.background = avatarColor(name);
    un.textContent = name;
  }
  function userCardHtml(me) {
    return '<div class="settings-card user-card">' +
      '<div class="user-avatar" style="background:' + avatarColor(me) + '">' + esc(userInitials(me)) + '</div>' +
      '<div class="set-user-name">' + esc(me) + '</div>' +
      '<div class="user-acts">' +
        '<button class="ghost-btn" onclick="sUI.changePassword()">修改密码</button>' +
        '<button class="ghost-btn" onclick="sUI.logout()">退出登录</button>' +
      '</div></div>';
  }
  async function setPageAccount(ctx) {
    setTitle('账户');
    setActions('');
    setBody('<div class="set-scroll"><div class="empty-tip">加载中…</div></div>');
    // 单个 /api/me 判认证开关:启用时中间件保证已登录,user 必有;
    // 未启用时该路由 404 → 只是没有密码/登出卡,画像仍渲染(未认证 = 空串键隐式单用户)。
    let me = null;
    try { const r = await req('GET', '/api/me'); if (r && r.user) me = r; } catch (_) { /* 404 等一律按无账户信息处理 */ }
    let p = null, pErr = '';
    try { p = await req('GET', '/api/profile'); } catch (e) { pErr = String((e && e.message) || e); }
    if (!ctx()) return;
    let html = '<div class="set-scroll">';
    if (me) html += userCardHtml(me.user);
    html += pErr
      ? '<div class="settings-card"><h4>用户画像</h4><div class="empty-tip">加载失败:' + esc(pErr) + '</div></div>'
      : profileCardHtml(p);
    setBody(html + '</div>');
  }
  async function changePassword() {
    try {
      const newP = await promptModal('修改密码', '新密码,至少 6 位', '', { type: 'password' });
      if (newP == null) return;
      if (newP.length < 6) { toast('新密码至少 6 位'); return; }
      await req('POST', '/api/password', { new_password: newP });
      toast('密码已修改,立即生效');
    } catch (e) { toast('修改失败:' + e.message); }
  }
  // ---------- 页:账户——用户画像编辑卡直接渲染在账户页(无二级页;保存后 renderSetPage 重拉刷新停用徽标) ----------
  const PROFILE_FIELDS = [
    ['honorific', '称谓', '希望被怎么称呼'],
    ['industry', '行业', '影响术语与默认假设'],
    ['preference', '偏好', '语言 / 交付格式等输出要求'],
  ];
  function profileCardHtml(p) {
    let html = '<div class="settings-card"><h4>用户画像' +
      (p.enabled === false ? ' <span class="badge held">已停用</span>' : '') + '</h4>' +
      '<div class="cfg-kv"><label>启用</label><input type="checkbox" id="prof-enabled"' + (p.enabled === false ? '' : ' checked') + '></div>';
    for (const [k, name, ph] of PROFILE_FIELDS) {
      const v = String(p[k] || '');
      html += '<div class="cfg-kv"><label>' + esc(name) + '</label>' +
        '<input class="cfg-input" id="prof-' + k + '" type="text" maxlength="80" data-orig="' + att(v) + '" value="' + att(v) + '" placeholder="' + esc(ph) + '"></div>';
    }
    html += '<button class="primary-btn" style="margin-top:8px" onclick="sUI.saveProfile()">保存</button>' +
      '<div class="cfg-note">画像只记「不知道就会做错」的信息，新会话开始时作为背景注入（会话内不更新；清空字段保存即抹除）。' +
      '停用后不再注入也不再更新，重新启用仅对新会话/清空后的会话生效。近期关注（最近会话标题）自动带入背景，无需维护。</div></div>';
    return html;
  }
  async function saveProfile() {
    const body = { enabled: $('prof-enabled').checked };
    for (const [k] of PROFILE_FIELDS) { const el = $('prof-' + k); if (el) body[k] = el.value.trim(); }
    try { await req('PUT', '/api/profile', body); toast('已保存，新会话生效'); renderSetPage(); }
    catch (e) { toast('保存失败:' + e.message); }
  }

  // ---------- 页:服务(服务状态 + 系统配置;搬自 settings.js) ----------
  const CFG_FORM = [
    { group: 'Agent 会话', items: [
      { path: 'agent.temperature', label: '温度 temperature', type: 'float' },
      { path: 'agent.max_tool_iterations', label: '单会话最大工具轮次', type: 'int' },
      { path: 'agent.max_retries', label: '上游失败重试次数', type: 'int' },
      { path: 'agent.language', label: '回复语言(留空不限)', type: 'text' },
      { path: 'agent.auto_compress_tokens', label: '自动压缩 In 阈值(0=关)', type: 'int' },
    ] },
    { group: '终端工具', items: [
      { path: 'terminal.default_timeout_ms', label: '命令默认超时(ms)', type: 'int' },
      { path: 'terminal.max_output_chars', label: '输出最大字符数', type: 'int' },
    ] },
    { group: '技能', items: [
      { path: 'skills.timeout_ms', label: '技能执行超时(ms)', type: 'int' },
    ] },
    { group: '上传预处理（浏览器端）', items: [
      { path: 'upload.image_compress_threshold_kb', label: '大图阈值(KB)', type: 'int' },
      { path: 'upload.image_max_dim', label: '压缩后长边上限(px)', type: 'int' },
      { path: 'upload.image_quality', label: 'JPEG 质量(0~1)', type: 'float' },
      { path: 'upload.confirm_size_mb', label: '大文件确认阈值(MB)', type: 'int' },
    ] },
    { group: '模型租约(会话结束后的保持)', items: [
      { path: 'model_hold.idle_release_ms', label: '无人观看释放(ms)', type: 'int' },
      { path: 'model_hold.active_max_ms', label: '最长保持(ms)', type: 'int' },
      { path: 'model_hold.sweep_ms', label: '巡检间隔(ms)', type: 'int' },
    ] },
  ];
  function kvPlain(label, v) {
    return '<div class="cfg-kv"><label>' + esc(label) + '</label><b>' + esc(dispVal(v)) + '</b></div>';
  }
  // 容量格式化（内存/磁盘量级到 GB/TB，fmtSize 只到 MB 不够用）；数字与单位不留空格
  function fmtCap(n) {
    if (n == null || !Number.isFinite(n)) return '?';
    if (n < 1024) return n + 'B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n >= 100 ? Math.round(n) : n.toFixed(1)) + units[i];
  }
  // 带阈值的 kv 行：warn 时值标红（接收拼好的纯文本，内部自行 esc）
  function kvWarn(label, text, warn) {
    return '<div class="cfg-kv"><label>' + esc(label) + '</label><b' +
      (warn ? ' style="color:#c0392b"' : '') + '>' + esc(text) + '</b></div>';
  }
  // 服务状态里的负载三行（内存/CPU/磁盘），数据来自 /api/system/status 的 sys 字段
  function svcLoadHtml(st) {
    const sys = st.sys || {};
    let html = '';
    const mem = sys.mem;
    if (mem && mem.total_bytes) {
      // 「剩余」= 主机 MemAvailable（含可回收 cache），不是容器配额剩余额度
      html += kvWarn('内存', fmtCap(mem.avail_bytes) + ' / ' + fmtCap(mem.total_bytes) +
        ' (剩余 ' + Math.round(mem.avail_bytes / mem.total_bytes * 100) + '%)', mem.avail_bytes / mem.total_bytes < 0.15);
    }
    const cpu = sys.cpu;
    if (cpu && cpu.cores) {
      html += kvWarn('CPU', 'load ' + cpu.load1 + ' / ' + cpu.load5 + ' / ' + cpu.load15 +
        ' · ' + cpu.cores + ' 核' + (cpu.quota_cores ? '（配额 ' + cpu.quota_cores + ' 核）' : ''),
        cpu.load1 > cpu.cores);
    }
    for (const d of (sys.disks || [])) {
      const pct = d.total_bytes ? Math.round((1 - d.free_bytes / d.total_bytes) * 100) : 0;
      html += kvWarn('磁盘', fmtCap(d.free_bytes) + ' / ' + fmtCap(d.total_bytes) + ' (已用 ' + pct + '%)', pct >= 90);
    }
    return html;
  }
  function svcCardHtml(st) {
    let html = '<div class="settings-card"><h4>服务状态' +
      (SET.pendingKeys.size ? ' <span class="badge held">待重启生效</span>' : '') + '</h4>';
    html += kvPlain('版本 / Node', st.version + ' / ' + st.node);
    html += kvPlain('已运行', fmtUptime(st.uptime_ms) + '(启动于 ' + new Date(st.started_at).toLocaleString() + ')');
    html += kvPlain('端口', st.port);
    html += svcLoadHtml(st);
    html += kvPlain('命令执行', st.executor_url ? st.executor_url + '（远端）' : '本地');
    if (SET.pendingKeys.size) html += kvPlain('待生效改动', Array.from(SET.pendingKeys).join(', '));
    html += '<button class="primary-btn" id="restart-btn" style="margin-top:8px" onclick="sUI.restart()">重启服务</button>' +
      '<div class="cfg-note">配置改动重启后生效;重启约需十几秒,期间页面暂不可用。非 Docker 部署不会自动拉起。</div></div>';
    return html;
  }
  function cfgInputHtml(it) {
    const cur = getByPath(SET.effCfg, it.path);
    const v = cur == null ? '' : String(cur);
    if (it.type === 'text') {
      return '<div class="cfg-kv"><label>' + esc(it.label) + '</label>' +
        '<input class="cfg-input" type="text"' +
        ' data-path="' + att(it.path) + '" data-type="text" data-label="' + att(it.label) + '" data-orig="' + att(v) + '"' +
        ' value="' + att(v) + '" placeholder="如：中文 / English"></div>';
    }
    const step = it.type === 'float' ? ' step="any"' : ' step="1"';
    return '<div class="cfg-kv"><label>' + esc(it.label) + '</label>' +
      '<input class="cfg-input" type="number"' + step +
      ' inputmode="decimal"' +
      ' data-path="' + att(it.path) + '" data-type="' + it.type + '" data-label="' + att(it.label) + '" data-orig="' + att(v) + '"' +
      ' value="' + att(v) + '"></div>';
  }
  function formCardHtml() {
    let html = '';
    for (const g of CFG_FORM) {
      html += '<div class="settings-card"><h4>' + esc(g.group) + '</h4>';
      html += g.items.map(cfgInputHtml).join('');
      html += '</div>';
    }
    html += '<button class="primary-btn" id="cfg-save-btn" onclick="sUI.saveForm()">更新配置</button>' +
      '<div class="cfg-note" style="margin-bottom:12px">更新即写入 config.yml(注释保留);多数配置需重启服务后生效。' +
      '模型、账号、MCP 等请用右上角配置文件编辑。</div>';
    return html;
  }
  async function setPageService(ctx) {
    setTitle('服务');
    // 临时隐藏右上角"编辑配置文件"按钮(sUI.openCfg),恢复时取消下方注释即可
    // setActions('<button class="icon-btn" title="编辑配置文件" onclick="sUI.openCfg()">' +
    //   '<svg class="ic" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"></path></svg></button>');
    setActions('');
    setBody('<div class="set-scroll" id="svc-body"><div class="empty-tip">加载中…</div></div>');
    try {
      const [st, cg] = await Promise.all([
        req('GET', '/api/system/status'),
        req('GET', '/api/config'),
      ]);
      if (!ctx()) return;
      SET.effCfg = cg.effective || {};
      const el = $('svc-body');
      if (el) el.innerHTML = svcCardHtml(st) + formCardHtml();
    } catch (e) {
      if (ctx()) setBody('<div class="set-scroll"><div class="empty-tip">加载失败:' + esc(e.message) + '</div></div>');
    }
  }
  // 表单保存:收集与打开时不同的项,逐项 PATCH(搬自 settings.js saveForm)
  async function saveForm() {
    const inputs = document.querySelectorAll('#set-body .cfg-input');
    const edits = [];
    for (const inp of inputs) {
      const v = inp.value.trim();
      if (v === inp.dataset.orig) continue;
      let val = v;
      if (inp.dataset.type === 'int' || inp.dataset.type === 'float') {
        val = Number(v);
        if (v === '' || !isFinite(val)) { toast('「' + inp.dataset.label + '」需填数字'); return; }
        if (inp.dataset.type === 'int' && !Number.isInteger(val)) { toast('「' + inp.dataset.label + '」需为整数'); return; }
      }
      edits.push({ path: inp.dataset.path, value: val });
    }
    if (!edits.length) { toast('没有改动'); return; }
    const btn = $('cfg-save-btn');
    if (btn) btn.disabled = true;
    let lastChanged = [];
    try {
      for (const e of edits) {
        const r = await req('PATCH', '/api/config', { path: e.path, value: e.value });
        lastChanged = r.changed || [];
        lastChanged.forEach(k => SET.pendingKeys.add(k));
      }
      toast('已保存 ' + edits.length + ' 项' + (lastChanged.length ? ',重启后生效' : ''));
    } catch (e) {
      toast('保存失败:' + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
    renderSetPage();
  }
  // 重启服务(搬自 settings.js restart):确认弹窗 + 执行。可复用部分拆为 restartNow(模型池「重启服务」横幅按钮直用)。
  async function restart() {
    if (!await confirmModal('重启服务', '重启服务使新配置生效?正在执行的 AI 会话会被打断。', '重启')) return;
    await restartNow();
  }
  async function restartNow() {
    try {
      await req('POST', '/api/system/restart');
    } catch (e) {
      // 仅「有会话在跑」值得二次确认强打;配置不合法等 409 强打也无法启动,直接报给用户
      if (e.status === 409 && /个任务.*执行中/.test(e.message)) {
        if (!await confirmModal('有任务在跑', e.message, '强制重启', true)) return;
        try { await req('POST', '/api/system/restart?force=true'); }
        catch (e2) { toast('重启失败:' + e2.message); return; }
      } else { toast('重启失败:' + e.message); return; }
    }
    const btn = $('restart-btn');
    if (btn) { btn.disabled = true; btn.textContent = '重启中,请勿关闭页面…'; }
    toast('服务重启中…');
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      try { const r = await fetch('/api/health'); if (r.ok) { location.reload(); return; } } catch (_) {}
    }
    toast('90 秒内未恢复,请检查容器状态(非 Docker 部署需手动启动)');
    if (btn) { btn.disabled = false; btn.textContent = '重启服务'; }
  }

  // ---------- 页:config.yml 原文编辑器(搬自 settings.js) ----------
  function openCfgEditor() { setPush('cfg-editor'); }
  async function setPageCfgEditor(ctx) {
    setTitle('config.yml 原文');
    setActions('<button class="icon-btn" title="校验并保存" onclick="sUI.saveCfg()">' +
      '<svg class="ic" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg></button>');
    setBody('<div class="set-editor"><div class="cfg-err hidden" id="cfg-editor-err"></div>' +
      '<textarea id="set-editor-area" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea></div>');
    try {
      const cg = await req('GET', '/api/config');
      if (!ctx()) return;
      SET.cfgOrig = cg.text;
      $('set-editor-area').value = cg.text;
    } catch (e) {
      // 读取失败不能留下空编辑器:保存会把空文本写回配置，改展示错误态
      if (ctx()) setBody('<div class="set-scroll"><div class="empty-tip">读取失败:' + esc(e.message) + '</div></div>');
    }
  }
  async function saveCfg() {
    const area = $('set-editor-area');
    if (!area) { toast('配置未加载'); return; }
    const text = area.value;
    const errEl = $('cfg-editor-err');
    if (errEl) errEl.classList.add('hidden');
    try {
      await req('POST', '/api/config/validate', { text }); // 先干跑,错误信息更友好
      const r = await req('PUT', '/api/config', { text });
      SET.cfgOrig = text;
      (r.changed || []).forEach(k => SET.pendingKeys.add(k));
      toast('配置已保存');
      setPopRaw(); // 保存成功直接退出编辑页,回服务页即刷新生效值展示
    } catch (e) {
      if (errEl) { errEl.textContent = '校验失败:' + e.message; errEl.classList.remove('hidden'); }
      toast('配置不合法,未写入');
    }
  }
  async function closeCfg() {
    const area = $('set-editor-area');
    if (area && area.value !== SET.cfgOrig &&
        !await confirmModal('未保存的修改', '有未保存的修改,确定关闭并丢弃?', '关闭', true)) return;
    setPopRaw();
  }

  // ---------- 页:技能(列表/详情/文件编辑;搬自 skills.js) ----------
  async function setPageSkills(ctx) {
    SET.curSkill = null;
    setTitle('技能管理');
    setActions('<button class="icon-btn" title="新建技能" onclick="sUI.openCreate()">' +
      '<svg class="ic" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>');
    setBody('<div class="set-scroll" id="skills-list"><div class="empty-tip">加载中…</div></div>');
    try {
      const rows = await req('GET', '/api/skills');
      if (!ctx()) return;
      const el = $('skills-list');
      if (!el) return;
      if (!rows.length) {
        el.innerHTML = '<div class="empty-tip">还没有技能,点右上角 + 新建一个。</div>';
        return;
      }
      el.innerHTML = rows.map(s => {
        const a = encodeURIComponent(s.name);
        return '<div class="session-card" onclick="sUI.open(\'' + a + '\')">' +
          '<div class="session-main">' +
            '<div class="session-name">' + esc(s.name) +
              (s.has_md ? '' : ' <span class="badge cancelled">缺 SKILL.md</span>') +
              (s.entry ? ' <span class="badge active">' + s.entry + ' 入口</span>' : '') +
            '</div>' +
            '<div class="skill-desc">' + esc(s.description || '') + '</div>' +
            '<div class="session-meta"><span>' + s.file_count + ' 个文件</span>' +
              '<span>' + fmtSize(s.size) + '</span>' +
              (s.mtime ? '<span>' + fmtTime(s.mtime) + '</span>' : '') + '</div>' +
          '</div>' +
          '<div class="card-acts">' +
            '<button class="card-act" onclick="event.stopPropagation();sUI.renameSkill(\'' + a + '\')">改名</button>' +
            '<button class="card-act del" onclick="event.stopPropagation();sUI.deleteSkill(\'' + a + '\')">删除</button>' +
          '</div>' +
        '</div>';
      }).join('');
    } catch (e) {
      if (ctx()) setBody('<div class="set-scroll"><div class="empty-tip">加载失败:' + esc(e.message) + '</div></div>');
    }
  }
  async function openSkill(nameEnc) {
    SET.curSkill = decodeURIComponent(nameEnc);
    setPush('skill-detail');
  }
  async function setPageSkillDetail(ctx) {
    if (!SET.curSkill) { if (SET.stack.length > 1) setPopRaw(); return; }
    setTitle(SET.curSkill);
    setActions('<label class="icon-btn" title="上传文件">' +
      '<input type="file" style="display:none;" onchange="sUI.onUpload(event)">' +
      '<svg class="ic" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg></label>');
    setBody('<div class="set-scroll" id="skill-detail"><div class="empty-tip">加载中…</div></div>');
    try {
      const d = await req('GET', '/api/skills/' + encodeURIComponent(SET.curSkill));
      if (!ctx()) return;
      setTitle(d.name);
      const el = $('skill-detail');
      if (!el) return;
      const newBtn = '<button class="primary-btn" style="margin-top:10px" onclick="sUI.newFile()">+ 新建文件</button>';
      if (!d.files.length) {
        el.innerHTML = '<div class="skill-files"><div class="empty-tip">技能目录是空的</div></div>' + newBtn;
        return;
      }
      el.innerHTML = '<div class="skill-files">' + d.files.map(f => {
        const a = encodeURIComponent(f.filename);
        return '<div class="file-row" onclick="sUI.editFile(\'' + a + '\')">' +
          '<svg class="file-ico" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' +
          '<span class="file-name">' + esc(f.filename) + '</span>' +
          '<span class="file-size">' + fmtSize(f.size) + '</span>' +
          '<button class="file-act" onclick="event.stopPropagation();sUI.editFile(\'' + a + '\')">编辑</button>' +
          '<button class="file-act del" onclick="event.stopPropagation();sUI.deleteFile(\'' + a + '\')">删除</button>' +
          '</div>';
      }).join('') + '</div>' + newBtn;
    } catch (e) {
      if (ctx()) setBody('<div class="set-scroll"><div class="empty-tip">加载失败:' + esc(e.message) + '</div></div>');
    }
  }
  function setPageSkillEditor(ctx) {
    setTitle(SET.editorLabel || '编辑文件');
    setActions('<button class="icon-btn" title="保存" onclick="sUI.saveFile()">' +
      '<svg class="ic" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg></button>');
    setBody('<div class="set-editor"><textarea id="set-editor-area" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea></div>');
    $('set-editor-area').value = SET.editorText;
  }
  async function openSkillFile(pathEnc) {
    const rel = decodeURIComponent(pathEnc);
    try {
      const f = await req('GET', '/api/skills/' + encodeURIComponent(SET.curSkill) + '/file?path=' + encodeURIComponent(rel));
      SET.editorPath = f.path; SET.editorOrig = f.content;
      SET.editorText = f.content;
      SET.editorLabel = SET.curSkill + ' / ' + f.path;
      setPush('skill-editor');
    } catch (e) { toast('打开失败:' + e.message); }
  }
  async function newSkillFile() {
    if (!SET.curSkill) return;
    const p = await promptModal('新建文件', '相对技能目录的路径,可含子目录(如 scripts/run.sh)', '');
    if (p == null) return;
    const rel = p.trim();
    if (!rel) { toast('路径为空'); return; }
    SET.editorPath = rel; SET.editorOrig = '';
    SET.editorText = '';
    SET.editorLabel = SET.curSkill + ' / ' + rel + '(新建)';
    setPush('skill-editor');
  }
  async function saveSkillFile() {
    if (!SET.curSkill || SET.editorPath == null) return;
    const content = $('set-editor-area').value;
    try {
      await req('PUT', '/api/skills/' + encodeURIComponent(SET.curSkill) + '/file', { path: SET.editorPath, content });
      SET.editorOrig = content;
      toast('已保存 ' + SET.editorPath);
      SET.editorPath = null;
      setPopRaw(); // 保存成功直接退出编辑页,回详情即刷新文件列表
    } catch (e) { toast('保存失败:' + e.message); }
  }
  async function closeSkillEditor() {
    const area = $('set-editor-area');
    if (area && area.value !== SET.editorOrig &&
        !await confirmModal('未保存的修改', '有未保存的修改,确定关闭编辑器并丢弃?', '关闭', true)) return;
    SET.editorPath = null; SET.editorOrig = ''; SET.editorText = '';
    setPopRaw();
  }
  async function deleteSkillFile(pathEnc) {
    const rel = decodeURIComponent(pathEnc);
    if (!await confirmModal('删除文件', '删除文件 ' + rel + ' ?', '删除', true)) return;
    try {
      await req('DELETE', '/api/skills/' + encodeURIComponent(SET.curSkill) + '/file?path=' + encodeURIComponent(rel));
      toast('已删除');
      renderSetPage();
    } catch (e) { toast('删除失败:' + e.message); }
  }
  // 单文件上传;重名默认 409,询问后带 overwrite 重试(搬自 skills.js)
  async function uploadSkillFile(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || !SET.curSkill) return;
    const send = async function (overwrite) {
      const fd = new FormData();
      fd.append('file', file);
      return req('POST', '/api/skills/' + encodeURIComponent(SET.curSkill) + '/upload' + (overwrite ? '?overwrite=true' : ''), fd, true);
    };
    try {
      await send(false);
      toast('已上传 ' + file.name);
    } catch (e) {
      if (/已存在/.test(e.message)) {
        if (!await confirmModal('文件已存在', file.name + ' 已存在,覆盖?', '覆盖')) return;
        try { await send(true); toast('已覆盖 ' + file.name); }
        catch (e2) { toast('上传失败:' + e2.message); }
      } else {
        toast('上传失败:' + e.message);
      }
    }
    renderSetPage();
  }
  function openCreateSkill() {
    $('skill-new-name').value = '';
    $('skill-new-desc').value = '';
    $('skill-create-modal').classList.remove('hidden');
    $('skill-new-name').focus();
  }
  function closeCreateSkill() { $('skill-create-modal').classList.add('hidden'); }
  async function createSkill() {
    const name = $('skill-new-name').value.trim();
    if (!name) { toast('请填写技能名'); return; }
    try {
      await req('POST', '/api/skills', { name, description: $('skill-new-desc').value.trim() });
      closeCreateSkill();
      toast('已创建 ' + name);
      SET.curSkill = name;
      setPush('skill-detail'); // 新建后直接进详情,方便继续编辑 SKILL.md
    } catch (e) { toast('创建失败:' + e.message); }
  }
  async function renameSkill(nameEnc) {
    const name = nameEnc ? decodeURIComponent(nameEnc) : SET.curSkill;
    if (!name) return;
    const nn = await promptModal('重命名技能', '新的技能名', name);
    if (nn == null) return;
    const newName = nn.trim();
    if (!newName || newName === name) return;
    try {
      await req('POST', '/api/skills/' + encodeURIComponent(name) + '/rename', { newName });
      toast('已重命名为 ' + newName);
      if (SET.curSkill === name) SET.curSkill = newName;
      renderSetPage();
    } catch (e) { toast('重命名失败:' + e.message); }
  }
  async function deleteSkill(nameEnc) {
    const name = nameEnc ? decodeURIComponent(nameEnc) : SET.curSkill;
    if (!name) return;
    if (!await confirmModal('删除技能', '确定删除技能「' + name + '」?目录下所有文件将不可恢复。', '删除', true)) return;
    try {
      await req('DELETE', '/api/skills/' + encodeURIComponent(name));
      toast('已删除 ' + name);
      if (SET.curSkill === name) SET.curSkill = null;
      if (setTop() === 'skill-detail') setPopRaw(); else renderSetPage();
    } catch (e) { toast('删除失败:' + e.message); }
  }

  // ---------- 页:模型池(状态 + 增/改/删;搬自 models.js) ----------
  // api_key 脱敏显示兼容后端已脱敏结果(幂等)
  function maskKey(k) {
    k = k || '';
    if (k.includes('***')) return k;
    if (k.length > 8) return k.slice(0, 3) + '***' + k.slice(-4);
    if (k.length > 0) return '***' + k.slice(-2);
    return '';
  }
  // token 用量紧凑显示:<1000 原样;k(1 位小数去尾零);≥1M 用 M
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 1000000) { const v = (n / 1000).toFixed(1).replace(/\.0$/, ''); return v + 'k'; }
    const v = (n / 1000000).toFixed(1).replace(/\.0$/, '');
    return v + 'M';
  }
  function balText(gk) {
    const b = SET.balanceByGroup[gk];
    if (!b) return '余额 --';
    if (b.error) return '余额 查询失败';
    return '余额 ' + (b.total_balance == null ? '--' : b.total_balance) + (b.currency ? ' ' + esc(b.currency) : '');
  }
  function balTitle(gk) {
    const b = SET.balanceByGroup[gk];
    if (!b) return '';
    if (b.error) return '查询失败:' + b.error;
    const parts = [];
    if (b.available === false) parts.push('上游报告余额不可用');
    if (b.granted_balance != null) parts.push('赠送 ' + b.granted_balance);
    if (b.topped_up_balance != null) parts.push('充值 ' + b.topped_up_balance);
    return parts.join(' · ');
  }
  async function fetchBalance(gk, pi, ki, manual) {
    SET.balanceRequested[gk] = true; // 无论成败,本页会话不再自动重查(手动刷新不受限)
    const btn = $('mbrg-' + gk);
    if (btn) btn.classList.add('spin');
    const el = $('mbal-' + gk);
    if (el) el.textContent = '余额 …';
    try {
      const r = await req('GET', '/api/platforms/balance?pi=' + pi + '&ki=' + ki);
      const b = r.balance || {};
      SET.balanceByGroup[gk] = {
        total_balance: b.total_balance, currency: b.currency,
        granted_balance: b.granted_balance, topped_up_balance: b.topped_up_balance,
        available: b.is_available,
      };
    } catch (e) {
      SET.balanceByGroup[gk] = { error: e.message };
      if (manual) toast('查余额失败:' + e.message); // 自动查询失败只落悬停详情,不打扰
    }
    if (btn) btn.classList.remove('spin');
    const el2 = $('mbal-' + gk);
    if (el2) { el2.textContent = balText(gk); el2.title = balTitle(gk); }
  }
  // 点刷新图标:无视「本页已查过」标记,总是重新请求
  function refreshBalance(ev, pi, ki) {
    if (ev) ev.stopPropagation(); // 冒泡到分组头会误触折叠/展开
    fetchBalance(pi + '-' + ki, pi, ki, true);
  }
  const BAL_REFRESH_SVG = '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
  // 平台卡折叠/展开(gk = 'p'+pi)。首次展开:给该平台每个 Key 行自动查一次余额(每页会话一次;手动刷新不受限)。
  function toggleModelGroup(gk) {
    const on = !SET.expandedGroups[gk];
    SET.expandedGroups[gk] = on;
    const el = $('mgrp-' + gk);
    if (!el) return;
    el.classList.toggle('open', on);
    const body = el.querySelector('.model-group-body');
    if (body) body.classList.toggle('hidden', !on);
    if (on) {
      const pi = Number(gk.slice(1));
      const p = SET.cfgPlatforms[pi] || {};
      if (SET.balanceTypes.indexOf(String(p.type || '')) >= 0) {
        (p.keys || []).forEach((k, ki) => {
          const bk = pi + '-' + ki;
          if (!SET.balanceRequested[bk] && $('mbal-' + bk)) fetchBalance(bk, pi, ki, false);
        });
      }
    }
  }
  // 启停切换:写 platforms[pi].models[mi].enable(缺省启用),重启后生效。
  // 重启前后端 effective 仍返旧值,成功后本地记入 SET.pendingEnable 保持卡片显示不回弹。
  async function toggleModelEnable(rawId) {
    const m = SET.cfgModels[idxOf(decodeURIComponent(rawId))];
    if (!m) return toast('模型不存在');
    const next = m.enable === false; // 当前禁用 → 目标启用
    try {
      // 与 key 解耦:所有 key 共享同一份 models,enable 改在平台层
      await req('PATCH', '/api/config', { path: ['platforms', m.platform_index, 'models', m.model_index, 'enable'], value: next });
      // 本地同步:同 id 的所有副本都更新
      for (const x of SET.cfgModels) if (x.id === m.id) x.enable = next;
      SET.pendingEnable[m.id] = next;
      afterWrite();
    } catch (e) {
      toast('切换失败:' + e.message);
      loadModelCards(); // 失败时重拉,回滚开关显示
    }
  }
  // 单个模型卡;点击整卡弹所属平台的编辑弹窗(enable 开关点击不冒泡)。余额是 Key 级概念,在卡体顶部按 Key 分行。
  function modelCardHtml(m, pi) {
    const run = SET.runtimeById[m.id];
    const disabled = m.enable === false;
    // 运行池里没有 = 配置新增但还没重启生效;禁用后若仍在池里(未重启)也提示待重启
    const stateHtml = disabled
      ? (run
          ? '<span class="model-card-state pending">待重启</span>'
          : '<span class="model-card-state off">已禁用</span>')
      : run
        ? '<span class="model-card-state ' + (run.is_busy ? 'busy' : 'idle') + '">' + (run.is_busy ? '占用中' : '空闲') + '</span>'
        : '<span class="model-card-state pending">待重启</span>';
    return '<div class="model-card' + (disabled ? ' off' : '') + '" title="点击编辑平台" onclick="sUI.mEdit(' + pi + ')">' +
      '<div class="model-card-head">' +
        '<span class="model-card-name">' + esc(m.display_name || m.mid || m.id) + '</span>' +
        '<span class="model-card-meta">' + esc(m.mid || m.id) +
          (run && run.is_busy && run.current_session_id ? ' · 会话 ' + esc(run.current_session_id) : '') + '</span>' +
        stateHtml +
        '<label class="model-en-sw" title="' + (disabled ? '已禁用,点击启用' : '启用中,点击禁用') + '" onclick="event.stopPropagation()">' +
          '<input type="checkbox"' + (disabled ? '' : ' checked') + ' onchange="sUI.mToggleEnable(\'' + encodeURIComponent(m.id) + '\')">' +
          '<span class="sw-track"></span>' +
        '</label>' +
      '</div>' +
      '<div class="cfg-kv"><label>今日 token</label><b title="输入 / 输出">' + (run ? fmtTok(run.today_prompt) + ' / ' + fmtTok(run.today_completion) : '--') + '</b></div>' +
      '<div class="cfg-kv"><label>累计 token</label><b title="输入 / 输出">' + (run ? fmtTok(run.total_prompt) + ' / ' + fmtTok(run.total_completion) : '--') + '</b></div>' +
      '<div class="cfg-kv"><label>缓存命中</label><b title="今日缓存 / 累计缓存 tok；历史命中率 = 累计缓存命中 ÷ 累计输入">' +
        (run && run.total_prompt ? fmtTok(run.total_cached || 0) + ' · ' + Math.round((run.total_cached || 0) / run.total_prompt * 100) + '%' : '--') +
        '</b></div>' +
    '</div>';
  }
  // 平台卡:头部 = 平台名 + N keys 徒章 + 启用/总数模型数;体内 = 每 Key 一行余额(仅已接入类型)+ 该平台模型列表。
  // models 从打平 cfgModels 取首份 key 副本(已含 deletedModels/pendingEnable 过滤)。
  function modelGroupHtml(pi) {
    const p = SET.cfgPlatforms[pi] || {};
    const keys = p.keys || [];
    const models = [];
    const seen = new Set();
    for (const m of SET.cfgModels) {
      if (m.platform_index === pi && !seen.has(m.id)) { seen.add(m.id); models.push(m); }
    }
    const gk = 'p' + pi;
    const open = !!SET.expandedGroups[gk];
    // 仅已接入余额查询的类型显示余额行(未接入的显示出来也只会是报错,不如不显示)
    const hasBal = SET.balanceTypes.indexOf(String(p.type || '')) >= 0;
    const balHtml = hasBal ? keys.map((k, ki) => {
      const bk = pi + '-' + ki;
      return '<div class="mbal-row">' +
        '<span class="mbal-key">' + esc(k.api_key ? maskKey(k.api_key) : '无 key') + '</span>' +
        '<span class="mbal-val" id="mbal-' + bk + '" title="' + esc(balTitle(bk)) + '">' + balText(bk) + '</span>' +
        '<button class="mbal-refresh" id="mbrg-' + bk + '" title="重新查询余额" onclick="event.stopPropagation();sUI.refreshBalance(event,' + pi + ',' + ki + ')">' + BAL_REFRESH_SVG + '</button>' +
      '</div>';
    }).join('') : '';
    return '<div class="model-group' + (open ? ' open' : '') + '" id="mgrp-' + gk + '">' +
      '<div class="model-group-head" onclick="sUI.toggleGroup(\'' + gk + '\')">' +
        '<svg class="model-group-caret" viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"></polyline></svg>' +
        '<span class="model-group-name">' + esc(p.name || ('平台' + pi)) + '</span>' +
        '<span class="model-group-badge">' + keys.length + ' keys</span>' +
        '<span class="model-group-meta">' + models.filter(m => m.enable !== false).length + ' / ' + models.length + ' 模型</span>' +
      '</div>' +
      '<div class="model-group-body' + (open ? '' : ' hidden') + '">' +
        balHtml +
        (models.length ? models.map(m => modelCardHtml(m, pi)).join('') : '<div class="model-group-empty">该平台暂无模型</div>') +
      '</div>' +
    '</div>';
  }
  async function loadModelCards(ctx) {
    const el = $('model-cards');
    if (!el || (ctx && !ctx())) return;
    try {
      const [rt, cg] = await Promise.all([req('GET', '/api/models'), req('GET', '/api/config')]);
      if (ctx && !ctx()) return;
      if (!$('model-cards')) return; // 异步期间已离开本页
      SET.runtimeById = {};
      for (const m of rt || []) SET.runtimeById[m.id] = m;
      SET.cfgPlatforms = (cg.effective && cg.effective.platforms) || [];
      SET.cfgModels = (cg.effective && cg.effective.models) || [];
      // 已删除/已改名旧 id 的标记清理:配置(live)与运行池都已无此 id 才清——重启前池里残留时须保留标记,
      // 否则会话页选择弹窗(读 /api/models 运行池)会重新列出已不可用的模型。
      const liveIds = new Set(SET.cfgModels.map(m => m.id));
      const poolIds = new Set((rt || []).map(m => m.id));
      for (const id of Object.keys(SET.deletedModels)) if (!liveIds.has(id) && !poolIds.has(id)) delete SET.deletedModels[id];
      SET.cfgModels = SET.cfgModels.filter(m => !SET.deletedModels[m.id]);
      // 重启前 effective 仍是旧配置:叠加已写盘的启停结果,保证卡片显示与已保存配置一致
      for (const m of SET.cfgModels) if (m.id in SET.pendingEnable) m.enable = SET.pendingEnable[m.id];
      SET.balanceTypes = cg.balance_types || [];
      const box = $('model-cards');
      if (!SET.cfgModels.length) {
        box.innerHTML = '<div class="empty-tip">尚未配置模型,点右上角 + 添加平台。</div>';
        return;
      }
      let html = '';
      SET.cfgPlatforms.forEach((p, pi) => { html += modelGroupHtml(pi); });
      // 有待重启的变更:列表顶部常驻「重启服务」横幅(增/改/删模型、启停开关、平台弹窗保存均经 afterWrite 置位)
      box.innerHTML = (SET.modelsPendingRestart
          ? '<div class="restart-bar"><span>配置已写入，重启后生效</span><button class="primary-btn" onclick="sUI.restartNow()">重启服务</button></div>'
          : '') + html +
        '<div class="empty-tip">token 显示格式为「输入 / 输出」。</div>';
    } catch (e) {
      const box = $('model-cards');
      if (box && (!ctx || ctx())) box.innerHTML = '<div class="empty-tip">加载失败:' + esc(e.message) + '</div>';
    }
  }
  function setPageModels(ctx) {
    setTitle('模型池');
    setActions('<button class="icon-btn" title="添加模型" onclick="sUI.openAdd()">' +
      '<svg class="ic" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>');
    setBody('<div class="set-scroll" id="model-cards"><div class="empty-tip">加载中…</div></div>');
    // 余额与展开态跨设置内导航保持(仅 closeSettings 回会话页时重置),重进本页不重复查余额
    loadModelCards(ctx);
  }
  function idxOf(id) {
    for (let i = 0; i < SET.cfgModels.length; i++) if (SET.cfgModels[i].id === id) return i;
    return -1;
  }
  function afterWrite() {
    SET.modelsPendingRestart = true;
    SET.balanceByGroup = {};      // 配置变了,旧余额不再对应现有 pi/ki 槽位
    SET.balanceRequested = {};
    toast('已写入 config.yml,到「服务」页重启后生效');
    loadModelCards();
  }
  // ---------- 平台编辑/新增弹窗(共用一套 UI 与渲染) ----------
  // pfEdit 工作态:keys/models 行数组;ref=null 为弹窗新增行,ref=原配置下标(仅保存时算 diff 用)。
  // 保存 = 一次批量 PATCH(body.edits),服务端同一次读文/校验/写盘,原子生效。
  let pfEdit = null;
  // 当前平台名下的去重模型列表(打平 cfgModels 取首份 key 副本,已含 deletedModels/pendingEnable 过滤)
  function platformModels(pi) {
    const models = []; const seen = new Set();
    for (const m of SET.cfgModels) if (m.platform_index === pi && !seen.has(m.id)) { seen.add(m.id); models.push(m); }
    return models;
  }
  function openModelEditor(pi) {
    const add = pi == null;
    const p = add ? {} : (SET.cfgPlatforms[pi] || {});
    pfEdit = {
      idx: add ? -1 : Number(pi),
      // 已有 Key:输入框置空(留空=保持原值),masked 存脱敏值仅做 placeholder 提示;绝不把脱敏值回写文件
      keys: add ? [] : (p.keys || []).map((k, ki) => ({ ref: ki, api_key: '', masked: k.api_key || '' })),
      models: add ? [] : platformModels(pi).map(m => ({ ref: m.model_index, id: m.mid || m.id, vision: !!m.vision, enable: m.enable !== false })),
    };
    $('mpe-title').textContent = add ? '新增平台' : '编辑平台';
    $('mpe-name').value = add ? '' : (p.name || '');
    $('mpe-url').value = add ? '' : (p.url || '');
    if (add) { pfEdit.keys.push({ ref: null, api_key: '' }); pfEdit.models.push({ ref: null, id: '', vision: false, enable: true }); }
    $('mpe-del-btn').classList.toggle('hidden', add);
    renderPfRows();
    $('model-edit-modal').classList.remove('hidden');
  }
  // Key 行:全部可编辑。已有 Key 输入框置空 + placeholder 提示当前脱敏值,输入新值=替换,留空=保持。
  function pfKeysRowHtml(r, i) {
    const ph = r.ref == null
      ? 'API KEY'
      : '当前: ' + (r.masked ? maskKey(r.masked) : '无 key');
    return '<div class="mpe-row">' +
      '<input class="mpe-grow" type="text" placeholder="' + esc(ph) + '" value="' + esc(r.api_key) + '" oninput="sUI.mKeyApi(' + i + ',this.value)">' +
      '<button class="mpe-del" title="删除此 Key" onclick="sUI.mDelKey(' + i + ')">×</button>' +
    '</div>';
  }
  // 模型子卡片两行:上行配 id,下行勾 vision/enable。id 可改(仅改 config.yml,重启生效)。
  // display_name/concurrency/type 不进弹窗:保存只按细粒度 path 改,不碰文件里其余字段。
  function pfModelsRowHtml(r, i) {
    return '<div class="mpe-mcard">' +
      '<div class="mpe-row">' +
        '<input class="mpe-grow" type="text" placeholder="id(上游模型名)" value="' + esc(r.id) + '" oninput="sUI.mModId(' + i + ',this.value)">' +
        '<button class="mpe-del" title="删除此模型" onclick="sUI.mDelModel(' + i + ')">×</button>' +
      '</div>' +
      '<div class="mpe-cks">' +
        '<label class="mpe-ck"><input type="checkbox"' + (r.vision ? ' checked' : '') + ' onchange="sUI.mModVision(' + i + ',this.checked)">图片输入</label>' +
        '<label class="mpe-ck"><input type="checkbox"' + (r.enable !== false ? ' checked' : '') + ' onchange="sUI.mModEnable(' + i + ',this.checked)">启用</label>' +
      '</div>' +
    '</div>';
  }
  // 行下标变化后需重渲染(事件处理器里捕获了旧 i),故增删后重建两段行列表。
  function renderPfRows() {
    if (!pfEdit) return;
    $('mpe-keys').innerHTML = pfEdit.keys.map(pfKeysRowHtml).join('') || '<div class="model-group-empty">至少保留一个 Key</div>';
    $('mpe-models').innerHTML = pfEdit.models.map(pfModelsRowHtml).join('') || '<div class="model-group-empty">至少保留一个模型</div>';
  }
  function addPfKey() { if (!pfEdit) return; pfEdit.keys.push({ ref: null, api_key: '' }); renderPfRows(); }
  function addPfModel() { if (!pfEdit) return; pfEdit.models.push({ ref: null, id: '', vision: false, enable: true }); renderPfRows(); }
  function delPfKey(i) {
    if (!pfEdit) return;
    if (pfEdit.keys.length <= 1) return toast('至少保留一个 Key');
    pfEdit.keys.splice(i, 1); renderPfRows();
  }
  function delPfModel(i) {
    if (!pfEdit) return;
    if (pfEdit.models.length <= 1) return toast('至少保留一个模型');
    pfEdit.models.splice(i, 1); renderPfRows();
  }
  function setPfKey(i, f, v) { if (pfEdit && pfEdit.keys[i]) pfEdit.keys[i][f] = v; }
  function setPfModel(i, f, v) { if (pfEdit && pfEdit.models[i]) pfEdit.models[i][f] = v; }
  function closeModelEditor() { $('model-edit-modal').classList.add('hidden'); }
  // 根据工作态算批量编辑:原地改(值变更项) → 删行(降序) → 新增行(append)。
  // YAML 数组删项后下标收紧,同批内删/改/增按原 ref 定位,服务端依次应用。
  function buildPfEdits() {
    const p = SET.cfgPlatforms[pfEdit.idx];
    const edits = [];
    const name = $('mpe-name').value.trim();
    const url = $('mpe-url').value.trim().replace(/\/+$/, '');
    if (name && name !== p.name) edits.push({ path: ['platforms', pfEdit.idx, 'name'], value: name });
    if (url && url !== p.url) edits.push({ path: ['platforms', pfEdit.idx, 'url'], value: url });
    // Key:已有行输入非空=替换 api_key(留空保持原值,避免把脱敏占位写回文件);新增行直接 append
    pfEdit.keys.forEach(r => {
      if (r.ref == null) {
        edits.push({ op: 'append', path: ['platforms', pfEdit.idx, 'keys'], value: { api_key: String(r.api_key || '').trim() } });
      } else {
        const nv = String(r.api_key || '').trim();
        if (nv) edits.push({ path: ['platforms', pfEdit.idx, 'keys', r.ref, 'api_key'], value: nv });
      }
    });
    const delKeys = [];
    for (let ki = 0; ki < (p.keys || []).length; ki++) {
      if (!pfEdit.keys.some(r => r.ref === ki)) delKeys.push(ki);
    }
    delKeys.sort((a, b) => b - a).forEach(ki => edits.push({ op: 'delete', path: ['platforms', pfEdit.idx, 'keys', ki] }));
    // 模型:已有行只按细粒度 path 改 vision/enable(不整体覆盖,保住文件里的 display_name/extra_params 等);
    // 新增行 append 最小对象(缺省项不写:display_name 后端同 id,enable 缺省启用)
    pfEdit.models.forEach(r => {
      if (r.ref != null) {
        const om = (p.models || [])[r.ref] || {};
        const nid = String(r.id || '').trim();
        if (nid && om.id && nid !== om.id) {
          edits.push({ path: ['platforms', pfEdit.idx, 'models', r.ref, 'id'], value: nid });
          SET.deletedModels[p.name + '/' + om.id] = true; // 重启前运行池里旧 id 不再可绑,标记隐藏
          delete SET.deletedModels[p.name + '/' + nid];   // 改成曾被删的 id:清掉旧标记防误屏蔽
        }
        if (!!om.vision !== !!r.vision) edits.push({ path: ['platforms', pfEdit.idx, 'models', r.ref, 'vision'], value: !!r.vision });
        if ((om.enable !== false) !== (r.enable !== false)) edits.push({ path: ['platforms', pfEdit.idx, 'models', r.ref, 'enable'], value: r.enable !== false });
      } else {
        const id = String(r.id || '').trim();
        const nv = { id };
        if (r.vision) nv.vision = true;
        if (r.enable === false) nv.enable = false;
        edits.push({ op: 'append', path: ['platforms', pfEdit.idx, 'models'], value: nv });
      }
    });
    const delMods = (p.models || []).map((_, i) => i).filter(i => !pfEdit.models.some(r => r.ref === i)).sort((a, b) => b - a);
    delMods.forEach(mi => { SET.deletedModels[p.name + '/' + p.models[mi].id] = true; edits.push({ op: 'delete', path: ['platforms', pfEdit.idx, 'models', mi] }); });
    return edits;
  }
  async function saveModelEditor() {
    if (!pfEdit) return;
    const add = pfEdit.idx < 0;
    const name = $('mpe-name').value.trim();
    const url = $('mpe-url').value.trim().replace(/\/+$/, '');
    if (!url) return toast('请填写平台上游地址');
    if (!pfEdit.models.length) return toast('至少保留一个模型');
    if (!pfEdit.keys.length) return toast('至少保留一个 Key');
    const idSet = new Set();
    for (const r of pfEdit.models) {
      const id = String(r.id || '').trim();
      if (!id) return toast('模型 id 不能为空');
      if (idSet.has(id)) return toast('模型 id 重复:' + id);
      idSet.add(id);
    }
    let edits;
    try {
      if (add) {
        // 新增平台:一次 append 整个对象(name 留空由服务端取主机段;type/concurrency/display_name 均不落配置,走各自缺省)
        edits = [{ op: 'append', path: ['platforms'], value: {
          name, url,
          keys: pfEdit.keys.map(r => ({ api_key: String(r.api_key || '').trim() })),
          models: pfEdit.models.map(r => {
            const id = String(r.id).trim();
            const nv = { id };
            if (r.vision) nv.vision = true;
            if (r.enable === false) nv.enable = false;
            return nv;
          }),
        } }];
      } else {
        // 改名不影响 pi(数组位置);其余按原 ref 定位,见 buildPfEdits
        edits = buildPfEdits();
        if (!edits.length) { closeModelEditor(); return toast('没有变更'); }
      }
      await req('PATCH', '/api/config', { edits });
      // 重加同名模型(重启前被标记隐藏的):清掉删除标记防误屏蔽
      const pname = name || (SET.cfgPlatforms[pfEdit.idx] || {}).name || '';
      if (!add) for (const r of pfEdit.models) if (r.ref == null) delete SET.deletedModels[pname + '/' + String(r.id || '').trim()];
      closeModelEditor();
      afterWrite(); // 列表顶部出现「重启服务」横幅按钮
    } catch (e) { toast('保存失败:' + e.message); }
  }
  // 删除整个平台:仅改 config.yml(一次 delete platforms[pi]),重启前列表已无它(effective 实时解析文件)
  async function delPlatformFromModal() {
    if (!pfEdit || pfEdit.idx < 0) return;
    const pi = pfEdit.idx;
    const p = SET.cfgPlatforms[pi] || {};
    closeModelEditor();
    const ok = await confirmModal('删除平台', '删除平台「' + (p.name || ('平台' + pi)) + '」及其全部 Key 与模型?此操作仅修改 config.yml。', '删除', true);
    if (!ok) return;
    try {
      await req('PATCH', '/api/config', { path: ['platforms', pi], op: 'delete' });
      // 运行池重启前仍持有该平台的模型:标记隐藏,防会话页选择弹窗误绑
      for (const m of (p.models || [])) SET.deletedModels[p.name + '/' + m.id] = true;
      afterWrite();
    } catch (e) { toast('删除失败:' + e.message); }
  }

  // ---------- 页:MCP 服务(增/改/删;name / url / 多 headers / timeout_ms / enable) ----------
  // 与模型池共用 PATCH /api/config 的细粒度 edit 接口:
  //   · 新增 = append 到 mcp_servers;
  //   · 删 = delete mcp_servers[pi];
  //   · 改 = setIn mcp_servers[pi].(name|url|timeout_ms|enable);headers 是普通键值对象,整体 setIn 一次到位。
  // 运行配置(cg.effective.mcp_servers)即文件刚解析后的视图,按 pi 直接定位;重启后才会重新发现工具。
  let mcpEdit = null; // 工作态:{ idx, headers:[{key, value, masked}] };idx=-1 为新增
  const MCP_HEADER_MASK = '*****'; // 与后端 routes/config.js 的掩码保持一致
  async function setPageMcp(ctx) {
    setTitle('MCP 服务');
    setActions('<button class="icon-btn" title="添加 MCP 服务" onclick="mcpUI.add()">' +
      '<svg class="ic" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>');
    setBody('<div class="set-scroll" id="mcp-list"><div class="empty-tip">加载中…</div></div>');
    await loadMcpList(ctx);
  }
  async function loadMcpList(ctx) {
    const box = $('mcp-list');
    if (!box || (ctx && !ctx())) return;
    try {
      const cg = await req('GET', '/api/config');
      if (ctx && !ctx()) return;
      if (!$('mcp-list')) return;
      SET.cfgMcp = (cg.effective && cg.effective.mcp_servers) || [];
      if (!SET.cfgMcp.length) {
        box.innerHTML = (SET.mcpPendingRestart
          ? '<div class="restart-bar"><span>配置已写入，重启后生效</span><button class="primary-btn" onclick="sUI.restartNow()">重启服务</button></div>'
          : '') + '<div class="empty-tip">尚未配置 MCP 服务，点右上角 + 添加。</div>';
        return;
      }
      const banner = SET.mcpPendingRestart
        ? '<div class="restart-bar"><span>配置已写入，重启后生效</span><button class="primary-btn" onclick="sUI.restartNow()">重启服务</button></div>'
        : '';
      box.innerHTML = banner + SET.cfgMcp.map(mcpCardHtml).join('') +
        '<div class="empty-tip">点卡片编辑 MCP 服务，启用后启动时发现其工具并追加到内置工具之后。</div>';
    } catch (e) {
      const b = $('mcp-list');
      if (b && (!ctx || ctx())) b.innerHTML = '<div class="empty-tip">加载失败:' + esc(e.message) + '</div>';
    }
  }
  // MCP 卡:头部 = 名称 + url + enable 状态;体内 = headers 键值列表。整卡点击进入编辑。
  function mcpCardHtml(s, pi) {
    const off = s.enable === false;
    const stateHtml = off ? '<span class="model-card-state off">已禁用</span>' : '<span class="model-card-state idle">启用</span>';
    const entries = Object.entries(s.headers || {});
    // header 值等同密码对待:后端 effective 已脱敏为固定短掩码,这里透传展示;若收到未脱敏原文也一律替换,不外显
    const maskVal = (v) => { const str = String(v == null ? '' : v); if (!str) return '--'; return str.includes('*') ? esc(str) : MCP_HEADER_MASK; };
    const headersHtml = entries.length
      ? entries.map(([k, v]) => '<div class="cfg-kv"><label>' + esc(k) + '</label><b>' + maskVal(v) + '</b></div>').join('')
      : '<div class="cfg-kv"><label>(无)</label><b>--</b></div>';
    return '<div class="model-card" onclick="mcpUI.edit(' + pi + ')">' +
      '<div class="model-card-head">' +
        '<span class="model-card-name">' + esc(s.name || ('MCP-' + pi)) + '</span>' +
        '<span class="model-card-meta">' + esc(s.url || '') + '</span>' +
        stateHtml +
      '</div>' + headersHtml +
    '</div>';
  }
  // 弹窗打开：add 模式 (idx=-1) → 空工作态;edit 模式 → 从当前配置复制。
  function openMcpEditor(idx) {
    const add = idx == null;
    const s = add ? {} : (SET.cfgMcp[idx] || {});
    mcpEdit = {
      idx: add ? -1 : Number(idx),
      // headers 数组:每个 {key, value, masked} 为一条编辑行。已有行 value 置空、masked 存当前脱敏值仅做提示
      // (同平台 Key 的留空=保持原值);新行 masked=null,必须手输真值。空 key 行保存时丢弃。
      headers: add
        ? [{ key: '', value: '', masked: null }]
        : Object.entries(s.headers || {}).map(([k, v]) => ({ key: k, value: '', masked: String(v) })),
    };
    $('mce-title').textContent = add ? '添加 MCP 服务' : '编辑 MCP 服务';
    $('mce-name').value = add ? '' : (s.name || '');
    $('mce-url').value = add ? '' : (s.url || '');
    // 运行配置里的 timeout_ms 已被 config.js 填上缺省值,所以这里显示的就是当前生效值(没配则为 60000)。
    $('mce-timeout').value = add || s.timeout_ms == null ? '' : String(s.timeout_ms);
    $('mce-enable').checked = add ? true : (s.enable !== false);
    $('mce-del-btn').classList.toggle('hidden', add);
    renderMcpHeaders();
    $('mcp-edit-modal').classList.remove('hidden');
  }
  function closeMcpEditor() { $('mcp-edit-modal').classList.add('hidden'); }
  // header 行:id 由 JS 运行时下标 i 拼接,避免与服务端 path 冲突
  function mcpHeaderRowHtml(r, i) {
    // 已有行:输入框置空,placeholder 提示当前脱敏值;留空=保持原值,输入新值=替换
    const ph = r.masked != null ? '当前: ' + r.masked + '（留空保持不变）' : '值';
    return '<div class="mpe-row">' +
      '<input class="mpe-grow" type="text" placeholder="Header 名(如 Authorization)" value="' + esc(r.key) + '" oninput="mcpUI.setHeader(' + i + ',\'key\',this.value)">' +
      '<input class="mpe-grow" type="text" placeholder="' + esc(ph) + '" value="' + esc(r.value) + '" oninput="mcpUI.setHeader(' + i + ',\'value\',this.value)">' +
      '<button class="mpe-del" title="删除此 header" onclick="mcpUI.delHeader(' + i + ')">×</button>' +
    '</div>';
  }
  function renderMcpHeaders() {
    if (!mcpEdit) return;
    const box = $('mce-headers');
    if (!mcpEdit.headers.length) box.innerHTML = '<div class="model-group-empty">未配置 header</div>';
    else box.innerHTML = mcpEdit.headers.map(mcpHeaderRowHtml).join('');
  }
  function addMcpHeader() {
    if (!mcpEdit) return;
    mcpEdit.headers.push({ key: '', value: '', masked: null });
    renderMcpHeaders();
  }
  function delMcpHeader(i) {
    if (!mcpEdit) return;
    mcpEdit.headers.splice(i, 1);
    renderMcpHeaders();
  }
  function setMcpHeader(i, f, v) { if (mcpEdit && mcpEdit.headers[i]) mcpEdit.headers[i][f] = v; }
  // 收集弹窗内的修改为批量 PATCH:服务端一次读文/写回/校验,原子生效。
  // headers 整体替换(简单可靠;键值对场景下增量 diff 收益小):空 key 行不写入。
  function buildMcpEdits() {
    if (!mcpEdit) return [];
    const edits = [];
    const name = $('mce-name').value.trim();
    const url = $('mce-url').value.trim();
    const enable = $('mce-enable').checked;
    // 超时:留空 = 不写入该项（沿用缺省 60s）。区间在 UI 先把一道,
    // 比写进 YAML 再被 config.js 静默夹掉好排查（两边上限保持 600000 一致）。
    const tmoRaw = $('mce-timeout').value.trim();
    let tmo = null;
    if (tmoRaw !== '') {
      tmo = Number(tmoRaw);
      if (!Number.isFinite(tmo) || tmo < 1000 || tmo > 600000) throw new Error('超时要填 1000 ~ 600000 毫秒（留空 = 默认 60s）');
      tmo = Math.round(tmo);
    }
    const add = mcpEdit.idx < 0;
    if (add) {
      if (!url) throw new Error('请填写 url');
      const obj = { url };
      if (name) obj.name = name;
      if (!enable) obj.enable = false;
      if (tmo != null) obj.timeout_ms = tmo;
      const headers = {};
      for (const r of mcpEdit.headers) {
        const k = String(r.key || '').trim();
        const v = String(r.value || '').trim();
        if (k) headers[k] = v;
      }
      if (Object.keys(headers).length) obj.headers = headers;
      edits.push({ op: 'append', path: ['mcp_servers'], value: obj });
    } else {
      const cur = SET.cfgMcp[mcpEdit.idx] || {};
      if (!url) throw new Error('请填写 url');
      if (name !== (cur.name || '')) edits.push({ path: ['mcp_servers', mcpEdit.idx, 'name'], value: name });
      if (url !== (cur.url || '')) edits.push({ path: ['mcp_servers', mcpEdit.idx, 'url'], value: url });
      if (!!cur.enable !== enable) edits.push({ path: ['mcp_servers', mcpEdit.idx, 'enable'], value: enable });
      // 超时:清空 = 删掉该键（回落到缺省）;后端 deleteIn 支持嵌套键,无键时是空操作。
      const curTmo = cur.timeout_ms == null ? null : Number(cur.timeout_ms);
      if (tmo !== curTmo) edits.push(tmo == null
        ? { path: ['mcp_servers', mcpEdit.idx, 'timeout_ms'], op: 'delete' }
        : { path: ['mcp_servers', mcpEdit.idx, 'timeout_ms'], value: tmo });
      // headers 仅在内容变更时整体 setIn;避免无意义重写(顺序可能不同)
      const newH = {};
      for (const r of mcpEdit.headers) {
        const k = String(r.key || '').trim();
        // 已有行留空 = 保持原值:把脱敏占位原样发回,由后端按键名还原真值(前端不持有真值)
        const v = String(r.value || '').trim() || (r.masked != null ? r.masked : '');
        if (k) newH[k] = v;
      }
      const curH = cur.headers || {};
      const same = JSON.stringify(newH) === JSON.stringify(curH);
      if (!same) edits.push({ path: ['mcp_servers', mcpEdit.idx, 'headers'], value: newH });
    }
    return edits;
  }
  async function saveMcpEditor() {
    let edits;
    try { edits = buildMcpEdits(); }
    catch (e) { toast(e.message); return; }
    if (!edits.length) { toast('没有改动'); closeMcpEditor(); return; }
    try {
      await req('PATCH', '/api/config', { edits });
      closeMcpEditor();
      afterMcpWrite();
    } catch (e) { toast('保存失败:' + e.message); }
  }
  async function delMcpEditor() {
    if (!mcpEdit || mcpEdit.idx < 0) return;
    const s = SET.cfgMcp[mcpEdit.idx] || {};
    closeMcpEditor();
    if (!await confirmModal('删除 MCP 服务', '删除「' + (s.name || s.url || ('MCP-' + mcpEdit.idx)) + '」?此操作仅修改 config.yml,重启后该服务的工具不再加载。', '删除', true)) return;
    try {
      await req('PATCH', '/api/config', { path: ['mcp_servers', mcpEdit.idx], op: 'delete' });
      afterMcpWrite();
    } catch (e) { toast('删除失败:' + e.message); }
  }
  function afterMcpWrite() {
    SET.mcpPendingRestart = true;
    toast('已写入 config.yml,到「服务」页重启后生效');
    loadMcpList();
  }
  window.mcpUI = {
    add: function () { openMcpEditor(null); },
    edit: openMcpEditor,
    close: closeMcpEditor,
    save: saveMcpEditor,
    del: delMcpEditor,
    addHeader: addMcpHeader,
    delHeader: delMcpHeader,
    setHeader: setMcpHeader,
  };

  // ---------- 设置区对外接口(动态卡片里的 onclick 均指向这里) ----------
  window.sUI = {
    // 账户
    changePassword: changePassword,
    saveProfile: saveProfile,
    logout: async function () {
      sessionStorage.removeItem('agent_creds'); // 旧版本遗留的 Basic 凭据，顺带清理
      localStorage.removeItem('agent_token');  // 清 autoRestore token，防止自动恢复旧用户
      try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
      location.href = '/logout';
    },
    // 服务
    saveForm: saveForm,
    restart: restart,
    openCfg: openCfgEditor,
    saveCfg: saveCfg,
    closeCfg: closeCfg,
    // 技能
    open: openSkill,
    openCreate: openCreateSkill,
    closeCreate: closeCreateSkill,
    createSkill: createSkill,
    renameSkill: renameSkill,
    deleteSkill: deleteSkill,
    editFile: openSkillFile,
    saveFile: saveSkillFile,
    closeEditor: closeSkillEditor,
    newFile: newSkillFile,
    deleteFile: deleteSkillFile,
    onUpload: uploadSkillFile,
    // 模型池(平台编辑/新增共用弹窗;mEdit 参数为平台下标 pi)
    openAdd: function () { openModelEditor(null); },
    mEdit: function (pi) { openModelEditor(pi); },
    mClose: closeModelEditor,
    mSave: saveModelEditor,
    mAddKey: addPfKey,
    mDelKey: delPfKey,
    mAddModel: addPfModel,
    mDelModel: delPfModel,
    mKeyApi: function (i, v) { setPfKey(i, 'api_key', v); },
    mModId: function (i, v) { setPfModel(i, 'id', v); },
    mModVision: function (i, v) { setPfModel(i, 'vision', v); },
    mModEnable: function (i, v) { setPfModel(i, 'enable', v); },
    mDelPlat: delPlatformFromModal,
    restartNow: restartNow,
    toggleGroup: toggleModelGroup,
    refreshBalance: refreshBalance,
    mToggleEnable: toggleModelEnable,
  };

  // ---------- 初始化 ----------
  bindChatScroll(); // 聊天区滚动跟随/右下角回底按钮(只绑一次)
  setView('welcome');
  openDrawer(drawerMQ.matches); // 桌面端:侧边栏默认展开;跨断点缩放窗口时同步切换开合态
  drawerMQ.addEventListener('change', e => openDrawer(e.matches));
  // 页面加载时校验 cookie 身份：防止 localStorage 旧 token 通过 autoRestore 恢复错误用户
  (async () => {
    let verifiedUser = null; // 校验结果顺带复用给侧边栏，避免同一次加载请求两次 /api/me
    try {
      const res = await fetch('/api/me', { credentials: 'include' });
      if (res.ok) {
        const j = await res.json();
        if (!j.user) {
          // cookie 无效或用户已从配置中移除 → 彻底清理所有前端凭据并跳登录
          localStorage.removeItem('agent_token');
          sessionStorage.removeItem('agent_creds'); // 旧版本遗留的 Basic 凭据，顺带清理
          location.href = '/logout';
          return;
        }
        verifiedUser = String(j.user);
      }
    } catch (_) { /* 网络错误放过，让后续请求正常走 */ }
    loadSessionList();
    loadDrawerUser(verifiedUser); // 侧边栏底部展示真实登录用户(未启用鉴权/拉取失败时静默回退默认占位)
    // 会话深链 /?s=<session_id>：数据页面（/app/{task_id}/...）的「返回会话」FAB 用——
    // task_id 即会话 id（engine 里 1:1），启动时消费一次即 replaceState 抹掉参数，
    // 避免刷新/分享时被钉回该会话；会话已删则 openSession 自行报错，落在 welcome。
    const deep = new URLSearchParams(location.search).get('s');
    if (deep) {
      history.replaceState(null, '', '/');
      openSession(deep);
    }
  })();
