/**
 * 零依赖搜索核心：Parallel（默认，匿名免 key）与 Exa（备用）两个免费后端的统一封装。
 *
 * 只用 Node 内置 fetch，不依赖任何 npm 包。两个后端都是公开的免费 MCP 端点，
 * 本模块以 JSON-RPC `tools/call` 的方式直接调用它们，并归一化成统一的结果结构：
 * `{ url, title?, snippet?, publishedAt? }[]`。
 *
 * 上游实现参考：@sheep233_/dsh-web-search-free（github.com/sheep-programmer/dsh-web-search-free）。
 */

/** Parallel Web Search 免费 MCP 端点（匿名可用，OpenCode 默认后端之一）。 */
export const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp';
/** Exa 免费 MCP 端点（匿名可用；EXA_API_KEY 可提升限额）。 */
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';

const USER_AGENT = 'web-search-free/1.0.0';
/** 单次上游搜索请求的超时，避免远端挂起拖死 MCP 请求。 */
const REQUEST_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 30_000);

/**
 * 向免费 MCP 端点发一次 `tools/call`，返回工具结果里的 text 载荷。
 * 响应可能是裸 JSON，也可能是 SSE（`data: {...}`）分帧，两种都兼容。
 */
async function callMcpTool(endpoint, toolName, toolArgs, signal) {
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: toolArgs },
    }),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`${toolName} API error (HTTP ${response.status})`);
  }
  const text = extractToolText(await response.text());
  if (text === undefined) {
    throw new Error(`${toolName} returned no tool result`);
  }
  return text;
}

/** 从裸 JSON 或 SSE 文本中提取 MCP `tools/call` 的 result.content[].text。 */
export function extractToolText(body) {
  const parsePayload = (raw) => {
    try {
      const data = JSON.parse(raw);
      const item = data.result?.content?.find((c) => c.type === 'text' && typeof c.text === 'string');
      return item?.text || undefined;
    } catch {
      return undefined; // 不是 JSON 载荷，交给 SSE 行解析
    }
  };

  const trimmed = body.trim();
  if (trimmed.length > 0) {
    const direct = parsePayload(trimmed);
    if (direct !== undefined) return direct;
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = parsePayload(line.slice(6));
    if (data !== undefined) return data;
  }
  return undefined;
}

/** Parallel 响应解析：text 是内嵌 JSON `{ results: [...] }`。 */
export function mapParallelResponse(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Parallel search returned an unprocessable payload: ${String(error)}`);
  }
  const sources = [];
  for (const item of payload.results ?? []) {
    if (!item.url) continue;
    sources.push({
      url: item.url,
      ...(item.title ? { title: item.title } : {}),
      ...(item.excerpts?.length > 0 ? { snippet: item.excerpts.join(' ') } : {}),
      ...(item.publish_date ? { publishedAt: item.publish_date } : {}),
    });
  }
  return sources;
}

/**
 * Exa 响应解析：text 是纯文本块，每条结果以 `Title: ` 开头：
 * ```
 * Title: <标题>
 * URL: <链接>
 * Published: <日期 | N/A>
 * Author: <作者 | N/A>
 * Highlights:
 * <正文摘要>
 * ```
 */
export function parseExaText(text) {
  const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
  const sources = [];
  for (const block of blocks) {
    const url = block.match(/^URL: (\S+)$/m)?.[1];
    if (url === undefined) continue;
    const title = block.match(/^Title: (.+)$/m)?.[1]?.trim();
    const published = block.match(/^Published: (.+)$/m)?.[1]?.trim();
    const highlights = block.split(/^Highlights:\s*$/m)[1]?.trim();
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(highlights ? { snippet: highlights.slice(0, 500) } : {}),
      ...(published && published !== 'N/A' ? { publishedAt: published } : {}),
    });
  }
  return sources;
}

/** Parallel 搜索（默认免费后端）。 */
export async function parallelSearch(query, maxResults) {
  const text = await callMcpTool(PARALLEL_MCP_URL, 'web_search', {
    objective: query,
    search_queries: [query],
  }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  const sources = mapParallelResponse(text);
  return maxResults !== undefined ? sources.slice(0, maxResults) : sources;
}

/** Exa 搜索（备用免费后端；apiKey 可选，用于提升匿名限额）。 */
export async function exaSearch(query, maxResults, apiKey) {
  const endpoint = apiKey
    ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}`
    : EXA_MCP_URL;
  const text = await callMcpTool(endpoint, 'web_search_exa', {
    query,
    type: 'auto',
    numResults: maxResults ?? 8,
    livecrawl: 'fallback',
  }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  const sources = parseExaText(text);
  return maxResults !== undefined ? sources.slice(0, maxResults) : sources;
}
