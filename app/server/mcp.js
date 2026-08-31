// 极简 MCP 客户端（Streamable HTTP：JSON-RPC over HTTP，无状态，响应可能是 SSE 帧包裹的 JSON）。
// MCP 服务在 config.yml 的 mcp_servers 中配置（可多个）：{name?, url, headers?}。
// 启动时 init() 对每个服务调 tools/list 发现工具，转成 OpenAI function 格式，
// 追加在内置工具（definitions.json）之后一起随 system prompt 发给模型；
// 工具调用经 tools/call 转发给对应服务。
// 与内置工具严格分离：本模块不碰内置定义；MCP 工具默认沿用原始名，
// 仅当与内置工具或其他 MCP 工具重名时加「服务名__」前缀。

let toolDefs = [];                    // OpenAI function 格式（所有 MCP 工具）
const toolIndex = new Map();          // 发送名 -> { server, tool }（服务配置 + 原始工具名）
let builtinNames = new Set();

// 发一次 JSON-RPC 请求，返回 result（HTTP 非 2xx / error / 无法解析时抛异常）。
async function rpc(server, method, params, timeoutMs) {
  const callId = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(server.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      }, server.headers || {}),
      body: JSON.stringify({ jsonrpc: '2.0', id: callId, method, params: params || {} }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + raw.slice(0, 300));
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
  } finally {
    clearTimeout(timer);
  }
}

// 发现所有 MCP 服务的工具。单个服务失败只警告，不影响其他服务与内置工具。
async function init(cfg) {
  toolDefs = [];
  toolIndex.clear();
  try {
    for (const d of require('./tools/definitions.json')) {
      if (d.function && d.function.name) builtinNames.add(d.function.name);
    }
  } catch (_) { /* 内置定义读不到就不做重名保护 */ }

  const servers = (cfg && cfg.mcp_servers) || [];
  for (const s of servers) {
    try {
      const result = await rpc(s, 'tools/list', {}, 15000);
      const tools = (result && result.tools) || [];
      for (const t of tools) {
        if (!t || !t.name) continue;
        let name = t.name;
        if (builtinNames.has(name) || toolIndex.has(name)) name = s.name + '__' + name;
        toolIndex.set(name, { server: s, tool: t.name });
        toolDefs.push({
          type: 'function',
          function: {
            name,
            description: t.description || t.title || '',
            parameters: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
          },
        });
      }
      console.log('[mcp] ' + s.name + ': 发现 ' + tools.length + ' 个工具');
    } catch (err) {
      console.error('[mcp] ' + s.name + ' 工具发现失败（本轮运行该服务不可用）: ' + (err && err.message || err));
    }
  }
}

// 随请求发送的 MCP 工具定义（追加在内置工具之后）。
function toolDefinitions() { return toolDefs; }

function hasTool(name) { return toolIndex.has(name); }

// 把工具调用转发给对应 MCP 服务，返回给模型的文本结果。
async function callTool(name, args) {
  const entry = toolIndex.get(name);
  if (!entry) return 'Error: 未知 MCP 工具 ' + name;
  let result;
  try {
    result = await rpc(entry.server, 'tools/call', { name: entry.tool, arguments: args || {} }, 60000);
  } catch (err) {
    return 'MCP ' + entry.server.name + '/' + entry.tool + ' 调用失败: ' + (err && err.message || err);
  }
  const content = result && result.content;
  if (Array.isArray(content)) {
    const text = content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
    if (text) return text;
  }
  return JSON.stringify(result).slice(0, 20000);
}

module.exports = { init, toolDefinitions, hasTool, callTool };
