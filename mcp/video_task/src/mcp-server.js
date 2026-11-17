#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// 上游必须是 OpenAI 兼容的视频端点：提交 POST /videos/generations，查询 GET /videos/{task_id}。
// Base-Url / 模型 / 凭据全部由调用方随每个请求用 header 带入（X-Video-Task-Base-Url /
// X-Video-Task-Model / Authorization），服务自己不存、也不预设任何厂商。

// 提交与查询都是快接口（wait=false 立刻回 task_id），卡住基本等于上游挂了。
const UPSTREAM_TIMEOUT_MS = 60_000;

// ── 优雅退出 ──────────────────────────────────────────────────────────────
// 容器里 node 以 PID 1 运行且未注册 SIGTERM 处理器时，内核不会对其执行默认
// 终止动作，docker stop/restart 会白等满 10s 宽限期才被 SIGKILL。
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
  const args = { http: false, port: 3000, host: "0.0.0.0" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--port") args.port = parseInt(argv[++i], 10);
    else if (a === "--host") args.host = argv[++i];
  }
  return args;
}

// 对外只有三个 header：Authorization / X-Video-Task-Base-Url / X-Video-Task-Model。
function pickAuthToken(headers) {
  if (!headers) return null;
  const s = String(headers["authorization"] || "").trim();
  if (!s) return null;
  if (/^Bearer\s+/i.test(s)) {
    const t = s.replace(/^Bearer\s+/i, "").trim();
    return t || null;
  }
  return s;
}

function pickHeaderString(headers, name) {
  if (!headers) return null;
  const v = headers[name];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function pickBaseUrl(headers) {
  return pickHeaderString(headers, "x-video-task-base-url");
}

function pickModel(headers) {
  return pickHeaderString(headers, "x-video-task-model");
}

// 解析 Base-Url：必须是完整 http(s) URL。允许调用方直接填到 /videos/generations
// 或 /videos（照抄文档的写法），统一剥回 base——否则查询会被拼成两条路径。
function resolveBaseUrl(rawBase) {
  const base = String(rawBase || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "Missing X-Video-Task-Base-Url: pass the upstream base URL (e.g. https://<host>/v1)."
    );
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(
      `Invalid X-Video-Task-Base-Url "${base}": must be a full http(s) URL.`
    );
  }
  return base.replace(/\/videos(\/generations)?$/i, "");
}

// 模型只由 header 决定，AI 看不到也填不了。不猜缺省值：猜错只会换来含义不明的 400。
function resolveModel(headers) {
  const model = pickModel(headers);
  if (!model) {
    throw new Error("Missing X-Video-Task-Model: pass the upstream model name.");
  }
  return model;
}

// 一次解析出本次请求的上游、凭据、模型。配置问题同步抛错，直接回给调用方。
function resolveTarget(headers) {
  const token = pickAuthToken(headers);
  if (!token) {
    throw new Error('Missing Authorization: use "Authorization: Bearer <token>".');
  }
  return {
    base: resolveBaseUrl(pickBaseUrl(headers)),
    token,
    model: resolveModel(headers),
  };
}

// 统一的上游请求：超时、错误体解析都在这层，提交与查询共用。
async function callUpstream({ url, token, method = "POST", body }) {
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
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
    const err = new Error(`Upstream error: ${resp.status} ${resp.statusText} - ${text}`);
    err.status = resp.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// ===== op=create：提交视频生成（wait=false，立刻返回 task_id）=====
async function submitVideo({ base, token, model, prompt, image_url, seconds, aspect_ratio, resolution, negative_prompt, enable_audio }) {
  const body = { model, wait: false };
  if (prompt) body.prompt = prompt;
  if (image_url) body.image = image_url; // OpenAI Videos 口径的参考图字段
  if (seconds !== undefined) body.seconds = seconds;
  if (aspect_ratio) body.aspect_ratio = aspect_ratio;
  if (resolution) body.resolution = resolution;
  if (negative_prompt) body.negative_prompt = negative_prompt;
  if (enable_audio !== undefined) body.enable_audio = Boolean(enable_audio);

  return await callUpstream({ url: base + "/videos/generations", token, body });
}

// ===== op=get：查询任务（单次拉取，不内部轮询）=====
async function queryVideo({ base, token, taskId }) {
  return await callUpstream({
    url: base + "/videos/" + encodeURIComponent(taskId),
    token,
    method: "GET",
  });
}

const DONE = new Set(["completed", "succeeded", "success"]);
const FAILED = new Set(["failed", "error", "cancelled", "canceled"]);

function normalizeStatus(s) {
  return String(s || "").toLowerCase();
}

// ---------- op=create 的业务处理 ----------
async function handleCreate({ args, headers }) {
  // 纯空白 prompt 等同没给：schema 只校验类型/长度，不校验内容。
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt && !args.image_url) {
    return {
      isError: true,
      content: [{ type: "text", text: 'op=create requires at least one of "prompt" or "image_url".' }],
    };
  }

  let target;
  try {
    target = resolveTarget(headers);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }

  try {
    const data = await submitVideo({
      ...target,
      prompt,
      image_url: args.image_url,
      seconds: args.seconds,
      aspect_ratio: args.aspect_ratio,
      resolution: args.resolution,
      negative_prompt: args.negative_prompt,
      enable_audio: args.enable_audio ?? args.with_audio,
    });

    const taskId = data.task_id || data.id;
    const summary =
      `task_id: ${taskId}\n` +
      `model: ${target.model}\n` +
      `status: ${data.status || "queued"}\n` +
      `\n` +
      `Video generation is asynchronous. ` +
      `Call this tool again with op="get" and task_id="${taskId}" to fetch the result.`;

    return { content: [{ type: "text", text: summary }] };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `提交视频任务失败：${e.message}${e.detail ? `\nDetails: ${JSON.stringify(e.detail)}` : ""}`,
        },
      ],
    };
  }
}

// ---------- op=get 的业务处理 ----------
async function handleGet({ args, headers }) {
  // 纯空白 task_id 不能直接拼进上游路径，否则得到一条含编码后空白的报错。
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (!taskId) {
    return { isError: true, content: [{ type: "text", text: 'op=get requires "task_id".' }] };
  }

  let target;
  try {
    target = resolveTarget(headers);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }

  try {
    const data = await queryVideo({ ...target, taskId });
    const status = normalizeStatus(data.status);

    if (DONE.has(status)) {
      const url = (data.videos || [])[0]?.url || (data.data || [])[0]?.url;
      if (!url) {
        return {
          isError: true,
          content: [{ type: "text", text: `任务已完成但没有视频地址。Raw: ${JSON.stringify(data).slice(0, 500)}` }],
        };
      }
      const credit = data.usage?.credit;
      const text =
        `task_id: ${taskId}\n` +
        `model: ${data.model || target.model}\n` +
        `status: completed\n` +
        `Video URL: ${url}\n` +
        (credit !== undefined ? `credit: ${credit}\n` : "") +
        (data.hint ? `note: ${data.hint}\n` : "");
      return { content: [{ type: "text", text }] };
    }

    const errBlock = data.error ? `\nerror: ${JSON.stringify(data.error)}` : "";
    const progress = data.progress !== undefined ? `\nprogress: ${data.progress}` : "";
    return {
      isError: FAILED.has(status),
      content: [
        {
          type: "text",
          text: `task_id: ${taskId}\nmodel: ${data.model || target.model}\nstatus: ${data.status || "unknown"}${progress}${errBlock}`,
        },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `查询视频任务失败：${e.message}${e.detail ? `\nDetails: ${JSON.stringify(e.detail)}` : ""}`,
        },
      ],
    };
  }
}

function buildServer() {
  const server = new McpServer({ name: "video_task", version: "2.0.0" }, { capabilities: { tools: {} } });

  server.tool(
    "video_task",
    `AI video generation task (async).

Operations:
- \`create\`: Start a new task. Requires at least one of \`prompt\` or \`image_url\`. Returns \`task_id\` immediately.
- \`get\`: Check a task by \`task_id\`. Returns status and, when completed, the video URL.

Examples:
- Text-to-video → \`{"op":"create","prompt":"A cat running in a garden"}\`
- Image-to-video → \`{"op":"create","image_url":"https://example.com/cat.jpg","prompt":"The cat runs forward"}\`
- Check task → \`{"op":"get","task_id":"<task_id from create>"}\`

Workflow: call \`create\` once, then call \`get\` with the returned \`task_id\` until status is \`completed\` or \`failed\`. Never create duplicate tasks just to check status.`,
    {
      op: z.enum(["create", "get"]).describe("create 提交生成；get 按 task_id 查结果。"),
      prompt: z
        .string()
        .max(2000)
        .optional()
        .describe("视频描述，create 时 prompt 与 image_url 至少给一个。图生视频时描述画面如何运动。"),
      image_url: z
        .string()
        .url()
        .optional()
        .describe(
          "参考图（图生视频）：公开可访问的 png/jpeg URL。本地文件先用 agent 内置的公开临时 URL 工具换成短链。"
        ),
      seconds: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("视频时长（秒）。留空用上游默认；越长越慢越贵。"),
      aspect_ratio: z.string().optional().describe("画幅，如 16:9 / 9:16 / 1:1。"),
      resolution: z.string().optional().describe("分辨率，如 768P / 1080P。留空用上游默认。"),
      negative_prompt: z.string().optional().describe("不希望出现的画面描述。"),
      enable_audio: z.boolean().optional().describe("是否生成音频，默认 false。"),
      with_audio: z.boolean().optional().describe("旧字段名，等同 enable_audio。"),
      task_id: z.string().min(1).optional().describe("create 返回的 task_id，get 时必填。"),
    },
    async (args, extra) => {
      const headers = extra?.requestInfo?.headers;
      switch (args.op) {
        case "create":
          return await handleCreate({ args, headers });
        case "get":
          return await handleGet({ args, headers });
        default:
          return {
            isError: true,
            content: [{ type: "text", text: `Unknown op "${args.op}" (available: create, get).` }],
          };
      }
    }
  );

  return server;
}

async function startHttp({ port, host }) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const sessions = new Map();

  closeAllSessions = () => {
    for (const { server, transport } of sessions.values()) {
      try { transport.close(); } catch {}
      try { server.close(); } catch {}
    }
    sessions.clear();
    httpServer?.closeAllConnections?.();
  };

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "video_task", sessions: sessions.size });
  });

  async function handleSessionRequest(req, res) {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: missing valid Mcp-Session-Id for non-initialize request" },
        id: req.body?.id ?? null,
      });
      return;
    }

    const newId = randomUUID();
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newId,
      onsessioninitialized: (id) => { sessions.set(id, { server, transport }); },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  app.post("/mcp", handleSessionRequest);

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
    console.log(`[video] MCP HTTP server listening on http://${host}:${port}/mcp`);
  });
}

async function startStdio() {
  const server = buildServer();
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
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
