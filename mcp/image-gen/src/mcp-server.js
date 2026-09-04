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

// 从请求头里提取 token（兼容多种命名 + Bearer 前缀）
function extractTokenFromHeaders(headers) {
  if (!headers) return null;
  const candidates = [
    headers["authorization"],
    headers["x-image-gen-token"],
    headers["x-mcp-token"],
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

// 创建 McpServer，把 token 通过闭包注入到工具回调里
function buildServer({ token }) {
  const server = new McpServer(
    { name: "image-gen", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.tool(
    "generate_image",
    "调用智谱 CogView 图片生成 API，根据 prompt 生成图片，返回图片 URL。可选指定 model 和 size。",
    {
      prompt: z
        .string()
        .min(1)
        .describe("图片生成提示词，描述想要生成的画面内容"),
      model: z
        .string()
        .optional()
        .describe("模型名称，可选，默认 CogView-3-Flash"),
      size: z
        .string()
        .optional()
        .describe(
          "图片尺寸，例如 1024x1024、1280x1280、1024x1792、1792x1024、768x1344、1344x768，遵循智谱 API 规格"
        ),
    },
    async (args) => {
      // model 优先级：工具参数 > DEFAULT_MODEL
      const model = args.model || DEFAULT_MODEL;
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
                text: `调用成功但未返回图片 URL：${JSON.stringify(data)}`,
              },
            ],
          };
        }
        const summary = urls
          .map((u, i) => `图片 ${i + 1}: ${u}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `模型: ${model}\n提示词: ${args.prompt}\n${summary}`,
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
              text: `生成图片失败: ${e.message}${
                e.detail ? `\n详情: ${JSON.stringify(e.detail)}` : ""
              }`,
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

  // session -> transport + server + token/model
  const sessions = new Map();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "image-gen", sessions: sessions.size });
  });

  // 主入口：先从 header 取 token（每个 HTTP 请求都取一次），
  // 然后用这个 token 创建一个新的 server+transport；
  // 已有 session 直接复用 transport，token 沿用 session 首次创建时的值
  // （避免跨请求 token 不一致；MCP 客户端本来就该每次都带同一个 token）
  const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    // 已有 session：复用 transport，token/model 直接从 session 缓存里拿
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

    // 从本次请求 header 取 token
    const token = extractTokenFromHeaders(req.headers);
    if (!token) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "缺少鉴权 token，请通过 HTTP 请求头（例如 Authorization: Bearer <token> 或 X-Image-Gen-Token: <token>）传递。",
        },
        id: req.body?.id ?? null,
      });
      return;
    }

    const newId = randomUUID();
    const server = buildServer({ token });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newId,
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, token });
        console.log(`[image-gen] session initialized: ${id}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        console.log(`[image-gen] session closed: ${transport.sessionId}`);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

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

  app.listen(port, host, () => {
    console.log(
      `[image-gen] MCP HTTP server listening on http://${host}:${port}/mcp`
    );
  });
}

async function startStdio() {
  // stdio 模式下没有 HTTP header，token 暂未支持（保留入口便于本地调试）
  const server = buildServer({ token: "" });
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[image-gen] MCP stdio server started (no auth)");
}

const args = parseArgs(process.argv.slice(2));
if (args.http) {
  startHttp({ port: args.port, host: args.host }).catch((e) => {
    console.error("[image-gen] failed to start http server:", e);
    process.exit(1);
  });
} else {
  startStdio().catch((e) => {
    console.error("[image-gen] failed to start stdio server:", e);
    process.exit(1);
  });
}
