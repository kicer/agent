// wxbot：Agent 栈的微信「调制解调器」（wxbot 只服务本 agent、不对外暴露，作为根 compose 的 agent-wxbot 服务已并入仓库）。
//   - 基于 @wechatbot/wechatbot（官方 iLink 协议 Node SDK），同进程多实例：
//     一个实例 = 一个 core 用户的 bot 账号（扫码登录后仅本人可与 bot 单线对话，协议保证无陌生人入口）。
//   - 本服务不保存任何业务状态：绑定（core 用户 ↔ 实例）权威在 agent-core 的 wechat_bindings 表；
//     这里只做三件事——实例控制（core 调 /api/instances*）、收信转发（POST core /wxhook/inbox）、
//     外发投递（core 调 /api/deliver → bot.send）。二维码呈现挪进 core 的 Web 设置页。
//   - 凭证按实例隔离在 bot.storage_dir/<binding_id>/（compose 卷 ./data），重启自动恢复登录免扫码；
//     启动时扫描目录逐个拉起实例（core 起来与否不影响；上线状态经 /wxhook/hook 回报 core，core 不在线则丢弃，
//     首条消息的 inbox 会顺带把状态纠回 online）。
//   - 零配置文件：必需接线全走 compose env（WXBOT_TOKEN / CORE_URL / WXBOT_LOG_LEVEL，同 executor 的 EXECUTOR_* 模式）；
//     不读 core 的 config.yml（内含平台密钥/登录 secret，只给 core 进程），日志等级只认 env，避免两处配置漂移与信息泄漏。
//   - 鉴权：/api/* 需 Bearer token；env WXBOT_TOKEN 自动并入白名单，与 core 侧同一值即双向打通；
//     仅 /health 开放。凭证 = 微信账号权限，./wxbot/data 卷勿外泄。
import express from "express";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import QRCode from "qrcode";
import { WeChatBot, stripMarkdown } from "@wechatbot/wechatbot";

// ── 配置加载（含 ${ENV_VAR} 展开）────────────────────────────────────────────
const DEFAULTS = {
  server: { port: 8093 },
  auth: { enabled: true, tokens: [] },
  core: {
    url: "",      // agent-core 内网地址；一般不配，由 compose env CORE_URL 兑底注入
    token: "",    // 调 core /wxhook/* 的凭据；由 env WXBOT_TOKEN 兑底（与 auth 白名单同源）
  },
  bot: {
    storage_dir: "/data/bots",   // 每绑定一个子目录（目录名 = binding id）
    log_level: "info",           // debug | info | warn | error | silent；运行期被 env WXBOT_LOG_LEVEL 覆盖（compose 注入，同 EXECUTOR_LOG_LEVEL 模式）
    strip_markdown: false,       // 出口 markdown 纯文化开关：微信已支持渲染 markdown，默认 false 原样透传；env WXBOT_STRIP_MARKDOWN=1 可恢复剥除
    empty_hint: "（这条消息类型暂时接不住——支持文字/图片/视频/文件；指令可发 /help）", // 未接入类型（voice/贴纸等）的本地兑底回执
  },
};

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    const b = base[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      b && typeof b === "object" && !Array.isArray(b)
    ) {
      out[k] = deepMerge(b, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function expandEnv(value) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
      const v = process.env[name];
      if (v === undefined || v === "") {
        console.error(`[wxbot] config 引用了 \${${name}}，但环境变量 ${name} 未设置`);
        process.exit(1);
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
    return out;
  }
  return value;
}

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => String(s).trim()).filter(Boolean);
  return [];
}

function loadConfig() {
  const cfgPath = process.env.WXBOT_CONFIG || path.resolve(process.cwd(), "config.yml");
  let fileCfg = {};
  if (fs.existsSync(cfgPath)) {
    fileCfg = yaml.load(fs.readFileSync(cfgPath, "utf8")) || {};
  } else {
    console.warn(`[wxbot] 未找到配置文件 ${cfgPath}，使用内置默认值`);
  }
  return deepMerge(DEFAULTS, expandEnv(fileCfg));
}

const CONFIG = loadConfig();
// env 兑底（同 agent-core 的 EXECUTOR_URL/EXECUTOR_TOKEN 模式）：compose 注入这两个变量后，
// 本服务零配置文件即可上线；config.yml 只在需要改次要旋钮时出现。
CONFIG.auth.tokens = asList(CONFIG.auth.tokens);
const ENV_TOKEN = String(process.env.WXBOT_TOKEN || "").trim();
if (ENV_TOKEN && !CONFIG.auth.tokens.includes(ENV_TOKEN)) CONFIG.auth.tokens.push(ENV_TOKEN);
CONFIG.core.url = String(CONFIG.core.url || process.env.CORE_URL || "").trim().replace(/\/+$/, "");
CONFIG.core.token = String(CONFIG.core.token || ENV_TOKEN).trim();
const AUTH_TOKENS = new Set(CONFIG.auth.tokens);
if (CONFIG.auth.enabled && AUTH_TOKENS.size === 0) {
  console.warn("[wxbot] tokens 为空且未注入 WXBOT_TOKEN：所有 /api 请求都会被 401 拒绝");
}
if (!CONFIG.core.url) {
  console.warn("[wxbot] core.url 未配置且未注入 CORE_URL：收信无法转发给 Agent（实例仍可登录，回复会提示服务未配置）");
}
fs.mkdirSync(CONFIG.bot.storage_dir, { recursive: true });

// 日志等级：env WXBOT_LOG_LEVEL（compose 注入，与 EXECUTOR_LOG_LEVEL 同模式；none/off → SDK 词表的 silent），
// 未注入/非法值走 DEFAULTS（或可选覆盖文件）的值，不影响启动。debug 时收信消息原始结构会原样打印（见 describeMsg）。
{
  const map = { debug: "debug", info: "info", warn: "warn", error: "error", none: "silent", off: "silent" };
  const lv = String(process.env.WXBOT_LOG_LEVEL || "").trim().toLowerCase();
  CONFIG.bot.log_level = map[lv] || String(CONFIG.bot.log_level || "info").toLowerCase();
}

// markdown 出口处理开关：微信已支持渲染 markdown → 默认透传；若某些客户端/版本翻车，
// env WXBOT_STRIP_MARKDOWN=1/true（compose 注入）或配置文件 bot.strip_markdown: true 恢复旧行为（出口纯文化）。
{
  const ev = String(process.env.WXBOT_STRIP_MARKDOWN || "").trim().toLowerCase();
  if (ev) CONFIG.bot.strip_markdown = /^(1|true|on|yes)$/.test(ev);
  else CONFIG.bot.strip_markdown = CONFIG.bot.strip_markdown === true || CONFIG.bot.strip_markdown === "true";
}
// 出口文本：开关开启才 stripMarkdown，否则原样；命令回执与 /api/deliver 两处发送共用。
const outText = (s) => (CONFIG.bot.strip_markdown ? stripMarkdown(String(s)) : String(s));

// ── 鉴权 ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!CONFIG.auth.enabled) return next();
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token || !AUTH_TOKENS.has(token)) {
    return res.status(401).json({ error: "缺少或无效的 Authorization: Bearer <WXBOT_TOKEN>" });
  }
  next();
}

// ── core 客户端 ─────────────────────────────────────────────────────────
async function corePost(p, body, timeoutMs = 15000) {
  const res = await fetch(CONFIG.core.url + p, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + CONFIG.core.token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 保留文本 */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || text.slice(0, 160) || ("core HTTP " + res.status));
    e.status = res.status;
    throw e;
  }
  return data;
}

// fire-and-forget：core 不在线/超时只留日志，绝不抛出
function sendHook(inst, event, extra = {}) {
  corePost("/wxhook/hook", { id: inst.id, event, ...extra }, 8000)
    .catch((e) => console.warn(`[wxbot:${inst.id}] hook(${event}) 上报失败：${e.message}`));
}

// ── 实例管理（binding id ↔ WeChatBot）───────────────────────────────────────
// id 只允许安全字符：它直接当存储目录名用（路径穿越防线）。
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const instances = new Map(); // id -> inst

function storageDirOf(id) {
  return path.join(CONFIG.bot.storage_dir, id);
}

function setState(inst, state) {
  if (inst.state === state) return;
  inst.state = state;
  console.log(`[wxbot:${inst.id}] state → ${state}`);
}

function destroyInstance(id, rmStorage) {
  const inst = instances.get(id);
  if (!inst) return false;
  instances.delete(id);
  inst.dead = true;
  Promise.resolve(inst.bot?.stop?.()).catch(() => {});
  if (rmStorage) {
    try { fs.rmSync(storageDirOf(id), { recursive: true, force: true }); }
    catch (e) { console.warn(`[wxbot:${id}] 清理凭证目录失败：${e.message}`); }
  }
  return true;
}

function createInstance(id) {
  if (instances.has(id)) return instances.get(id);
  const inst = { id, state: "starting", qrUrl: null, accountId: null, bot: null, dead: false };
  const callbacks = {
    onQrUrl: (url) => { inst.qrUrl = String(url || ""); setState(inst, "qr"); },
    onScanned: () => setState(inst, "scanned"),
    onExpired: () => { inst.qrUrl = null; setState(inst, "expired"); sendHook(inst, "expired"); },
  };
  const bot = new WeChatBot({
    storage: "file",
    storageDir: storageDirOf(id),
    logLevel: CONFIG.bot.log_level,
    loginCallbacks: callbacks,
  });
  inst.bot = bot;

  bot.on("login", (creds) => {
    inst.accountId = creds?.accountId ?? null;
    inst.qrUrl = null;
    setState(inst, "online");
    sendHook(inst, "online", { accountId: inst.accountId });
  });
  bot.on("session:restored", (creds) => {
    inst.accountId = creds?.accountId ?? inst.accountId ?? null;
  });
  bot.on("error", (e) => console.error(`[wxbot:${id}] bot error:`, e?.message || e));

  bot.onMessage((msg) => onIncoming(inst, msg));
  instances.set(id, inst);

  // login() + start()：有持久凭证则免扫码直接恢复；失败置 error 并上报（expired 已在回调里）
  bot.run({ callbacks })
    .then(() => { if (!inst.dead && inst.state !== "online") setState(inst, "online"); })
    .catch((e) => {
      if (inst.dead) return;
      setState(inst, "error");
      sendHook(inst, "error", { note: String(e?.message || e).slice(0, 200) });
      console.error(`[wxbot:${id}] 登录/轮询失败: ${e?.message || e}`);
    });
  return inst;
}

// 收信 → 转发 core inbox。命令回执（kind=command）同步回文本；
// 普通消息（kind=message）不回执——最终回复稍后由 core 经 /api/deliver 推过来。
// 媒体消息（image/video/file）：SDK 下好字节随 inbox 转发（core 落任务目录 + 拼「用户上传了文件」
// 告知行，同 web 附件模式）。msg.text 对媒体消息是 SDK 占位描述（如 "[image]"），不能当真正文；
// voice 特殊：iLink 服务端已自动转写，msg.text 即识别出的文字，按文本处理（silk 原始音频不下载）。
const MEDIA_KINDS = new Set(["image", "video", "file"]);
const TEXT_LIKE_KINDS = new Set(["text", "voice"]);

// log_level=debug 时打印收信消息的原始结构（长文本截断、Buffer 只记大小、数组只记个数）：
// 用于观察新消息类型/未接入类型的字段形态（如 voice 转写文字、混合消息等）。
function describeMsg(msg) {
  const cut = (s) => (s.length > 300 ? s.slice(0, 300) + `…(${s.length})` : s);
  const out = {};
  for (const [k, v] of Object.entries(msg || {})) {
    if (v === undefined) continue;
    if (v === null || typeof v === "number" || typeof v === "boolean") { out[k] = v; continue; }
    if (Buffer.isBuffer(v)) { out[k] = `<buffer ${v.length}b>`; continue; }
    if (typeof v === "string") { out[k] = cut(v); continue; }
    if (Array.isArray(v)) { out[k] = `<array ${v.length}>`; continue; }
    let s;
    try { s = cut(JSON.stringify(v)); } catch { s = "[object]"; }
    out[k] = s === undefined ? "[unserializable]" : s;
  }
  return out;
}

async function onIncoming(inst, msg) {
  if (CONFIG.bot.log_level === "debug") {
    try { console.log(`[wxbot:${inst.id}] recv: ${JSON.stringify(describeMsg(msg))}`); } catch { /* 调试日志不进主链路 */ }
  }
  const type = String(msg?.type || "text");
  const text = TEXT_LIKE_KINDS.has(type) ? String(msg?.text ?? "").trim() : "";
  const userId = String(msg?.userId ?? "");
  const isMedia = MEDIA_KINDS.has(type);
  if (!text && !isMedia) {
    try { await inst.bot.reply(msg, CONFIG.bot.empty_hint); } catch { /* 尽力而为 */ }
    return;
  }
  inst.bot.sendTyping(userId).catch(() => {});
  let media = null;
  if (isMedia) {
    try {
      const dl = await inst.bot.download(msg);
      const buf = dl && dl.data ? (Buffer.isBuffer(dl.data) ? dl.data : Buffer.from(dl.data)) : null;
      if (!buf || !buf.length) {
        console.warn(`[wxbot:${inst.id}] ${type} 无可下载媒体`);
        try { await inst.bot.reply(msg, CONFIG.bot.empty_hint); } catch { /* 忽略 */ }
        return;
      }
      if (buf.length > 20 * 1024 * 1024) {
        try { await inst.bot.send(userId, "⚠️ 附件过大（限 20MB），未转发"); } catch { /* 忽略 */ }
        return;
      }
      media = { kind: type, b64: buf.toString("base64"), filename: dl.fileName || undefined };
    } catch (e) {
      console.error(`[wxbot:${inst.id}] 媒体下载失败（${type}）：`, e?.message || e);
      try { await inst.bot.send(userId, "⚠️ 媒体下载失败：" + String(e?.message || e).slice(0, 120)); } catch { /* 忽略 */ }
      return; // 媒体即消息主体，下载失败不降级成空文本
    }
  }
  try {
    const r = await corePost("/wxhook/inbox", { id: inst.id, from: userId, text: text || undefined, media: media || undefined }, 30000);
    // 命令回执可能是 markdown（channel 层规范格式）；默认透传（微信已支持渲染），开关控制是否纯文化。
    if (r && r.kind === "command" && r.reply) await inst.bot.send(userId, outText(r.reply));
  } catch (e) {
    if (e.status === 404) {
      // core 侧绑定已删（解绑通知丢失的孤儿实例）：告知用户并自毁（连凭证一起清，避免复活再骚扰）
      try { await inst.bot.send(userId, "⚠️ 该微信已解绑，请到 Agent 网页端设置里重新绑定。"); } catch { /* 忽略 */ }
      destroyInstance(inst.id, true);
      return;
    }
    console.error(`[wxbot:${inst.id}] inbox 转发失败：${e.message}`);
    try { await inst.bot.send(userId, "⚠️ Agent 服务异常：" + String(e.message || e).slice(0, 120)); } catch { /* 忽略 */ }
  }
}

// ── HTTP 服务 ──────────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
// 附件投递带 base64 大 body：该路径单独先挂大限额解析器（早于全局 1mb；body-parser 幂等，
// 全局那份见到 req._body 会自动跳过），与 core 侧 /wxhook 同法。
app.use("/api/deliver_media", express.json({ limit: "30mb" }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    instances: Array.from(instances.values()).map((i) => ({ id: i.id, state: i.state })),
  });
});

app.get("/api/instances", requireAuth, (_req, res) => {
  res.json(Array.from(instances.values()).map((i) => ({
    id: i.id, state: i.state, accountId: i.accountId, hasQr: Boolean(i.qrUrl),
  })));
});

// 幂等确保实例存在（core 启动恢复 / 新建绑定 / refresh 共用）
app.post("/api/instances", requireAuth, (req, res) => {
  const id = String((req.body || {}).id || "");
  if (!ID_RE.test(id)) return res.status(400).json({ error: "非法实例 id" });
  const existed = instances.has(id);
  createInstance(id);
  res.json({ ok: true, existed });
});

// 重发登录流程（二维码过期/失败后用）：销毁但不清凭证（有凭证则 refresh 直接恢复在线而不是出二维码）
app.post("/api/instances/:id/refresh", requireAuth, (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "非法实例 id" });
  destroyInstance(id, false);
  createInstance(id);
  res.json({ ok: true });
});

// 解绑销毁：停实例 + 删登录凭证（重新绑定需再扫码）
app.delete("/api/instances/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "非法实例 id" });
  res.json({ ok: true, existed: destroyInstance(id, true) });
});

// 当前登录二维码（SVG）——core 设置页代理呈现，不经公网
app.get("/api/instances/:id/qr.svg", requireAuth, async (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst || !inst.qrUrl) return res.status(404).json({ error: "当前没有待扫二维码" });
  const svg = await QRCode.toString(inst.qrUrl, { type: "svg", margin: 1 });
  res.type("image/svg+xml").send(svg);
});

// core → wxbot 外发投递（assistant 最终回复，core 已按微信长度分好段）
app.post("/api/deliver", requireAuth, async (req, res) => {
  const { id, to, text } = req.body || {};
  const inst = instances.get(String(id || ""));
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  if (!to || !String(text || "").trim()) return res.status(400).json({ error: "to/text 不能为空" });
  try {
    await inst.bot.send(String(to), outText(text));
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "发送失败：" + String(e?.message || e).slice(0, 200) });
  }
});

// core → wxbot「正在输入」心跳（工具调用/回执节奏触发；typing 由微信侧自动过期，无需 stopTyping）
app.post("/api/typing", requireAuth, async (req, res) => {
  const { id, to } = req.body || {};
  const inst = instances.get(String(id || ""));
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  if (!to) return res.status(400).json({ error: "to 不能为空" });
  try {
    await inst.bot.sendTyping(String(to));
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "typing 失败：" + String(e?.message || e).slice(0, 200) });
  }
});

// core → wxbot 附件投递（链接→卡片）：core 已把正文里的 /p/ 链接换成本地读好的字节并做
// 归属/大小/数量校验；这里只转发 SDK——bot.send 的 file 按扩展名自动路由 image/video/file 卡片，
// CDN 上传 + 加密全在 SDK 内。
app.post("/api/deliver_media", requireAuth, async (req, res) => {
  const { id, to, filename, b64 } = req.body || {};
  const inst = instances.get(String(id || ""));
  if (!inst) return res.status(404).json({ error: "实例不存在" });
  if (!to || !String(b64 || "").trim()) return res.status(400).json({ error: "to/b64 不能为空" });
  const buf = Buffer.from(String(b64).slice(0, 30 * 1024 * 1024), "base64");
  if (!buf.length) return res.status(400).json({ error: "b64 解码失败" });
  if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: "附件过大（限 20MB）" });
  const safeName = String(filename || "file").split(/[\\/]/).pop().slice(0, 120) || "file";
  try {
    await inst.bot.send(String(to), { file: buf, fileName: safeName });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "附件发送失败：" + String(e?.message || e).slice(0, 200) });
  }
});

// 启动即恢复：扫描凭证目录逐个拉起实例（core 不在线也照常上线；状态回调失败不影响）
for (const ent of fs.readdirSync(CONFIG.bot.storage_dir, { withFileTypes: true })) {
  if (ent.isDirectory() && ID_RE.test(ent.name)) createInstance(ent.name);
}

const httpServer = app.listen(CONFIG.server.port, "0.0.0.0", () => {
  console.log(`[wxbot] listening on :${CONFIG.server.port}, core=${CONFIG.core.url || "(未配置)"}, log_level=${CONFIG.bot.log_level}, 恢复实例 ${instances.size} 个}`);
});

// 优雅停机（对齐 executor/server.js 的 shutdown 模式）：此前未注册任何信号处理，bot.run() 的
// 长轮询与 SDK 长连接吊着事件循环，docker stop/restart 只能等满 10s 宽限期吃 SIGKILL，重启肉眼可见地慢。
// 现自接管：停掉全部实例（保留登录凭证，下次启动照常恢复）、关 HTTP，3s 兜底定时器无条件退出——
// stop 自身若悬挂（SDK 第三方黑盒）兜底是唯一可信保险；最坏停机 3s。
function shutdown(sig) {
  console.log(`[wxbot] 收到 ${sig}，停止服务`);
  for (const id of Array.from(instances.keys())) destroyInstance(id, false);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
