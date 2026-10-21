// 极简 MCP 客户端（Streamable HTTP：JSON-RPC over HTTP，无状态，响应可能是 SSE 帧包裹的 JSON）。
// MCP 服务在 config.yml 的 mcp_servers 中配置（可多个）：{name?, url, headers?, mode?, timeout_ms?, tools_allow?, tools_deny?}。
// 启动时 init() 对每个服务调 tools/list 发现工具（mode: disable 的服务跳过加载；配了 tools_allow/tools_deny
// 时按名单过滤），发现失败的服务按 2s / 20s / 1min 再试 3 次（容器并行启动/重启后的乱序兜底），转成 OpenAI function 格式，
// 追加在内置工具（definitions.json）之后一起随 system prompt 发给模型；
// mode: skill 的服务工具照常注册进 toolIndex（lab 可调），不追加进
// toolDefs，而是由 tools/skills.js 自动包装成技能（get 返回注册表里的原始 input_schema）。
// 工具调用经 tools/call 转发给对应服务。
// 与内置工具严格分离：本模块不碰内置定义；MCP 工具默认沿用原始名，
// 仅当与内置工具或其他 MCP 工具重名时加「服务名__」前缀。

const log = require('./log');

// 单次 tools/call 的缺省最大等待；服务配了 timeout_ms 就用服务的（config.js 已归一化）。
// 与 config.js 的 MCP_CALL_TIMEOUT_MS 保持一致。
const CALL_TIMEOUT_MS = 60000;

let toolDefs = [];                    // OpenAI function 格式（所有 MCP 工具）
const toolIndex = new Map();          // 发送名 -> { server, tool, def }（服务配置 + 原始工具名 + 原始契约）
let builtinNames = new Set();
let PUBLIC_BASE = ''; // core 自身公网前缀（loadConfig 已归一：VIRTUAL_HOST 优先 config.yml）；随每次请求 X-Public-Base 头下发

// 发一次 JSON-RPC 请求，返回 { result, headers }（HTTP 非 2xx / error / 无法解析时抛异常）。
// 某些 MCP 服务遵循 Streamable HTTP 规范会在 initialize 响应里返回 Mcp-Session-Id，
// 之后所有非 initialize 请求都必须带上该 header，否则返回 400。我们把会话 id 缓存在 server.sessionId 里。
// session 过期补偿：非 initialize 请求若 400 且错误信息含 session，清掉旧 id 并重新 initialize 后重试一次。
async function rpc(server, method, params, timeoutMs, extraHeaders) {
  const callId = Date.now();
  const ms = timeoutMs || 30000;
  const ctrl = new AbortController();
  // timedOut 用于把 AbortError（原生信息只说 "This operation was aborted"）翻成带秒数的超时信息：
  // 超时现在是可配的，不印出来的话排查时看不出当时配了多少。
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  try {
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    }, server.headers || {});
    // 会话上下文随请求下发（如 officecli 预览需要知道会话工作目录拼链接）；HTTP 头必须 ASCII，含非标字符则丢弃
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (typeof v === 'string' && /^[\x20-\x7e]+$/.test(v)) headers[k] = v;
      }
    }
    // 公网前缀单一真相随请求下发：给“要返回给人点的链接”的服务拼绝对 url（如 officecli 预览槽位），
    // 免得每个 MCP 服务各自配 env 记一遍 core 地址。
    if (PUBLIC_BASE) headers['X-Public-Base'] = PUBLIC_BASE;
    // initialize 请求自身不需要带 session id；其他请求如果该服务提供了 session id 则必须带
    if (method !== 'initialize' && server.sessionId) headers['Mcp-Session-Id'] = server.sessionId;
    const res = await fetch(server.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: callId, method, params: params || {} }),
    });
    const raw = await res.text();
    // 响应头里出现 Mcp-Session-Id 就缓存到 server（多处出现都被覆盖为最后一次，重复请求同一服务后保持一致）
    const sid = res.headers.get('mcp-session-id');
    if (sid) server.sessionId = sid;
    if (!res.ok) {
      // session 过期补偿：仅对非 initialize 请求，400 且错误信息含 session 时重新握手后重试一次。
      // 不调 tools/list —— 工具表在 init() 时已经发现并固化，运行期间不需要重新发现。
      if (method !== 'initialize' && res.status === 400 && /session/i.test(raw)) {
        clearTimeout(timer);
        log.warn('mcp', server.name + ' session 疑似过期，重新握手: ' + raw.slice(0, 200));
        server.sessionId = null;
        // 重新跑 initialize，递归走当前函数，method=initialize 不会再触发重连逻辑
        try {
          await rpc(server, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'agent', version: '1.0.0' },
          }, 15000);
          // 按 MCP 规范发 notifications/initialized（无响应体，失败不阻断）
          try { await rpc(server, 'notifications/initialized', {}, 5000); } catch (_) { /* 通知失败不阻断 */ }
        } catch (e) {
          // 老服务可能没有 initialize，会报 Method not found；不阻断，按既有兼容走原通道
          if (!/Method not found/i.test(String(e && e.message || e))) throw e;
        }
        // 重试原请求（新一次 fetch + 新 AbortController）
        return await rpc(server, method, params, ms, extraHeaders);
      }
      throw new Error('HTTP ' + res.status + ': ' + raw.slice(0, 300));
    }
    // 响应可能是 SSE 帧（多行 data: {...}），取 id 匹配或最后一条 JSON
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        try {
          const obj = JSON.parse(t.slice(5).trim());
          if (!payload || obj.id === callId) payload = obj;
        } catch (_) { /* 跳过非 JSON 帧 */ }
      }
    }
    if (!payload) throw new Error('响应无法解析：' + raw.slice(0, 300));
    if (payload.error) throw new Error('MCP 错误：' + JSON.stringify(payload.error).slice(0, 500));
    return payload.result;
  } catch (err) {
    // 只有定时器真的触发才改写；其余错误（HTTP 非 2xx、解析失败等）原样上抛。
    // 注意 session 重试分支已先 clearTimeout，不会误报成超时。
    if (timedOut) throw new Error('MCP 请求超时（' + ms + 'ms）：' + method + ' @ ' + server.url);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 启动发现失败后的重试阶梯（毫秒）：2s / 20s / 1min，共 3 次。
// 动机：compose 并行拉起容器、宿主机重启后容器顺序也不保证，而工具发现只在启动时跑一次；
// 不重试的话该服务会在这个进程的整个生命周期里缺席，只能重启 core 才能恢复。
const DISCOVERY_RETRY_DELAYS_MS = [2000, 20000, 60000];

// 发现单个服务的工具并并入工具表：成功返回 true，失败返回 false（不抛）。
// 对要求会话的服务，先发 initialize 拿到 Mcp-Session-Id，再发 notifications/initialized + tools/list。
async function loadServer(s) {
  // 清理上次会话 id（重启后服务端会拒绝旧 id；不清理会一直 400）
  s.sessionId = null;
  try {
    // 先 initialize：兼容要求会话的服务。strict 模式下服务端会返回 session id；
    // 不要求的服务也会正常响应（只是响应头里没有 mcp-session-id）。
    try {
      await rpc(s, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agent', version: '1.0.0' },
      }, 15000);
      // 按 MCP 规范：initialize 成功后发 notifications/initialized 通知（不需要 id，不期待响应体）
      try { await rpc(s, 'notifications/initialized', {}, 5000); } catch (_) { /* 通知失败不阻断 */ }
    } catch (e) {
      // 某些老服务（无 initialize）会报 Method not found；不阻断，走原 tools/list 路径
      if (!/Method not found/i.test(String(e && e.message || e))) throw e;
    }
    const result = await rpc(s, 'tools/list', {}, 15000);
    const all = (result && result.tools) || [];
    // 工具名单过滤（发生在重命名之前，按服务端的【原始工具名】匹配）：
    // allow 是白名单（配了就只保留名单内），deny 在其后叠加生效（deny 优先）。
    // 动机：单服务动辄二三十个工具全塞进每次模型请求（如浏览器类），只放行主循环用得上的。
    let tools = all;
    if (Array.isArray(s.tools_allow)) tools = tools.filter(t => s.tools_allow.includes(t && t.name));
    if (Array.isArray(s.tools_deny)) tools = tools.filter(t => !s.tools_deny.includes(t && t.name));
    let hidden = 0;
    for (const t of tools) {
      if (!t || !t.name) continue;
      let name = t.name;
      if (builtinNames.has(name) || toolIndex.has(name)) name = s.name + '__' + name;
      // 先进索引：mode=skill 的工具同样要能被 lab 调到，只是不下发。
      // 索引里连规范化后的契约一起留住，技能 get 时原样返回（单一份真相，不会跟 MCP 实现漂移）。
      const def = {
        name,
        description: t.description || t.title || '',
        parameters: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
      };
      toolIndex.set(name, { server: s, tool: t.name, def });
      if (s.mode === 'skill') { hidden++; continue; }
      toolDefs.push({ type: 'function', function: def });
    }
    let msg = s.name + ': 发现 ' + tools.length + ' 个工具' + (s.sessionId ? ' (session)' : '');
    if (tools.length !== all.length) msg += '（服务端共 ' + all.length + ' 个，已按 tools_allow/tools_deny 过滤）';
    if (hidden) msg += '（mode=skill：' + hidden + ' 个以技能形式暴露，不下发给模型）';
    log.info('mcp', msg);
    // 配了名单却一个都没过滤中，十有八九是名单里的名字跟 tools/list 返回不一致；
    // 不 warn 的话排查时只能对着「发现 0 个工具」干瞪眼。
    if (all.length && !tools.length && (s.tools_allow || s.tools_deny)) {
      log.warn('mcp', s.name + ': 名单过滤后剩 0 个工具，请核对 tools_allow/tools_deny 与 ' +
        '服务端实际工具名（如 ' + all.slice(0, 3).map(t => t.name).join(', ') + ' …）');
    }
    return true;
  } catch (err) {
    log.warn('mcp', s.name + ' 工具发现失败（' + (err && err.message || err) + '）');
    return false;
  }
}

// 对启动时发现失败的服务按阶梯重试；成功后工具立即并入工具表，模型的下一轮请求即可见。
function retryFailed(failed) {
  let pending = failed.slice();
  const attempt = (i) => {
    const timer = setTimeout(async () => {
      if (!pending.length) return;
      log.info('mcp', '重试工具发现 第 ' + (i + 1) + '/' + DISCOVERY_RETRY_DELAYS_MS.length + ' 次: ' +
        pending.map(s => s.name).join(', '));
      const still = [];
      for (const s of pending) {
        if (!(await loadServer(s))) still.push(s);
      }
      pending = still;
      if (!pending.length) {
        log.info('mcp', '重试成功：失败服务的工具已并入');
      } else if (i + 1 < DISCOVERY_RETRY_DELAYS_MS.length) {
        attempt(i + 1);
      } else {
        log.warn('mcp', '重试结束仍不可用: ' + pending.map(s => s.name).join(', ') +
          '（服务恢复后需重启 core 才能加载其工具）');
      }
    }, DISCOVERY_RETRY_DELAYS_MS[i]);
    // 不因待重试的定时器拖住进程退出（测试、一次性脚本里尤其明显）
    if (timer.unref) timer.unref();
  };
  attempt(0);
}

// 发现所有 MCP 服务的工具。单个服务失败只警告，不影响其他服务与内置工具，并进入重试阶梯。
async function init(cfg) {
  toolDefs = [];
  toolIndex.clear();
  PUBLIC_BASE = (cfg && cfg.public_link && cfg.public_link.base_url) || '';
  try {
    for (const d of require('./tools/definitions.json')) {
      if (d.function && d.function.name) builtinNames.add(d.function.name);
    }
  } catch (_) { /* 内置定义读不到就不做重名保护 */ }

  const servers = (cfg && cfg.mcp_servers) || [];
  const failed = [];
  for (const s of servers) {
    // mode: disable 时启动不加载该服务（不建工具表；配置保留，改回 advertise 重启后恢复）
    if (s.mode === 'disable') {
      log.info('mcp', s.name + ': mode=disable，跳过工具加载');
      continue;
    }
    if (!(await loadServer(s))) failed.push(s);
  }
  if (failed.length) retryFailed(failed);
}

// 随请求发送的 MCP 工具定义（追加在内置工具之后）。
function toolDefinitions() { return toolDefs; }

function hasTool(name) { return toolIndex.has(name); }

// mode=skill 的工具：不进 tools 数组，由 skills.js 包装成技能（list/get/run）。
// 名字一律用最终可调用名（含重名时的 server__ 前缀），否则模型拿到的是调不通的名字。
function skillTools() {
  const out = [];
  for (const [name, e] of toolIndex) {
    if (!e || !e.server || e.server.mode !== 'skill' || !e.def) continue;
    out.push({ name, description: e.def.description, parameters: e.def.parameters, server: e.server.name, tool: e.tool });
  }
  return out;
}

// 只认 mode=skill：advertise 的工具已经直接下发给模型，不必再绕技能这一层。
function getSkillTool(name) {
  const key = String(name == null ? '' : name).trim();
  const e = toolIndex.get(key);
  if (!e || !e.server || e.server.mode !== 'skill' || !e.def) return null;
  return { name: key, description: e.def.description, parameters: e.def.parameters, server: e.server.name, tool: e.tool };
}

// 把工具调用转发给对应 MCP 服务，返回给模型的文本结果。
// 超时取该服务的 timeout_ms（config.js 里归一化 + 夹过区间）；这里再兜一次底，
// 兼容没走配置加载的调用方（如测试里手搓的 cfg）。
async function callTool(name, args, ctx) {
  const entry = toolIndex.get(name);
  if (!entry) return 'Error: 未知 MCP 工具 ' + name;
  let result;
  try {
    result = await rpc(entry.server, 'tools/call', { name: entry.tool, arguments: args || {} },
      Number(entry.server.timeout_ms) || CALL_TIMEOUT_MS,
      // 会话工作目录随请求下发（officecli 预览把裸文件名/相对路径补全会话目录；其它服务忽略此头）
      ctx && ctx.taskDir ? { 'X-Session-Dir': String(ctx.taskDir) } : null);
  } catch (err) {
    return 'MCP ' + entry.server.name + '/' + entry.tool + ' 调用失败: ' + (err && err.message || err);
  }
  const content = result && result.content;
  if (Array.isArray(content)) {
    // 通用 UI 卡片块（type==="ui_card"）：剥离后不进模型面（下一行只拼 text），整块交 ctx.onCard（任意服务/工具可产出，engine 注入 → bus SSE 给前端）
    if (ctx && typeof ctx.onCard === "function") {
      for (const c of content) if (c && c.type === "ui_card") {
        try { ctx.onCard(Object.assign({}, c, { from: entry.server.name + "/" + entry.tool })); } catch (_) { /* 卡片是增强，不影响工具结果 */ }
      }
    }
    const text = content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
    if (text) return text;
  }
  return JSON.stringify(result).slice(0, 20000);
}

// 会话生命周期等后台场景的尽力通知：向声明了该工具的 MCP 服务发一次 tools/call。
// 工具没注册/服务异常都只留日志，绝不把异常或延迟带给调用方。
async function notifyTool(name, args, timeoutMs, extraHeaders) {
  const entry = toolIndex.get(name);
  if (!entry) return false;
  try {
    await rpc(entry.server, 'tools/call', { name: entry.tool, arguments: args || {} }, Number(timeoutMs) || 5000, extraHeaders);
    return true;
  } catch (e) {
    log.info('mcp', 'notifyTool ' + name + ' 失败(尽力而为): ' + (e && e.message || e));
    return false;
  }
}

module.exports = { init, toolDefinitions, hasTool, skillTools, getSkillTool, callTool, notifyTool };
