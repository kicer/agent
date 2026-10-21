#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const ZHIPU_SUBMIT_URL =
  "https://open.bigmodel.cn/api/paas/v4/videos/generations";
const ZHIPU_QUERY_URL = (id) =>
  `https://open.bigmodel.cn/api/paas/v4/async-result/${encodeURIComponent(id)}`;

// 默认模型：cogvideox-flash
const DEFAULT_MODEL = "cogvideox-flash";

// AI 不可见的服务端默认（可被同名 header 覆盖）
const DEFAULT_QUALITY = "speed";       // speed | quality
const DEFAULT_FPS = 30;                // 30 | 60
const DEFAULT_WATERMARK_ENABLED = true; // 平台政策默认 true

// submit/query 都是快接口，卡住基本等于上游挂了；限时避免工具调用被拖死
const UPSTREAM_TIMEOUT_MS = 30_000;

// ── 优雅退出 ──────────────────────────────────────────────────────────────
// 容器里 node 以 PID 1 运行且未注册 SIGTERM 处理器时，内核不会对其执行默认
// 终止动作，docker stop/restart 会白等满 10s 宽限期才被 SIGKILL。
// 显式注册处理器，关闭 MCP session 与长连接后立即退出；3s 定时器为兜底。
let httpServer = null;
let closeAllSessions = () => {};
let shuttingDown = false;

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[video] received ${sig}, shutting down`);
  closeAllSessions();
  if (!httpServer) process.exit(0); // stdio 模式无监听，直接退
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function parseArgs(argv) {
  const args = {
    http: false,
    port: 3000,
    host: "0.0.0.0",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--port") args.port = parseInt(argv[++i], 10);
    else if (a === "--host") args.host = argv[++i];
  }
  return args;
}

function pickToken(headers) {
  if (!headers) return null;
  const candidates = [
    headers["x-video-task-token"],
    headers["x-mcp-token"],
    headers["authorization"],
  ];
  for (const v of candidates) {
    if (!v) continue;
    const s = String(v).trim();
    if (!s) continue;
    if (/^Bearer\s+/i.test(s)) {
      const t = s.replace(/^Bearer\s+/i, "").trim();
      if (t) return t;
    } else {
      return s;
    }
  }
  return null;
}

function pickModel(headers) {
  if (!headers) return null;
  const v =
    headers["x-video-task-model"] ||
    headers["x-mcp-model"] ||
    headers["x-model"];
  if (!v) return null;
  const s = String(v).trim();
  return s || null;
}

function pickHeaderString(headers, name, fallback) {
  if (!headers) return fallback;
  const v = headers[name];
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

function pickHeaderInt(headers, name, fallback) {
  if (!headers) return fallback;
  const v = headers[name];
  if (v === undefined || v === null) return fallback;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function pickHeaderBool(headers, name, fallback) {
  if (!headers) return fallback;
  const v = headers[name];
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return fallback;
}

async function callZhipu({ url, token, method = "POST", body }) {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    // AbortSignal.timeout 中止时抛 TimeoutError/AbortError，转成明确的超时错误
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(`Upstream request timed out after ${UPSTREAM_TIMEOUT_MS} ms`);
    }
    throw e;
  }
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const err = new Error(
      `Zhipu API error: ${resp.status} ${resp.statusText} - ${text}`
    );
    err.status = resp.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// ===== op=create：提交视频生成（同步只提交，立刻返回）=====
async function submitVideo({
  token,
  model,
  prompt,
  image_url,
  quality,
  with_audio,
  fps,
  watermark_enabled,
}) {
  // 平台要求 image_url 和 prompt 至少传一个（handler 侧已校验）
  const body = {
    model,
    quality,
    with_audio: Boolean(with_audio),
    watermark_enabled: Boolean(watermark_enabled),
    fps,
    // 由服务端生成唯一 request_id，便于日志关联；不暴露给 AI
    request_id: randomUUID(),
  };
  if (prompt) body.prompt = prompt;
  if (image_url) body.image_url = image_url;

  return await callZhipu({ url: ZHIPU_SUBMIT_URL, token, body });
  // { model, id, request_id, task_status }
}

// ===== op=get：查询异步结果（单次拉取，不内部轮询）=====
async function queryAsyncResult({ token, id }) {
  return await callZhipu({
    url: ZHIPU_QUERY_URL(id),
    token,
    method: "GET",
  });
  // { id, request_id, model, task_status, video_result?, ... }
}

// ---------- op=create 的业务处理 ----------
async function handleCreate({ args, headers, token }) {
  if (!args.prompt && !args.image_url) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: 'op=create requires at least one of "prompt" or "image_url".',
        },
      ],
    };
  }

  // AI 不可见：全部走 header
  const model = pickModel(headers) || DEFAULT_MODEL;
  const quality = pickHeaderString(
    headers,
    "x-video-task-quality",
    DEFAULT_QUALITY
  );
  const fps = pickHeaderInt(headers, "x-video-task-fps", DEFAULT_FPS);
  const watermark_enabled = pickHeaderBool(
    headers,
    "x-video-task-watermark",
    DEFAULT_WATERMARK_ENABLED
  );

  try {
    const data = await submitVideo({
      token,
      model,
      prompt: args.prompt,
      image_url: args.image_url,
      quality,
      with_audio: args.with_audio ?? false,
      fps,
      watermark_enabled,
    });

    const summary =
      `Model: ${model}\n` +
      `task_id: ${data.id}\n` +
      `request_id: ${data.request_id}\n` +
      `task_status: ${data.task_status}\n` +
      `\n` +
      `Video generation is asynchronous. ` +
      `Call this tool again with op="get" and task_id="${data.id}" to fetch the result.`;

    return { content: [{ type: "text", text: summary }] };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to submit video task: ${e.message}${
            e.detail ? `\nDetails: ${JSON.stringify(e.detail)}` : ""
          }`,
        },
      ],
    };
  }
}

// ---------- op=get 的业务处理 ----------
async function handleGet({ args, token }) {
  if (!args.task_id) {
    return {
      isError: true,
      content: [{ type: "text", text: 'op=get requires "task_id".' }],
    };
  }

  try {
    const data = await queryAsyncResult({ token, id: args.task_id });
    const status = data.task_status || "UNKNOWN";

    if (status === "SUCCESS") {
      const v = (data.video_result || [])[0];
      if (!v || !v.url) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Task succeeded but no video URL returned. Raw: ${JSON.stringify(
                data
              )}`,
            },
          ],
        };
      }
      const summary =
        `task_id: ${data.id}\n` +
        `model: ${data.model}\n` +
        `task_status: SUCCESS\n` +
        `Video URL: ${v.url}\n` +
        (v.cover_image_url ? `Cover: ${v.cover_image_url}\n` : "");
      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: v.url },
        ],
      };
    }

    // PROCESSING / FAIL / 其他：原样返回关键字段
    const errBlock = data.error ? `\nerror: ${JSON.stringify(data.error)}` : "";
    return {
      isError: status === "FAIL",
      content: [
        {
          type: "text",
          text:
            `task_id: ${data.id}\n` +
            `model: ${data.model}\n` +
            `task_status: ${status}` +
            errBlock,
        },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to query video task: ${e.message}${
            e.detail ? `\nDetails: ${JSON.stringify(e.detail)}` : ""
          }`,
        },
      ],
    };
  }
}

function buildServer() {
  const server = new McpServer(
    { name: "video_task", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.tool(
    "video_task",
    `AI video generation.

op=create  Submit a new task. Returns a task_id immediately; generation runs asynchronously.
           Requires at least one of prompt or image_url.
           - text-to-video: pass prompt only.
           - image-to-video: also pass image_url.
op=get     Fetch the status of a previously submitted task. Requires task_id.
           On SUCCESS, returns the video URL.

Typical flow: call op=create, then call op=get with the returned task_id until task_status is SUCCESS or FAIL.`,
    {
      op: z.enum(["create", "get"]).describe("Operation to perform."),
      prompt: z
        .string()
        .max(512)
        .optional()
        .describe(
          "Video text description (max 512 chars). Used with op=create. When combined with image_url it serves as the motion/action description."
        ),
      image_url: z
        .string()
        .url()
        .optional()
        .describe(
          "Reference image for image-to-video. Used with op=create. Must be a publicly reachable URL to a png/jpeg/jpg <= 5MB (for local files, first use the agent's built-in tool to mint a public temporary URL)."
        ),
      with_audio: z
        .boolean()
        .optional()
        .describe(
          "Whether to generate AI audio. Used with op=create. Default false."
        ),
      task_id: z
        .string()
        .min(1)
        .optional()
        .describe("task_id returned by op=create. Required when op=get."),
    },
    async (args, extra) => {
      const headers = extra?.requestInfo?.headers;
      const token = pickToken(headers);
      if (!token) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing authentication token." }],
        };
      }

      switch (args.op) {
        case "create":
          return await handleCreate({ args, headers, token });
        case "get":
          return await handleGet({ args, token });
        default:
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Unknown op "${args.op}" (available: create, get).`,
              },
            ],
          };
      }
    }
  );

  return server;
}

async function startHttp({ port, host }) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // session -> { server, transport } 映射
  const sessions = new Map();

  closeAllSessions = () => {
    for (const { server, transport } of sessions.values()) {
      try {
        transport.close();
      } catch {}
      try {
        server.close();
      } catch {}
    }
    sessions.clear();
    // 掰掉未关闭的 SSE / keep-alive 连接，否则 httpServer.close() 回调不会触发
    httpServer?.closeAllConnections?.();
  };

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "video_task", sessions: sessions.size });
  });

  async function handleSessionRequest(req, res) {
    const sessionId = req.headers["mcp-session-id"];

    // 已有 session：复用 transport
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // 新 session：必须是 initialize 请求
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Bad Request: missing valid Mcp-Session-Id for non-initialize request",
        },
        id: req.body?.id ?? null,
      });
      return;
    }

    const newId = randomUUID();
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newId,
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  // POST /mcp: 主入口
  app.post("/mcp", handleSessionRequest);

  // GET /mcp & DELETE /mcp: 用于 SSE 流 / 会话关闭
  const handleOther = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", handleOther);
  app.delete("/mcp", handleOther);

  httpServer = app.listen(port, host, () => {
    console.log(
      `[video] MCP HTTP server listening on http://${host}:${port}/mcp`
    );
  });
}

async function startStdio() {
  const server = buildServer();
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[video] MCP stdio server started");
}

const args = parseArgs(process.argv.slice(2));
if (args.http) {
  startHttp({ port: args.port, host: args.host }).catch((e) => {
    console.error("[video] failed to start http server:", e);
    process.exit(1);
  });
} else {
  startStdio().catch((e) => {
    console.error("[video] failed to start stdio server:", e);
    process.exit(1);
  });
}
