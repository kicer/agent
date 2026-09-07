// 上游调用：OpenAI 兼容 /chat/completions 流式接口（由 cli-proxy-api 代理）。
// 累积 content 与 tool_calls 分片；支持 abort。
const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'templates', 'system-prompt.txt'), 'utf8');

// system prompt 完全静态：所有会话共用同一份内容，利于上游前缀缓存。
// 动态会话信息（日期/任务目录/模型显示名）不再拼入 system prompt，
// 而是在新建会话时作为首条 user 消息发送，见 engine.js 的 sessionContextContent。
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
// 省 token：image_url 块仅在其位于最后一条 assistant 消息之后（模型尚未对它回复）时保留；
// 之前的视为已消费，发请求时替换为文字标记。DB 始终存全量：UI 历史照常渲染图片，
// 模型如需重看可再次 read_file（新消息在尾部，会重新携带图片）。
// 压缩摘要相关行（见 engine.runLoopInner / summarizeContext）：
// - type='summary'（assistant，收尾答复）：不跳过。它是压缩后后续轮次的上下文起点，
//   正常以 assistant 历史行发给模型；「仅摘要」与「压缩总结」两种模式都会打此标。
// - type='archived'（压缩时摘要之前的全部旧行，含旧摘要/指令/工具轮）：不发模型。
//   这是「仅摘要」的核心语义：UI 照常保留展示，但后续对话从摘要开始，旧历史不再烧 token；
//   「压缩总结」则另由前端 DELETE keep=summary 把存档行物理删除。
// - type='summarize_request'（压缩指令）：只在触发的那一压缩回合内发给模型（见下方判定），
//   回合完成后不再携带，防旧指令让 AI 误以为还要再总结。
// errAck 行（AI tool call 参数错误，见 engine.checkToolArgs）：整条不发给模型，
// 关联 tool 回执按 id 一并跳过（否则会留下无 tool_call 配对的孤儿 tool 消息，上游拒收）；
// 改以一条 user 错误提示替代，让模型看到原因后重新生成工具调用 ——
// 坏样本留在上下文里只会被模型继续模仿，反复报同一个错。
function buildMessages(session, language) {
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
  // summarize_request 「已答复」判定的前置信息：最后一次「回合收尾回复」（无 tool_calls 的 assistant）的位置。
  // 指令行在其之后 = 还在等 AI 响应这条指令（当前压缩回合），应发给模型；在其之前 = 旧指令，跳过防污染。
  // errAck 带 tool_calls 不在此列；历史里残留的旧指令（如 generate_only）后面必然跟着摘要收尾行，自然被跳过。
  let lastClosingAssistant = -1;
  history.forEach((row, i) => {
    if (row.role === 'assistant' && !row.tool_calls) lastClosingAssistant = i;
  });
  history.forEach((row, i) => {
      // archived：UI 可见，但不进入模型上下文（节省 token）
      if (row.type === 'archived') return;
      // summarize_request：仅在触发的那一压缩回合内发给模型（见函数头注释）
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
    // tool/user 行：含图哨兵 JSON 还原为内容块（解析结果按行 id 缓存）；已消费的图剥掉 base64，只留文字描述 + 标记
    const blocks = cachedDecodeBlocks(session, row);
    let content = row.content || '';
    if (blocks) {
      if (i < lastAssistant) {
        content = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n') +
          '\n[图片数据已省略：模型此前已识别过本图；如需重新查看请再次调用 read_file]';
      } else {
        content = blocks;
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
      try {
        onEvent(JSON.parse(data));
      } catch (_) {
        if (onBadData) onBadData(data);
      }
    }
  }
}

// 深度合并 src 到 dst（就地改 dst）：同名键两边都是普通对象则递归；其余 src 覆盖 dst。
// 用于将模型的 extra_params / thinking_params 合入上游请求体。
function deepMergeInto(dst, src) {
  for (const k of Object.keys(src || {})) {
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
      deepMergeInto(dst[k], sv);
    } else {
      dst[k] = sv;
    }
  }
  return dst;
}

// 调模型一次。onText(textDelta) 回调流式文本。
// 返回 { content, tool_calls: [{id,name,arguments(string)}], finish_reason, usage, aborted }
// options.deepThink: true 时将 modelCfg.thinking_params 合并进 body。
async function callModel(cfg, modelId, messages, tools, options) {
  const opts = options || {};
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort());
  }
  // modelId = 内部唯一键「平台名/模型id」；发给上游的模型名用 mid（原始 id）。
  const modelCfg = (cfg.models || []).find(m => m.id === modelId);
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

  try {
    await forEachSSEData(res, evt => {
      sseFrames++;
      if (opts.shouldCancel && opts.shouldCancel()) { aborted = true; controller.abort(); return; }
      if (evt.usage) usage = evt.usage;
      const choice = evt.choices && evt.choices[0];
      if (!choice) {
        // choices=[] 但含 usage：OpenAI 兼容协议最后一帧只发 token 统计，正常情况，
        // 不算错误帧。其它无 usage 也无 choices 的（如 event: error 帧）才走 onBadEvent。
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
      }
      },
      opts.onMeta,
      opts.onBadData,
    );
  } catch (e) {
    if (e && e.name === 'AbortError') aborted = true; else throw e;
  }
  if (opts.shouldCancel && opts.shouldCancel()) aborted = true;

  return { content, reasoning, tool_calls: Array.from(toolCalls.values()), finish_reason: finishReason, usage, aborted, sseFrames };
}

module.exports = { callModel, buildMessages, buildSystemPrompt, systemPromptText, setSkillListText, encodeBlocks, decodeBlocks };
