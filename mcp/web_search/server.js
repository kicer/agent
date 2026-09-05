#!/usr/bin/env node
/**
 * MCP server 入口 —— 免费网页搜索（Parallel 默认 / Exa 备用，匿名免 key）。
 *
 * 本地重构版（上游：@sheep233_/dsh-web-search-free），零运行时依赖，直接 node 启动。
 *
 * ## 双传输
 * - **stdio**（默认）：`node server.js`
 *   - `claude mcp add web_search -- node <路径>/server.js`
 * - **HTTP/SSE**（监听端口）：`node server.js --http --port 3000 --host 0.0.0.0`
 *   - 兼容 Streamable HTTP（`POST /`）与老式 SSE（`GET /sse` + `POST /messages`）
 *   - `GET /` 或 `GET /health` 返回服务信息，可做健康检查
 *
 * 环境变量：EXA_API_KEY（可选，提升 Exa 匿名限额）；SEARCH_TIMEOUT_MS（可选，上游超时）。
 */
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SERVER_NAME, VERSION, dispatch } from './mcp.js';

// ── stdio 传输（默认）───────────────────────────────────────────────────────
function runStdio() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    void dispatch(trimmed).then((response) => {
      if (response != null) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
}

// ── HTTP/SSE 传输（--http [--port <n>] [--host <addr>]）──────────────────────
function runHttp(host, port) {
  /** sessionId → 老式 SSE 响应流（GET /sse 建立的连接）。 */
  const sseChannels = new Map();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // 健康检查 / 服务信息
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: SERVER_NAME, version: VERSION, transport: 'http/sse', port }));
      return;
    }

    // 老式 SSE 通道：GET /sse（MCP-Session-Id 关联后续 POST /messages）
    if (req.method === 'GET' && url.pathname === '/sse') {
      const sessionId = req.headers['mcp-session-id'] ?? randomUUID();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'mcp-session-id': sessionId,
      });
      res.write(`event: endpoint\ndata: /messages?session_id=${sessionId}\n\n`);
      sseChannels.set(sessionId, res);
      req.on('close', () => { sseChannels.delete(sessionId); });
      return;
    }

    // 消息端点：POST /（Streamable HTTP）与 POST /messages（老式 SSE）
    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/messages')) {
      const sessionId = req.headers['mcp-session-id'] ?? url.searchParams.get('session_id') ?? undefined;
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        void dispatch(body).then((response) => {
          if (response === null) { // 通知
            res.writeHead(202).end();
            return;
          }
          const payload = JSON.stringify(response);
          // 老式 SSE：结果推回通道连接
          if (url.pathname === '/messages' && sessionId !== undefined && sseChannels.has(sessionId)) {
            sseChannels.get(sessionId).write(`data: ${payload}\n\n`);
            res.writeHead(202, { 'mcp-session-id': sessionId }).end();
            return;
          }
          // Streamable HTTP：按 Accept 返回 SSE 帧或裸 JSON
          if (String(req.headers.accept ?? '').includes('text/event-stream')) {
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              ...(sessionId !== undefined ? { 'mcp-session-id': sessionId } : {}),
            });
            res.end(`data: ${payload}\n\n`);
            return;
          }
          res.writeHead(200, {
            'content-type': 'application/json',
            ...(sessionId !== undefined ? { 'mcp-session-id': sessionId } : {}),
          });
          res.end(payload);
        });
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'not found',
      hint: 'MCP endpoints: POST / (streamable http), GET /sse + POST /messages (legacy sse), GET / (info)',
    }));
  });

  server.listen(port, host, () => {
    process.stdout.write(`[web_search] HTTP/SSE listening on http://${host}:${port} (MCP: POST /, GET /sse + POST /messages)\n`);
  });
}

// ── 入口：参数解析 ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const httpMode = args.includes('--http')
  || (args.includes('--transport') && args[args.indexOf('--transport') + 1] === 'http');

const readFlag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

if (httpMode) {
  const port = Number(readFlag('--port', 3100));
  runHttp(readFlag('--host', '127.0.0.1'), Number.isFinite(port) ? port : 3100);
} else {
  runStdio();
}
