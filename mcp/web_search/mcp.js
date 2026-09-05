/**
 * MCP（Model Context Protocol）协议层：工具清单 + JSON-RPC 分发。
 *
 * 与传输无关（stdio / HTTP 都在 server.js 里），只负责把一条 JSON-RPC
 * 消息变成 JSON-RPC 响应。支持的 method 与上游 dsh-web-search-free 一致：
 * initialize / tools/list / tools/call / ping。
 */
import { parallelSearch, exaSearch } from './core.js';

export const SERVER_NAME = 'web_search';
export const VERSION = '1.0.0';
const DEFAULT_PROTOCOL = '2025-03-26';

/** 暴露给 MCP 客户端的工具清单。 */
const TOOLS = [
  {
    name: 'web_search',
    description: 'Free web search tool. Uses Parallel by default or Exa as fallback. Returns an array of results with title, url, snippet, and publishedAt.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        provider: { type: 'string', enum: ['parallel', 'exa'], description: "Backend provider: 'parallel' (default) or 'exa' (fallback)" },
        numResults: { type: 'integer', minimum: 1, default: 8, description: 'Maximum number of results to return (default 8)' },
      },
      required: ['query'],
    },
  },
];

/** 执行一次 tools/call；失败时抛 { code, message } 表示工具级错误。 */
async function callTool(name, args) {
  if (name !== 'web_search') throw { code: -32602, message: `unknown tool: ${name}` };

  const params = args ?? {};
  const query = typeof params.query === 'string' && params.query.trim().length > 0
    ? params.query.trim()
    : null;
  if (query === null) throw { code: -32602, message: 'query is required' };

  const provider = params.provider === 'exa' ? 'exa' : 'parallel';
  const numResults = typeof params.numResults === 'number' && Number.isFinite(params.numResults)
    ? Math.max(1, Math.floor(params.numResults))
    : 8;

  const sources = provider === 'exa'
    ? await exaSearch(query, numResults, process.env.EXA_API_KEY)
    : await parallelSearch(query, numResults);

  return { content: [{ type: 'text', text: JSON.stringify(sources, null, 2) }] };
}

/** 处理一条请求消息，返回 result；失败时抛 { code, message }。 */
async function handleRequest(message) {
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
      return callTool(message.params?.name, message.params?.arguments);
    case 'ping':
      return {};
    default:
      throw { code: -32601, message: `method not found: ${String(message.method)}` };
  }
}

/**
 * 解析并执行一条 JSON 消息。
 * @returns 响应信封对象；notification（无 id）返回 null；非法 JSON 返回 undefined。
 */
export async function dispatch(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (message.id === undefined) return null; // 通知不响应
  try {
    return { jsonrpc: '2.0', id: message.id, result: await handleRequest(message) };
  } catch (error) {
    const e = error;
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: typeof e.code === 'number' ? e.code : -32603, message: String(e.message ?? error) },
    };
  }
}
