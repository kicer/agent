#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// 上游必须是 OpenAI 兼容的端点：文生图走 /images/generations，图生图走 /images/edits。
// Base-Url / 模型 / 凭据全部由调用方随每个请求用 header 带入（X-Image-Task-Base-Url /
// X-Image-Task-Model / Authorization），服务自己不存、也不预设任何厂商。

// 上游同步调用耗时上限（出图几十秒量级，留足余量）。
// 超时后任务记为 FAIL，避免上游挂而不回时永远卡在 PROCESSING。
const UPSTREAM_TIMEOUT_MS = 180_000;

// 图生图要先把参考图拉成字节再 multipart 上传：下载超时与体积都要单独兜底，
// 否则慢 CDN 会拖死任务、超大原图会顶满容器内存。
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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

// 解析 Base-Url：必须是完整 http(s) URL。允许调用方直接填到 /images/generations 或
// /images/edits（老配置、照抄文档的写法），统一剥回 base，端点由 mode 决定——
// 否则图生图会被错发到 generations。
function resolveBaseUrl(rawBase) {
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
  return base.replace(/\/images\/(generations|edits)$/i, "");
}

// mode=edit 走 /images/edits（图生图），否则走 /images/generations（文生图）。
function resolveEndpoint(base, mode) {
  return base + (mode === "edit" ? "/images/edits" : "/images/generations");
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
    base: resolveBaseUrl(pickBaseUrl(headers)),
    token,
    model: resolveModel(headers),
  };
}

// 统一的上游 POST：超时、错误体解析都在这层，JSON 与 multipart 共用。
// contentType 为空表示交给 fetch 自己写（multipart 必须这样，boundary 由它生成）。
async function postUpstream({ url, token, body, contentType }) {
  const headers = { Authorization: `Bearer ${token}` };
  if (contentType) headers["Content-Type"] = contentType;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body,
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

const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};
const EXT_TO_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};

function urlExtension(url) {
  try {
    const m = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

// 判定参考图的 MIME：优先响应头，其次 URL 扩展名。响应头只要声明是 image/* 就放行
// （avif / tiff 这类冷门格式交给上游判断），避免本地图片被我们提前拒掉。
// 两者都不是图片就报错——典型情况是链接过期后拿到 HTML 错误页，继续上传只会换来
// 上游一句难懂的 400。
function pickImageMime(contentType, url) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (/^image\/[a-z0-9.+-]+$/.test(ct)) return ct;
  const mime = EXT_TO_MIME[urlExtension(url)];
  if (mime) return mime;
  throw new Error(
    `Reference image is not an image: content-type "${ct || "none"}" (${url}).`
  );
}

// multipart 里的文件名按 MIME 补扩展名；冷门 image/* 就把子类型当年扩展名。
function extensionForMime(mime) {
  return (
    MIME_TO_EXT[mime] ||
    mime.slice("image/".length).replace(/[^a-z0-9]/g, "") ||
    "img"
  );
}

// 图生图需要真实字节：先把 image URL 拉下来。带独立超时与体积上限，错误直述下载环节，
// 便于区分「参考图挂了」和「上游出图失败」。
async function downloadImage(url) {
  let resp;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(
        `Failed to download reference image: timed out after ${IMAGE_DOWNLOAD_TIMEOUT_MS} ms (${url})`
      );
    }
    throw new Error(`Failed to download reference image: ${e.message} (${url})`);
  }
  if (!resp.ok) {
    throw new Error(
      `Failed to download reference image: ${resp.status} ${resp.statusText} (${url})`
    );
  }
  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared > MAX_IMAGE_BYTES) {
    throw new Error(
      `Reference image is too large: ${declared} bytes (limit ${MAX_IMAGE_BYTES}) (${url})`
    );
  }
  // 不直接 arrayBuffer()：没有 content-length 的响应会一路读进内存，
  // 这里边读边计数，超限立刻中止（断掉上游连接）。
  const chunks = [];
  let total = 0;
  for await (const chunk of resp.body) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES) {
      throw new Error(
        `Reference image is too large: >${MAX_IMAGE_BYTES} bytes (limit ${MAX_IMAGE_BYTES}) (${url})`
      );
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    throw new Error(`Reference image is empty (${url})`);
  }
  const buffer = Buffer.concat(chunks, total);
  const mime = pickImageMime(resp.headers.get("content-type"), url);
  return { buffer, mime, filename: `image.${extensionForMime(mime)}` };
}

// 文生图：JSON 体。response_format=url（b64_json 几十 MB，既塞不进任务表也没法给模型看）。
// 尺寸/质量一律不传，交给上游默认值。
async function callImagesGenerations({ url, token, model, prompt }) {
  const body = JSON.stringify({ model, prompt, n: 1, response_format: "url" });
  return postUpstream({ url, token, body, contentType: "application/json" });
}

// 图生图：上游只认 /images/edits，且实测只接受两种入参——
//   1) multipart/form-data，image 字段是文件（image=@a.jpg）；
//   2) application/json，image 字段是 data:image/...;base64,... 的 data URL。
// 这里走 multipart：参考图已经在本地手里，直接当文件上传，省掉 base64 的 1/3 体积膨胀，
// 也避开网关对超大 JSON 体的限制。响应格式与 generations 一致（data[0].url）。
async function callImagesEdits({ url, token, model, prompt, image }) {
  const ref = await downloadImage(image);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("image", new Blob([ref.buffer], { type: ref.mime }), ref.filename);
  form.append("n", "1");
  form.append("response_format", "url");
  // 不传 Content-Type：fetch 会带上含 boundary 的 multipart/form-data
  return postUpstream({ url, token, body: form });
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
// 上游智谱/网关的 images 接口是同步阻塞的，但对外要和 video_task 一样提供
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
  const upstream = image
    ? callImagesEdits({
        url: resolveEndpoint(target.base, "edit"),
        token: target.token,
        model: target.model,
        prompt,
        image,
      })
    : callImagesGenerations({
        url: resolveEndpoint(target.base, "generation"),
        token: target.token,
        model: target.model,
        prompt,
      });
  upstream
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

  // image 是文生图/图生图开关：不传 = 文生图（/images/generations）；传一个公网 URL = 修图
  // （/images/edits，服务会先把这张图拉下来再以 multipart 上传）。
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
