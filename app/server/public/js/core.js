  /*
   * ============================================================================
   * Agent 任务台 v2 —— 接入真实后端(全部沿用 /api 现有接口,未新增任何接口)
   * ----------------------------------------------------------------------------
   * 已接入:
   *   GET    /api/sessions?status=active&limit=100             抽屉「今天/昨天」活跃列表
   *   GET    /api/sessions?status=done&limit=50&with_total=1   抽屉归档列表
   *   GET    /api/sessions?q=..&limit=50                       抽屉搜索
   *   POST   /api/sessions {title:'', model_id:''}             首条消息自动建档
   *   GET    /api/sessions/:id                                 打开会话(消息+文件)
   *   POST   /api/sessions/:id/messages {content, attachments} 发送消息
   *   POST   /api/sessions/:id/files                           附件上传(multipart)
   *   GET    /api/sessions/:id/stream                          SSE 流式输出
   *   POST   /api/sessions/:id/stop | /release                  状态栏「终止/断开」
   *   POST   /api/sessions/:id/bind {model_id}                  状态栏「选择模型」(任意可选,仅输出中拒绝)
   *   DELETE /api/sessions/:id/messages                         状态栏「清空」(会话内删除已移除,清空由这里承担)
   *   DELETE /api/sessions/:id/messages/:messageId              删除单条消息/工具卡(删 assistant 连带工具回执;单删工具卡同步摘除父调用)
   *   GET    /api/models                                        状态栏「选择模型」弹窗模型列表
   *
   * 设置区(侧边栏用户区整行点击进入;页面搬自 index.html,未新增任何接口):
   *   GET    /api/system/status | POST /api/system/restart[?force=true]   服务·状态与重启
   *   GET/PUT/PATCH /api/config | POST /api/config/validate               系统配置 / 原文编辑 / 模型增删改
   *   GET    /api/models | GET /api/platforms/balance                     模型·模型池与余额
   *   GET/POST/PUT/DELETE /api/skills[/:name][/file|/upload|/rename]      技能·技能与文件管理
   *   GET    /api/me | POST /api/password | GET /logout                    账户·信息/改密/退出
   *   GET/PUT /api/profile                                                  账户·用户画像(可见/可改/可关)
   *   GET/POST/DELETE /api/wechat[/:id][/qr|/refresh]                       账户·微信绑定(未配 wxbot 时入口自动隐藏)
   *
   * 后端已有但 v2 尚未接入 UI 的接口(先列出,不实现):
   *   PATCH  /api/sessions/:id                                重命名(后端已支持)
   *   GET    /api/sessions/:id/files/download-token?path=      文件下载(配合文件面板)
   *
   * 无后端支撑、仅前端占位的概念(先不实现):
   *   · 「文秘助理 / 识图专家」模式 —— 后端无 mode 字段,当前仅影响提示文案
   *   · 「思考过程」折叠块(已思考 N 秒) —— 后端不产出 reasoning,已移除 mock
   * 鉴权:任意请求 401 时跳转 /login(与 core.js 的 req 一致)。
   * ============================================================================
   */
  'use strict';

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  // ---------- markdown 渲染(同步 index:本地 vendor/marked.min.js;缺失/异常时回退转义纯文本) ----------
  // 返回 { html, fmt }:fmt=false 表示未做转换,气泡不带 .md 类、保持 pre-wrap 原文排版
  if (typeof marked !== 'undefined') marked.setOptions({ breaks: true, gfm: true });
  function mdHtml(text) {
    if (typeof marked === 'undefined') return { html: esc(text), fmt: false };
    try { return { html: marked.parse(text || ''), fmt: true }; }
    catch (_) { return { html: esc(text), fmt: false }; }
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    const now = new Date();
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (now.toDateString() === d.toDateString()) return hm;
    const md = (d.getMonth() + 1) + '/' + d.getDate();
    return (d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '/' + md) + ' ' + hm;
  }
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2000);
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* 落入降级 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '-9999px'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  // ---------- API(与 core.js 的 req 保持一致) ----------
  // 默认单次请求超时：机器休眠几小时后链路中间的 keep-alive 连接被静默拆线（无 FIN/RST），
  // 回页面后首个 POST 会写进黑洞 socket 永远 Pending（线上已实测 /messages 挂起）。
  // 超时让黑洞变快失败，再补一次重试（重试必新建连接）。
  const FETCH_TIMEOUT_MS = 15000;
  function fetchOnce(url, opt, timeoutMs) {
    if (!timeoutMs) return fetch(url, opt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeoutMs);
    const p = fetch(url, Object.assign({}, opt, { signal: ctrl.signal }));
    return p.finally(() => clearTimeout(timer));
  }
  // 只识别“请求铁定/极可能没进服务器”的网络层错误：TypeError=连接失败/重置，AbortError=本函数超时。
  // HTTP 4xx/5xx 不在此列（已拿到响应，不重试）。
  function isNetworkErr(e) { return !!e && (e.name === 'AbortError' || e instanceof TypeError); }

  async function req(method, url, body, isForm, timeoutMs) {
    const opt = { method, headers: {} };
    // 浏览器身份只认 HttpOnly cookie：服务端所有路由（含 /api/me、SSE）统一按 cookie 认定用户。
    // 不要在此附加 sessionStorage 里的 Basic 头——sessionStorage 按标签页隔离、刷新后残留，
    // 而 cookie 是浏览器全局的；两者并用会在多用户切号后出现 /api/me 是 A、列表数据是 B 的分裂。
    if (body && !isForm) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    } else if (body && isForm) {
      opt.body = body;
    }
    const tmo = timeoutMs == null ? FETCH_TIMEOUT_MS : timeoutMs;
    let res;
    try {
      try {
        res = await fetchOnce(url, opt, tmo);
      } catch (e) {
        if (!isNetworkErr(e)) throw e;
        // 黑洞/残破连接典型特征：第一次碰死、重连即活——只补发这一次
        await new Promise(r => setTimeout(r, 300));
        res = await fetchOnce(url, opt, tmo);
      }
    } catch (e) {
      if (isNetworkErr(e)) {
        const err = new Error('网络不可用或请求超时');
        err.network = true;
        throw err;
      }
      throw e;
    }
    // 运行中登录态失效：带上当前页 URL，重新登录后原页返回
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('未登录'); }
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // ---------- 模式配置（顶部 icon 按会话助手类型渲染；欢迎页已不再提供模式切换） ----------
  const MODES = {
    secretary: {
      label: '文秘助理', hint: '支持文字输入，可起草、润色、整理文书',
      icon: '<svg class="header-mode-icon" viewBox="0 0 24 24"><path d="M6 3h12l4 6-10 13L2 9z"></path><polyline points="2 9 22 9"></polyline><polyline points="10 3 8 9 12 22"></polyline><polyline points="14 3 16 9 12 22"></polyline></svg>',
    },
    vision: {
      label: '识图专家', hint: '支持图片识别输入',
      icon: '<svg class="header-mode-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
    },
  };

  // ---------- 全局状态 ----------
  const state = {
    view: 'welcome',          // welcome | chat
    mode: 'secretary',          // 新建会话默认助手类型（欢迎页已去掉模式切换，不再可变）
    sessionType: 'secretary',   // 当前会话的助手类型（建档时锁定，后续不随模式切换变更）
    deepThink: false,           // 深度思考开关(仅本地视觉状态,无后端参数)
    phase: '',                  // 当前会话阶段（sessions.phase: advising=顾问 / executing=执行；徽标据此渲染）
    pendingModel: '',           // welcome 预选模型（ensureSession 建档时透传 model_id）
    sessionId: null,            // 当前会话
    sessionTitle: '',           // 当前会话标题
    status: '',                 // 当前会话状态(SSE 更新)
    schedule: null,             // 当前会话定时任务（详情 schedule 字段，null=无）
    sessions: [],               // 抽屉列表缓存
    attachments: [],            // 待发送附件 {file, name, size}
    lastImgBlobUrl: null,       // 任务文件图片预览的 blob URL，下次预览或开新图时回收
    lastPdfBlobUrl: null,       // 同上:PDF 页内预览的 blob URL(浏览器内建查看器用)
    es: null,                   // EventSource
    lastSseAt: 0,               // 最近一次收到 SSE 心跳时刻（看门狗静默判死用）
    streamText: '',             // 当前流式累积文本
    streamEl: null,             // 当前流式 AI 气泡
    streamWrap: null,           // 当前流式消息容器（.msg.other）；思考面板与气泡都挂它上面
    streamReasoning: '',        // 当前流式累积思考文本
    streamThinkEl: null,        // 当前流式思考面板的 body 节点（未出现思考时为 null）
    toolCards: {},              // tool_call_id -> 工具卡片元素(同步 index 工具卡样式)
    toolCallStreaming: {},      // tool_call_id -> {name, args}：参数流式生成中的累积态(早建卡卡面实时填充)
    toolCallMsgIds: {},         // tool_call_id -> tool 消息行 id（历史懒加载映射，renderDetail 重建）
        typingEl: null,             // 「思考中」占位
        streaming: false,
        pendingSummary: false,      // 是否在等待「压缩」总结 AI 回复（避免重复弹窗；同时用于按钮 disabled 防重入）
        lastAssistantMsgId: null,   // 最近处理过的 SSE assistant_message id：重复 id 直接丢，防重渲染（补「2 遍」问题）
    chatHasMore: false,           // 当前会话是否还有更早的历史未加载（消息懒加载分页）
    chatOldestId: null,           // 已加载最早一条消息的行 id（拉更早页的 before 游标）
    chatLoadedCount: 0,           // 已加载消息条数（重拉详情时按同量分页，避免退回全量渲染）
  };

  // ---------- 视图切换 ----------
  function setView(view) {
      state.view = view;
      $('welcome-view').classList.toggle('hidden', view !== 'welcome');
      $('chat-view').classList.toggle('hidden', view !== 'chat');
      $('new-chat-btn').classList.toggle('hidden', view !== 'chat'); // 新建按钮仅对话状态显示
      renderHeader();
      updatePhaseBar(); // 状态栏仅对话视图显示
      updateScrollBottomBtn();
    }

  // ---------- 会话阶段徽标 ----------
  // 头部标题前小图标：advising（顾问：澄清需求/规划）才显示（tooltip 说明），
  // executing 是主干状态不显示、减噪。原 profile 模式徽标机位改造而来（手动切换模式已移除）。
  const PHASE_BADGES = {
    advising: {
      label: '顾问模式：澄清需求、规划任务；写定任务书后自动开始执行',
      icon: '<svg viewBox="0 0 24 24" class="ic" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/></svg>',
    },
  };
  function phaseBadgeHtml(p) {
    const b = PHASE_BADGES[p];
    if (!b) return '';
    return '<span class="prof-badge phase-' + esc(p) + '" title="' + esc(b.label) + '">' + b.icon + '</span>';
  }

  function renderHeader() {
    const c = $('header-center');
    // welcome（含刚 newChat）一律清空：newChat 会停在 welcome，不重刷会残留旧会话标题
    if (state.view !== 'chat' || !state.sessionId) { c.innerHTML = ''; return; }
    // 顶部只显会话阶段徽标（advising 才显）+ 标题；助手类型 icon 早已退位
    const title = document.createElement('div');
    title.className = 'header-title';
    title.style.cursor = 'pointer';
    title.title = '点击重命名';
    title.innerHTML = phaseBadgeHtml(state.phase) +
      '<span class="header-title-text">' + esc(state.sessionTitle || state.sessionId) + '</span>';
    title.addEventListener('click', renameSession); // 点标题重命名(同步 index)
    c.innerHTML = '';
    c.appendChild(title);
  }

  // ---------- 模式切换已移除：新建会话固定用 state.mode（secretary），助手类型不再占顶部 icon
  // （历史 vision 会话的类型字段保留，仅不再在标题处展示）。 ----------

