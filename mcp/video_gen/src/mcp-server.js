#!/usr/bin/env node
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const ZHIPU_SUBMIT_URL =
  "https://open.bigmodel.cn/api/paas/v4/videos/generations";
const ZHIPU_QUERY_URL = (id) =>
  `https://open.bigmodel.cn/api/paas/v4/async-result/${encodeURIComponent(id)}`;

// 默认模型：你说的 cogvideox-flash，文档枚举里也确认可用
const DEFAULT_MODEL = "cogvideox-flash";

// AI 不可见的服务端默认（可被同名 header 覆盖）
const DEFAULT_QUALITY = "speed";       // speed | quality
const DEFAULT_FPS = 30;               // 30 | 60
const DEFAULT_WATERMARK_ENABLED = true; // 平台政策默认 true

// ===== 上传文件相关 =====
// 公开的 base URL：拼接进 tool description，告诉 AI 该往哪里 POST 上传
// 优先级：环境变量 > 默认 http://localhost:<port>
function resolvePublicBaseUrl({ port, host }) {
  const env = (process.env.PUBLIC_BASE_URL || "").trim();
  if (env) return env.replace(/\/+$/, "");
  return `http://localhost:${port}`;
}

// 上传文件存储目录：容器内临时目录，服务重启即丢（你明确要求）
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/video_gen_uploads";
const UPLOAD_PATH_PREFIX = "/uploads"; // 对外的 URL 路径前缀
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024; // 8MB（智谱 image_url 上限 5MB，留余量）
const UPLOAD_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
]);

// 过期清理：UPLOAD_TTL_HOURS 小时之前的文件会被定时删除
const UPLOAD_TTL_HOURS = (() => {
  const n = parseInt(process.env.UPLOAD_TTL_HOURS || "24", 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
})();
const UPLOAD_TTL_MS = UPLOAD_TTL_HOURS * 60 * 60 * 1000;
const UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时一次

// 清理 UPLOAD_DIR 下 mtime 早于 TTL 的文件。返回 {kept, removed, errors}
async function cleanupUploads({ now = Date.now(), dir = UPLOAD_DIR } = {}) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch (e) {
    if (e && e.code === "ENOENT") return { kept: 0, removed: 0, errors: 0 };
    console.error(`[video_gen] cleanup: readdir failed: ${e.message}`);
    return { kept: 0, removed: 0, errors: 1 };
  }

  let kept = 0;
  let removed = 0;
  let errors = 0;
  await Promise.all(
    entries.map(async (name) => {
      const full = path.join(dir, name);
      try {
        const st = await fs.promises.stat(full);
        if (!st.isFile()) return;
        if (now - st.mtimeMs >= UPLOAD_TTL_MS) {
          await fs.promises.unlink(full);
          removed++;
        } else {
          kept++;
        }
      } catch (e) {
        if (e && e.code === "ENOENT") return;
        errors++;
        console.error(`[video_gen] cleanup: ${name}: ${e.message}`);
      }
    })
  );
  return { kept, removed, errors };
}

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
    headers["x-video-gen-token"],
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
    headers["x-video-gen-model"] ||
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
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
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

// ===== 工具：提交视频生成（同步只提交，立刻返回）=====
async function submitVideo({
  token,
  model,
  prompt,
  image_url,
  size,
  quality,
  with_audio,
  fps,
  watermark_enabled,
}) {
  // 平台要求 image_url 和 prompt 至少传一个
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
  if (size) body.size = size;

  const data = await callZhipu({
    url: ZHIPU_SUBMIT_URL,
    token,
    body,
  });
  return data; // { model, id, request_id, task_status }
}

// ===== 工具：查询异步结果（单次拉取，不内部轮询）=====
async function queryAsyncResult({ token, id }) {
  const data = await callZhipu({
    url: ZHIPU_QUERY_URL(id),
    token,
    method: "GET",
  });
  return data; // { id, request_id, model, task_status, video_result?, ... }
}

function buildServer({ publicBaseUrl }) {
  const server = new McpServer(
    {
      name: "video_gen",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const uploadUrl = `${publicBaseUrl}/upload`;

  // ---------- 工具 1：video_gen ----------
  server.tool(
    "video_gen",
    `Submit a video generation task (text-to-video or image-to-video).
Returns the task_id immediately; poll the result later with query_video.
prompt is required. Must add image_url for image-to-video.

If you need to use a LOCAL image file as image_url, upload it FIRST with this exact command (replace the path):

    curl -F "file=@/path/to/your/image.png" ${uploadUrl}

The response JSON has a "url" field — pass that URL directly as the image_url argument below.
Supported formats: png, jpeg, jpg. Max 5MB per image.
Uploaded files live in container temp storage and are discarded on restart — do not rely on long-term URLs.`,
    {
      prompt: z
        .string()
        .describe(
          "Video text description (max 512 chars). Required; when combined with image_url it serves as the motion/action description."
        ),
      image_url: z
        .string()
        .url()
        .optional()
        .describe(
          "Reference image URL string for image-to-video. Image <= 5MB, .png/.jpeg/.jpg. Use the /upload endpoint to get a URL from a local file."
        ),
      size: z
        .string()
        .optional()
        .describe(
          "Video size, e.g. 1920x1080, 1080x1920, 1024x1024, 1280x720, etc."
        ),
      with_audio: z
        .boolean()
        .optional()
        .describe("Whether to generate AI audio. Default false."),
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

      // AI 不可见：全部走 header
            const model = pickModel(headers) || DEFAULT_MODEL;
            const quality = pickHeaderString(headers, "x-video-gen-quality", DEFAULT_QUALITY);
            const fps = pickHeaderInt(headers, "x-video-gen-fps", DEFAULT_FPS);
            const watermark_enabled = pickHeaderBool(
              headers,
              "x-video-gen-watermark",
              DEFAULT_WATERMARK_ENABLED
            );

      if (!args.prompt && !args.image_url) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Either prompt or image_url must be provided.",
            },
          ],
        };
      }

      try {
        const data = await submitVideo({
                  token,
                  model,
                  prompt: args.prompt,
                  image_url: args.image_url,
                  size: args.size,
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
          `Video generation is asynchronous. Call query_video with task_id="${data.id}" to fetch the result.`;

        return {
          content: [{ type: "text", text: summary }],
        };
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
  );

  // ---------- 工具 2：query_video ----------
  server.tool(
    "query_video",
    "Query the status of a previously submitted video generation task. " +
      "Returns task_status and, if SUCCESS, the video URL(s).",
    {
      task_id: z
        .string()
        .min(1)
        .describe("The task id returned by video_gen."),
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

      try {
        const data = await queryAsyncResult({
          token,
          id: args.task_id,
        });

        const status = data.task_status || "UNKNOWN";
        if (status === "SUCCESS") {
          const v = (data.video_result || [])[0];
          if (!v || !v.url) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Task succeeded but no video URL returned. Raw: ${JSON.stringify(data)}`,
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
        const errBlock = data.error
          ? `\nerror: ${JSON.stringify(data.error)}`
          : "";
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
  );

  return server;
}

async function startHttp({ port, host }) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const publicBaseUrl = resolvePublicBaseUrl({ port, host });
  console.log(`[video_gen] PUBLIC_BASE_URL = ${publicBaseUrl}`);

  // ===== /upload：接收图片，返回 URL（不走 MCP）=====
    // 磁盘存储：保证 UPLOAD_DIR 存在（容器内临时，重启即丢）
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    // 过期清理：启动时跑一次，之后每小时一次
    cleanupUploads()
      .then((r) =>
        console.log(
          `[video_gen] startup cleanup: kept=${r.kept} removed=${r.removed} errors=${r.errors} ttl=${UPLOAD_TTL_HOURS}h`
        )
      )
      .catch((e) => console.error(`[video_gen] startup cleanup failed: ${e.message}`));
    const cleanupTimer = setInterval(() => {
      cleanupUploads()
        .then((r) => {
          if (r.removed > 0 || r.errors > 0) {
            console.log(
              `[video_gen] periodic cleanup: kept=${r.kept} removed=${r.removed} errors=${r.errors}`
            );
          }
        })
        .catch((e) => console.error(`[video_gen] periodic cleanup failed: ${e.message}`));
    }, UPLOAD_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref(); // 不阻止进程退出

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".bin").toLowerCase();
      cb(null, `${randomUUID()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (UPLOAD_ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
      cb(new Error(`Unsupported content-type: ${file.mimetype}. Allowed: ${[...UPLOAD_ALLOWED_MIME].join(", ")}`));
    },
  });

  app.post("/upload", (req, res) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({
          error: err.message || "upload failed",
        });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Missing form field 'file'" });
      }
      const url = `${publicBaseUrl}${UPLOAD_PATH_PREFIX}/${req.file.filename}`;
      return res.json({
        url,
        filename: req.file.filename,
        size: req.file.size,
        content_type: req.file.mimetype,
        original_name: req.file.originalname,
      });
    });
  });

  // 静态下载：只要文件存在于 UPLOAD_DIR 就吐出去（不鉴权、不持久化）
  app.use(
    UPLOAD_PATH_PREFIX,
    express.static(UPLOAD_DIR, {
      fallthrough: false,
      maxAge: 0,
    })
  );

  // session -> { server, transport } 映射
  const sessions = new Map();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "video_gen", sessions: sessions.size });
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
        const server = buildServer({ publicBaseUrl });
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
      `[video_gen] MCP HTTP server listening on http://${host}:${port}/mcp`
    );
  });
}

async function startStdio() {
  // stdio 模式下上传接口不可用，用 placeholder 避免 description 里出现奇怪的占位
  const server = buildServer({ publicBaseUrl: "http://localhost:3000" });
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[video_gen] MCP stdio server started");
}

const args = parseArgs(process.argv.slice(2));
if (args.http) {
  startHttp({ port: args.port, host: args.host }).catch((e) => {
    console.error("[video_gen] failed to start http server:", e);
    process.exit(1);
  });
} else {
  startStdio().catch((e) => {
    console.error("[video_gen] failed to start stdio server:", e);
    process.exit(1);
  });
}
