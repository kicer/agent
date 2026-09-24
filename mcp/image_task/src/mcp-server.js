#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const ZHIPU_API_URL =
  "https://open.bigmodel.cn/api/paas/v4/images/generations";
const DEFAULT_MODEL = "CogView-3-Flash";

// 上游同步调用耗时上限（出图几十秒量级，留足余量）。
// 超时后任务记为 FAIL，避免上游挂而不回时永远卡在 PROCESSING。
const UPSTREAM_TIMEOUT_MS = 180_000;

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
  console.log(`[image] received ${sig}, shutting down`);
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
    headers["x-image-task-token"],
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
    headers["x-image-task-model"] ||
    headers["x-mcp-model"] ||
    headers["x-model"];
  if (!v) return null;
  const s = String(v).trim();
  return s || null;
}

async function callZhipuImagesGenerations({ token, model, prompt }) {
  const body = { model, prompt };
  let resp;
  try {
    resp = await fetch(ZHIPU_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    // AbortSignal.timeout 中止时抛 TimeoutError/AbortError，
    // 转成普通错误后由 runImageTask 回写 FAIL
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

function extractUrls(data) {
  if (!data) return [];
  if (Array.isArray(data.data)) {
    return data.data
      .map((it) => it && (it.url || it.b64_json))
      .filter(Boolean);
  }
  if (typeof data.url === "string") return [data.url];
  return [];
}

// ===== 自维护任务表（异步语义全靠这层模拟） =====
// 上游智谱 images 接口是同步阻塞的，但对外要和 video_task 一样提供
// create（立即返回 task_id）+ get（轮询结果）的异步契约：
// create 登记 PROCESSING 后把同步调用丢到后台跑，get 从表里读最新状态。
//
// 已知取舍：
// - 表在进程内存里：容器重启/重建后任务丢失，get 会报 unknown task_id；
//   图片生成只跑几秒，窗口很小，不值得为此引入持久化。
// - 只适用于单实例部署：多副本时 create 和 get 可能打到不同进程，表不互通。
const TASK_TTL_MS = 60 * 60 * 1000; // 已完成（SUCCESS/FAIL）任务保留 1 小时
const MAX_TASKS = 1000;             // 表容量上限，超出从最老的已完成任务开始淘汰

// task_id -> { status, model, prompt, createdAt, urls?, error? }
const tasks = new Map();

function pruneTasks() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (t.status !== "PROCESSING" && now - t.createdAt > TASK_TTL_MS) {
      tasks.delete(id);
    }
  }
  if (tasks.size > MAX_TASKS) {
    // Map 按插入序迭代；PROCESSING 永不主动淘汰
    for (const [id, t] of tasks) {
      if (tasks.size <= MAX_TASKS) break;
      if (t.status !== "PROCESSING") tasks.delete(id);
    }
  }
}

// 后台跑同步上游调用，结果回写任务表（fire-and-forget，不 await）
function runImageTask({ task, token, model, prompt }) {
  callZhipuImagesGenerations({ token, model, prompt })
    .then((data) => {
      const urls = extractUrls(data);
      if (urls.length === 0) {
        task.status = "FAIL";
        task.error = `Zhipu returned no image URL. Raw response: ${JSON.stringify(data)}`;
      } else {
        task.status = "SUCCESS";
        task.urls = urls;
      }
    })
    .catch((e) => {
      task.status = "FAIL";
      task.error = `${e.message}${
        e.detail ? ` Details: ${JSON.stringify(e.detail)}` : ""
      }`;
    });
}

// ===== op=create：提交图片生成（立即返回 task_id，后台执行）=====
async function handleCreate({ args, headers, token }) {
  if (!args.prompt) {
    return {
      isError: true,
      content: [{ type: "text", text: 'op=create requires "prompt".' }],
    };
  }

  // model 完全由 HTTP header 控制（X-Image-Task-Model / X-Mcp-Model / X-Model），
  // 不存进 session，每次从本次请求的 header 读取，未设置则用默认 CogView-3-Flash。
  // AI 看不到 model 参数（schema 中已删除），避免其误传。
  const model = pickModel(headers) || DEFAULT_MODEL;

  pruneTasks();
  const taskId = randomUUID();
  const task = {
    status: "PROCESSING",
    model,
    prompt: args.prompt,
    createdAt: Date.now(),
  };
  tasks.set(taskId, task);

  // token/model 在此刻从本次请求 header 捕获进闭包，后台完成前无需再取
  runImageTask({ task, token, model, prompt: args.prompt });

  const summary =
    `Model: ${model}\n` +
    `task_id: ${taskId}\n` +
    `task_status: PROCESSING\n` +
    `\n` +
    `Image generation is running in background. ` +
    `Call this tool again with op="get" and task_id="${taskId}" to fetch the result.`;

  return { content: [{ type: "text", text: summary }] };
}

// ===== op=get：查询任务状态（只读本地表，不碰上游）=====
async function handleGet({ args }) {
  if (!args.task_id) {
    return {
      isError: true,
      content: [{ type: "text", text: 'op=get requires "task_id".' }],
    };
  }

  const task = tasks.get(args.task_id);
  if (!task) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `Unknown task_id "${args.task_id}". ` +
            `Finished tasks are kept for 1 hour and are lost on service restart.`,
        },
      ],
    };
  }

  if (task.status === "PROCESSING") {
    return {
      content: [
        {
          type: "text",
          text:
            `task_id: ${args.task_id}\n` +
            `model: ${task.model}\n` +
            `task_status: PROCESSING\n` +
            `\n` +
            `Call op="get" again in a few seconds.`,
        },
      ],
    };
  }

  if (task.status === "FAIL") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `task_id: ${args.task_id}\ntask_status: FAIL\nerror: ${task.error}`,
        },
      ],
    };
  }

  // SUCCESS：输出格式与原同步版 create 一致（摘要块 + 每张图一个 URL 块）
  const lines = task.urls.map((u, i) => `Image ${i + 1}: ${u}`).join("\n");
  const summary =
    `task_id: ${args.task_id}\n` +
    `model: ${task.model}\n` +
    `task_status: SUCCESS\n` +
    `${lines}`;
  return {
    content: [
      { type: "text", text: summary },
      ...task.urls.map((u) => ({ type: "text", text: u })),
    ],
  };
}

function buildServer() {
  const server = new McpServer(
    {
      name: "image_task",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.tool(
    "image_task",
    `Manages asynchronous image generation tasks.

op=create  Submit a new task. Returns a task_id immediately; generation runs in background.
           Requires prompt.
op=get     Fetch the status of a previously submitted task. Requires task_id.
           On SUCCESS, returns the image URLs.

Typical flow: call op=create, then call op=get with the returned task_id until task_status is SUCCESS or FAIL.`,
    {
      op: z.enum(["create", "get"]).describe("Operation to perform."),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Image generation prompt; describe the desired scene in detail. Required when op=create."
        ),
      task_id: z
        .string()
        .min(1)
        .optional()
        .describe("task_id returned by op=create. Required when op=get."),
    },
    async (args, extra) => {
      // SDK 在 tool callback 的 extra.requestInfo.headers 里会透传当前 HTTP 请求的 headers
      // （参见 webStandardStreamableHttp.js: buildRequestInfo 段）
      const headers = extra?.requestInfo?.headers;
      const token = pickToken(headers);
      if (!token) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Missing authentication token.",
            },
          ],
        };
      }

      switch (args.op) {
        case "create":
          return await handleCreate({ args, headers, token });
        case "get":
          return await handleGet({ args });
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
    res.json({
      status: "ok",
      service: "image_task",
      sessions: sessions.size,
      tasks: tasks.size,
    });
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
          message: "Bad Request: missing valid Mcp-Session-Id for non-initialize request",
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
      `[image] MCP HTTP server listening on http://${host}:${port}/mcp`
    );
  });
}

async function startStdio() {
  // 保留 stdio 启动方式，便于本地直接调试
  const server = buildServer();
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[image] MCP stdio server started");
}

const args = parseArgs(process.argv.slice(2));
if (args.http) {
  startHttp({ port: args.port, host: args.host }).catch((e) => {
    console.error("[image] failed to start http server:", e);
    process.exit(1);
  });
} else {
  startStdio().catch((e) => {
    console.error("[image] failed to start stdio server:", e);
    process.exit(1);
  });
}
