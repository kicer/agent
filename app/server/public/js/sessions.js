// 会话列表(抽屉)/ 打开新建重命名 / SSE 看门狗与挂起 / 状态栏 / 定时任务 / 上下文压缩(拆自 index.html 内联脚本,纯搬运不改逻辑)
'use strict';
  // ---------- 会话列表(抽屉) ----------
  function groupLabel(ts) {
    const d = new Date(ts), n = new Date();
    const sod = t => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    const diff = (sod(n) - sod(d)) / 86400000;
    if (diff <= 0) return '今天';
    if (diff === 1) return '昨天';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
  }

  // 抽屉行状态指示:仅进行中的会话(排队/活跃/保持)展示彩色圆点,已完成/已终止不显示
  const DRAWER_STATUS_TEXT = { queued: '排队中', active: '活跃中', held: '保持中' };
  function drawerStatusDot(s) {
    const st = s && s.status;
    const label = DRAWER_STATUS_TEXT[st];
    if (!label) return '';
    return '<span class="st-dot ' + esc(st) + '" aria-label="' + label + '"></span>';
  }

  function renderDrawerList() {
    const list = state.sessions.slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    const box = $('drawer-list');
    if (!list.length) { box.innerHTML = '<div class="drawer-empty">没有找到相关对话</div>'; return; }
    let html = '', lastGroup = null;
    for (const s of list) {
      const g = groupLabel(s.updated_at);
      if (g !== lastGroup) { html += '<div class="group-label">' + esc(g) + '</div>'; lastGroup = g; }
      html += '<div class="conv-wrap">' +
        '<button class="conv-item' + (s.id === state.sessionId ? ' active' : '') + '" data-id="' + esc(s.id) + '">' +
          '<span class="conv-title">' + esc(s.title || s.id) + '</span>' + drawerStatusDot(s) +
        '</button>' +
        '<button class="conv-del" data-del="' + esc(s.id) + '" title="删除会话" aria-label="删除会话">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        '</button>' +
      '</div>';
    }
    box.innerHTML = html;
  }

  async function loadSessionList() {
    const q = $('search-input').value.trim();
    try {
      let list;
      if (q) {
        const r = await req('GET', '/api/sessions?q=' + encodeURIComponent(q) + '&limit=50&with_total=1');
        list = r.rows || [];
      } else {
        const [active, done] = await Promise.all([
          req('GET', '/api/sessions?status=active&limit=100'),
          req('GET', '/api/sessions?status=done&limit=50&with_total=1'),
        ]);
        list = (active || []).concat((done && done.rows) || []);
      }
      state.sessions = list;
      renderDrawerList();
    } catch (e) { toast('加载会话失败:' + e.message); }
  }

  // ---------- 会话打开 / 新建 / 状态栏(抽屉行 × 调 deleteSession; 默认含任务目录) ----------
  async function deleteSession(id) {
    if (!id) return;
    // 从已加载列表查出会话标题,让 modal 能显示「标题 + ID」方便核对
    const s = (state.sessions || []).find(x => x.id === id);
    const title = s ? (s.title || s.id) : id;
    const body = '确定删除会话 <b>「' + esc(title) + '」</b> 吗？删除后无法恢复。' +
      '<div class="confirm-sub">会话 ID：' + esc(id) + '</div>';
    if (!await confirmModal('删除会话', body, '删除', true,
        { checkbox: { label: '同时删除任务文件夹', default: true }, bodyHtml: true })) return;
    const delDir = state._confirmChecked ? 'true' : 'false';
    try {
      await req('DELETE', '/api/sessions/' + id + '?delete_dir=' + delDir);
      // 删的是当前打开的会话:回 welcome 视图并清状态
      if (state.sessionId === id) {
        closeStream();
        removeTyping();
        state.sessionId = null;
        state.sessionTitle = '';
        state.sessionType = 'secretary';
        state.streamEl = null;
        state.streamText = '';
        state.toolCards = {};
        state.toolCallStreaming = {}; // 流式参数早卡映射随会话/回合重置
        state.streaming = false;
        setView('welcome'); // 复用 newChat 同样的视图切换路径
      }
      toast('已删除会话');
      loadSessionList();
    } catch (e) { toast('删除失败:' + e.message); }
  }
  function closeStream() {
    if (state.es) { state.es.close(); state.es = null; }
    // SSE 一断，本地「等待压缩收尾」状态就成孤儿（再也收不到带 is_summary 的最终消息）：
    // 复位以免压缩按钮永久 disabled / 防重入卡死。切会话、重开流都会经过这里。
    // （后果仅是：离开期间的摘要不会自动淡出存档，重进会话后由 renderDetail 按库内标记渲染，历史保持完整。）
    state.pendingSummary = false;
  }

  // ---------- SSE 静默看门狗 ----------
  // 流断档期的 assistant_message/tool_* 等事件不会重放（sse.js 无客户端即丢弃），页面会停在“无回应”假死；
  // 而 EventSource 本身多半已自动重连——真正缺的是重新拉一次库。服务端每 15s 发可见心跳（event: ping），
  // 静默超 45s 即判死，自动做一次“切走再切回”式重同步（resyncSession）；重连失败则 45s 后再试，不刷屏。
  let sseResyncing = false;
  function resyncSession() {
    const id = state.sessionId;
    if (!id || state.view !== 'chat' || sseResyncing) return;
    sseResyncing = true;
    state.lastSseAt = Date.now(); // 计时从现在开始，失败也等下个周期再试
    closeStream();
    req('GET', '/api/sessions/' + id + '?limit=' + CHAT_INIT_PAGE_SIZE).then(detail => {
      if (state.sessionId === id && state.view === 'chat') renderDetail(detail);
    }).catch(() => {}).then(() => {
      sseResyncing = false;
      if (state.sessionId === id && state.view === 'chat' && !state.es) connectStream();
    });
  }
  setInterval(() => {
    if (document.hidden) return; // 后台不跑看门狗，免得被系统部分唤醒时空转重渲染耗能耗
    if (state.sessionId && state.view === 'chat' && state.es && Date.now() - state.lastSseAt > 45000) resyncSession();
  }, 5000);

  // ---------- 后台超时挂起 SSE ----------
  // 长时间在后台就断开 EventSource（否则长连接会阻止 Safari/App Nap 冻结整页，整晚小功耗累积成“大量能耗”被强制重载）；
  // 回到前台再 resyncSession() 一次性补拉数据 + 重连。
  const SSE_SUSPEND_HIDDEN_MS = 2 * 60 * 1000;
  let sseSuspended = false;
  let sseSuspendTimer = 0;
  function suspendStream() {
    if (sseSuspended || !document.hidden) return;
    if (state.es) closeStream();
    sseSuspended = true;
  }
  function resumeStream() {
    if (!sseSuspended) return;
    sseSuspended = false;
    resyncSession();
  }
  // 后台标签页里 interval 被限频；切回前台立刻补一次判定，自动覆盖“休眠/切走醒来后页面停在半截”场景
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(sseSuspendTimer);
      sseSuspendTimer = setTimeout(suspendStream, SSE_SUSPEND_HIDDEN_MS);
      return;
    }
    clearTimeout(sseSuspendTimer);
    resumeStream();
    if (state.sessionId && state.view === 'chat' && state.es
        && Date.now() - state.lastSseAt > 45000) resyncSession();
  });

  async function openSession(id) {
      closeStream();
      removeTyping();
      setFilesPanel(false); // 会话切换,收起文件面板防旧列表残留
      state.sessionId = id;
      state.status = '';
      state.schedule = null; // 防详情返回前残留上一会话的任务状态条
      // 先从抽屉列表缓存取会话类型，让顶部 icon 立即正确；详情回来后由 renderDetail 纠正
      const cached = (state.sessions || []).find(x => x.id === id);
      state.sessionType = (cached && cached.assistant_type) || 'secretary';
      state.streamEl = null;
      state.streamText = '';
      state.streamWrap = null;
      state.lastAssistantMsgId = null;
    state.toolCards = {};
    state.toolCallStreaming = {}; // 流式参数早卡映射随会话/回合重置
    state.streaming = false;
    state.attachments = [];
    userPaused = false;
    state.chatHasMore = false; // 分页状态先复位：防详情返回前用旧会话的游标/标志拉到错会话的消息
    state.chatOldestId = null;
    state.chatLoadedCount = 0;
    renderAttachChips();
    clearUploadCards(); // 切会话清掉旧会话的上传卡片
    renderDrawerList(); // 会话切换后立刻重画抽屉高亮,避免下次打开才看到更新
    setView('chat');
    $('chat-view').innerHTML = '<div class="drawer-empty">加载中…</div>';
    try {
      const detail = await req('GET', '/api/sessions/' + id + '?limit=' + CHAT_INIT_PAGE_SIZE);
      if (state.sessionId !== id) return; // 期间已切到别的会话
      renderDetail(detail);
      connectStream();
    } catch (e) {
      if (state.sessionId === id) toast('打开会话失败:' + e.message);
    }
  }

  // 确保存在当前会话:首条消息自动建档(POST /api/sessions)；助手类型此时锁定，后续不可变更
  async function ensureSession() {
    if (state.sessionId) return state.sessionId;
    const s = await req('POST', '/api/sessions', { title: '', model_id: '', assistant_type: state.mode });
    state.sessionId = s.id;
    state.sessionTitle = (s && s.title) || '';
    state.sessionType = (s && s.assistant_type) || state.mode;
    setView('chat');
    renderHeader();
    updatePhaseBar();
    connectStream();
    return s.id;
  }

  function newChat() {
    closeStream();
    removeTyping();
    setFilesPanel(false); // 新建会话,文件面板随之收起
    state.sessionId = null;
    state.sessionTitle = '';
    state.sessionType = 'secretary';
    state.status = '';
    state.schedule = null;
    state.attachments = [];
    state.streamEl = null;
    state.streamText = '';
    state.toolCards = {};
    state.toolCallStreaming = {}; // 流式参数早卡映射随会话/回合重置
    state.streaming = false;
    userPaused = false;
    renderAttachChips();
    clearUploadCards();
    setView('welcome');
    $('chat-view').innerHTML = '';
    $('msg-input').value = '';
    autosize();
    updateScrollBottomBtn();
  }

  // ---------- 会话重命名(点击 header 标题触发;PATCH 接口,同步 index 交互) ----------
  async function renameSession() {
    if (!state.sessionId) return;
    const cur = state.sessionTitle || state.sessionId;
    // 标题与 id 相同时(未命名)输入框留空
    const t = await promptModal('重命名会话', '输入新的会话名称', cur === state.sessionId ? '' : cur);
    if (t === null) return; // 取消
    const title = String(t).trim();
    try {
      await req('PATCH', '/api/sessions/' + state.sessionId, { title: title });
      toast('已重命名');
      state.sessionTitle = title;
      renderHeader();
      loadSessionList();
    } catch (e) { toast('重命名失败:' + e.message); }
  }

  // ---------- 会话状态栏(搬自 index 的 phase-bar 功能) ----------
  function updatePhaseBar(d) {
    const bar = $('phase-bar');
    if (!bar) return;
    // 定时任务状态条与会话状态栏同刷新入口（其内部自判视图/有无任务，早退路径也要走到）
    updateScheduleBar();
    if (!(state.view === 'chat' && state.sessionId)) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const pill = $('status-pill');
    const stMap = { queued: '排队中', active: '活跃中', held: '保持中', completed: '已完成', cancelled: '已终止' };
    let text = stMap[state.status] || state.status || '--';
    if (d && d.queue_pos) text += '(第 ' + d.queue_pos + ' 位)';
    // active/held 时附带当前占用的模型
    if ((state.status === 'active' || state.status === 'held') && d && d.model_id) {
      text += ' · ' + d.model_id;
    }
    pill.textContent = text;
    // 状态胶囊配色:活跃中绿(执行中)、保持中黄(已答完、保持模型中)等;状态栏整体同步染色
    pill.className = 'status-pill ' + (state.status || '');
    bar.className = 'phase-bar ' + (state.status || '');
    // 活跃中提供「终止」;保持中改为「断开」(主动放弃保持租约,会话结为已完成)
    const btn = $('stop-btn');
    const actionable = state.status === 'active' || state.status === 'held';
    btn.classList.toggle('hidden', !actionable);
    btn.textContent = state.status === 'held' ? '断开' : '终止';
    btn.classList.toggle('muted', state.status === 'held');
    // 已完成/已终止时提供「选择模型」,手动指定空闲模型后继续对话
        const msBtn = $('model-switch-btn');
        if (msBtn) msBtn.classList.toggle('hidden', !(state.sessionId && (state.status === 'completed' || state.status === 'cancelled')));
        // 状态栏「压缩」按钮：active 时不允许（避免与正在跑的回合抢上下文）;
        // 其余状态可点。未发起总结时可点；发起后按钮 disabled 防双击。
        const cpBtn = $('compress-btn');
        if (cpBtn) {
          const allowShow = !!(state.sessionId && state.status && state.status !== 'active');
          cpBtn.classList.toggle('hidden', !allowShow);
          // 只有不在请求中时才允许 active 决定 disabled；避免总结流程中被打断时再次被 allowed
          if (!state.pendingSummary) cpBtn.disabled = state.status === 'active';
        }
      }

  // ---------- 定时任务状态条（整条可点→详情弹窗；创建只走 AI 工具，频次/提示词可在弹窗内改） ----------
  const CRON_DOW = ['日', '一', '二', '三', '四', '五', '六'];
  // cron 人类可读化：只覆盖常见形态（每天/每周几几点、每 N 小时），其余原样显示表达式
  function cronText(expr) {
    const p = String(expr || '').trim().split(/\s+/);
    if (p.length !== 5) return String(expr || '');
    const min = p[0], hour = p[1], dom = p[2], mon = p[3], dow = p[4];
    const hm = /^\d+$/.test(min) && /^\d+$/.test(hour)
      ? hour.padStart(2, '0') + ':' + min.padStart(2, '0') : '';
    if (dom === '*' && mon === '*') {
      const everyH = hour.match(/^\*\/(\d+)$/);
      if (dow === '*' && min === '0' && everyH) return '每 ' + everyH[1] + ' 小时';
      if (dow === '*' && hm) return '每天 ' + hm;
      if (/^\d$/.test(dow) && hm) return '每周' + CRON_DOW[+dow] + ' ' + hm;
    }
    return String(expr);
  }
  function updateScheduleBar() {
    const bar = $('schedule-bar');
    if (!bar) return;
    const sc = state.schedule;
    if (!(state.view === 'chat' && state.sessionId && sc)) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    let last;
    // running 不精确（AI 跑完到下次 tick 间仍显示），对 UI 够用；无专用轮询，重进会话时刷新
    if (sc.last_status === 'running') last = '执行中…';
    else if (sc.last_status === 'ok') last = '上次 ok';
    else if (sc.last_status === 'error') last = '上次 error' + (sc.last_note ? ': ' + sc.last_note : '');
    else if (sc.last_status === 'skipped') last = '上次 跳过' + (sc.last_note ? '：' + sc.last_note : '');
    else last = '下次 ' + fmtTime(sc.next_run_at);
    bar.innerHTML = '<span class="sched-text">' + esc(cronText(sc.cron_expr)) + ' · ' + esc(last) + '</span>'
      + '<span class="sched-eye"><svg class="ic" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></span>';
    bar.classList.remove('hidden');
  }
  // 频次控件显隐：每天=[时分] 每周=[天][时分] 每隔=[N][小时] 自定义=[cron 文本框]
  function schedFreqUi() {
    const f = $('sched-freq').value;
    const hm = f === 'daily' || f === 'weekly';
    $('sched-dow').classList.toggle('hidden', f !== 'weekly');
    $('sched-hh').classList.toggle('hidden', !hm);
    $('sched-colon').classList.toggle('hidden', !hm);
    $('sched-mm').classList.toggle('hidden', !hm);
    $('sched-nh').classList.toggle('hidden', f !== 'everyN');
    $('sched-nh-unit').classList.toggle('hidden', f !== 'everyN');
    $('sched-cron').classList.toggle('hidden', f !== 'custom');
  }
  // 既有 cron → 控件：只认每天/每周几/每 N 小时三形态（与 cronText 覆盖一致），其余落入自定义
  function schedFillFromCron(expr) {
    const f = $('sched-freq');
    const p = String(expr || '').trim().split(/\s+/);
    f.value = 'custom';
    if (p.length === 5 && p[2] === '*' && p[3] === '*' && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1])) {
      if (p[4] === '*') f.value = 'daily';
      else if (/^[0-6]$/.test(p[4])) { f.value = 'weekly'; $('sched-dow').value = p[4]; }
      if (f.value !== 'custom') { $('sched-hh').value = +p[1]; $('sched-mm').value = +p[0]; }
    } else if (p.length === 5 && p[0] === '0' && /^\*\/\d+$/.test(p[1]) && p[2] === '*' && p[3] === '*' && p[4] === '*') {
      f.value = 'everyN';
      $('sched-nh').value = p[1].slice(2);
    }
    if (f.value === 'custom') $('sched-cron').value = String(expr || '');
    schedFreqUi();
  }
  // 控件 → cron 表达式；非法输入抛中文 Error（后端 validateCron 再兜底：可解析 + 间隔 ≥1h）
  function schedComposeCron() {
    const f = $('sched-freq').value;
    if (f === 'custom') {
      const c = $('sched-cron').value.trim();
      if (!c) throw new Error('请输入 cron 表达式');
      return c;
    }
    if (f === 'everyN') {
      const n = parseInt($('sched-nh').value, 10);
      if (!(n >= 1 && n <= 23)) throw new Error('间隔需为 1-23 的整小时数');
      return '0 */' + n + ' * * *';
    }
    const hh = parseInt($('sched-hh').value, 10);
    const mm = parseInt($('sched-mm').value, 10);
    if (!(hh >= 0 && hh <= 23)) throw new Error('小时需为 0-23');
    if (!(mm >= 0 && mm <= 59)) throw new Error('分钟需为 0-59');
    return mm + ' ' + hh + ' * * ' + (f === 'weekly' ? $('sched-dow').value : '*');
  }
  function openScheduleModal() {
    const sc = state.schedule;
    if (!sc || state.view !== 'chat') return;
    schedFillFromCron(sc.cron_expr);
    let meta = sc.next_run_at ? '下次执行 ' + fmtTime(sc.next_run_at) : '';
    if (sc.last_run_at) meta += (meta ? '\n' : '') + '上次执行 ' + fmtTime(sc.last_run_at) + (sc.last_status ? ' · ' + sc.last_status : '');
    $('sched-modal-meta').textContent = meta;
    $('sched-modal-prompt').value = sc.prompt || '';
    $('schedule-modal').classList.remove('hidden');
  }
  function closeScheduleModal() { $('schedule-modal').classList.add('hidden'); }
  async function saveSchedule() {
    const id = state.sessionId;
    if (!id || !state.schedule) return;
    const prompt = $('sched-modal-prompt').value.trim();
    if (!prompt) { toast('提示词不能为空'); return; }
    let cron;
    try { cron = schedComposeCron(); } catch (e) { toast(e.message); return; }
    try {
      await req('PATCH', '/api/sessions/' + id + '/schedule', { prompt: prompt, cron_expr: cron });
      toast('定时任务已更新');
      closeScheduleModal();
      // 频次变了 next_run_at 由后端重算，重拉详情同步状态条（与删除后同一套刷新路径）
      const detail = await req('GET', '/api/sessions/' + id + '?limit=' + Math.max(CHAT_PAGE_SIZE, state.chatLoadedCount));
      if (state.sessionId === id) { renderDetail(detail); connectStream(); }
    } catch (e) { toast('更新失败:' + e.message); }
  }
  async function deleteSchedule() {
    if (!state.sessionId) return;
    const id = state.sessionId;
    if (!await confirmModal('删除定时任务', '删除后本会话不再定时执行。', '删除', true)) return;
    try {
      await req('DELETE', '/api/sessions/' + id + '/schedule');
      toast('定时任务已删除');
      closeScheduleModal();
      // 重载详情：状态条消失，会话内多出一条 scheduler_note 通知（AI 未被触发）
      const detail = await req('GET', '/api/sessions/' + id + '?limit=' + Math.max(CHAT_PAGE_SIZE, state.chatLoadedCount));
      if (state.sessionId === id) { renderDetail(detail); connectStream(); }
    } catch (e) { toast('删除失败:' + e.message); }
  }
  async function stopSession() {
    if (!state.sessionId) return;
    const held = state.status === 'held';
    try {
      if (held) {
        await req('POST', '/api/sessions/' + state.sessionId + '/release');
        toast('已断开,模型已释放');
      } else {
        await req('POST', '/api/sessions/' + state.sessionId + '/stop');
        toast('已发送终止指令');
      }
    } catch (e) { toast((held ? '断开失败:' : '终止失败:') + e.message); }
  }
  async function openModelSwitch() {
    if (!state.sessionId) return;
    const list = $('bind-model-list');
    const footer = $('bind-model-footer');
    list.innerHTML = '<div class="empty-tip">加载中…</div>';
    footer.textContent = '';
    $('bind-model-modal').classList.remove('hidden');
    try {
      // /api/models 已按平台补齐 platform/mid/vision/key_count（见 server.js）；行本身按模型 id 唯一。
      // 已删除但重启前仍在运行池里的模型不再展示,避免误绑到重启后就消失的模型
      const rows = ((await req('GET', '/api/models')) || []).filter(m => !SET.deletedModels[m.id]);
      if (!rows.length) {
        list.innerHTML = '<div class="empty-tip">还没有配置模型。</div>';
        return;
      }
      // 平台颜色盘(循环使用)
      const DOT_COLORS = ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#06B6D4','#F97316'];
      // 按平台分组;/api/models 已按模型聚合槽位:slots_total/slots_busy = 该模型的 key 总数/被占数,
      // is_busy 仅在全部 key 被占时为真(同模型还剩空闲 key 就仍可再选)。
      const platMap = new Map();
      for (const m of rows) {
        const pk = m.platform || '';
        if (!platMap.has(pk)) {
          platMap.set(pk, { name: pk || '未知平台', keyCount: m.key_count || 0, models: [] });
        }
        platMap.get(pk).models.push(m);
      }
      const groups = [...platMap.values()];
      // 可选 = 模型还有空闲 key 槽位;统计可用数供底部提示
      let avail = 0;
      for (const g of groups) for (const m of g.models) if (!m.is_busy) avail++;
      list.innerHTML = groups.map((g, gi) => {
        const dotColor = DOT_COLORS[gi % DOT_COLORS.length];
        const itemHtml = g.models.map(m => {
          const total = m.slots_total || g.keyCount || 1;
          const free = total - (m.slots_busy || 0);
          const disabled = !!m.is_busy;
          const title = m.is_busy ? ' 占用中' : ((m.slots_busy || 0) > 0 ? ' ' + free + '/' + total + ' key 空闲' : '');
          return '<div class="msw-item' + (disabled ? ' disabled' : '') + '"' +
            (disabled ? '' : ' onclick="bindModel(\'' + esc(m.id) + '\')"') + '>' +
            '<div class="msw-radio"></div>' +
            '<div class="msw-info">' +
              '<div class="msw-name">' + esc(m.display_name || m.mid || m.id) +
                (title ? ' <span class="msw-busy">' + title.trim() + '</span>' : '') + '</div>' +
              '<div class="msw-tags">' +
                (m.vision ? '<span class="msw-tag vision">Vision</span>' : '') +
                '<span class="msw-tag thinking">Thinking</span>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');
        return '<div class="msw-group">' +
          '<div class="msw-group-header">' +
            '<span class="msw-dot" style="background:' + dotColor + '"></span>' +
            '<span>' + esc(g.name) + '</span>' +
            '<span class="msw-group-keys">' + g.keyCount + ' key' + (g.keyCount > 1 ? 's' : '') + '</span>' +
          '</div>' +
          itemHtml +
        '</div>';
      }).join('');
      footer.textContent = '共 ' + avail + ' 个模型可用';
    } catch (e) {
      list.innerHTML = '<div class="empty-tip">读取模型列表失败:' + e.message + '</div>';
    }
  }
  function closeModelSwitch() { $('bind-model-modal').classList.add('hidden'); }
  async function bindModel(modelId) {
    if (!state.sessionId) return;
    const id = state.sessionId;
    closeModelSwitch();
    try {
      await req('POST', '/api/sessions/' + id + '/bind', { model_id: modelId });
      toast('已绑定模型 ' + modelId);
    } catch (e) { toast('绑定失败:' + e.message); }
    // 无论成败都刷新会话详情(失败多为并发占用,状态可能已变);按已加载量分页重渲染，避免长会话退回全量重建
    try {
      const detail = await req('GET', '/api/sessions/' + id + '?limit=' + Math.max(CHAT_PAGE_SIZE, state.chatLoadedCount));
      if (state.sessionId === id) { renderDetail(detail); connectStream(); }
      loadSessionList();
    } catch (_) {}
  }
  // ---------- 「压缩」上下文总结 ----------
    // 用户点 phase-bar「压缩」按钮 → 弹窗选动作（右上角 X 关闭 = 不做任何事）：
    //   摘要（generate_only）：AI 总结落库后，后端把摘要标 type='summary'、之前的消息标 type='archived'
    //     （UI 保留全部展示，但旧消息不再发给模型）；前端把摘要前旧消息就地淡出存档。
    //   清空：直接走 clearChat()（DELETE 全部聊天记录，从零开始，不可恢复）。
    // 开始压缩后：后端响应回显 prompt，前端把它渲染成一条普通用户消息气泡（仅展示：
    // 指令不再入库、也不发给模型，压缩回合的 system prompt 已整体替换为压缩提示词）；
    // 压缩回合中间的 AI 回复（思考/工具调用等）全部按普通消息渲染；
    // 只有回合收尾的那条最终答复才带 is_summary，渲染成摘要卡片。
    // 后端 summarize 路由无需 body；runLoopInner 在最终 assistant_message SSE 上带 is_summary。
    async function summarizeChat() {
      if (!state.sessionId) return;
      if (state.pendingSummary) return; // 已在请求中，防重入
      if (state.status === 'active') { toast('AI 还在输出，请稍候再压缩'); return; }
      // 弹窗两个动作：摘要（generate_only）/ 清空（clear → clearChat）；右上 X / 点遮罩 / Esc 关闭。
      const choice = await compressModeModal();
      if (!choice) return;
      if (choice === 'clear') { await clearChat(); return; }
      await startSummary();
    }

    // 发起摘要压缩回合（手动「压缩→摘要」与自动压缩弹窗确认后共用）：
    // POST /summarize → 回显指令气泡 + 打字占位；收尾由带 is_summary 的最终答复/done 事件走既有链路。
    async function startSummary() {
      if (!state.sessionId || state.pendingSummary) return;
      state.pendingSummary = true;
      const btn = $('compress-btn');
      if (btn) btn.disabled = true;
      try {
        const r = await req('POST', '/api/sessions/' + state.sessionId + '/summarize');
        // 开始压缩后直接把「压缩指令」当成普通用户消息发出来（后端回显 prompt）；
        // 后续中间的 AI 回复全部按普通消息渲染，直到带 is_summary 的最终答复才转摘要卡片。
        if (r && r.prompt) appendUserMsg(r.prompt);
        if (r && r.delivered === 'live') addTyping(); // 已直接送达：先挂打字占位，首个 delta 到达时自动移除
        toast('已生成摘要中…');
      } catch (e) {
        state.pendingSummary = false;
        if (btn) btn.disabled = false;
        toast('压缩失败：' + e.message);
      }
    }

    // 自动压缩提议（后端回合结束+宽限期后发 auto_compress 事件，不再自启）：弹 modal 由用户手动确认。
    // 取消/忽略 = 本会话不再提议（服务端闸门，想压可手动点「压缩」）；防重入：确认期间不叠加弹窗。
    async function proposeAutoCompress(d) {
      const sid = state.sessionId;
      if (!sid || state.view !== 'chat' || state.status !== 'held') return; // 会话已有新动静，提议过期
      if (_autoCompressPrompting) return;
      _autoCompressPrompting = true;
      let ok = false;
      try {
        ok = await confirmModal('自动压缩上下文',
          '本轮输入 ' + fmtTok(d.prompt_tokens) + ' tokens，已达阈值 ' + fmtTok(d.threshold) +
          '。AI 将生成结构化摘要，摘要之前的旧消息会存档（聊天里仍保留展示）不再发给 AI，后续对话从摘要开始。现在压缩？',
          '立即压缩');
      } finally {
        _autoCompressPrompting = false;
      }
      if (!ok) { toast('已跳过，本会话不再自动提议压缩'); return; }
      if (state.sessionId !== sid) return; // 确认期间切了会话，作废
      if (state.status === 'active') { toast('AI 正在输出，本次提议作废，可稍后手动压缩'); return; }
      await startSummary();
    }

    // 自动压缩确认弹窗防重入标记（见 proposeAutoCompress）
    let _autoCompressPrompting = false;

    // 压缩动作选择弹窗：右上 X 关闭 + 两个动作（摘要 / 清空）。
      // 返回 'generate_only' | 'clear' | null（关闭取消）。
      // 这里手写一个独立小弹窗以避免与 confirmModal(两按钮)耦合；复用现有 modal-overlay / modal-close-btn 样式。
      // 颜色复用现有按钮语义：摘要 = primary-btn（蓝/确定风）；清空 = ghost-btn.danger（红/删除风）。
      function compressModeModal() {
        return new Promise(resolve => {
          const wrap = document.createElement('div');
          wrap.className = 'modal-overlay';
          wrap.innerHTML =
            '<div class="modal">' +
              '<button class="modal-close-btn" data-act="cancel" aria-label="关闭">' +
                '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
              '</button>' +
              '<h3 id="compress-modal-title">压缩上下文</h3>' +
              '<div class="modal-body" style="font-size:14px;line-height:1.55;color:#555;padding:4px 0 12px;">' +
                'AI 将基于当前上下文生成结构化总结；完成后摘要之前的旧消息都会<b>存档</b>，不再发送给 AI，后续对话从摘要开始。' +
                '<br>· 「摘要」= 聊天里<b>保留全部历史展示</b>（旧消息变淡标注已存档），并多一张摘要卡片。' +
                '<br>· 「清空」= 直接<b>删除本会话全部聊天记录</b>，从零开始（不可恢复，任务文件保留）。' +
              '</div>' +
              '<div class="btn-row">' +
                '<button class="ghost-btn danger" data-act="clear">清空</button>' +
                '<button class="primary-btn" data-act="generate_only">摘要</button>' +
              '</div>' +
            '</div>';
          function close(v) {
            wrap.remove();
            document.removeEventListener('keydown', onKey);
            resolve(v);
          }
          function onKey(e) { if (e.key === 'Escape') close(null); }
          wrap.addEventListener('click', e => { if (e.target === wrap) close(null); });
          wrap.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => close(b.dataset.act === 'cancel' ? null : b.dataset.act)));
          document.addEventListener('keydown', onKey);
          document.body.appendChild(wrap);
          // 默认聚焦关闭按钮，避免误触发两个动作
          wrap.querySelector('.modal-close-btn').focus();
        });
      }

    // 「摘要」实时收尾：后端已把摘要之前的消息行标成 type='archived'，这里把 DOM 里
      // 摘要卡片（.msg-summary-live，多轮压缩取最后一张）之前的所有兄弟节点收进淡色存档容器，
      // 尾部附一条「已存档」说明，与 renderDetail 重渲染样式一致。
      function archiveDomBeforeSummary() {
        const box = $('chat-view');
        const cards = box.querySelectorAll('.msg-summary-live');
        const card = cards.length ? cards[cards.length - 1] : null;
        if (!card) return;
        const arc = document.createElement('div');
        arc.className = 'msg-archived';
        let el = box.firstChild;
        while (el && el !== card) { const next = el.nextSibling; arc.appendChild(el); el = next; }
        if (!arc.childNodes.length) return; // 首次就压缩：摘要前没有旧消息，不插空说明
        arc.insertAdjacentHTML('beforeend',
          '<div class="archived-note">以上消息已存档，不再发送给 AI；后续对话从摘要开始</div>');
        box.insertBefore(arc, card);
      }

    // 「清空」：删除本会话全部聊天记录（AI 后续对话不再携带这段历史），任务文件不受影响。
      // 入口：压缩动作弹窗的「清空」按钮。
      async function clearChat() {
        if (!state.sessionId) return;
        const id = state.sessionId;
        const ok = await confirmModal('清空会话内容',
          '将删除本会话的全部聊天记录，AI 后续对话不再携带这段历史（从零开始，更省 token）。任务文件全部保留，不受影响。此操作不可恢复。',
          '清空', true);
        if (!ok) return;
        try {
          await req('DELETE', '/api/sessions/' + id + '/messages');
          toast('会话内容已清空，文件已保留');
          // 服务端已将会话收尾为 completed 并清空消息：重新拉取详情即为干净起点
          const detail = await req('GET', '/api/sessions/' + id);
          if (state.sessionId === id) { renderDetail(detail); connectStream(); }
          loadSessionList();
        } catch (e) { toast('清空失败：' + e.message); }
        const cpBtn = $('compress-btn');
        if (cpBtn) cpBtn.disabled = state.status === 'active';
      }

