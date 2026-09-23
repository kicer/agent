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

async function callZhipuImagesGenerations({ token, model, prompt, size }) {
  const body = { model, prompt };
  if (size) body.size = size;
  const resp = await fetch(ZHIPU_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
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

// ===== op=create：提交图片生成（同步，直接返回图片 URL）=====
async function handleCreate({ args, headers, token }) {
  // model 完全由 HTTP header 控制（X-Image-Task-Model / X-Mcp-Model / X-Model），
  // 不存进 session，每次从本次请求的 header 读取，未设置则用默认 CogView-3-Flash。
  // AI 看不到 model 参数（schema 中已删除），避免其误传。
  const model = pickModel(headers) || DEFAULT_MODEL;
  const size = args.size;

  try {
    const data = await callZhipuImagesGenerations({
      token,
      model,
      prompt: args.prompt,
      size,
    });
    const urls = extractUrls(data);
    if (urls.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Returned no image URL. Raw response: ${JSON.stringify(data)}`,
          },
        ],
      };
    }
    const summary = urls
      .map((u, i) => `Image ${i + 1}: ${u}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Model: ${model}\nPrompt: ${args.prompt}\n${summary}`,
        },
        ...urls.map((u) => ({ type: "text", text: u })),
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to generate image: ${e.message}${
            e.detail ? `\nDetails: ${JSON.stringify(e.detail)}` : ""
          }`,
        },
      ],
    };
  }
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
    `Manages image generation. Generation is synchronous: op=create returns the image URLs directly.

op=create  Generate an image from a prompt. Requires prompt; optional size.`,
    {
      op: z
        .enum(["create"])
        .describe(
          'Operation to perform. Only "create" is supported (generation is synchronous, so there is no task to poll).'
        ),
      prompt: z
        .string()
        .min(1)
        .describe(
          "Image generation prompt; describe the desired scene in detail. Used with op=create."
        ),
      size: z
        .string()
        .optional()
        .describe(
          "Image size, Preferred sizes: 1024x1024, 1280x1280, 1536x1024, 1024x1536, Each side must be a multiple of 32. Used with op=create."
        ),
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
        default:
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Unknown op "${args.op}" (available: create).`,
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
    res.json({ status: "ok", service: "image_task", sessions: sessions.size });
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
