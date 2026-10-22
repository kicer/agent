// 上游调用：OpenAI 兼容 /chat/completions 流式接口（由 cli-proxy-api 代理）。
// 累积 content 与 tool_calls 分片；支持 abort。
const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'templates', 'profile-default.txt'), 'utf8');

// 上下文压缩提示词（templates/prompt-compress.txt）：点「压缩」时不插入指令消息。
// 压缩回合（见 compressMessages）沿用默认 system prompt + 正常历史消息，
// 末尾追加一条 user（本模板原文，参考 titleMessages 的拼法），且该回合不传 tools。
// 需要调整压缩策略时直接改这个模板文件。
const COMPRESS_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'templates', 'prompt-compress.txt'), 'utf8');

// 自动生成会话标题提示词（templates/prompt-title.txt）：会话建立后第 1 次交互完成时触发。
// 与压缩回合不同，这里**不带 system prompt**：直接复用历史里的 user/assistant 文本消息，
// 末尾追加一条 user（本模板，{{language}} 占位符替换为配置语言），见 titleMessages。
const TITLE_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'templates', 'prompt-title.txt'), 'utf8');

// 拼标题回合的 messages：历史原样（只留 user/assistant 纯文本行）+ 末尾一条标题指令 user。
// 与 buildMessages 同取舍：archived 行不进；__blocks__ 哨兵 JSON 还原为文字，图片以 [图片] 占位；
// 含 tool_calls 的 assistant 行无文本内容则跳过，tool 回执行整体跳过（只要对话主干）。
// 注入行不进（白名单制，新合成 type 默认排除）：[CTX] channel/memory 是固定模板文本，
// 喂给标题模型等于拿广告词做摘要；scheduler_note/errAck/旧 summarize_request 同类系统噪音。
// 白名单里 summary 与 task_brief 例外保留：它们本身就是会话主题的最佳凝缩（阶段切换后
// 旧历史全 archived，只剩 task_brief 可读）；profile 快照不在 messages 表，天然不进。
const TITLE_ROW_TYPES = new Set([null, undefined, 'summary', 'task_brief']);
function titleMessages(history, language) {
  const messages = [];
  for (const row of history || []) {
    if (!TITLE_ROW_TYPES.has(row.type)) continue;
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

// system prompt 进程内恒定（利于上游前缀缓存）。多套并存：默认模板 + 每套 model_profiles
// 的自定义 prompt（文本随配置加载时读入，见 config.js normalizeModelProfiles，经
// setProfilePrompts 注册）。请求时按 profile 名选取——纯内存指针选择，零 IO。
function buildSystemPrompt() {
  return SYSTEM_PROMPT_TEMPLATE;
}

let PROFILE_PROMPTS = {}; // profile 名 -> 自定义 prompt 全文（不含技能段/语言后缀）
function setProfilePrompts(map) {
  PROFILE_PROMPTS = map || {};
  _promptTextCache = new Map(); // 注册表变化后拼接结果需重建
}

// 部署级回复语言指令：拼在 system prompt 末尾（尾部对弱模型约束力最强）。
// 同一进程内恒定，不破坏前缀缓存；改配置需重启生效。
// system prompt 每次请求都随 messages 发出，拼接结果按 (profile, 语言) 缓存，不重复分配大字符串。
let _promptTextCache = new Map(); // 'profile\u0000lang' -> text

// “可用技能”段落（skills.formatSkillListForPrompt）：启动时快照（server.js）与技能变更后
//（routes/skills.js）经 setSkillListText 更新。插入位置由模板内的 {APP_SKILLS_SECTION} 占位符决定
//（拼在技能规则旁边，模型一眼看到清单，不再盲猜尾部多出来的孤儿段落）：
// - 模板含占位符 → 就地替换（默认模板与自定义 prompt 同机制）；
// - 默认模板没占位符 → 兑底尾拼（兼容手改模板时删掉了占位行）；自定义 prompt 没占位符 → 无技能段（完全接管）。
// 仅技能增删/描述变化时更新，否则进程内恒定，不破坏前缀缓存。
const APP_SKILLS_TOKEN = '{APP_SKILLS_SECTION}';
let SKILL_LIST_TEXT = '';
function setSkillListText(text) {
  SKILL_LIST_TEXT = text || '';
  _promptTextCache = new Map(); // 列表变化后拼接结果需重建
}

function withSkillList(text, appendFallback) {
  if (text.includes(APP_SKILLS_TOKEN)) {
    // split/join：替掉所有出现位；清单为空时顺手压掉替换留下的空行
    return text.split(APP_SKILLS_TOKEN).join(SKILL_LIST_TEXT).replace(/\n{3,}/g, '\n\n').trim();
  }
  if (appendFallback && SKILL_LIST_TEXT) text += '\n\n' + SKILL_LIST_TEXT;
  return text;
}

function systemPromptText(language, profile) {
  const t = String(language || '').trim();
  const key = (profile || 'default') + '\u0000' + t;
  const hit = _promptTextCache.get(key);
  if (hit) return hit;
  let text;
  if (profile && PROFILE_PROMPTS[profile]) {
    text = withSkillList(PROFILE_PROMPTS[profile], false); // 自定义文件：没放占位符就真没有技能段
  } else {
    text = withSkillList(SYSTEM_PROMPT_TEMPLATE, true);
  }
  if (t) text += '\n\n## Reply Language\n' +
    '- ALWAYS respond to the user in ' + t + '. Tool descriptions, tool outputs and errors are usually in English — ' +
    'never let them switch your reply language. Tool names, parameters, code, file paths and shell commands stay as-is; ' +
    'every sentence addressed to the user MUST be in ' + t + '.';
  _promptTextCache.set(key, text);
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
// 缓存的是原始块数组而非「消费后投影」——消费与否仍按 lastAck 实时判定，
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

// read_file 图片回执是单个 JSON 对象（字段契约见 tools/executor.js 的 imageReceipt）。
// 发送侧要改写回执时只动字段，绝不追加句子：拼在 JSON 后面会让整条回执不可解析，
// 模型又退回「从自然语言里猜像素到底到没到」。非 JSON / 非图片回执（旧库散文、文本读取正文）
// 返回 null，调用方自行回退。
function patchImageReceipt(text, patch) {
  if (typeof text !== 'string' || text.charAt(0) !== '{') return null;
  let o;
  try { o = JSON.parse(text); } catch (_) { return null; }
  if (!o || o.kind !== 'image') return null;
  return JSON.stringify(Object.assign(o, patch));
}
// 图片编号标签：从回执字段生成「read_file <path> 1080×1920」，只用于把图与回执对上号。
// 旧库散文回执退回首行（历史行照旧可读）。
function imageLabel(text) {
  if (typeof text === 'string' && text.charAt(0) === '{') {
    try {
      const o = JSON.parse(text);
      if (o && o.kind === 'image') return 'read_file ' + (o.path || '') + (o.width && o.height ? ' ' + o.width + '×' + o.height : '');
    } catch (_) { /* 落到下面按散文取首行 */ }
  }
  return (text || 'read_file 图片回传').split('\n')[0];
}

// 将 DB 消息行转为 OpenAI messages 数组（不含 system，由调用方拼接）。
// 图片两种形态：旧库/用户粘贴附件的 image_url 块（data: URL）原样透传；
// 新版 read_file 读图存的是 image_ref 块（{rel}，指向任务目录 .imgcache/ 产物）。
// tool 回执里的未消费图不放在回执内发送——tool 角色带 image_url 非标准形态，
// 大量 OpenAI 兼容上游会整批忽略或只认批次最后一张，模型看不到图却见回执写着
// 「已回传」，会反复 read_file 补看（死循环烧 token，见多模态回退复盘）；
// 故回执里只留文字（read_file 读图时是一个结构化 JSON 对象，字段见
// tools/executor.js 的 imageReceipt；发送侧只改字段、不追加句子），图块现签成
// image_url（mintUrl 公网链回调）后统一并入
// 该批之后的一条 user 消息（user 角色各家通吃）：逐图说明文字全部置顶、图块按回执顺序紧随
//（对齐官方示例排布；探针实测 DS 对交替排布也兼容，取低风险形态），
// 并只对本批新增的图附「一句话说明」的自检指令——兼作送达自检，破弱模型的“没收到”
// 惯性叙事；早前批次不再重复要求描述（旧版对全部未消费图每轮重发祈使句，驱动了重复循环）；
// 签不到（base_url 未配等）降级为文字占位，绝不把 image_ref 这种非标准块发上游。
// 省 token：图块保留到「最后一次写过文本的 assistant」之前——模型把图片描述写在 content
// 里、同时继续发 tool_calls，就是它确实看到像素的证据。旧判据只认「无 tool_calls 的收尾
// 回复」，于正常的多步任务（工具轮不停）里图永远算未消费，每轮都把「逐张简述…然后继续
// 完成用户的任务」重发一遍，模型照做又产生 tool_calls——自我维持的重复循环（2026-10 实机：
// 同一批图被反复描述直到人工终止）。没写任何文本的中间轮仍算「没看过」，图继续随请求
// 携带（14:33 实测：图已进上下文而模型仍自述没看到，行为鲁棒优先于极致省钱）。
// DB 始终存全量：UI 历史照常渲染图片，模型如需重看可再次 read_file（新回执在尾部）。
// 重放时只省略像素块、**不改写回执字段**：回执是历史事实，改写成「未投递」会让模型
// 把当时成功的读图误判为失败，进而反复重读同一条（2026-10 实机循环的直接成因）。
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
// profile：本轮生效的 prompt+tools 组合名（model_profiles，见 engine.resolveProfileName），
// 空 = 默认全量组合。
// withProfile=false 时跳过画像快照注入（压缩回合专用，见 compressMessages）。
function buildMessages(session, language, mintUrl, profile, withProfile, trimOn) {
  const messages = [{ role: 'system', content: systemPromptText(language, profile) }];
  // 用户画像快照（sessions.profile_snapshot，建会话/清空时冻结，见 user-profile.js）：
  // 作为 system 后首条 user 注入，会话内字节恒定不破坏前缀缓存；
  // 刻意不落 messages 表：阶段切换归档、压缩摘要都只动 messages 表，碰不到它。
  if (withProfile !== false && session.profile_snapshot) messages.push({ role: 'user', content: session.profile_snapshot });
  const history = session.history;
  // 行被删除后清理残留的图片解析缓存条目（只增不清会缓慢泄漏；条数不会超过现存行数）
  if (session.blocksCache && session.blocksCache.size > history.length) {
    const ids = new Set(history.map(r => r.id));
    for (const k of Array.from(session.blocksCache.keys())) if (!ids.has(k)) session.blocksCache.delete(k);
  }
  // 裁剪预扫：① 每行距尾的 assistant 轮数（从尾往头扫）；② tool_call id → function
  // （给 fetch/read_file 占位回填 url/path）。trimOn=false 时整个跳过（压缩回合）。
  const trimActive = trimOn !== false && (TRIM.writeRounds > 0 || TRIM.resultRounds > 0);
  const roundsAfter = new Map();
  const callById = new Map();
  if (trimActive) {
    let n = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const r = history[i];
      roundsAfter.set(r.id, n);
      if (r.role === 'assistant' && r.type !== 'archived' && r.type !== 'errAck') n++;
    }
    if (TRIM.resultRounds > 0) {
      for (const r of history) {
        if (r.role !== 'assistant' || !r.tool_calls) continue;
        try { for (const c of JSON.parse(r.tool_calls) || []) if (c && c.id && c.function) callById.set(c.id, c.function); } catch (_) {}
      }
    }
  }
  // tool 回执按 tool_call_id 索引：给 errAck 行拼错误提示时取执行时挡下的原因
  const toolRowById = new Map();
  for (const row of history) if (row.role === 'tool' && row.tool_call_id) toolRowById.set(row.tool_call_id, row);
  // 「已消费」分界 = 最后一条**写过文本**的 assistant 行（不要求无 tool_calls）：
  // 描述写在 content 里 + 继续调工具，就是模型真看到图的证据（见文件头注释的循环复盘）。
  // errAck / archived 不发模型，不算回复：它们之前的图不算被消费。
  let lastAck = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.role !== 'assistant' || r.type === 'errAck' || r.type === 'archived') continue;
    if (String(r.content || '').trim()) { lastAck = i; break; }
  }
  // 「本批新增」起点 = 最后一条 assistant 行之后的 tool 回执（engine 每轮把新回执行追加在末尾）。
  // 只有这些图带「请描述」的祈使句；更早批次仍未消费的图只静默携带，否则模型每轮都被
  // 要求重述一遍旧图，进而把旧任务再推一遍。
  let lastAssistantRow = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') { lastAssistantRow = i; break; }
  }
  const newFrom = lastAssistantRow + 1;
  const dropToolCallIds = new Set();
  // 旧版 summarize_request 「已答复」判定的前置信息：最后一次「回合收尾回复」（无 tool_calls 的 assistant）的位置。
  // 指令行在其之后 = 还在等 AI 响应这条指令（旧版压缩回合未收尾），应发给模型；在其之前 = 旧指令，跳过防污染。
  // 新版压缩不再产生这种行（改为替换 system prompt），此处仅处理旧库升级后的残留数据。
  let lastClosingAssistant = -1;
  history.forEach((row, i) => {
    if (row.role === 'assistant' && !row.tool_calls) lastClosingAssistant = i;
  });
  // 未消费图片的暂存区：tool 回执降级为纯文本，图块收集到这里，
  // 循环结束后合并成一条 user 消息发送（顺序约束：天然落在该批全部回执之后、
  // 且是模型下一次的直接输入，assistant→tool 回执的紧邻约束不被打断）。
  const pendingImages = [];   // 待投递的图块（按回执顺序；签不到时不占位）
  const pendingLabels = [];   // 每图一行「对应回执」说明，合并进首条文字块（text 置顶、图在后）
  let imgSeq = 0;
  let newCount = 0;           // 其中本批新增的图数：为 0 时不带「请描述」的祈使句
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
        const echo = [];
        for (const c of calls) {
          if (!c || !c.id) continue;
          dropToolCallIds.add(c.id);
          const tr = toolRowById.get(c.id);
          const txt = tr && typeof tr.content === 'string' ? tr.content : '';
          if (txt.startsWith('Error:')) errs.push(txt);
          // 回显你上轮实际提交的参数形：errAck 整轮移除后模型看不到自己的作答，光挨骂无法改——
          // 给它「答卷」对照着修形状（标注为错误样本，不被当作合法调用模仿）。
          echo.push(c.function && c.function.name ? c.function.name + '(' + String(c.function.arguments || '').slice(0, 200) + ')' : '');
        }
        messages.push({
          role: 'user',
          content: '[系统] 你上一轮的 tool call 参数有误，未正确执行并已从对话历史中移除。\n' +
            (echo.length ? '你上轮实际提交的参数（仅供纠错对照，不要原样重复）：\n' + echo.join('\n') + '\n' : '') +
            '错误详情：\n' +
            (errs.join('\n') || 'Error: ToolCall Invalid Params') +
            '\n请严格按工具参数定义修正后重新调用。',
        });
        return;
      }
      const m = { role: 'assistant', content: row.content || '' };
      // 思维链回传原料：存库 reasoning 随原样带给 callModel（中性内部键，按模型
      // reasoning_ack_field 改名注入后此键必被剥除，不会泄往上游）。
      if (row.reasoning) m.__reasoning = row.reasoning;
      if (row.tool_calls) {
        m.tool_calls = JSON.parse(row.tool_calls);
        if (trimActive && TRIM.writeRounds > 0) trimWriteCalls(m.tool_calls, roundsAfter.get(row.id) || 0);
      }
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
      if (i < lastAck) {
        // 已消费的图重放时**只省略像素，不改写回执**：回执记的是「那次读取发生了什么」
        //（当时确实投递了）；「这次重放不重复发」只是传输细节，不该写进历史事实。
        // 若改写成 image_attached:false / reason:omitted_already_sent / retryable:false，
        // 模型会把历史读图当成失败、认为「这次没拿到画面」，于是反复重读同一条（实测循环）。
        // 确实需要重看时它自己再 read_file 即可，那条新回执会是完整的成功回执。
        content = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
      } else if (row.role === 'tool') {
        // 未消费的图：回执只留文字，图块挪进批次后的 user 合并消息（见 pendingImages/Labels）
        const texts = blocks.filter(b => b && b.type === 'text').map(b => b.text);
        content = texts.join('\n');
        const label = imageLabel(texts[0]);
        const isNew = i >= newFrom;
        let mintFailed = false;
        for (const b of blocks) {
          if (!b || (b.type !== 'image_ref' && b.type !== 'image_url')) continue;
          let block = b;
          if (b.type === 'image_ref') {
            const url = mintUrl ? mintUrl(b.rel) : null;
            if (!url) { mintFailed = true; continue; } // 签不到就不占编号：没图可描述
            block = { type: 'image_url', image_url: { url } };
          }
          const seq = ++imgSeq;
          if (isNew) newCount++;
          pendingImages.push(block);
          pendingLabels.push('[图片 ' + seq + ']' + (isNew ? '（本批新增）' : '') + ' ' + label
            + (isNew ? '' : '（早前批次，已投递过，不要重复描述）'));
        }
        // 签不到外链 = 本次请求像素确实到不了：当场把回执字段降级，让模型拿到的是
        // 「ok 但 image_attached=false + reason」，而不是一句需要它自己解读的说明。
        if (mintFailed) {
          const degraded = patchImageReceipt(content, {
            image_attached: false, reason: 'link_unavailable', retryable: false,
            hint: '服务端签不出图片外链，本张图的像素未能随本次请求送达；重读也无法送达，请直接告知用户',
          });
          if (degraded !== null) content = degraded;
        }
      } else {
        // user 行（粘贴附件/旧形态）：image_url 块（data: URL）原样；image_ref → 现签公网外链
        //（每次请求重签，不过期）
        content = blocks.map(b => {
          if (!b || b.type !== 'image_ref') return b;
          const url = mintUrl ? mintUrl(b.rel) : null;
          return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[图片外链不可用：请直接告知用户，勿反复重读同一文件]' };
        });
      }
    }
    if (row.role === 'tool') {
      if (trimActive && typeof content === 'string') content = trimToolContent(content, row, callById, roundsAfter);
      messages.push({ role: 'tool', tool_call_id: row.tool_call_id, name: row.name, content });
    } else {
      messages.push({ role: row.role, content });
    }
  });
  // 未消费图片合并发送：图上文字置顶、图块紧随（同序）。
  // 只有「本批新增」的图才能带祈使句——旧版对所有未消费图每轮都写「逐张简述…然后
  // 继续完成用户的任务」，模型把它当成新的用户任务，描述完继续干活→又产生 tool_calls→
  // 图仍算未消费→再要求描述，自维持重复。早前批次只静默携带并明确「不要重复描述」。
  if (pendingImages.length) {
    const tail = newCount
      ? '\n标注「本批新增」的图片是本轮新投递的：各用一句话说明里面有什么（确认像素已收到），'
        + '然后继续你手头的工具流程。本条不是新的用户任务，不要在这里展开分析。'
      : '\n以上均为早前批次已投递过的图片（像素仍在上下文中）：不要重复描述，专注完成用户的任务。';
    messages.push({
      role: 'user',
      content: [{ type: 'text',
        text: '[系统提示] 以下不是用户新输入，是你此前 read_file 回传的图片（按回执顺序）：\n'
          + pendingLabels.join('\n')
          + tail }]
        .concat(pendingImages),
    });
  }
  return messages;
}

// ---------- 重负载占位裁剪（历史重放省 token） ----------
// fetch/read_file 回执与 write_file 参数正文是重放里最贵的存量，且都可再生：文件在盘上、
// 页面可重抓；write 参数只是当时快照（后续 edit_file 一次就失真，本就不该被当现势引用）。
// 组装请求时对「距尾 ≥N 个 assistant 轮」的行换单行占位：纯函数、DB 不动（UI 工具卡照旧
// 可展全量）、与压缩归档正交（archived 行本来就不进模型）。距离按现存行数 assistant 轮：
// 删中间消息可让已占位行短暂复活全文（一次性断前缀缓存，与图片消费 i<lastAck 同一
// 语义，接受）。阈值可配（config agent.trim_write_rounds / trim_result_rounds，0=关），
// 启动时 setPayloadTrim 注入。
let TRIM = { writeRounds: 1, resultRounds: 2 };
const TRIM_MIN_CHARS = 600; // 短正文不裁：占位行自身成本接近原文，裁了反而胀
function setPayloadTrim(agentCfg) {
  const a = agentCfg || {};
  const toN = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(0, n) : d; };
  TRIM = { writeRounds: toN(a.trim_write_rounds, 1), resultRounds: toN(a.trim_result_rounds, 2) };
}
// write_file 参数占位：只洗 content。AI 友好记号风格：键值对、不写整句——path 不必重复，
// 本条 arguments 里就还在；改写的是已 parse 副本，DB 行不动，重新 stringify 保持 JSON 合法。
function trimWriteCalls(calls, rounds) {
  if (rounds < TRIM.writeRounds) return;
  for (const c of calls || []) {
    if (!c || !c.function || c.function.name !== 'write_file') continue;
    let args;
    try { args = JSON.parse(c.function.arguments || ''); } catch (_) { continue; }
    if (!args || typeof args.content !== 'string' || args.content.length < TRIM_MIN_CHARS) continue;
    args.content = '[OMITTED, size=' + args.content.length + ']';
    c.function.arguments = JSON.stringify(args);
  }
}
// fetch/read_file 回执占位：同款键值记号。url/path 不进占位——发起调用的 assistant 行仍载着
// 它们，参数本身就是恢复指针。图片回执（blocks 非空）不碰：已有自己的消费省略逻辑。
function trimToolContent(content, row, callById, roundsAfter) {
  if (TRIM.resultRounds <= 0 || content.length < TRIM_MIN_CHARS) return content;
  if ((roundsAfter.get(row.id) || 0) < TRIM.resultRounds) return content;
  const fn = callById.get(row.tool_call_id);
  const name = row.name || (fn && fn.name) || '';
  if (name !== 'fetch' && name !== 'read_file') return content;
  if (name === 'fetch') {
    const hm = /^HTTP (\d{3})/.exec(content);
    return '[OMITTED' + (hm ? ', http_status=' + hm[1] : '') + ', size=' + content.length + ']';
  }
  return '[OMITTED, size=' + content.length + ']';
}

// 拼压缩回合的 messages（参考 titleMessages 的拼法）：默认 system prompt + 正常历史
//（与 buildMessages 同取舍：archived 不发、旧摘要/工具轮照常），末尾追加一条 user
//（prompt-compress.txt 原文，历史就在它前面的 messages 里，不再填占位符）。
// 调用方（engine.runLoopInner 的 compressing 分支）需同时不传 tools。
// 【缓存铁律】压缩请求必须与上一次常规请求字节同构、只在尾部追加指令：画像快照与
// 占位裁剪一律照常（不传 withProfile/trim = 同一拼法），也不裁历史中间任何注入行——
// 从首个被删/被改动行起前缀缓存全断，等于全价重读（旧代码 withProfile=false 把坐在
// 第 1 条的快照抽掉，比裁历史更隐蔽）。模型把画像转述进摘要无伤大雅：快照本就每轮
// 瞬态重发，重复几行字换整段缓存命中，划算。标题回合是另一套无缓存最小请求，
// 才能用白名单狠筛——两套逻辑不可串用。
function compressMessages(session, language, mintUrl, profile) {
  const messages = buildMessages(session, language, mintUrl, profile);
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
  // 思维链回传（逐模型 opt-in，纯配置闸门不看 tools）：reasoning_ack_field 非空时，把
  // buildMessages 挂的内部键 __reasoning 按该字段名写回 assistant 行（对话/压缩/标题回合同规则；
  // 没配/无思考的行零变化）。无论配与否都剥一遍 __reasoning，内部键不出仓库。
  if (body.messages && body.messages.length) {
    const ack = modelCfg.reasoning_ack_field;
    // 思考模式下带 tool_calls 的 assistant 行必须回传 reasoning_content：中途开启思考时，
    // 本轮早先的调用没有思维链，用空串占位（缺失会被上游 400，空串实测通过）。
    body.messages = body.messages.map(mm => {
      if (!mm || mm.role !== 'assistant') return mm;
      const fill = !!(opts.deepThink && ack && mm.tool_calls && !mm.__reasoning);
      if (!mm.__reasoning && !fill) return mm;
      const c = Object.assign({}, mm);
      if (ack) c[ack] = c.__reasoning || '';
      delete c.__reasoning;
      return c;
    });
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

module.exports = { callModel, buildMessages, buildSystemPrompt, systemPromptText, setSkillListText, setPayloadTrim, setProfilePrompts, encodeBlocks, decodeBlocks, compressMessages, titleMessages, patchImageReceipt };
