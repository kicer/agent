#!/usr/bin/env node
// MCP 视频任务服务：对接 WorkBuddy 网关（wb.ai）的 OpenAI 兼容视频接口
//   提交 POST /v1/videos/generations（wait=false，立刻回 task_id）
//   查询 GET  /v1/videos/{task_id}
// 只有一条工具 video_task，用 op 区分 create / get；服务端不轮询，AI 自己查。
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// 上游网关地址：容器内可用 WB_BASE_URL 覆盖
const WB_BASE = (process.env.WB_BASE_URL || "https://wb.ai.foresh.com").replace(/\/+$/, "");
const SUBMIT_URL = `${WB_BASE}/v1/videos/generations`;
const queryUrl = (id) => `${WB_BASE}/v1/videos/${encodeURIComponent(id)}`;

// 默认模型：minimax 出片约 2 分钟、扣 57 积分；kling 约 8 分钟、扣 103 积分
const DEFAULT_MODEL = "cn:minimax-video-h3";
const DEFAULT_SECONDS = 4;

// 提交/查询都是快接口（wait=false 立刻返回），卡住基本等于上游挂了
const UPSTREAM_TIMEOUT_MS = 60_000;

// 上游状态归一：命中终态才停轮询
const DONE = new Set(["completed", "succeeded", "success"]);
const FAILED = new Set(["failed", "error", "cancelled", "canceled"]);

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
  if (!httpServer) process.exit(0);
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

// 鉴权：每个请求从 header 取 wb.ai 的 API Key，服务端不落盘
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
  const v = headers["x-video-task-model"] || headers["x-mcp-model"] || headers["x-model"];
  if (!v) return null;
  const s = String(v).trim();
  return s || null;
}

async function callWb({ url, token, method = "POST", body }) {
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
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(`上游 ${UPSTREAM_TIMEOUT_MS} ms 内没有响应`);
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
    // 网关的错误体是 {error:{message}}，取原话给模型看，便于自行纠错
    const msg = data?.error?.message || data?.error?.code || text.slice(0, 300);
    const err = new Error(`网关返回 ${resp.status}: ${msg}`);
    err.status = resp.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// ===== op=create：提交任务，wait=false 立刻返回 task_id =====
async function submitVideo({ token, model, prompt, imageUrl, seconds, aspectRatio, resolution, negativePrompt, enableAudio }) {
  const body = { model, prompt, wait: false };
  if (imageUrl) body.image = imageUrl;
  if (seconds) body.seconds = seconds;
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (negativePrompt) body.negative_prompt = negativePrompt;
  if (enableAudio !== undefined && enableAudio !== null) body.enable_audio = Boolean(enableAudio);
  return await callWb({ url: SUBMIT_URL, token, body });
}

// ===== op=get：查任务（单次拉取） =====
async function queryVideo({ token, taskId }) {
  return await callWb({ url: queryUrl(taskId), token, method: "GET" });
}

function normStatus(s) {
  return String(s || "").trim().toLowerCase();
}

async function handleCreate({ args, headers, token }) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return {
      isError: true,
      content: [{ type: "text", text: 'op=create 需要 "prompt"（视频描述，必填）。' }],
    };
  }

  const model = pickModel(headers) || DEFAULT_MODEL;
  const seconds = Number.isFinite(args.seconds) ? args.seconds : DEFAULT_SECONDS;

  try {
    const data = await submitVideo({
      token,
      model,
      prompt,
      imageUrl: args.image_url,
      seconds,
      aspectRatio: args.aspect_ratio,
      resolution: args.resolution,
      negativePrompt: args.negative_prompt,
      // 兼容旧字段名
      enableAudio: args.enable_audio ?? args.with_audio,
    });

    const taskId = data.task_id || data.id;
    const summary =
      `model: ${data.model || model}\n` +
      `task_id: ${taskId}\n` +
      `status: ${normStatus(data.status) || "queued"}\n` +
      `\n` +
      `视频是异步生成（minimax 约 2 分钟，kling 约 8 分钟）。` +
      `之后用 op="get" 加 task_id="${taskId}" 查询，直到 status 变成 completed 或 failed。` +
      `不要重复提交同一个任务。`;

    return { content: [{ type: "text", text: summary }] };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `提交视频任务失败：${e.message}`,
        },
      ],
    };
  }
}

async function handleGet({ args, token }) {
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (!taskId) {
    return {
      isError: true,
      content: [{ type: "text", text: 'op=get 需要 "task_id"。' }],
    };
  }

  try {
    const data = await queryVideo({ token, taskId });
    const status = normStatus(data.status) || "unknown";

    if (DONE.has(status)) {
      const url = (data.videos || [])[0]?.url;
      if (!url) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `任务已完成但没有返回视频地址。原始响应：${JSON.stringify(data).slice(0, 500)}`,
            },
          ],
        };
      }
      const credit = data.usage?.credit;
      const summary =
        `task_id: ${taskId}\n` +
        `model: ${data.model || "-"}\n` +
        `status: completed\n` +
        `Video URL: ${url}\n` +
        (credit !== undefined ? `credit: ${credit}\n` : "") +
        `\n注意：视频是签名直链，约 12 小时失效；要长期保存请立刻下载到本地。`;
      return { content: [{ type: "text", text: summary }] };
    }

    if (FAILED.has(status)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `task_id: ${taskId}\n` +
              `status: ${status}\n` +
              (data.error ? `error: ${JSON.stringify(data.error)}\n` : "") +
              `任务已失败，需要换提示词或模型重新提交。`,
          },
        ],
      };
    }

    // queued / in_progress：告诉模型继续等，别重复提交
    const progress = data.progress;
    return {
      content: [
        {
          type: "text",
          text:
            `task_id: ${taskId}\n` +
            `model: ${data.model || "-"}\n` +
            `status: ${status}` +
            (progress !== undefined && progress !== null ? `（进度 ${progress}%）` : "") +
            `\n还没出片，稍后再用 op="get" 查一次。`,
        },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `查询视频任务失败：${e.message}` }],
    };
  }
}

function buildServer() {
  const server = new McpServer(
    { name: "video_task", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.tool(
    "video_task",
    `AI 视频生成任务（异步）。

操作：
- \`create\`：提交视频生成，必须给 \`prompt\`。立刻返回 \`task_id\`，生成在后台跑。
- \`get\`：用 \`task_id\` 查进度，出片后返回视频直链。

示例：
- 文生视频 → \`{"op":"create","prompt":"一只橘猫在阳光下的草地上奔跑，电影感"}\`
- 图生视频 → \`{"op":"create","prompt":"画面里的人缓缓转身","image_url":"https://..."}\`
- 查任务 → \`{"op":"get","task_id":"<create 返回的 task_id>"}\`

工作流：\`create\` 调一次，然后反复用 \`get\` 查同一个 \`task_id\`，直到 status 变成 completed 或 failed。**不要为了看进度重复提交任务。**
耗时参考：minimax 约 2 分钟（扣 57 积分），kling 约 8 分钟（扣 103 积分）。视频直链约 12 小时失效。`,
    {
      op: z
        .enum(["create", "get"])
        .describe("create 提交生成；get 按 task_id 查结果。"),
      prompt: z
        .string()
        .max(2000)
        .optional()
        .describe("视频描述，create 必填。图生视频时描述画面如何运动。"),
      image_url: z
        .string()
        .url()
        .optional()
        .describe(
          "图生视频的参考图，公网可访问的 png/jpeg URL。本地文件先用 mint_public_link 换成公网短链。"
        ),
      seconds: z
        .number()
        .min(4)
        .max(15)
        .optional()
        .describe("视频时长（秒），默认 4。越长越慢越贵。"),
      aspect_ratio: z
        .string()
        .optional()
        .describe("画幅，如 16:9 / 9:16 / 1:1。上游不严格校验，写合法值即可。"),
      resolution: z
        .string()
        .optional()
        .describe("分辨率，如 768P / 1080P。留空用上游默认。"),
      negative_prompt: z
        .string()
        .optional()
        .describe("不希望出现的画面描述。"),
      enable_audio: z
        .boolean()
        .optional()
        .describe("是否生成音频，默认 false。"),
      with_audio: z
        .boolean()
        .optional()
        .describe("旧字段名，等同 enable_audio。"),
      task_id: z
        .string()
        .min(1)
        .optional()
        .describe("create 返回的 task_id，get 时必填。"),
    },
    async (args, extra) => {
      const headers = extra?.requestInfo?.headers;
      const token = pickToken(headers);
      if (!token) {
        return {
          isError: true,
          content: [{ type: "text", text: "缺少鉴权：header 里要带 Authorization: Bearer <API Key>。" }],
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
            content: [{ type: "text", text: `未知 op "${args.op}"（可用：create、get）。` }],
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
      try {
        transport.close();
      } catch {}
      try {
        server.close();
      } catch {}
    }
    sessions.clear();
    httpServer?.closeAllConnections?.();
  };

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "video_task", upstream: WB_BASE, sessions: sessions.size });
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
    console.log(`[video] MCP HTTP server listening on http://${host}:${port}/mcp → ${WB_BASE}`);
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
