// 发送 / SSE 流式渲染 / 复制与全屏查看器(拆自 index.html 内联脚本,纯搬运不改逻辑)
'use strict';
  // ---------- 发送 ----------
  async function uploadFiles(sessionId, files) {
    const out = [];
    // 后端 multer 单请求最多 10 个文件(limits 见 routes/files.js),超过就分批
    for (let i = 0; i < files.length; i += 10) {
      const fd = new FormData();
      for (const f of files.slice(i, i + 10)) fd.append('files', f.file, f.name);
      // 大文件上传在慢速网络上可以远超普通请求超时：放宽到 120s
      const r = await req('POST', '/api/sessions/' + sessionId + '/files', fd, true, 120000);
      out.push(...(r.uploaded || []));
    }
    return out.map(u => ({ name: u.filename, size: u.size }));
  }

  async function send() {
    const ta = $('msg-input');
    const content = ta.value.trim();
    const editingId = state.editingMsgId || 0;
    // 没有文字就不发（避免产生空消息）；但只有附件时允许发送——粘贴长文本转成的 .txt 需要能单独发出。
    // 运行中也是这条规则：有字就发（后端 live 追投），没字又没附件时按钮本身是「停止」。
    if (!content && !state.attachments.length) return;

    const pending = state.attachments.slice();
    state.attachments = [];
    renderAttachChips();
    ta.value = '';
    autosize();
    updateSendBtn(); // 清空后若仍在生成中，按钮应回到「停止」

    let domDropped = false;
    try {
      const id = await ensureSession();
      let atts = [];
      if (pending.length) atts = await uploadFiles(id, pending);
      // 输入区上传卡片里成功入库的文件:正文前拼一行告知，让 AI 知道任务目录多了哪些文件
      const upNames = Array.from($('up-cards').querySelectorAll('.up-card[data-done="1"]'))
        .map(c => c.dataset.name).filter(Boolean);
      // 输入区上传卡片 + 本条消息随附的附件（粘贴转文件等）都要告知；
      // atts 用的是服务端返回的真实文件名（重名会自动加序号）。
      const names = upNames.concat(atts.map(a => a.name));
      const text = names.length
        ? '用户上传了文件：' + names.join('、') + (content ? '\n\n' + content : '')
        : content;
      const body = { content: text, deepThink: !!state.deepThink };
      let sent;
      if (editingId) {
        // 覆盖式编辑：先撤掉本地该条及其后的渲染，再让服务端删除同范围历史并以新内容重开一轮
        dropDomFromMessage(editingId);
        domDropped = true;
        sent = await req('POST', '/api/sessions/' + id + '/messages/' + editingId + '/edit', body);
        clearEditState();
      } else {
        sent = await req('POST', '/api/sessions/' + id + '/messages', body);
      }
      clearUploadCards(); // 消息已发出(告知行已拼入正文),卡片使命完成清掉

      appendUserMsg(text, atts.map(a => a.name), sent && sent.message_id);
      // 标题取用户原文，不带文件告知行；纯附件发送时退回粘贴文本的前缀
      const seed = content || (pending[0] && pending[0].titleSeed) || '';
      if (!state.sessionTitle && seed) {
        state.sessionTitle = seed.length > 24 ? seed.slice(0, 24) : seed;
      }
      renderHeader();
      // 运行中插话：正文字流进行中已有一个气泡作「活着」的信号，不再挂打字占位
      //（刚挂上就会被下一个 delta 移除，只会闪一下）；工具间隙里补上占位反而有用。
      if (!state.streaming) addTyping();
      loadSessionList();
    } catch (e) {
      // 发送失败:附件还原+草稿文本回填（发送前已清空输入框，挂起/失败不能让文字蒸发），
      // 用户等待期间新敲的内容排在后面不丢。
      state.attachments = pending.concat(state.attachments);
      renderAttachChips();
      if (content) {
        ta.value = content + (ta.value ? '\n' + ta.value : '');
        autosize();
      }
      updateSendBtn(); // 文字/附件都可能被还原：按当前状态刷新发送键（附件在时不能停在停止态）
      // 编辑请求失败(如运行中 409)：服务端历史未动，把被乐观撤掉的节点重拉回来
      if (domDropped) restoreChatView();
      toast('发送失败:' + e.message);
    }
  }

  // ---------- SSE 流 ----------
  // 助手消息流式容器：首个 delta 到达时创建，同时为思考面板预留挂载点
  function ensureStreamWrap() {
    if (state.streamWrap) return state.streamWrap;
    const wrap = document.createElement('div');
    wrap.className = 'msg other';
    const bubble = document.createElement('div');
    bubble.className = 'bubble-ai';
    wrap.appendChild(bubble);
    $('chat-view').appendChild(wrap);
    state.streamWrap = wrap;
    state.streamEl = bubble;
    return wrap;
  }
  // 思考面板:首次思考 delta 到达时创建,带 open 状态（流式中默认展开）
  function ensureStreamThinkPanel() {
    if (state.streamThinkEl) return state.streamThinkEl;
    if (!state.streamWrap) ensureStreamWrap();
    const det = document.createElement('details');
    det.className = 'msg-think streaming';
    det.open = true; // 流式阶段默认展开，看思考增量
    const sum = document.createElement('summary');
    sum.innerHTML = '思考过程' + THINK_COPY_BTN;
    const body = document.createElement('div');
    body.className = 'msg-think-body';
    det.appendChild(sum);
    det.appendChild(body);
    // 插在气泡之前（思考 → 结论 的顺序）
    state.streamWrap.insertBefore(det, state.streamEl);
    state.streamThinkEl = body;
    return body;
  }
  // 思考结束(正文开始流式或本轮收尾):自动折叠思考面板并去掉流式高亮边框;用户仍可手动点开回看
  function collapseStreamThink() {
    if (!state.streamThinkEl) return;
    const det = state.streamThinkEl.closest('details');
    if (det) { det.open = false; det.classList.remove('streaming'); }
  }

  // ---------- 流式 delta 合帧渲染 ----------
  // 快速输出模型(如 DeepSeek)的 delta 频率远超屏幕刷新率：逐条全量重写文本节点 +
  // 读布局滚动(scrollHeight/scrollTop)会把主线程挤满，页面与右下角转圈肉眼可见地卡。
  // 改为 delta 只累积进缓冲，每个动画帧统一刷一次 DOM；文本节点内容只在尾部增长时
  // 走 appendData 增量追加，避免整段文本节点重建重排。
  let streamPaintQueued = false;
  function paintStreamingText(el, full) {
    if (!el) return;
    const tn = el.firstChild;
    if (tn && tn.nodeType === 3) {
      if (tn.data === full) return; // 无变化不碰 DOM，不触发布局
      if (full.startsWith(tn.data)) { tn.appendData(full.slice(tn.data.length)); return; }
    }
    el.textContent = full; // 结构不符(收尾后重建/罕见回退)才整段重写
  }

  function scheduleStreamPaint() {
    if (streamPaintQueued) return;
    streamPaintQueued = true;
    requestAnimationFrame(() => {
      streamPaintQueued = false;
      paintStreamingText(state.streamEl, state.streamText);
      paintStreamingText(state.streamThinkEl, state.streamReasoning);
      maybeAutoScroll();
      updateScrollBottomBtn();
    });
  }

  function connectStream() {
    closeStream();
    if (!state.sessionId) return;
    const es = new EventSource('/api/sessions/' + state.sessionId + '/stream');
    state.es = es;
    state.lastSseAt = Date.now(); // 建连即重置静默计时
    // 任何具名事件都算连接存活：静默看门狗与回前台宽限共用（error 不列，原生连接错误也走 error）
    ['ping', 'status', 'assistant_delta', 'reasoning_delta', 'assistant_message', 'tool_call_start',
      'tool_call_args', 'tool_call', 'tool_result', 'ui_card', 'auto_compress', 'done', 'title', 'think_auto']
      .forEach(function (n) { es.addEventListener(n, function () { markSseAlive(n); }); });
    es.addEventListener('status', ev => {
      const d = JSON.parse(ev.data);
      state.status = d.status;
      if (d.model_id) state.modelId = d.model_id;
      renderHeader();
      updateHeaderActions();
      updateScrollBottomBtn(); // 状态切换同步右下角转圈(开始/结束干活)
    });
    es.addEventListener('think_auto', ev => {
      const d = JSON.parse(ev.data);
      if (!d.supported) {
        toast('当前模型未配置思考参数，技能 ' + d.skill + ' 的深度思考要求无法生效');
        return;
      }
      if (state.deepThink) return;
      state.deepThink = true;
      $('deep-think-btn').classList.add('on');
      toast('技能 ' + d.skill + ' 需要深度思考，已自动开启');
    });
    es.addEventListener('assistant_delta', ev => {
      const d = JSON.parse(ev.data);
      removeTyping();
      state.streamText += d.text;
      if (!state.streamEl) {
        if (!state.streamText.trim()) return; // 忽略前导空白(纯工具调用回合无文本)
        ensureStreamWrap();
        state.streamText = d.text; // 上面 if 已 trim 为非空
        collapseStreamThink();    // 首个正文 delta：思考已结束，折叠思考面板
      }
      state.streaming = true;
      scheduleStreamPaint(); // DOM 刷新合到每个动画帧一次：快速输出模型逐 token 重排会挤爆主线程
    });
    es.addEventListener('reasoning_delta', ev => {
      const d = JSON.parse(ev.data);
      removeTyping();
      state.streamReasoning += d.text;
      if (!state.streamWrap) ensureStreamWrap();
      ensureStreamThinkPanel();
      state.streaming = true;
      scheduleStreamPaint();
    });
    es.addEventListener('assistant_message', ev => {
              const d = JSON.parse(ev.data);
              // 防重：同 id 的 assistant_message 只处理一次（防御 EventSource 自动重连、服务端重发等情况）
              if (d.id && state.lastAssistantMsgId === d.id) return;
              if (d.id) state.lastAssistantMsgId = d.id;
              // 已落库的回合记入增量跟踪（否则回前台补拉会把同一条 assistant 再追加一遍）
              if (d.id) {
                state.renderedSigs[d.id] = 'assistant|' + (d.is_summary ? 'summary' : '');
                if (d.id > state.lastRenderedMsgId) state.lastRenderedMsgId = d.id;
              }
              removeTyping();
          const hasText = !!(d.content && d.content.trim());
          const r = hasText ? mdHtml(d.content) : null;
          // 思考面板：本轮结束时锁定为后端返回的完整文本（不清空 streamReasoning 以防与历史回填不一致）
          if (d.reasoning && d.reasoning.trim()) {
            if (!state.streamWrap) ensureStreamWrap();
            ensureStreamThinkPanel();
            state.streamThinkEl.textContent = d.reasoning;
          }
          if (state.streamEl) {
            if (r) {
              state.streamEl.className = 'bubble-ai' + (r.fmt ? ' md' : ''); // 增量期间是纯文本,收尾统一换 md 排版
              state.streamEl.innerHTML = r.html;
              decorateCodePre(state.streamEl); // 流式期间不插按钮(每帧整块换 innerHTML),收尾统一装饰一次
            } else {
              // 无文本时去掉气泡（纯工具调用/纯思考也要保留思考面板）
              state.streamEl.remove();
            }
            state.streamEl = null;
            state.streamText = '';
          } else if (r) {
            // 没起过气泡但收到文本：现在才创建（思考先行、文本后到的罕见场景）
            if (!state.streamWrap) ensureStreamWrap();
            const bubble = document.createElement('div');
            bubble.className = 'bubble-ai' + (r.fmt ? ' md' : '');
            bubble.innerHTML = r.html;
            decorateCodePre(bubble);
            state.streamWrap.appendChild(bubble);
          }
          // 「压缩」总结回合的最终答复（后端已保证只有压缩回合里首条无工具调用的收尾回复才带 is_summary，
          // 中间 AI 回复已按普通消息渲染）：把已流式输出的气泡装进摘要卡片（与历史重渲染同款样式），
          // 并标记 wrap 为 msg-summary-live：archiveDomBeforeSummary 据此定位摘要卡片，之前的旧消息收进存档容器。
          // open=true 让用户立刻读到；后续轮次不自动折起（卡片可手动点 summary 收起）。
          // 防重：同一 streamWrap 已有卡片则不再重复插入（保护 SSE 重连重发等场景）。
          if (d.is_summary && hasText && state.streamWrap && !state.streamWrap.querySelector('.msg-summary')) {
            const wrap0 = state.streamWrap;
            const det = document.createElement('details');
            det.className = 'msg-summary';
            det.open = true;
            det.innerHTML = summaryHeaderHtml() + '<div class="msg-summary-body"></div>';
            const body = det.querySelector('.msg-summary-body');
            const bubble = wrap0.querySelector('.bubble-ai');
            const ref = bubble ? bubble.nextSibling : null;
            if (bubble) body.appendChild(bubble); // 把总结气泡收进卡片 body（保留原位，不打乱思考面板顺序）
            wrap0.insertBefore(det, ref);
            wrap0.classList.add('msg-summary-live');
          }
          // 补上尾部操作行(时间戳+复制/删除),与历史重渲染(aiMsgHtml)同款;
          // created_at 由后端落库时间随事件回传,重进会话后时刻不变
          if (state.streamWrap) {
            state.streamWrap.insertAdjacentHTML('beforeend', actionsHtml(d.created_at, d.content || '', d.id, d.usage));
          }
          if (d.tool_calls) appendToolCardsFromAssistant(d, $('chat-view'));
          state.streaming = false;
          // 思考面板本轮结束兜底折叠(正常已在首个正文 delta 时折过,这里是 no-op);
          // 覆盖无正文的回合(如纯工具调用/纯思考),也顺带清掉 .streaming 高亮。工具卡保持展开,由用户自行收起。
          collapseStreamThink();
          state.streamWrap = null;
          state.streamReasoning = '';
          state.streamThinkEl = null;
          maybeAutoScroll();
          updateScrollBottomBtn();
          // 「压缩」总结完成后：后端已把摘要标成 type='summary' 并把之前的旧消息标成 type='archived'
                //（不再发给模型）；聊天保留全部展示，把摘要之前的旧消息就地淡出存档。
                // 仅在客户端主动点了压缩（pendingSummary）时才走收尾；避免历史重加载/跨设备重连误触发。
                // 仅有内容的总结才走后续流；空的/错误的总结只复位按钮状态。
                if (d.is_summary && state.pendingSummary && hasText) {
                  state.pendingSummary = false;
                  // 历史保留展示，但摘要之前的旧消息已存档：同步淡出 + 尾部说明，和重进入后的样式一致。
                  archiveDomBeforeSummary();
                  toast('已生成摘要：旧历史已存档，后续对话从摘要开始');
                  updateHeaderActions();
                } else if (d.is_summary && state.pendingSummary && !hasText) {
                  // AI 总结为空/出错，复位状态。用于按钮状态还原。
                  state.pendingSummary = false;
                  updateHeaderActions();
                }
        });
    // 参数流式生成早卡：id+name 就绪即建卡展开，长参数（write_file 大文件）期间不再是死寂 typing
    es.addEventListener('tool_call_start', ev => {
      const d = JSON.parse(ev.data);
      removeTyping();
      if (state.toolCards[d.id]) return; // 重连/重复广播防御
      state.toolCallStreaming[d.id] = { name: d.name || '', args: '' };
      // 保持原折叠态：参数进度看摘要行的「生成参数中… N 字符」，不自动展开
      const card = renderToolCard(d.id, d.name, '', Date.now(), { generating: true });
      $('chat-view').appendChild(card);
      state.toolCards[d.id] = card;
      maybeAutoScroll();
    });
    es.addEventListener('tool_call_args', ev => {
      const d = JSON.parse(ev.data);
      const st = state.toolCallStreaming[d.id];
      if (!st) return; // 未建早卡(无 id/name 或已收尾)则丢弃，收尾后残留碎片自然忽略
      st.args += d.args || '';
      const card = state.toolCards[d.id];
      if (!card) return;
      if (card.dataset.painting) return; // 150ms 合并重绘：超大参数不逐帧刷
      card.dataset.painting = '1';
      setTimeout(() => {
        delete card.dataset.painting;
        if (!card.isConnected || !state.toolCallStreaming[d.id]) return;
        const fullEl = card.querySelector('.tool-args-full');
        if (fullEl) { fullEl.textContent = st.args; fullEl.scrollTop = fullEl.scrollHeight; }
        const argsEl = card.querySelector('.tool-args');
        const n = st.args.length;
        if (argsEl) argsEl.textContent = '生成参数中… ' + (n >= 1024 ? (n / 1024).toFixed(1) + 'k 字符' : n + ' 字符');
        maybeAutoScroll();
      }, 150);
    });
    es.addEventListener('tool_call', ev => {
      const d = JSON.parse(ev.data);
      removeTyping(); // 工具卡出现也算即时反馈
      if (state.toolCards[d.id]) {
        // 执行时的完整参数事件：若为流式早卡则回填收尾（unwrap 后的干净参数），普通卡不动
        finalizeToolCardArgs(d.id, d.name, d.arguments);
        return;
      }
      // 无早卡(旧行为/刷新后重连)：直接建展开卡
      const card = renderToolCard(d.id, d.name, d.arguments, Date.now(), { open: true });
      $('chat-view').appendChild(card);
      state.toolCards[d.id] = card;
      maybeAutoScroll();
    });
    es.addEventListener('tool_result', ev => {
      const d = JSON.parse(ev.data);
      fillToolResult(d.tool_call_id, d.content, d.is_error, d.image_url, d.msg_id);
      maybeAutoScroll();
    });
    // 通用 UI 卡片：工具回包附 ui_card 块（MCP 层剥离转发），渲染器与动作注册表见 preview.js appendUiCard
    es.addEventListener('ui_card', ev => {
      appendUiCard(JSON.parse(ev.data));
    });
    // 后端回合结束+宽限期后的自动压缩提议：不再自动执行，弹 modal 请用户手动确认（见 proposeAutoCompress）
    es.addEventListener('auto_compress', ev => {
      proposeAutoCompress(JSON.parse(ev.data));
    });
    es.addEventListener('done', ev => {
      removeTyping(); // 本轮结束,占位亦终止(如模型报错无回复)
      // 压缩回合异常结束的兜底（模型报错回合直接 break / 被终止 → 不会有带 is_summary 的最终消息）：
      // 复位等待状态并还原压缩按钮，历史保持原样不动。
      if (state.pendingSummary) {
        state.pendingSummary = false;
        toast('压缩回合已结束，未收到摘要，历史未变动');
        updateHeaderActions();
      }
      state.streaming = false;
      state.streamEl = null; // 防御性清理:回合异常结束(如终止)时不留悬空气泡到下一轮
      collapseStreamThink(); // 异常收尾兜底:未折叠的思考面板收起并去掉流式高亮
      state.streamText = '';
      state.streamWrap = null;
      state.streamReasoning = '';
      state.streamThinkEl = null;
      // 异常收尾兜底：把参数未流完的早卡就地回填收尾，避免占位态永远呼吸
      for (const sid of Object.keys(state.toolCallStreaming)) {
        const stg = state.toolCallStreaming[sid];
        finalizeToolCardArgs(sid, stg.name, stg.args);
      }
      state.toolCards = {};
      state.toolCallStreaming = {}; // 流式参数早卡映射随会话/回合重置
      updateScrollBottomBtn();
      loadSessionList();
    });
    // 服务端首次交互后自动生成的标题（finalize 后约 1s 到达）：即时刷新顶栏 + 重拉会话列表（PC 常驻侧边栏/移动抽屉）
    es.addEventListener('title', ev => {
      const d = JSON.parse(ev.data);
      // title 为 null = 服务端清空会话时重置标题：顶栏一并清掉，避免新对话文不对题
      if (d && 'title' in d) { state.sessionTitle = d.title || ''; renderHeader(); }
      loadSessionList();
    });
    es.addEventListener('error', ev => {
      removeTyping();
      try {
        const d = JSON.parse(ev.data);
        if (d && d.message) toast('错误:' + d.message);
      } catch (_) { /* EventSource 连接错误,自动重连 */ }
    });
  }

  // ---------- 消息区点击代理(复制;全屏查看器内的克隆按钮同样可复制) ----------
  async function onCopyClick(e) {
    const copyBtn = e.target.closest('.act-copy');
    if (!copyBtn) return;
    const toolCard = copyBtn.closest('.tool-card');
    const think = copyBtn.closest('.msg-think');
    if (think) e.preventDefault(); // 按钮在 summary 内:只复制,不触发折叠/展开
    let text = '';
    const codeWrap = copyBtn.closest('.code-wrap'); // 代码块逐块复制(decorateCodePre 注入):点时现取 pre 全文
    if (codeWrap) {
      const pre = codeWrap.querySelector('pre');
      text = pre ? pre.textContent : '';
    } else if (toolCard) {
      // 工具卡:参数 + 结果一并复制。点时取 DOM 现值,多次回填/流式更新后也不会复制旧内容
      const args = toolCard.querySelector('.tool-args-full');
      const res = toolCard.querySelector('.tool-result');
      const parts = [];
      if (args) parts.push('command:\n' + args.textContent);
      if (res) parts.push('result:\n' + res.textContent);
      text = parts.join('\n\n');
    } else if (think) {
      const b = think.querySelector('.msg-think-body');
      text = b ? b.textContent : '';
    } else {
      try { text = decodeURIComponent(escape(atob(copyBtn.dataset.b64 || ''))); } catch (_) {}
    }
    const ok = await copyText(text);
    toast(ok ? '已复制' : '复制失败');
    if (ok) {
      copyBtn.classList.add('copied');
      setTimeout(() => copyBtn.classList.remove('copied'), 1200);
    }
  }
  $('chat-view').addEventListener('click', onCopyClick);
  $('fs-viewer').addEventListener('click', onCopyClick);

  // ---------- 删除本条消息(复制按钮旁) ----------
  // 后端连带删 assistant 轮的 tool 回执;成功后重拉详情重建消息区(工具卡需随该轮一起拆)。
  // 执行中也可删:库行没了,下一轮组装模型历史时自然不含这条。
  $('chat-view').addEventListener('click', async e => {
    const btn = e.target.closest('.act-del');
    if (!btn) return;
    const msgId = Number(btn.dataset.msgId);
    if (!msgId || !state.sessionId) return;
    if (!window.confirm('删除本条消息？它将不再发给 AI。')) return;
    btn.disabled = true;
    try {
      await req('DELETE', '/api/sessions/' + state.sessionId + '/messages/' + msgId);
      toast('已删除');
      // 按已加载量分页重拉（长会话删一条不该退回全量重建）
      const detail = await req('GET', '/api/sessions/' + state.sessionId + '?limit=' + Math.max(CHAT_PAGE_SIZE, state.chatLoadedCount));
      if (state.view === 'chat') renderDetail(detail);
    } catch (err) {
      toast('删除失败:' + err.message);
      btn.disabled = false;
    }
  });

  // ---------- 编辑已发送的用户消息(覆盖式) ----------
  // 发送时服务端会删除该条及其后的全部历史(含工具回执/摘要),前端同步丢弃同范围的 DOM。
  // 已压缩存档的消息(type='archived')不给编辑入口：删掉摘要后它前面的行仍不发模型,上下文会断。
  function clearEditState() {
    state.editingMsgId = 0;
    const bar = $('edit-bar');
    if (bar) bar.classList.add('hidden');
  }
  function setEditState(msgId) {
    state.editingMsgId = msgId;
    const bar = $('edit-bar');
    if (bar) bar.classList.remove('hidden');
  }
  // 乐观撤场：删掉该条及之后的所有节点(旧工具卡/打字点/流式气泡都在后面),
  // 并把增量渲染游标回退到编辑点之前，免得后续软补拉把已丢的行当成还在。
  function dropDomFromMessage(msgId) {
    const box = $('chat-view');
    const btn = box && box.querySelector('[data-msg-id="' + msgId + '"]');
    const node = btn && btn.closest('.msg');
    if (!node) return false;
    let n = node;
    while (n) { const next = n.nextElementSibling; n.remove(); n = next; }
    let max = 0;
    for (const k of Object.keys(state.renderedSigs)) {
      const id = Number(k);
      if (id >= msgId) delete state.renderedSigs[k];
      else if (id > max) max = id;
    }
    state.lastRenderedMsgId = max;
    return true;
  }
  // 编辑失败(如运行中 409)：服务端没动历史，重拉已加载量恢复被乐观撤掉的节点。
  async function restoreChatView() {
    try {
      const detail = await req('GET', '/api/sessions/' + state.sessionId + '?limit=' + Math.max(CHAT_PAGE_SIZE, state.chatLoadedCount));
      if (state.view === 'chat') renderDetail(detail);
    } catch (_) { /* 恢复失败不阻断主流程 */ }
  }
  $('chat-view').addEventListener('click', e => {
    const btn = e.target.closest('.act-edit');
    if (!btn) return;
    const msgId = Number(btn.dataset.msgId);
    if (!msgId || !state.sessionId) return;
    if (state.status === 'active') { toast('任务执行中，暂不支持编辑'); return; }
    let text = '';
    try { text = decodeURIComponent(escape(atob(btn.dataset.b64 || ''))); } catch (_) { return; }
    const ta = $('msg-input');
    ta.value = text;
    autosize();
    updateSendBtn();
    setEditState(msgId);
    ta.focus();
    try { ta.setSelectionRange(text.length, text.length); } catch (_) {}
  });
  $('edit-cancel').addEventListener('click', () => {
    clearEditState();
    const ta = $('msg-input');
    ta.value = '';
    autosize();
    updateSendBtn();
    ta.focus();
  });

  // ---------- 全屏查看器(双击气泡/工具卡放大;图片单击放大;均同步 index) ----------
  // 源码查看:当前内容有源文本时(消息/文件预览)右上角 eye 钮可点,源码面板与渲染视图互切。
  // 源文本两条来路:预览调用方直接传(文件原文);双击消息时从尾部操作行复制钮取
  // (actionsHtml 本来就随消息嵌了全文 b64,零额外存储)。
  let fsSrcText = null; // null = 本轮查看无源文本,eye 钮隐藏
  let fsSrcOn = false;
  function setFsSource(text) {
    fsSrcText = text == null || text === '' ? null : String(text);
    fsSrcOn = false;
    $('fs-src-pane').classList.add('hidden');
    $('fs-body').classList.remove('hidden');
    const btn = $('fs-src-btn');
    btn.classList.toggle('hidden', fsSrcText == null);
    btn.classList.remove('on');
    btn.title = '显示源码';
    btn.setAttribute('aria-label', '显示源码');
    // 复制钮与 eye 同显隐：有源码才可复制
    $('fs-copy-btn').classList.toggle('hidden', fsSrcText == null);
  }
  function toggleFsSrc() {
    if (fsSrcText == null) return;
    fsSrcOn = !fsSrcOn;
    if (fsSrcOn) $('fs-src-code').textContent = fsSrcText; // 点开才填,闲置期不留大 DOM
    $('fs-src-pane').classList.toggle('hidden', !fsSrcOn);
    $('fs-body').classList.toggle('hidden', fsSrcOn);
    const btn = $('fs-src-btn');
    btn.classList.toggle('on', fsSrcOn);
    const lbl = fsSrcOn ? '返回渲染视图' : '显示源码';
    btn.title = lbl;
    btn.setAttribute('aria-label', lbl);
  }
  $('fs-src-btn').addEventListener('click', toggleFsSrc);
  // 复制源码：HTML/SVG/MD/代码通用，拿到的就是 eye 面板里那份文本
  $('fs-copy-btn').addEventListener('click', async () => {
    if (fsSrcText == null) return;
    const ok = await copyText(fsSrcText);
    toast(ok ? '已复制' : '复制失败');
  });

  function openFullscreen(el, src) {
    $('fs-viewer').classList.remove('fs-bar'); // 消息全屏沿用悬浮按钮，清掉文件预览的栏模式
    const body = $('fs-body');
    body.innerHTML = '';
    body.style.zoom = '';
    // 深拷贝并去掉 id:保留原类名使气泡/工具卡样式在查看器内照常生效,且避免 id 重复
    const clone = el.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
    // 全屏查看直接展开参数/结果,方便观看
    clone.querySelectorAll('details').forEach(function (d) { d.open = true; });
    // 克隆里摘掉删除/编辑钮:二者的委托绑在 chat-view,查看器里点了无响应,不留死按钮
    clone.querySelectorAll('.act-del, .act-edit').forEach(function (n) { n.remove(); });
    // 源文本:调用方传入优先(文件预览),否则从消息自带 b64 现取(双击场景)
    let s = src;
    if (s == null) {
      const b = clone.querySelector('.act-copy[data-b64]:not([data-b64=""])');
      if (b) { try { s = decodeURIComponent(escape(atob(b.dataset.b64))); } catch (_) { s = null; } }
    }
    body.appendChild(clone);
    setFsSource(s);
    $('fs-viewer').classList.remove('hidden');
  }
  function closeFullscreen() {
    setFsSource(null); // 顺手收起源码面板/隐藏 eye 钮,下轮打开不残留
    $('fs-viewer').classList.remove('fs-bar');
    $('fs-viewer').classList.add('hidden');
    $('fs-viewer').dispatchEvent(new Event('fs:close'));
  }
  // 双击消息气泡/工具卡 → 全屏查看(操作钮/图片不误触全屏)
  // 气泡连整个 .msg 一起克隆:尾部操作行(时间/token/复制)随原文进查看器,与聊天里所见一致
  $('chat-view').addEventListener('dblclick', function (e) {
    if (e.target.closest('.act') || e.target.closest('img')) return;
    const card = e.target.closest('.tool-card');
    if (card) { openFullscreen(card); return; }
    const bubble = e.target.closest('.bubble-ai, .bubble-user');
    if (bubble) openFullscreen(bubble.closest('.msg') || bubble);
  });

  // 点击消息/工具卡里的图片 → 图片全屏查看器(#fs-viewer 里的克隆图也生效)
  // 同一气泡/工具卡内的图作为一组，查看器里可左右滑动切换
  function imgViewerDelegate(e) {
    const im = e.target.closest('.bubble-ai img, .bubble-user img, .tool-card img');
    if (!im || !im.src) return;
    const box = im.closest('.msg') || im.closest('.tool-card') || $('fs-body');
    const list = Array.prototype.map.call(box.querySelectorAll('img'), x => ({ src: x.src, alt: x.alt || '' }))
      .filter(x => x.src);
    openImageViewer(im.src, im.alt || '', list);
  }
  $('chat-view').addEventListener('click', imgViewerDelegate);
  $('fs-viewer').addEventListener('click', imgViewerDelegate);

  // 图片全屏查看器:transform 缩放+平移。双指捻合缩放(1~6x)、放大后单指/鼠标拖动、双击切 2.5x。
  // 第 3 参 list([{src,alt}] 或 [src]) 传入「同组图片」时开启左右滑动切换；第 4 参 at 指定起始下标。
  let openImageViewer, closeImageViewer;
  (function () {
    const viewer = document.getElementById('img-viewer');
    const img = document.getElementById('img-viewer-img');
    const count = document.getElementById('img-count');
    let scale = 1, tx = 0, ty = 0, mode = null;
    let sx = 0, sy = 0, stx = 0, sty = 0, pDist = 0, pScale = 1;
    // gallery=当前组；gi=组内下标；wx/wy/wdx=横滑起点与实时水平位移
    let gallery = [], gi = 0, wx = 0, wy = 0, wdx = 0;
    const tdist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    function apply() {
      img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
      img.style.cursor = scale > 1 ? 'grab' : 'zoom-in';
    }
    function drawCount() {
      if (!count) return; // 旧版 HTML 缓存里没有计数节点时不报错
      const on = gallery.length > 1;
      count.textContent = on ? (gi + 1) + ' / ' + gallery.length : '';
      count.classList.toggle('hidden', !on);
    }
    // 切到组内第 i 张：缩放/位移必须复位，否则会带着上一张的放大态看下一张
    function showAt(i) {
      if (!gallery.length) return;
      gi = Math.max(0, Math.min(gallery.length - 1, i));
      scale = 1; tx = ty = 0; mode = null;
      img.style.transition = 'none';
      apply();
      img.src = gallery[gi].src; img.alt = gallery[gi].alt || '';
      drawCount();
    }
    openImageViewer = function (src, alt, list, at) {
      const raw = Array.isArray(list) && list.length ? list : [{ src: src, alt: alt }];
      gallery = raw.map(x => (typeof x === 'string' ? { src: x, alt: '' } : x)).filter(x => x && x.src);
      // 起始下标优先用调用方给的(文件面板那张是 blob URL，与组里的直链对不上)，否则按 src 匹配
      let i = typeof at === 'number' && at >= 0 ? at : gallery.findIndex(x => x.src === src);
      if (i < 0) i = 0;
      showAt(i);
      viewer.classList.remove('hidden');
    };
    closeImageViewer = function () {
      viewer.classList.add('hidden');
      gallery = []; drawCount(); // 关窗即清组，别让任务目录的地址一直挂着
    };
    // 点背景(非图片)关闭
    viewer.addEventListener('click', function (e) { if (e.target === viewer) closeImageViewer(); });
    img.addEventListener('dblclick', function () {
      scale = scale > 1 ? 1 : 2.5;
      if (scale === 1) { tx = ty = 0; }
      apply();
    });
    img.addEventListener('touchstart', function (e) {
      img.style.transition = 'none'; // 跟手拖动：清掉上一次回弹的过渡
      if (e.touches.length === 2) { mode = 'pinch'; pDist = tdist(e.touches) || 1; pScale = scale; }
      else if (e.touches.length === 1 && scale > 1) { mode = 'pan'; sx = e.touches[0].clientX; sy = e.touches[0].clientY; stx = tx; sty = ty; }
      else if (e.touches.length === 1 && gallery.length > 1) { mode = 'swipe'; wx = e.touches[0].clientX; wy = e.touches[0].clientY; wdx = 0; }
      else mode = null;
    }, { passive: true });
    img.addEventListener('touchmove', function (e) {
      if (mode === 'pinch' && e.touches.length >= 2) {
        e.preventDefault();
        scale = Math.min(6, Math.max(1, pScale * tdist(e.touches) / pDist));
        if (scale === 1) { tx = ty = 0; }
        apply();
      } else if (mode === 'pan' && e.touches.length === 1) {
        e.preventDefault();
        tx = stx + e.touches[0].clientX - sx;
        ty = sty + e.touches[0].clientY - sy;
        apply();
      } else if (mode === 'swipe' && e.touches.length === 1) {
        const dx = e.touches[0].clientX - wx, dy = e.touches[0].clientY - wy;
        // 只接管水平方向；竖直位移更大时不动图，留给以后的「下滑关闭」
        if (Math.abs(dx) > Math.abs(dy)) { wdx = dx; tx = dx * 0.5; apply(); }
      }
    }, { passive: false });
    img.addEventListener('touchend', function (e) {
      if (mode === 'swipe') {
        if (Math.abs(wdx) > 45) showAt(gi + (wdx < 0 ? 1 : -1)); // 左滑看下一张
        else { img.style.transition = 'transform .16s ease-out'; tx = 0; apply(); } // 不够格：弹回原位
        mode = null;
        return;
      }
      if (e.touches.length < 2) { if (mode === 'pinch') mode = null; }
      if (!e.touches.length) mode = null;
    }, { passive: true });
    img.addEventListener('touchcancel', function () { mode = null; }, { passive: true });
    // 桌面没有滑动：组内多图时用 ←/→ 切换（单图不响应）
    document.addEventListener('keydown', function (e) {
      if (viewer.classList.contains('hidden') || gallery.length < 2) return;
      if (e.key === 'ArrowLeft') showAt(gi - 1);
      else if (e.key === 'ArrowRight') showAt(gi + 1);
    });
    // 桌面:放大后按住拖动平移
    img.addEventListener('mousedown', function (e) {
      if (scale <= 1) return;
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY, tx0 = tx, ty0 = ty;
      const mv = function (ev) { tx = tx0 + ev.clientX - x0; ty = ty0 + ev.clientY - y0; apply(); };
      const up = function () { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    });
  })();

  // 消息全屏查看器双指缩放:viewport 是 user-scalable=no(原生捏合被禁),
  // 在查看器内接管双指手势,用 CSS zoom 缩放内容(1~4 倍,关闭时重置)。
  (function () {
    const viewer = document.getElementById('fs-viewer');
    if (!viewer) return;
    let startDist = 0, startZoom = 1, pinching = false;
    const tdist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    viewer.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 2) { pinching = false; return; }
      pinching = true;
      startDist = tdist(e.touches) || 1;
      startZoom = Number($('fs-body').style.zoom) || 1;
    }, { passive: true });
    viewer.addEventListener('touchmove', function (e) {
      if (!pinching || e.touches.length < 2) return;
      e.preventDefault(); // 双指期间阻止滚动,手势归缩放
      $('fs-body').style.zoom = Math.min(4, Math.max(1, startZoom * tdist(e.touches) / startDist)) || '';
    }, { passive: false });
    viewer.addEventListener('touchend', function (e) { if (e.touches.length < 2) pinching = false; }, { passive: true });
    viewer.addEventListener('touchcancel', function () { pinching = false; }, { passive: true });
  })();

