/**
 * MCP（Model Context Protocol）协议层：工具清单 + JSON-RPC 分发。
 *
 * 与传输无关（stdio / HTTP 都在 server.js 里），只负责把一条 JSON-RPC
 * 消息变成 JSON-RPC 响应。支持的 method：initialize / tools/list / tools/call / ping。
 *
 * 上游参数逐请求从 HTTP header 取（与 mcp/asr、mcp/image_task 同构）：
 *   X-Web-Search-Base-Url: https://<host>/v1   → 打 {base}/search（配了就用它，不降级）
 *   Authorization: Bearer <key>                 → 可选，裸 key 自动补 Bearer
 * 两者都不配 = 内置免费后端（Parallel → Exa）。stdio 模式没有 header，因此只有免费后端。
 */
import { customSearch, freeSearch } from './core.js';

export const SERVER_NAME = 'web_search';
export const VERSION = '1.1.0';
const DEFAULT_PROTOCOL = '2025-03-26';
const HDR_AUTH = 'authorization';
const HDR_BASE = 'x-web-search-base-url';

/** 暴露给 MCP 客户端的工具清单。 */
const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web. Returns results with title, url, snippet and (when available) publishedAt.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        numResults: { type: 'integer', minimum: 1, default: 8, description: 'Maximum number of results to return (default 8)' },
      },
      required: ['query'],
    },
  },
];

/** 从请求 header 取上游两要素；Authorization 允许写裸 key（自动补 Bearer）。 */
function upstreamOf(headers) {
  const h = headers || {};
  const raw = String(h[HDR_AUTH] || '').trim();
  return {
    auth: raw ? (/^bearer\s/i.test(raw) ? raw : 'Bearer ' + raw) : '',
    base: String(h[HDR_BASE] || '').trim().replace(/\/+$/, ''),
  };
}

/** 配了地址就必须是完整 http(s)：不能是相对路径，也不能把 key 发到别的协议上。 */
function assertBase(base) {
  let u = null;
  try { u = new URL(base); } catch (_) { u = null; }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
    throw new Error('X-Web-Search-Base-Url 必须是完整的 http(s) 地址，如 https://<host>/v1');
  }
}

/** 执行一次 tools/call；失败时抛 { code, message } 表示协议级错误。 */
async function callTool(name, args, headers) {
  if (name !== 'web_search') throw { code: -32602, message: `unknown tool: ${name}` };

  const params = args ?? {};
  const query = typeof params.query === 'string' && params.query.trim().length > 0
    ? params.query.trim()
    : null;
  if (query === null) throw { code: -32602, message: 'query is required' };

  const numResults = typeof params.numResults === 'number' && Number.isFinite(params.numResults)
    ? Math.max(1, Math.floor(params.numResults))
    : 8;

  const up = upstreamOf(headers);
  let sources;
  try {
    if (up.base) {
      assertBase(up.base);
      sources = await customSearch(query, numResults, up);
    } else {
      sources = await freeSearch(query, numResults, process.env.EXA_API_KEY);
    }
  } catch (error) {
    // 工具级错误回文本、协议层仍成功：模型能读懂并换查询/换工具，
    // 回 JSON-RPC error 只会被 core 拼成「调用失败」，模型反而不好自纠。
    return {
      isError: true,
      content: [{ type: 'text', text: 'Error: ' + String(error && error.message || error) }],
    };
  }

  return { content: [{ type: 'text', text: JSON.stringify(sources, null, 2) }] };
}

/** 处理一条请求消息，返回 result；失败时抛 { code, message }。 */
async function handleRequest(message, headers) {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: VERSION },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(message.params?.name, message.params?.arguments, headers);
    case 'ping':
      return {};
    default:
      throw { code: -32601, message: `method not found: ${String(message.method)}` };
  }
}

/**
 * 解析并执行一条 JSON 消息。
 * @param {string} raw JSON-RPC 文本
 * @param {object} [headers] 本次 HTTP 请求的 header（stdio 模式没有，上游参数就走免费后端）
 * @returns 响应信封对象；notification（无 id）返回 null；非法 JSON 返回 undefined。
 */
export async function dispatch(raw, headers) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (message.id === undefined) return null; // 通知不响应
  try {
    return { jsonrpc: '2.0', id: message.id, result: await handleRequest(message, headers) };
  } catch (error) {
    const e = error;
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: typeof e.code === 'number' ? e.code : -32603, message: String(e.message ?? error) },
    };
  }
}
