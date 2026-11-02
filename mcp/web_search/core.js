/**
 * 零依赖搜索核心：三路上游，统一归一化成 `{ url, title?, snippet?, publishedAt? }[]`。
 *
 * - 自定义上游（`X-Web-Search-Base-Url` + `Authorization`）：任意 `POST {base}/search`，
 *   请求体 `{ query, max_results }`、响应 `{ results: [{ title, url, snippet }] }`。
 * - Parallel（免费匿名 MCP 端点，默认后端）。
 * - Exa（免费 MCP 端点，Parallel 挂掉时的兜底）。
 *
 * 只用 Node 内置 fetch，不依赖任何 npm 包。免费侧两个后端都是公开的 MCP 端点，
 * 本模块以 JSON-RPC `tools/call` 的方式直接调用它们。
 *
 * 上游实现参考：@sheep233_/dsh-web-search-free（github.com/sheep-programmer/dsh-web-search-free）。
 */

/** Parallel Web Search 免费 MCP 端点（匿名可用，OpenCode 默认后端之一）。 */
export const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp';
/** Exa 免费 MCP 端点（匿名可用；EXA_API_KEY 可提升限额）。 */
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';

const USER_AGENT = 'web_search/1.1.0';
/** 单次上游搜索请求的超时，避免远端挂起拖死 MCP 请求。 */
const REQUEST_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 30_000);
/**
 * snippet 一律截断：搜索结果会进历史，之后每一轮都可能被整条重放。
 * 有些上游（如自建 v1/search）的 snippet 是整段正文，不截等于白烧 token。
 */
const SNIPPET_MAX_CHARS = 500;

/** 压平空白并截断；空串返回 ''（调用方据此决定要不要带这个字段）。 */
export function capSnippet(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > SNIPPET_MAX_CHARS ? s.slice(0, SNIPPET_MAX_CHARS) + '…' : s;
}

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

/**
 * 自定义上游：`POST {base}/search`，body `{ query, max_results }`。
 * 配置了地址就以它为准——失败直接抛错，不静默退回免费后端（否则 key 过期/base 写错
 * 只会表现为「结果质量突然变差」，永远没人发现）。
 * @param {{ auth: string, base: string }} up 由 mcp.js 从请求 header 解析（容器不存密钥）
 */
export async function customSearch(query, maxResults, up) {
  const url = up.base.replace(/\/+$/, '') + '/search';
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json',
    'user-agent': USER_AGENT,
  };
  // 免鉴权的自建服务可省；有值才带，避免给上游塞一个空 Authorization 反而被拒
  if (up.auth) headers.authorization = up.auth;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      // 不跟随跳转：Authorization 不能被顺手带到别的地址去
      redirect: 'error',
      headers,
      body: JSON.stringify({ query, max_results: maxResults }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`搜索上游请求失败（${url}）：${String(error && error.message || error)}`);
  }
  const raw = await response.text();
  if (!response.ok) {
    // 带上游响应片段：401 和 500 的处置完全不同，只说「请求失败」没法排查
    const detail = capSnippet(raw).slice(0, 200);
    throw new Error(`搜索上游 HTTP ${response.status}${detail ? '：' + detail : ''}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`搜索上游返回了无法解析的响应：${String(error)}`);
  }
  const sources = [];
  for (const item of payload.results ?? []) {
    if (!item || !item.url) continue;
    const snippet = capSnippet(item.snippet);
    const publishedAt = item.published_at ?? item.publishedAt ?? item.publish_date;
    sources.push({
      url: String(item.url),
      ...(item.title ? { title: String(item.title) } : {}),
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt: String(publishedAt) } : {}),
    });
  }
  return maxResults !== undefined ? sources.slice(0, maxResults) : sources;
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

/**
 * 免费侧入口：Parallel 优先，失败自动退 Exa。
 * 降级放在服务端（而不是让模型显式传 provider）——模型看不到后端，也就不会选错。
 * @param {string} [exaApiKey] 可选，提升 Exa 匿名限额
 */
export async function freeSearch(query, maxResults, exaApiKey) {
  try {
    return await parallelSearch(query, maxResults);
  } catch (first) {
    try {
      return await exaSearch(query, maxResults, exaApiKey);
    } catch (second) {
      throw new Error(`免费搜索后端均不可用（parallel: ${String(first && first.message || first)}；` +
        `exa: ${String(second && second.message || second)}）`);
    }
  }
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
