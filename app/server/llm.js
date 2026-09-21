// 上游调用：OpenAI 兼容 /chat/completions 流式接口（由 cli-proxy-api 代理）。
// 累积 content 与 tool_calls 分片；支持 abort。
const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'templates', 'system-prompt.txt'), 'utf8');

// 上下文压缩提示词（templates/compress-prompt.txt）：点「压缩」时不插入指令消息。
// 压缩回合（见 compressMessages）沿用默认 system prompt + 正常历史消息，
// 末尾追加一条 user（本模板原文，参考 titleMessages 的拼法），且该回合不传 tools。
// 需要调整压缩策略时直接改这个模板文件。
const COMPRESS_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'templates', 'compress-prompt.txt'), 'utf8');

// 自动生成会话标题提示词（templates/title-prompt.txt）：会话建立后第 1 次交互完成时触发。
// 与压缩回合不同，这里**不带 system prompt**：直接复用历史里的 user/assistant 文本消息，
// 末尾追加一条 user（本模板，{{language}} 占位符替换为配置语言），见 titleMessages。
const TITLE_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'templates', 'title-prompt.txt'), 'utf8');

// 拼标题回合的 messages：历史原样（只留 user/assistant 纯文本行）+ 末尾一条标题指令 user。
// 与 buildMessages 同取舍：archived 行不进；__blocks__ 哨兵 JSON 还原为文字，图片以 [图片] 占位；
// 含 tool_calls 的 assistant 行无文本内容则跳过，tool 回执行整体跳过（只要对话主干）。
function titleMessages(history, language) {
  const messages = [];
  for (const row of history || []) {
    if (row.type === 'archived') continue;
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    let content = row.content || '';
    const blocks = decodeBlocks(content);
    if (blocks) content = blocks.map(b => (b && b.type === 'text' ? b.text : '[图片]')).join('\n');
    if (!content.trim()) continue;
    messages.push({ role: row.role, content });
  }
  const lang = String(language || '').trim() || 'the same language as the conversation';
  messages.push({ role: 'user', content: TITLE_PROMPT_TEMPLATE.replaceAll('{{language}}', () => lang) });
  return messages;
}

// system prompt 完全静态：所有会话共用同一份内容，利于上游前缀缓存。
function buildSystemPrompt() {
  return SYSTEM_PROMPT_TEMPLATE;
}

// 部署级回复语言指令：拼在 system prompt 末尾（尾部对弱模型约束力最强）。
// 同一进程内恒定，不破坏前缀缓存；改配置需重启生效。
// system prompt 每次请求都随 messages 发出，拼接结果按语言缓存，不重复分配大字符串。
let _promptTextCache = null; // { lang, text }

// “可用技能”段落（skills.formatSkillListForPrompt）：启动时快照（server.js）与技能变更后
// （routes/skills.js）经 setSkillListText 更新，拼在模板之后、语言指令之前。
// 与语言指令同一约定：仅技能增删/描述变化时更新，否则进程内恒定，不破坏前缀缓存。
let SKILL_LIST_TEXT = '';
function setSkillListText(text) {
  SKILL_LIST_TEXT = text || '';
  _promptTextCache = null; // 列表变化后拼接结果需重建
}

function systemPromptText(language) {
  const t = String(language || '').trim();
  if (_promptTextCache && _promptTextCache.lang === t) return _promptTextCache.text;
  let text = SYSTEM_PROMPT_TEMPLATE;
  if (SKILL_LIST_TEXT) text += '\n\n' + SKILL_LIST_TEXT;
  if (t) text += '\n\n## Reply Language\n' +
    '- ALWAYS respond to the user in ' + t + '. Tool descriptions, tool outputs and errors are usually in English — ' +
    'never let them switch your reply language. Tool names, parameters, code, file paths and shell commands stay as-is; ' +
    'every sentence addressed to the user MUST be in ' + t + '.';
  _promptTextCache = { lang: t, text };
  return text;
}

// 多模态内容块存取：messages.content 列为 TEXT，含图片的 tool 消息
// 以 {"__blocks__":[content...]} 哨兵 JSON 落库（见需求 §5），
// 发请求时还原为 OpenAI 内容块数组（text + image_url）。tool/user 消息共用。
function encodeBlocks(blocks) { return JSON.stringify({ __blocks__: blocks }); }
function decodeBlocks(content) {
  if (typeof content !== 'string' || !content.startsWith('{"__blocks__":')) return null;
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.__blocks__) ? parsed.__blocks__ : null;
  } catch (_) { return null; }
}

// 含图行的解析缓存：哨兵 JSON 带 base64 大字段，工具循环里每个请求都整段 JSON.parse，
// 已消费的图片解析完还只留文字块，纯重复劳动。按行 id 把解析结果挂在 session 上：
// 单进程内存模型，行内容入库后不再变更，同一行只解析一次。
// 缓存的是原始块数组而非「消费后投影」——消费与否仍按 lastAssistant 实时判定，
// 删除后续 assistant 让图片回到「未消费」（需重新携带 base64）时也自然正确。
function cachedDecodeBlocks(session, row) {
  if (typeof row.content !== 'string' || !row.content.startsWith('{"__blocks__":')) return null;
  let cache = session.blocksCache;
  if (!cache) cache = session.blocksCache = new Map();
  if (cache.has(row.id)) return cache.get(row.id);
  const blocks = decodeBlocks(row.content);
  if (blocks) cache.set(row.id, blocks);
  return blocks;
}

// 将 DB 消息行转为 OpenAI messages 数组（不含 system，由调用方拼接）。
// 图片两种形态：旧库/用户粘贴附件的 image_url 块（data: URL）原样透传；
// 新版 read_file 读图存的是 image_ref 块（{rel}，指向任务目录 .imgcache/ 产物），
// 发送前用 mintUrl(rel)（engine 传入的公网链现签回调）换成 image_url 外链块，
// 签不到（base_url 未配等）降级为文字占位，绝不把 image_ref 这种非标准块发上游。
// 省 token：图块仅在其位于最后一条 assistant 消息之后（模型尚未对它回复）时保留；
// 之前的视为已消费，发请求时替换为文字标记。DB 始终存全量：UI 历史照常渲染图片，
// 模型如需重看可再次 read_file（新消息在尾部，会重新携带图片）。
// 压缩摘要相关行（见 engine.runLoopInner / summarizeContext）：
// - type='summary'（assistant，收尾答复）：不跳过。它是压缩后后续轮次的上下文起点，
//   正常以 assistant 历史行发给模型；压缩收尾时打此标。
// - type='archived'（压缩时摘要之前的全部旧行，含旧摘要/指令/工具轮）：不发模型。
//   即压缩的核心语义：UI 照常保留展示，但后续对话从摘要开始，旧历史不再烧 token。
// - type='summarize_request'（旧版压缩指令，已废弃）：新版压缩不再产生这种消息行
//   （压缩回合见 compressMessages），此处分支仅为兼容旧库里残留的指令行。
// errAck 行（AI tool call 参数错误，见 engine.checkToolArgs）：整条不发给模型，
// 关联 tool 回执按 id 一并跳过（否则会留下无 tool_call 配对的孤儿 tool 消息，上游拒收）；
// 改以一条 user 错误提示替代，让模型看到原因后重新生成工具调用 ——
// 坏样本留在上下文里只会被模型继续模仿，反复报同一个错。
function buildMessages(session, language, mintUrl) {
  const messages = [{ role: 'system', content: systemPromptText(language) }];
  const history = session.history;
  // 行被删除后清理残留的图片解析缓存条目（只增不清会缓慢泄漏；条数不会超过现存行数）
  if (session.blocksCache && session.blocksCache.size > history.length) {
    const ids = new Set(history.map(r => r.id));
    for (const k of Array.from(session.blocksCache.keys())) if (!ids.has(k)) session.blocksCache.delete(k);
  }
  // tool 回执按 tool_call_id 索引：给 errAck 行拼错误提示时取执行时挡下的原因
  const toolRowById = new Map();
  for (const row of history) if (row.role === 'tool' && row.tool_call_id) toolRowById.set(row.tool_call_id, row);
  let lastAssistant = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    // errAck / archived 不发模型，不算「模型已回复」：它们之前的图不算被消费，下次仍携带
    if (history[i].role === 'assistant' && history[i].type !== 'errAck' && history[i].type !== 'archived') { lastAssistant = i; break; }
  }
  const dropToolCallIds = new Set();
  // 旧版 summarize_request 「已答复」判定的前置信息：最后一次「回合收尾回复」（无 tool_calls 的 assistant）的位置。
  // 指令行在其之后 = 还在等 AI 响应这条指令（旧版压缩回合未收尾），应发给模型；在其之前 = 旧指令，跳过防污染。
  // 新版压缩不再产生这种行（改为替换 system prompt），此处仅处理旧库升级后的残留数据。
  let lastClosingAssistant = -1;
  history.forEach((row, i) => {
    if (row.role === 'assistant' && !row.tool_calls) lastClosingAssistant = i;
  });
  history.forEach((row, i) => {
      // archived：UI 可见，但不进入模型上下文（节省 token）
      if (row.type === 'archived') return;
      // summarize_request（旧版遗留行）：仅在未收尾的旧压缩回合内发给模型，其余一律跳过
      if (row.type === 'summarize_request') {
        if (i > lastClosingAssistant && (row.content || '').trim()) {
          messages.push({ role: 'user', content: row.content });
        }
        return;
      }
      if (row.role === 'assistant') {
      if (row.type === 'errAck') {
        let calls = [];
        try { calls = JSON.parse(row.tool_calls || '[]') || []; } catch (_) {}
        const errs = [];
        for (const c of calls) {
          if (!c || !c.id) continue;
          dropToolCallIds.add(c.id);
          const tr = toolRowById.get(c.id);
          const txt = tr && typeof tr.content === 'string' ? tr.content : '';
          if (txt.startsWith('Error:')) errs.push(txt);
        }
        messages.push({
          role: 'user',
          content: '[系统] 你上一轮的 tool call 参数有误，未正确执行并已从对话历史中移除。错误详情：\n' +
            (errs.join('\n') || 'Error: ToolCall Invalid Params') +
            '\n请严格按工具参数定义重新生成正确的调用。',
        });
        return;
      }
      const m = { role: 'assistant', content: row.content || '' };
      if (row.tool_calls) m.tool_calls = JSON.parse(row.tool_calls);
      if (!m.content) delete m.content;
      messages.push(m);
      return;
    }
    // errAck 轮的 tool 回执：随该轮一起丢弃，避免无主 tool 消息
    if (row.role === 'tool' && dropToolCallIds.has(row.tool_call_id)) return;
    // tool/user 行：含图哨兵 JSON 还原为内容块（解析结果按行 id 缓存）；已消费的图只留文字描述 + 标记
    const blocks = cachedDecodeBlocks(session, row);
    let content = row.content || '';
    if (blocks) {
      if (i < lastAssistant) {
        content = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n') +
          '\n[图片数据已省略：模型此前已识别过本图；如需重新查看请再次调用 read_file]';
      } else {
        // 未消费：image_ref → 现签公网外链（每次请求重签，不过期）；其余块（含旧 data: URL）原样
        content = blocks.map(b => {
          if (!b || b.type !== 'image_ref') return b;
          const url = mintUrl ? mintUrl(b.rel) : null;
          return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[图片外链不可用：请重新读取]' };
        });
      }
    }
    if (row.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: row.tool_call_id, name: row.name, content });
    } else {
      messages.push({ role: row.role, content });
    }
  });
  return messages;
}

// 拼压缩回合的 messages（参考 titleMessages 的拼法）：默认 system prompt + 正常历史
//（与 buildMessages 同取舍：archived 不发、旧摘要/工具轮照常），末尾追加一条 user
//（compress-prompt.txt 原文，历史就在它前面的 messages 里，不再填占位符）。
// 调用方（engine.runLoopInner 的 compressing 分支）需同时不传 tools。
function compressMessages(session, language, mintUrl) {
  const messages = buildMessages(session, language, mintUrl);
  messages.push({ role: 'user', content: COMPRESS_PROMPT_TEMPLATE });
  return messages;
}

// 解析 SSE 行流，对每个 data: JSON 调用 onEvent。
// 可选回调：onMeta(line) 逐行接收非 data 字段（event:/id:/retry:/注释/未知字段），
//           onBadData(raw) 在 data 行 JSON.parse 失败时被调用（原始字符串）。
// 两个回调都可选，传入则启用；流式行为不变（data 仍逐帧下传到 onEvent）。
async function forEachSSEData(response, onEvent, onMeta, onBadData) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataPieces = [];
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (t.startsWith('data:')) {
          dataPieces.push(t.slice(5).trim());
        } else if (t.length && onMeta) {
          // SSE 注释行以 ':' 开头（如 ":keep-alive"），这里原样交给 onMeta
          onMeta(t);
        }
      }
      if (!dataPieces.length) continue;
      const data = dataPieces.join('\n');
      if (data === '[DONE]') return;
      // 只把 JSON 解析失败归入坏帧；onEvent 内抛出的错误（如错误帧转的 throw）必须冒泡，不能被当成坏帧吞掉。
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (_) {
        if (onBadData) onBadData(data);
        continue;
      }
      onEvent(parsed);
    }
  }
}

// 深度合并 src 到 dst（就地改 dst）：同名键两边都是普通对象则递归；其余 src 覆盖 dst。
// 用于将模型的 extra_params / thinking_params 合入上游请求体。
function deepMergeInto(dst, src) {
  for (const k of Object.keys(src || {})) {
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)
        && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
      deepMergeInto(dst[k], sv);
    } else if (sv && typeof sv === 'object') {
      // 切断与配置对象的引用关系
      dst[k] = Array.isArray(sv) ? sv.slice() : structuredClone(sv);
    } else {
      dst[k] = sv;
    }
  }
  return dst;
}

// 有些小模型（如 MiniCPM）不走 reasoning 字段，而是把思考过程混进 content 开头：
//   - 成对前缀：  <think>思考</think>答复（可连多个，也兼容 <thinking>）；
//   - 仅结束标记：思考</think>答复（无开标签，第一个 </think> 之前全是思考）。
// 只在「正文开头」识别思考块：命中才剥离，正文中段出现的字面 <think>/</think>
//（代码示例、讲解标签等）一律不动，避免误吞答案。
function splitInlineThinking(raw) {
  const text0 = String(raw || '');
  if (!/<\/?think/i.test(text0)) return { content: text0, reasoning: '' };

  let text = text0;
  let think = '';
  let matched = false;

  // A) 开头成对块：^\s*<think>…</think>，非贪婪；连续多个块一并剥离，中段的不碰
  const paired = /^\s*<think(?:ing)?>([\s\S]*?)<\/think(?:ing)>/i;
  let m;
  while ((m = paired.exec(text))) {
    think += m[1];
    text = text.slice(m[0].length);
    matched = true;
  }

  // B) 无成对块时，按 MiniCPM 风格处理孤立的结束标记：
  //    只有第一个 </think> 之前算思考（indexOf 只吃前缀，绝不回退到最后，
  //    否则正文里随便一个 </think> 会把前面的全部答案吸进思考面板）；
  //    且要求结束标记之前没有任何开标签——真正的「仅结束标记」风格本就无开标签，
  //    正文里合法写出的 <think>…</think>（代码示例/讲解标签）因此得以放行。
  if (!matched) {
    const lc = text.toLowerCase();
    const close = lc.indexOf('</think');
    const open = lc.indexOf('<think');
    if (close !== -1 && (open === -1 || open > close)) {
      const gt = text.indexOf('>', close);
      think += text.slice(0, close);
      text = text.slice(gt === -1 ? text.length : gt + 1);
      matched = true;
    }
  }

  // 没在开头命中思考块 → 原样返回，保护正文里的字面标签
  if (!matched) return { content: text0, reasoning: '' };

  return { content: text.trim(), reasoning: think.trim() };
}

// 调模型一次。onText(textDelta) 回调流式文本。
// 返回 { content, tool_calls: [{id,name,arguments(string)}], finish_reason, usage, aborted }
// 可选回调 opts.onToolCallStart({id,name})：某 tool_call 首次凑齐 id+name 时触发一次；
// opts.onToolCallArgs({id,args})：此后该调用每段参数增量各触发一次（供前端流式渲染）。
// options.deepThink: true 时将 modelCfg.thinking_params 合并进 body。
async function callModel(cfg, modelId, messages, tools, options) {
  const opts = options || {};
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort());
  }
  // modelId = 「平台名/模型id」；opts.key_slot = 池槽位「平台#key下标」（会话占用的 key），两者合定位具体 key 副本；
  // 未传/未命中时退回按模型 id 取第一个副本（标题等旁路调用）。发给上游的模型名用 mid（原始 id）。
  const all = cfg.models || [];
  const modelCfg = (opts.key_slot ? all.find(m => m.id === modelId && m.platform + '#' + m.key_index === opts.key_slot) : null)
    || all.find(m => m.id === modelId);
  if (!modelCfg || !modelCfg.url) throw new Error('模型未在配置中定义或缺少 url: ' + modelId);

  const body = {
    model: modelCfg.mid || modelCfg.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: cfg.agent.temperature,
  };
  if (tools && tools.length) body.tools = tools;
  // 模型特有请求参数：与内置字段同名时额外优先（同时思考参数可覆盖）
  if (modelCfg.extra_params && Object.keys(modelCfg.extra_params).length) {
    deepMergeInto(body, modelCfg.extra_params);
  }
  if (opts.deepThink && modelCfg.thinking_params && Object.keys(modelCfg.thinking_params).length) {
    deepMergeInto(body, modelCfg.thinking_params);
  }

  const headers = { 'Content-Type': 'application/json' };
  if (modelCfg.api_key) headers.Authorization = 'Bearer ' + modelCfg.api_key;

  if (opts.onFetchParams) {
    const logBody = { ...body };
    delete logBody.messages;
    delete logBody.tools;
    opts.onFetchParams(logBody);
  }

  const res = await fetch(modelCfg.url + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error('上游返回 ' + res.status + ': ' + text.slice(0, 500));
    err.upstream_status = res.status;
    throw err;
  }

  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  let aborted = false;
  let sseFrames = 0; // 收到的上游 data 帧数（仅计数成功下传到 onEvent 的）
  const toolCalls = new Map(); // index -> {id, name, arguments}
  const announced = new Set();  // 已早广播的 slot idx（id+name 就绪即通知前端建卡，不等整轮生成完）
  const announcedLen = new Map(); // idx -> 已转发的参数字符数（参数碎片只发增量，不重复全量）

  try {
    await forEachSSEData(res, evt => {
      sseFrames++;
      if (opts.shouldCancel && opts.shouldCancel()) { aborted = true; controller.abort(); return; }
      if (evt.usage) usage = evt.usage;
      const choice = evt.choices && evt.choices[0];
      if (!choice) {
        // 部分代理把错误包成 HTTP 200 流内的 {"error":...} 帧：直接转 throw，
        // 汇入既有「非 200 → 重试/放弃 → ⚠️ 上屏」链路，不再静默吞帧。
        if (evt.error) {
          const msg = String(evt.error.message || evt.error.code || JSON.stringify(evt.error)).slice(0, 500);
          const err = new Error('上游错误帧: ' + msg);
          // 请求侧错误（参数不兼容等）重试也不会好，标 400 跳过重试
          if (/client_error|invalid_request/i.test(String(evt.error.code || '') + ' ' + String(evt.error.type || ''))) err.upstream_status = 400;
          controller.abort(); // 放掉底层连接（abort 不影响本次 throw）
          throw err;
        }
        // choices=[] 但含 usage：OpenAI 兼容协议最后一帧只发 token 统计，正常情况，
        // 不算错误帧。其它无 usage 也无 choices 的怪帧才走 onBadEvent。
        if (!evt.usage && opts.onBadEvent) opts.onBadEvent(evt);
        return;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content.length) {
        content += delta.content;
        if (opts.onText) opts.onText(delta.content);
      }
      // 思考/推理字段：各家上游不一致，同时支持 reasoning 和 reasoning_content；只走一个，优先级 reasoning
      const rPiece = (typeof delta.reasoning === 'string' && delta.reasoning)
        || (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
        || '';
      if (rPiece) {
        reasoning += rPiece;
        if (opts.onReasoning) opts.onReasoning(rPiece);
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index || 0;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: '', name: '', arguments: '' });
        const acc = toolCalls.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function) {
          if (tc.function.name) acc.name += tc.function.name;
          if (tc.function.arguments) acc.arguments += tc.function.arguments;
        }
        // 早反馈：id+name 就绪即通知前端建卡（写大文件等长参数生成期间不再静默如卡死）；
        // 其后参数碎片按增量转发（流式填「生成参数中」卡片）。
        if (acc.id && acc.name && !announced.has(idx)) {
          announced.add(idx);
          announcedLen.set(idx, acc.arguments.length);
          if (opts.onToolCallStart) opts.onToolCallStart({ id: acc.id, name: acc.name });
        }
        if (announced.has(idx) && opts.onToolCallArgs) {
          const from = announcedLen.get(idx) || 0;
          if (acc.arguments.length > from) {
            announcedLen.set(idx, acc.arguments.length);
            opts.onToolCallArgs({ id: acc.id, args: acc.arguments.slice(from) });
          }
        }
      }
      },
      opts.onMeta,
      opts.onBadData,
    );
  } catch (e) {
    if (e && e.name === 'AbortError') aborted = true; else throw e;
  }
  if (opts.shouldCancel && opts.shouldCancel()) aborted = true;

  // 归一化：把混进 content 的思考标签剥离出来（流式阶段无法回溯，故在整轮收尾统一处理；
  // engine 落库/发 assistant_message 用的是这里的返回值，前端收尾会用干净正文覆盖流式文本）
  const split = splitInlineThinking(content);
  content = split.content;
  if (split.reasoning) reasoning = reasoning ? split.reasoning + '\n' + reasoning : split.reasoning;

  return { content, reasoning, tool_calls: Array.from(toolCalls.values()), finish_reason: finishReason, usage, aborted, sseFrames };
}

module.exports = { callModel, buildMessages, buildSystemPrompt, systemPromptText, setSkillListText, encodeBlocks, decodeBlocks, compressMessages, titleMessages };
