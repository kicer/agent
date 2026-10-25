#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// 上游必须是 OpenAI 兼容的 /images/generations 端点：Base-Url / 模型 / 凭据全部由调用方
// 随每个请求用 header 带入（X-Image-Task-Base-Url / X-Image-Task-Model / Authorization），
// 服务自己不存、也不预设任何厂商。

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

// 对外只有三个 header：Authorization / X-Image-Task-Base-Url / X-Image-Task-Model。
// 不再支持 X-Image-Task-Token、X-Mcp-Token、X-Mcp-Model、X-Model 等旧写法。
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
  return pickHeaderString(headers, "x-image-task-base-url");
}

function pickModel(headers) {
  return pickHeaderString(headers, "x-image-task-model");
}

// 解析 Base-Url：必须是完整 http(s) URL。已经给到 /images/generations 就直接用，
// 否则补在 base 后面。
function resolveEndpoint(rawBase) {
  const base = String(rawBase || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "Missing X-Image-Task-Base-Url: pass the upstream base URL (e.g. https://<host>/v1)."
    );
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(
      `Invalid X-Image-Task-Base-Url "${base}": must be a full http(s) URL.`
    );
  }
  return /\/images\/generations$/i.test(base)
    ? base
    : base + "/images/generations";
}

// 模型只由 header 决定，AI 看不到也填不了。不猜缺省值：猜错只会换来含义不明的 400。
function resolveModel(headers) {
  const model = pickModel(headers);
  if (!model) {
    throw new Error("Missing X-Image-Task-Model: pass the upstream model name.");
  }
  return model;
}

// 一次解析出本次请求的上游、凭据、模型。
// 配置问题同步抛错，由 create 直接回给调用方，不登记注定失败的任务。
function resolveTarget(headers) {
  const token = pickAuthToken(headers);
  if (!token) {
    throw new Error('Missing Authorization: use "Authorization: Bearer <token>".');
  }
  return {
    url: resolveEndpoint(pickBaseUrl(headers)),
    token,
    model: resolveModel(headers),
  };
}

async function callImagesGenerations({ url, token, model, prompt, image }) {
  // 统一按 OpenAI 兼容协议：单图 + response_format=url（b64_json 几十 MB，既塞不进
  // 任务表也没法给模型看）。尺寸/质量一律不传，交给上游默认值。
  // 传了 image 就是图生图；上游字段是数组，所以这里包一层。
  const body = Object.assign(
    { model, prompt, n: 1, response_format: "url" },
    image ? { images: [image] } : null
  );
  let resp;
  try {
    resp = await fetch(url, {
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
      `Upstream API error: ${resp.status} ${resp.statusText} - ${text}`
    );
    err.status = resp.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// 只认 http(s) URL。b64_json 不再当 URL 存：它会把任务表撑爆，模型也读不了。
function extractUrls(data) {
  if (!data) return [];
  const items = Array.isArray(data.data)
    ? data.data
    : typeof data.url === "string"
      ? [data]
      : [];
  return items
    .map((it) => (it && typeof it.url === "string" ? it.url.trim() : ""))
    .filter((u) => /^https?:\/\//i.test(u));
}

function hasInlineBase64(data) {
  return (
    Array.isArray(data && data.data) &&
    data.data.some((it) => it && typeof it.b64_json === "string")
  );
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
function runImageTask({ task, target, prompt, image }) {
  callImagesGenerations({
    url: target.url,
    token: target.token,
    model: target.model,
    prompt,
    image,
  })
    .then((data) => {
      task.finishedAt = Date.now();
      const urls = extractUrls(data);
      if (urls.length === 0) {
        task.status = "FAIL";
        task.error = hasInlineBase64(data)
          ? "Upstream returned b64_json instead of a URL; this service only returns URLs. " +
            "Use a model that supports response_format=url."
          : `Upstream returned no image URL. Raw response: ${JSON.stringify(data)}`;
      } else {
        task.status = "SUCCESS";
        task.urls = urls;
      }
    })
    .catch((e) => {
      task.finishedAt = Date.now();
      task.status = "FAIL";
      task.error = `${e.message}${
        e.detail ? ` Details: ${JSON.stringify(e.detail)}` : ""
      }`;
    });
}

// ===== op=create：提交图片生成（立即返回 task_id，后台执行）=====
async function handleCreate({ args, headers }) {
  // schema 只约束了 min(1)，"   " 这种纯空白能通过校验并白跑一次出图，所以这里 trim 后再判。
  // 顺手用 trim 过的值：上游拿到的 prompt 不带首尾空白。
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return {
      isError: true,
      content: [{ type: "text", text: 'op=create requires "prompt".' }],
    };
  }

  // image 是文生图/图生图开关：不传 = 文生图；传一个公网 URL = 修图。
  // 只接受公网 http(s) URL；本地文件请先由调用方用 mint_public_link 换成公网链接。
  if (args.image !== undefined && typeof args.image !== "string") {
    return {
      isError: true,
      content: [{ type: "text", text: 'op=create: "image" must be a string.' }],
    };
  }
  const image = typeof args.image === "string" ? args.image.trim() : "";
  if (image && !/^https?:\/\//i.test(image)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            'op=create: "image" must be a public http(s) URL. ' +
            "For a local file, call mint_public_link first to get a public URL.",
        },
      ],
    };
  }

  // 上游地址、模型、凭据全部来自本次请求的 header（Authorization /
  // X-Image-Task-Base-Url / X-Image-Task-Model），AI 看不到也填不了。
  // 配置类错误直接回错，不登记一个必然失败的任务。
  let target;
  try {
    target = resolveTarget(headers);
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: e.message }],
    };
  }

  pruneTasks();
  const taskId = randomUUID();
  const task = {
    status: "PROCESSING",
    model: target.model,
    prompt,
    createdAt: Date.now(),
  };
  tasks.set(taskId, task);

  // target 与 image 在此刻从本次请求捕获进闭包，后台完成前无需再取
  runImageTask({ task, target, prompt, image });

  const mode = image ? "edit" : "text-to-image";
  const summary =
    `Model: ${target.model}\n` +
    `Mode: ${mode}\n` +
    `task_id: ${taskId}\n` +
    `task_status: PROCESSING\n` +
    `\n` +
    `Image generation is running in background. ` +
    `Call this tool again with op="get" and task_id="${taskId}" to fetch the result.`;

  return { content: [{ type: "text", text: summary }] };
}

// 从 create 到完成（未完成则到当前）的累计秒数。
// 已完成任务用 finishedAt 定格，避免它留在表里越查越大。
function elapsedSeconds(task) {
  const end = task.status === "PROCESSING"
    ? Date.now()
    : (task.finishedAt || Date.now());
  return Math.max(0, Math.round((end - task.createdAt) / 1000));
}

// 轮询退避：起步 3s，之后每多等 5s 加 1s，封顶 30s。
function pollIntervalSeconds(elapsed) {
  return Math.min(30, 3 + Math.floor(elapsed / 5));
}

// ===== op=get：查询任务状态（只读本地表，不碰上游）=====
async function handleGet({ args }) {
  // 与 handleCreate 同理：纯空白 task_id 应报"缺参数"，而不是得到 Unknown task_id "   " 这种含糊错误。
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (!taskId) {
    return {
      isError: true,
      content: [{ type: "text", text: 'op=get requires "task_id".' }],
    };
  }

  const task = tasks.get(taskId);
  if (!task) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `Unknown task_id "${taskId}". ` +
            `Finished tasks are kept for 1 hour and are lost on service restart.`,
        },
      ],
    };
  }

  if (task.status === "PROCESSING") {
    const elapsed = elapsedSeconds(task);
    const retryAfter = pollIntervalSeconds(elapsed);
    return {
      content: [
        {
          type: "text",
          text:
            `task_id: ${taskId}\n` +
            `model: ${task.model}\n` +
            `elapsed: ${elapsed}s\n` +
            `task_status: PROCESSING\n` +
            `\n` +
            `Task is still processing. Sleep for ${retryAfter} seconds, then call op="get" again.`,
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
          text:
            `task_id: ${taskId}\n` +
            `elapsed: ${elapsedSeconds(task)}s\n` +
            `task_status: FAIL\n` +
            `error: ${task.error}`,
        },
      ],
    };
  }

  // SUCCESS：单块输出。旧格式是「摘要块 + 每张图一个裸 URL 块」，但 core 的 mcp.callTool
  // 只把 text 块用 \n 拼起来（串前端/微信也不认裸 URL 块），结果就是同一 URL 在模型面前出现两遍。
  const lines =
    task.urls.length === 1
      ? `Image URL: ${task.urls[0]}`
      : task.urls.map((u, i) => `Image ${i + 1}: ${u}`).join("\n");
  const summary =
    `task_id: ${taskId}\n` +
    `model: ${task.model}\n` +
    `elapsed: ${elapsedSeconds(task)}s\n` +
    `task_status: SUCCESS\n` +
    `${lines}`;
  return { content: [{ type: "text", text: summary }] };
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
    `AI image generation and editing task.

Operations:
- \`create\`: Create a generation task. Requires \`prompt\`. Returns \`task_id\` immediately; generation runs in background. Optionally pass \`image\` for image-to-image editing.
- \`get\`: Check a task. Requires \`task_id\`. Returns status and, on SUCCESS, image URLs.

Examples:
- New image → \`{"op":"create","prompt":"A cat sitting in a garden"}\`
- Edit an image → \`{"op":"create","prompt":"Make it snow","image":"https://..."}\`
- Check result → \`{"op":"get","task_id":"<task_id from create>"}\`

Workflow: call \`create\` once, then \`get\` with the returned \`task_id\` until \`task_status\` is \`SUCCESS\` or \`FAIL\`.`,
    {
      op: z
        .enum(["create", "get"])
        .describe("Use create to start a new image generation task; use get to check a task by its task_id."),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Image generation prompt; describe the desired scene in detail. Required for create; omit for get."
        ),
      task_id: z
        .string()
        .min(1)
        .optional()
        .describe("task_id returned by create. Required for get; omit for create."),
      image: z
        .string()
        .min(1)
        .regex(/^https?:\/\//i)
        .optional()
        .describe(
          "One public image URL to edit; omit for text-to-image. For a local file, call mint_public_link first to get a public URL."
        ),
    },
    async (args, extra) => {
      // SDK 在 tool callback 的 extra.requestInfo.headers 里会透传当前 HTTP 请求的 headers
      // （参见 webStandardStreamableHttp.js: buildRequestInfo 段）
      const headers = extra?.requestInfo?.headers;
      const token = pickAuthToken(headers);
      if (!token) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                'Missing Authorization: use "Authorization: Bearer <token>".',
            },
          ],
        };
      }

      switch (args.op) {
        case "create":
          return await handleCreate({ args, headers });
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
