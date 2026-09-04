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

function pickToken(headers) {
  if (!headers) return null;
  const candidates = [
    headers["x-image-gen-token"],
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
    headers["x-image-gen-model"] ||
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

function buildServer() {
  const server = new McpServer(
    {
      name: "image-gen",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.tool(
    "generate_image",
    "根据 prompt 生成图片，返回图片 URL。可选指定 size。",
    {
      prompt: z
        .string()
        .min(1)
        .describe("图片生成提示词，详细描述想要的画面内容"),
      size: z
        .string()
        .optional()
        .describe(
          "图片尺寸，例如 1024x1024、1280x1280、1024x1792、1792x1024、768x1344、1344x768"
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
                "缺少鉴权 token。",
            },
          ],
        };
      }

      // model 完全由 HTTP header 控制（X-Image-Gen-Model / X-Mcp-Model / X-Model），
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

  // session -> { server, transport } 映射
  const sessions = new Map();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "image-gen", sessions: sessions.size });
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

  app.listen(port, host, () => {
    console.log(
      `[image-gen] MCP HTTP server listening on http://${host}:${port}/mcp`
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
  console.error("[image-gen] MCP stdio server started");
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
