// 聊天消息渲染 / 历史懒加载 / 滚动跟随 / typing 效果(拆自 index.html 内联脚本,纯搬运不改逻辑;经典脚本按序加载,共享全局作用域)
'use strict';
  // ---------- 消息渲染 ----------
  // 旧消息兼容：早期服务端把附件说明拼在正文前(【系统通知】用户上传了文件：...),此处拆开单独展示 📎 行；
  // 新版已不再生成这种行，仅历史会话渲染时命中。
  function parseUploadNotice(content) {
    const m = /^【系统通知】用户上传了文件：([^\n]*)(?:\n([\s\S]*))?$/.exec(content || '');
    if (!m) return { text: content || '', files: null };
    const files = m[1].split('、').map(s => s.replace(/（大小[^）]*）$/, '').trim()).filter(Boolean);
    return { text: m[2] || '', files: files };
  }

  function actionsHtml(ts, content, msgId, usage) {
    const b64 = btoa(unescape(encodeURIComponent(content)));
    // 删除本条:仅已落库消息可删(传 m.id);流式未落库时无 id,不渲染
    const del = msgId
      ? '<button class="act act-del" title="删除本条" data-msg-id="' + msgId + '">' +
        '<svg class="ic sm" viewBox="0 0 24 24"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>' +
        '</button>'
      : '';
    // token 用量：In 输入(+缓存命中率), Out 输出；历史重渲染时 usage 是 JSON 串,流式事件里是对象
    let u = usage;
    if (typeof u === 'string') { try { u = JSON.parse(u); } catch (_) { u = null; } }
    const usageHtml = u && (u.pt || u.ct)
      ? '<span class="act-usage" title="输入 ' + (u.pt || 0) + ' tok，缓存命中 ' +
        (u.cached == null ? '未上报' : u.cached + ' tok') + '，输出 ' + (u.ct || 0) + ' tok">' +
        'In: ' + fmtTok(u.pt || 0) +
        (u.cached != null && u.pt ? '/' + Math.round(u.cached / u.pt * 100) + '%' : '') +
        ', Out: ' + fmtTok(u.ct || 0) + '</span>'
      : '';
    return '<div class="msg-actions">' +
      '<span>' + fmtTime(ts) + '</span>' +
      usageHtml +
      '<button class="act act-copy" title="复制" data-b64="' + b64 + '">' +
        '<svg class="ic sm" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
      '</button>' +
      del +
    '</div>';
  }

  function userMsgHtml(m) {
    const p = parseUploadNotice(m.content);
    const attach = p.files && p.files.length
      ? '<div class="attach-line">📎 ' + esc(p.files.join('、')) + '</div>' : '';
    const r = mdHtml(p.text);
    // 复制内容取纯文本（不含【系统通知】附件行），与气泡里显示一致
    return '<div class="msg me">' +
      '<div class="bubble-user' + (r.fmt ? ' md' : '') + '">' + attach + r.html + '</div>' +
      actionsHtml(m.created_at, p.text, m.id) +
    '</div>';
  }

  function aiMsgHtml(m) {
    const text = (m.content || '').trim();
    const reason = (m.reasoning || '').trim();
    if (!text && !reason) return null; // 纯工具调用的应答:不渲染气泡,工具卡由 appendToolCardsFromAssistant 铺
    const think = reason ? thinkPanelHtml(m.reasoning) : '';
    const bubble = text ? (() => { const r = mdHtml(m.content); return '<div class="bubble-ai' + (r.fmt ? ' md' : '') + '">' + r.html + '</div>'; })() : '';
    return '<div class="msg other">' + think + bubble + actionsHtml(m.created_at, m.content || '', m.id, m.usage) + '</div>';
  }
  // 思考过程折叠面板:summary 固定名「思考过程」+ 右侧复制按钮,body 展示推理全文。
  // 历史重渲染默认收起(与原设计一致),流式阶段的展开行为由 ensureStreamThinkPanel 显式控制。
  // 复制按钮走 onCopyClick 统一代理:点击时从 DOM 取思考全文(不依赖 b64,流式增量也能复制)
  const THINK_COPY_BTN = '<button class="act act-copy" title="复制思考内容">' +
    '<svg class="ic sm" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
    '</button>';
  function thinkPanelHtml(text) {
    return '<details class="msg-think"><summary>思考过程' + THINK_COPY_BTN + '</summary><div class="msg-think-body">' + esc(text) + '</div></details>';
  }

  // ---------- markdown 代码块逐块复制 ----------
  // marked 把围栏代码渲染成 .md 气泡内的 <pre><code>;渲染完成后做一次 DOM 装饰:
  // pre 包一层 .code-wrap(定位容器,按钮在滚动区外,横向滚动不带走按钮),右上放复制钮。
  // 复制文本在点击时从 pre.textContent 现取(onCopyClick 的 .code-wrap 分支),不嵌 b64、不怕内容后续变化。
  // 只碰 .md 里的 pre:工具卡 / 思考区已有自己的复制按钮,行内 code 不加。
  const CODE_COPY_BTN = '<button class="act act-copy" type="button" title="复制代码">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
    '</button>';
  function decorateCodePre(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.md pre').forEach(function (pre) {
      if (pre.querySelector('code')) decorateOne(pre);
    });
  }
  function decorateOne(pre) {
    const parent = pre.parentElement;
    if (!parent || parent === document.documentElement) return;
    if (parent.classList.contains('code-wrap')) {
      if (parent.querySelector('.act-copy')) return; // 已装饰过,幂等跳过
      parent.insertAdjacentHTML('beforeend', CODE_COPY_BTN);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    parent.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    wrap.insertAdjacentHTML('beforeend', CODE_COPY_BTN);
  }

  // 「压缩」摘要卡片：流式收尾与历史重渲染共用的头部（图标 + 标题 + 右侧说明）。
  function summaryHeaderHtml() {
    return '<summary>' +
      '<svg class="sum-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
        '<ellipse cx="12" cy="5" rx="8" ry="2.5"></ellipse>' +
        '<path d="M4 5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5"></path>' +
        '<path d="M4 11v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6"></path>' +
      '</svg>' +
      '<span>上下文总结</span>' +
      '<span class="sum-hint">后续对话以此为起点</span>' +
    '</summary>';
  }

  // 历史重渲染：被标记 type='summary' 的摘要消息渲染成摘要卡片（默认收起，点开可重现）。
  // 工具卡不挂：摘要行永远不带 tool_calls；复制/删除按钮照常提供。
  function summaryMsgHtml(m) {
    const r = mdHtml(m.content || '');
    return '<div class="msg other">' +
      '<details class="msg-summary">' + summaryHeaderHtml() +
        '<div class="msg-summary-body"><div class="bubble-ai' + (r.fmt ? ' md' : '') + '">' + r.html + '</div></div>' +
      '</details>' +
      actionsHtml(m.created_at, m.content || '', m.id, m.usage) +
    '</div>';
  }

  // ---------- 工具调用卡片(样式/交互同步 index;流式与历史共用) ----------
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
  function toolCopyBtnHtml(text) {
    if (!text) return '';
    const b64 = btoa(unescape(encodeURIComponent(text)));
    return '<button class="act act-copy" title="复制参数与结果" data-b64="' + b64 + '">' +
      '<svg class="ic sm" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>';
  }
  // 工具卡「删除本条」：删的是 tool 消息行；后端会把它在父 assistant 里的调用同步摘除。
  // msgId = tool 消息的库行 id（历史渲染传 m.id；实时由 tool_result 事件的 msg_id 携带）
  function toolDelBtnHtml(msgId) {
    if (!msgId) return '';
    return '<button class="act act-del" title="删除本条" data-msg-id="' + msgId + '">' +
      '<svg class="ic sm" viewBox="0 0 24 24"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button>';
  }
  function renderToolCard(id, name, argsStr, createdAt, opts) {
    const div = document.createElement('div');
    div.className = 'tool-card';
    div.id = 'tool-' + id;
    // 流式执行(open=true):结果在 tool-result 里增量填入,展开才能看到实时输出,回合结束也别自动折上。
    // 历史重渲染(默认 open=false):保持原来的收起观感,用户点 summary 再展开。
    const open = !!(opts && opts.open);
    // generating=true:tool_call 参数流式生成中的早卡，占位提示由 finalizeToolCardArgs 替换为完整参数
    const gen = !!(opts && opts.generating);
    if (gen) div.classList.add('tool-generating');
    div.innerHTML =
      '<details' + (open ? ' open' : '') + '><summary><span class="spin">◌</span>' +
      '<span class="tool-name">' + esc(name) + '</span>' +
      '<span class="tool-args">' + (gen ? '生成参数中…' : esc(toolArgsSummary(name, argsStr))) + '</span></summary>' +
      '<pre class="tool-args-full">' + (gen ? '' : esc(toolArgsFull(argsStr))) + '</pre>' +
      '<pre class="tool-result">执行中…</pre>' +
      // 时间行/复制按钮在折叠体内:展开卡片才可见
      '<div class="tool-time">' + fmtTime(createdAt || Date.now()) + '</div></details>';
    return div;
  }
  // 早卡收尾：回填完整参数、清「生成中」态（assistant_message / 执行时 tool_call 事件都会接手）
  function finalizeToolCardArgs(id, name, argsStr) {
    delete state.toolCallStreaming[id];
    const card = state.toolCards[id];
    if (!card || !card.classList.contains('tool-generating')) return;
    card.classList.remove('tool-generating');
    const argsEl = card.querySelector('.tool-args');
    if (argsEl) argsEl.textContent = toolArgsSummary(name || '', argsStr || '');
    const fullEl = card.querySelector('.tool-args-full');
    if (fullEl) fullEl.textContent = toolArgsFull(argsStr || '');
  }
  // tool 消息 content:纯文本,或含图片时的哨兵 JSON {"__blocks__":[...]}(read_file 读图回传)
  // 顺手剥掉旧数据里的「，图片见同条消息的 image_url 内容块」尾巴（新版文案已去掉，历史行还在库里）
  function parseToolContent(content) {
    if (typeof content === 'string' && content.startsWith('{"__blocks__":')) {
      try {
        const blocks = JSON.parse(content).__blocks__ || [];
        const ref = blocks.find(b => b.type === 'image_ref');
        const img = blocks.find(b => b.type === 'image_url');
        return {
          text: blocks.filter(b => b.type === 'text').map(b => (b.text || '').replace(/，图片见同条消息的 image_url 内容块/g, '')).join('\n'),
          // 新版存 .imgcache/ 相对路径:渲染走带 cookie 的会话内下载路由（不过期不裂图）；
          // 旧库里的 base64 image_url 块照常直接用
          imageUrl: ref
            ? '/api/sessions/' + encodeURIComponent(state.sessionId) + '/files/download?path=' + encodeURIComponent(ref.rel)
            : (img && img.image_url && img.image_url.url || null),
        };
      } catch (_) { /* 解析失败按原文显示 */ }
    }
    return { text: content, imageUrl: null };
  }
  function fillToolResult(id, content, isError, liveImageUrl, msgId) {
    const card = document.getElementById('tool-' + id);
    if (!card) return;
    if (isError) card.classList.add('error');
    card.querySelector('.spin').textContent = isError ? '✕' : '✓';
    const parsed = parseToolContent(content);
    const pre = card.querySelector('.tool-result');
    if (!pre) return;
    pre.textContent = parsed.text || '(空)';
    // 结果就绪后在卡片时间行补复制/删除按钮(删除走统一的 .act-del 委托)
    const timeRow = card.querySelector('.tool-time');
    if (timeRow) {
      if (msgId) card.dataset.msgId = msgId; // 记住 tool 消息行 id,多次回填不丢
      if (!timeRow.querySelector('.act-copy')) {
        timeRow.insertAdjacentHTML('beforeend', toolCopyBtnHtml(parsed.text || ''));
      }
      if (!timeRow.querySelector('.act-del')) {
        timeRow.insertAdjacentHTML('beforeend', toolDelBtnHtml(card.dataset.msgId));
      }
    }
    const img = liveImageUrl || parsed.imageUrl;
    if (img && !card.querySelector('.tool-img')) {
      const el = document.createElement('img');
      el.className = 'tool-img';
      el.src = img;
      el.title = '点击放大查看';
      pre.insertAdjacentElement('afterend', el);
    }
  }
  // 把 assistant 消息里的 tool_calls 建成工具卡片(历史渲染与 assistant_message 事件共用)
  function appendToolCardsFromAssistant(m, container) {
    if (!m.tool_calls) return;
    let calls;
    try { calls = typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls; } catch (_) { return; }
    for (const c of calls) {
      const id = c.id || ('c' + Math.random().toString(36).slice(2, 10));
      if (state.toolCards[id]) { // 早卡(流式生成中)：回填完整参数收尾；否则跳过不重复建卡
        finalizeToolCardArgs(id, c.function && c.function.name, c.function && c.function.arguments);
        continue;
      }
      const card = renderToolCard(id, c.function && c.function.name || '工具', c.function && c.function.arguments, m.created_at);
      container.appendChild(card);
      state.toolCards[id] = card;
    }
  }

  // ---------- tool 卡懒加载 ----------
  // 历史接口不再返回 role=tool 消息（内容大、含 base64 图片）；assistant 消息附带
  // tool_call_msg_ids 映射（tool_call.id → tool 消息行 id）。首次展开卡片时才拉取全文回填。
  function hookToolCardLazyLoad() {
    const box = $('chat-view');
    if (!box || box.dataset.toolLazyHooked) return;
    box.dataset.toolLazyHooked = '1';
    // toggle 事件不冒泡，用捕获阶段代理到列表容器
    box.addEventListener('toggle', e => {
      const details = e.target;
      if (!details || details.tagName !== 'DETAILS') return;
      const card = details.closest('.tool-card');
      if (!card) return;
      const pre = card.querySelector('.tool-result');
      // 仍是占位文案才拉取（已回填/流式输出中/加载失败复位后的文案都偏离占位时不重复触发）
      if (pre && pre.textContent !== '执行中…') return;
      loadToolCardContent(card);
    }, true);
  }

  async function loadToolCardContent(card) {
    const toolCallId = card.id.replace(/^tool-/, '');
    const msgId = state.toolCallMsgIds && state.toolCallMsgIds[toolCallId];
    if (!msgId || card.dataset.loading) return; // 无映射（tool 结果尚未产出/实时回合）：SSE 会自己填
    card.dataset.loading = '1';
    const pre = card.querySelector('.tool-result');
    if (pre) pre.textContent = '加载中…';
    try {
      const m = await req('GET', '/api/sessions/' + state.sessionId + '/messages/' + msgId);
      if (m && m.role === 'tool') fillToolResult(toolCallId, m.content, !!m.is_error, undefined, m.id);
      else if (pre) pre.textContent = '(无结果)';
    } catch (_) {
      // 复位占位，再次折叠/展开可重试
      if (pre) pre.textContent = '执行中…';
    } finally {
      delete card.dataset.loading;
    }
  }

  function msgNode(m) {
    if (m.role === 'user') return userMsgHtml(m);
    // 被「压缩总结」标记的摘要消息：重渲染成摘要卡片，而不是普通 AI 气泡
    if (m.role === 'assistant') return m.type === 'summary' ? summaryMsgHtml(m) : aiMsgHtml(m);
    return null; // tool 结果不单独展示
  }

  // 把一段消息渲染进目标容器（全量渲染时传 chat-view；懒加载更早页时传离屏 div 再前插进盒子）。
  // tool 行由后端过滤不返回，工具卡内容展开时由 hookToolCardLazyLoad 按 tool_call_msg_ids 拉取。
  // 返回 closeArc：若目标是分页前插且页尾存档段还要与现有顶部合并，调用方可不调它（不补「已存档」尾注）。
  function appendMessagesDom(messages, target) {
    // 存档段（type='archived'，「仅摘要」时摘要之前的旧历史）：连成一截淡色容器，
    // 段尾插一条「已存档、不再发给 AI」说明，紧接摘要卡片，一眼能看出上下文从哪里算起。
    let arcWrap = null;
    const closeArc = () => {
      if (!arcWrap) return;
      arcWrap.insertAdjacentHTML('beforeend',
        '<div class="archived-note">以上消息已存档，不再发送给 AI；后续对话从摘要开始</div>');
      arcWrap = null;
    };
    for (const m of messages || []) {
      let t = target;
      if (m.type === 'archived') {
        if (!arcWrap) { arcWrap = document.createElement('div'); arcWrap.className = 'msg-archived'; target.appendChild(arcWrap); }
        t = arcWrap;
      } else {
        closeArc();
      }
      const node = msgNode(m);
      if (node) t.insertAdjacentHTML('beforeend', node);
      if (m.role === 'assistant' && m.tool_call_msg_ids) Object.assign(state.toolCallMsgIds, m.tool_call_msg_ids);
      if (m.role === 'assistant') appendToolCardsFromAssistant(m, t);
    }
    // 历史渲染收口:给本轮新渲染出的代码块补复制按钮(目标可能是分页离屏容器,装饰后再随节点搬迁)
    decorateCodePre(target);
    return { closeArc };
  }

  function renderDetail(detail) {
    const s = detail.session;
    state.sessionTitle = (s && s.title) || '';
    state.sessionType = (s && s.assistant_type) || 'secretary'; // 顶部 icon 跟随会话类型
    state.phase = s && s.phase || ''; // 会话阶段（advising/executing）：头部徽标与 SSE status/phase 事件同源
    state.status = (s && s.status) || '';
    state.schedule = detail.schedule || null; // 定时任务状态条数据（随 updatePhaseBar 一并渲染）
    state.toolCards = {};
    state.toolCallStreaming = {}; // 流式参数早卡映射随会话/回合重置
    state.toolCallMsgIds = {}; // tool_call.id → tool 消息行 id（展开时懒加载用）
    userPaused = false;
    removeTyping();
    renderHeader();
    updatePhaseBar({ model_id: s && s.model_id });
    const box = $('chat-view');
    box.innerHTML = '';
    appendMessagesDom(detail.messages || [], box).closeArc();
    if (!(detail.messages || []).length) {
      box.innerHTML = '<div class="drawer-empty">描述你的需求，AI 会和你讨论并直接干活。</div>';
    }
    state.chatHasMore = !!detail.has_more;
    state.chatOldestId = detail.oldest_id || null;
    state.chatLoadedCount = (detail.messages || []).length;
    hookToolCardLazyLoad();
    scrollBottom();
    updateScrollBottomBtn();
    // 首屏条数太少撑不满滚动区时不会产生 scroll 事件，上滑永远触发不了加载：自动补一页
    if (state.chatHasMore && box.scrollHeight <= box.clientHeight + CHAT_TOP_TRIGGER) loadOlderMessages();
  }

  // ---------- 历史懒加载：开会话先只拉最近 CHAT_INIT_PAGE_SIZE 条，上滑接近顶部后每次再补 CHAT_PAGE_SIZE 条 ----------
  const CHAT_INIT_PAGE_SIZE = 3;  // 打开会话首屏非 tool 消息条数
  const CHAT_PAGE_SIZE = 10;      // 上滑到顶后每页补充条数
  const CHAT_TOP_TRIGGER = 100; // 距顶不足此像素时触发拉更早页
  let chatLoadingMore = false;  // 防重入（滚动事件高频触发）
  async function loadOlderMessages() {
    if (chatLoadingMore || state.view !== 'chat' || !state.sessionId || !state.chatHasMore) return;
    chatLoadingMore = true;
    const id = state.sessionId;
    const box = $('chat-view');
    // 消息流顶部内联轻提示（不用底部全局 toast，太重）：更早页补上后这行自动被顶掉移除
    const tip = document.createElement('div');
    tip.className = 'chat-load-earlier';
    tip.textContent = '正在加载更早消息…';
    box.insertBefore(tip, box.firstChild);
    try {
      const detail = await req('GET', '/api/sessions/' + id + '?limit=' + CHAT_PAGE_SIZE + '&before=' + (state.chatOldestId || 0));
      // 趁提示行还在流内量几何：下方锚点公式据此得「新 scrollTop = 旧 scrollTop + 新页高 - 提示行高」，
      // 旧内容逐像素不动，新页最后一行恰好向下补进提示行的位置
      const prevH = box.scrollHeight; // 含提示行高度
      const prevTop = box.scrollTop;
      tip.remove(); // 量完再移除，存档合并/几何计算中提示行不掺和
      if (state.sessionId !== id || state.view !== 'chat') return; // 请求期间已切会话/视图，丢弃
      const frag = document.createElement('div'); // 离屏容器（DocumentFragment 不支持 insertAdjacentHTML）
      const { closeArc } = appendMessagesDom(detail.messages || [], frag);
      // 存档段跨页合并：存档块总是从历史最开头连排到摘要前，只可能碰盒子顶部；
      // 本页尾部是未收尾的存档容器且现有顶部也是存档容器时，子节点并进现有容器（不重复加尾注）
      const firstArc = box.firstElementChild && box.firstElementChild.classList.contains('msg-archived') ? box.firstElementChild : null;
      const tail = frag.lastChild;
      if (firstArc && tail && tail.classList && tail.classList.contains('msg-archived') && !tail.querySelector('.archived-note')) {
        // 逆序会打乱存档段顺序：锁住现有首位作固定锚点，尾部子节点依时间序前插进去
        const arcAnchor = firstArc.firstChild;
        while (tail.firstChild) firstArc.insertBefore(tail.firstChild, arcAnchor);
        frag.removeChild(tail);
      } else {
        closeArc(); // 本页以存档段结尾且不与现有存档段相连：补「已存档」尾注
      }
      if (!detail.has_more) {
        // 已翻到最早：在内容流最顶上留一行终点提示（切会话时随 renderDetail 清空）
        const end = document.createElement('div');
        end.className = 'chat-load-earlier';
        end.textContent = '没有更早的消息了';
        frag.insertBefore(end, frag.firstChild);
      }
      // 前插保持视口锚定：prevH 含提示行高，差值即「新增页高 - 提示行高」，提示行被新页尾行原位覆盖
      // 注意先固定锚点：每轮现取 box.firstChild 会把新页插成逆序（终点提示也会随之沉到新页与现有内容之间）
      const anchor = box.firstChild;
      while (frag.firstChild) box.insertBefore(frag.firstChild, anchor);
      box.scrollTop = box.scrollHeight - prevH + prevTop;
      state.chatHasMore = !!detail.has_more;
      if (detail.oldest_id) state.chatOldestId = detail.oldest_id;
      state.chatLoadedCount += (detail.messages || []).length;
      // 旧页太短导致补完后仍贴在触发区：继续拉下一页，避免卡在顶部要再动一下才加载
      if (box.scrollTop <= CHAT_TOP_TRIGGER && state.chatHasMore) {
        chatLoadingMore = false;
        await loadOlderMessages(); // await：防重入锁由整条递归链末端统一释放，避免本层 finally 提前解锁导致重复拉同一页
      }
    } catch (e) {
      if (state.sessionId === id) toast('加载更早消息失败:' + e.message);
    } finally {
      tip.remove(); // 失败/丢弃路径下也要收掉进行中提示（已移除时是空操作）
      chatLoadingMore = false;
    }
  }

  function appendUserMsg(content, fileNames, msgId) {
    const attach = fileNames && fileNames.length
      ? '<div class="attach-line">📎 ' + esc(fileNames.join('、')) + '</div>' : '';
    const r = mdHtml(content);
    const wrap = document.createElement('div');
    wrap.className = 'msg me';
    wrap.innerHTML = '<div class="bubble-user' + (r.fmt ? ' md' : '') + '">' + attach + r.html + '</div>' +
      actionsHtml(Date.now(), content, msgId);
    decorateCodePre(wrap); // 用户消息里也可能有围栏代码块
    $('chat-view').appendChild(wrap);
    scrollBottom();
  }

  // ---------- 滚动跟随(同步 index:上翻历史自动暂停跟随;右下角浮动钮可回底/转圈) ----------
  const SCROLL_BOTTOM_THRESHOLD = 80; // 距底 80px 内视为「在底部」
  function isNearBottom() {
    const box = $('chat-view');
    return box.scrollHeight - box.scrollTop - box.clientHeight < SCROLL_BOTTOM_THRESHOLD;
  }
  function scrollBottom() {
    const box = $('chat-view');
    box.scrollTop = box.scrollHeight;
  }
  // 仅在「贴底」时跟随输出。userPaused 由 scroll 事件根据当前距底距离持续同步,
  // 覆盖滚轮/拖滚动条/键盘/触屏滑动等所有方式,只要用户把视口移出底部就停止跟随,
  // 重新回到底部(且无主动暂停意图)就恢复。wheel/touchmove 仍作为「主动向上」的即时信号。
  // 注意:不要在 maybeAutoScroll 里再判 isNearBottom —— 增量已经写进 DOM,一次大 delta
  // 把内容推过阈值后 isNearBottom 会变 false,导致后续跟着丢失,看起来像「不跟了」。
  // 「是否贴底」在 scroll 事件里捕获就行,那一刻是 DOM 变更前的真实位置。
  let userPaused = false;
  function maybeAutoScroll() {
    if (!userPaused) scrollBottom();
  }
  // AI 是否「正在干活」:流式输出中,或会话处于 active(含工具执行与多轮模型调用的间隙)
  function scrollBusy() { return state.streaming || state.status === 'active'; }
  function updateScrollBottomBtn() {
    const btn = $('scroll-bottom-btn');
    if (!btn) return;
    const inChat = state.view === 'chat' && !!state.sessionId;
    const busy = inChat && scrollBusy();
    // 运行中即使贴着底部也保持显示:转圈即「AI 还活着」指示,多轮工具间隙不至于看着像挂掉
    const show = busy || (inChat && !isNearBottom());
    btn.classList.toggle('hidden', !show);
    const spinner = btn.querySelector('.sb-spinner');
    if (spinner) spinner.classList.toggle('hidden', !busy);
    const arrow = btn.querySelector('.sb-arrow');
    if (arrow) arrow.classList.toggle('hidden', !!busy);
  }
  function clickScrollBottom() {
    userPaused = false;
    scrollBottom();
    updateScrollBottomBtn();
  }
  // 监听用户滚动意图:向上翻阅历史(滚轮向上/手指下拖)立即暂停跟随,回到底部时恢复。
  // 关键:用 wheel/touchmove 捕获「用户主动向上」的意图(程序滚动不会触发这二者),
  // 避免被自动跟随的 scrollBottom 反复拉回底部而无法上翻。
  function bindChatScroll() {
    const box = $('chat-view');
    let touchY = 0;
    box.addEventListener('wheel', e => { if (e.deltaY < 0) userPaused = true; }, { passive: true });
    box.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
    box.addEventListener('touchmove', e => {
      const dy = e.touches[0].clientY - touchY;
      if (dy > 3) userPaused = true;
      touchY = e.touches[0].clientY;
    }, { passive: true });
    box.addEventListener('scroll', () => {
      // 用 scroll 事件(而非 wheel/touchmove)统一收敛「是否在底部」,
      // 这样拖滚动条、键盘 PageUp/Home、触屏惯性滑等都会被纳入判断。
      // 程序触发的 scrollBottom 总是精确落底,isNearBottom() 恒为 true,不会误标记。
      userPaused = !isNearBottom();
      updateScrollBottomBtn();
      if (box.scrollTop <= CHAT_TOP_TRIGGER) loadOlderMessages(); // 上滑接近顶部 → 懒加载更早历史
    }, { passive: true });
  }

  function addTyping() {
    removeTyping();
    const ph = document.createElement('div');
    ph.className = 'msg other';
    ph.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
    $('chat-view').appendChild(ph);
    state.typingEl = ph;
    scrollBottom();
  }
  function removeTyping() {
    if (state.typingEl) { state.typingEl.remove(); state.typingEl = null; }
  }

