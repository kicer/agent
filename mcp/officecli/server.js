// officecli MCP 服务 shim —— Streamable HTTP(:3000) ⇄ officecli mcp(stdio) 桥。
//
// 为什么需要这么一层：officecli 的 MCP 只有 stdio 形态；且 watch(预览)必须与
// officecli 同容器(刷新信号=进程内 IPC)、与 shim 同父(躲开任何命令级进程回收)。
// 本进程是容器 PID1：常驻 officecli mcp 子进程 + watch.js 管槽位 watch 子进程。
//
// 工具面：单工具 officecli（command 字符串透传 + 桥内命令治理）：create/open/push 成功只回文件名确认，
// 预览链接固定格式由前端自拼（AI 面不出现 url）；save/close 自带 download url，点选回读 get-pos；watch/unwatch 桥内拦截但不向 AI 公示
//（必须拦截：vendor 原生 watch 会占死 stdio；且仅开放本会话目录）；隐去命令报原生风格 Unrecognized，
// help 同步对齐可见面；用法指引走 load_skill office-preview（见 DEPLOY_SKILL），零教条。
// 环境变量：OFFICE_WORKSPACE(= /workspace/tasks)、OFFICE_SLOTS(=4)、OFFICE_PREVIEW_PORT(=3100)。
// 公网 url 前缀不配置在这里：调用方（agent-core）每请求用 X-Public-Base 头注入（真相只在 core 一处），
// 会话工作目录同理经 X-Session-Dir 头注入（裸文件名自动补全会话目录，AI 无感）。
'use strict';
const http = require('node:http');
const { createServer } = http;
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 启动自检：officecli 缺失/不可执行不在首个 MCP 请求时以诡异超时现身——PID1 直接 fail fast 并教部署动作。
if (!(process.env.PATH || '').split(':').some((d) => { try { fs.accessSync(path.join(d, 'officecli'), fs.constants.X_OK); return true; } catch (_) { return false; } })) {
  console.error("[bridge] FATAL: officecli binary not found in PATH (expected /opt/officecli/officecli，由 entrypoint 拉取就位)。"
    + "查 [officecli-fetch] 启动日志；离线放置见 officecli/README「离线放置」（sha256 对上就认）。");
  process.exit(1);
}

const watch = require('./watch');
const gateway = require('./gateway');

const PORT = Number(process.env.PORT || 3000);
const PREVIEW_PORT = Number(process.env.OFFICE_PREVIEW_PORT || 3100);
const HOST = process.env.HOST || '0.0.0.0';
const CALL_TIMEOUT_MS = Number(process.env.OFFICECLI_TIMEOUT_MS || 120000);
const SERVER_NAME = 'officecli-mcp';

// ---------- stdio 桥：单条常驻 officecli mcp 子进程 ----------
let child = null;
let ready = false; // officecli 子进程是否已完成 initialize 握手
let buf = '';
let seq = 0;
const pending = new Map(); // bridge id -> {res 回调, timer:http 等待方}

function resetChild() {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('officecli process exited, retry')); }
  pending.clear(); buf = ''; child = null; ready = false;
}

function ensureChild() {
  if (child) return child;
  // cwd 进共享卷：否则相对路径产物落在容器根 fs（/app），core/executor 都看不见
  child = spawn('officecli', ['mcp'], { stdio: ['pipe', 'pipe', 'inherit'], cwd: watch.WORKSPACE });
  const me = child; // 身份守卫：只有当前子进程的 exit 才重置桥（换新后的旧进程迟到的 exit 不得误伤）
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        clearTimeout(p.timer); p.resolve(msg);
      } else if (msg.method) {
        console.log('[bridge] officecli 通知:', msg.method); // 桥接侧暂无需处理
      }
    }
  });
  me.on('exit', (code) => { console.log('[bridge] officecli mcp 退出', code); if (child === me) resetChild(); });
  return child;
}
// 向 officecli 子进程发一条 JSON-RPC 请求并等回包（id 重映射，多 HTTP 请求并发安全）
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const c = ensureChild();
    const id = ++seq;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id); reject(new Error('Timeout waiting for officecli response: ' + method));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function sendNotify(method, params) {
  const c = ensureChild();
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

// 桥自己补一次 initialize 握手（兜底：子进程重建后，客户端还没发过 initialize 就来请求）
async function selfInit() {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'officecli-mcp-shim', version: '0' } });
  sendNotify('notifications/initialized', {});
}

// 会话 id 从预览 url 拷回来时可能是百分号编码形态；解不动就用原样（id 字符集本不需编码）
function decSafe(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

// ---------- 部署面治理：隐藏命令报原生风格 unrecognized，help 同步对齐（AI 眼里 = 原生 CLI）----------
const unrecognized = (v) => "Unrecognized command or argument '" + v + "'.";
const HIDDEN_SUBS = new Set(['mark', 'unmark', 'marks', 'goto']); // 标注/滚动族：本部署只保留 watch / watch ls / unwatch / get-pos
const HIDDEN_VERBS = 'mcp|skills|install|plugins'; // 与 handle 里的 mblk 黑名单同步（view 已放开，只拦 html/screenshot 渲染模式）
const HIDDEN_LINE = /^ {2}(?:mcp|skills|install|plugins)\b/; // 注意：绝不能用字符串拼 RegExp，'\b' 在 JS 字符串里是退格符
const HELP_STRIP = /^ {2}(?:watch|unwatch)\b/; // 预览已自动化（create/open/push 附链接）：help 也不出示 watch/unwatch，防 AI 想起没用过的命令
const VIEW_BLOCKED = new Set(['html', 'screenshot', 'svg', 'pdf', 'forms']); // view 渲染族：需无头浏览器/导出插件，本环境一律屏蔽

// push 护栏：目标必须落在 WORKSPACE 内且是白名单扩展名（office + 资源图 + 常见数据；目标可以尚不存在，故不复用 watch.guard）。
// 裸相对名以会话目录为基准（absolutize 只处理 office/图片，其余允许类型若按 WORKSPACE 根解会落到会话外，与回执/files 列表不一致）；
// 显式绝对路径仍可指向工作区任意位置（既有设计）。pushTarget(p, base)：base 越界时退回 WORKSPACE。
function pushTarget(p, base) {
  const wsRoot = path.resolve(watch.WORKSPACE);
  const root = base && path.resolve(base).startsWith(wsRoot + path.sep) ? path.resolve(base) : wsRoot;
  const abs = path.resolve(root, String(p || ''));
  const rel = path.relative(wsRoot, abs);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Target must be inside the workspace (' + watch.WORKSPACE + '): ' + p);
  if (!PUSH_EXT_RE.test(abs)) throw new Error('Unsupported file type: ' + p + '. Allowed: office (.docx/.xlsx/.pptx), images (png/jpg/jpeg/gif/webp/bmp/tiff), pdf/csv/txt/json/md');
  return abs;
}
const PUSH_TIMEOUT_MS = 60000;
const PUSH_MAX_BYTES = 100 * 1024 * 1024;

// 交付取件链接前缀：executor 与本源同网，AI 终端里的 curl 直接用它（改名部署时用 env 覆盖）
const DL_BASE = (process.env.OFFICE_DL_BASE || 'http://mcp_officecli:' + PREVIEW_PORT).replace(/\/+$/, '');
const SYNC_TEACH = 'Your task directory and the officecli workspace are two separate disks. To edit a file that already '
  + 'exists in your task directory: sign a link for it with mint_public_link, then run officecli push <url> <filename> '
  + 'to sync it in. When done editing, save the file and download the returned download url back into your task directory.';

// help 照透传，但文本过一道：隐去的命令行删掉、桥扩展命令补进 Commands 清单（可见面 = 可调用面）
const HELP_ADD = [
  '  get-pos <file>                               Read what the user selected in the live preview (returns JSON).',
  '  push <url> <file>                            Download an http(s) URL into the workspace as <file>.',
  '  files                                        List files under the current workspace directory (server-side).',
];
function alignHelp(reply) {
  const items = reply && reply.result && Array.isArray(reply.result.content) ? reply.result.content : [];
  for (const it of items) {
    if (!it || typeof it.text !== 'string' || !it.text.includes('Commands:')) continue;
    const text = it.text.replace(/ ?Subcommands \(mark\/unmark\/marks\/goto\) operate on the running preview\./g, '');
    const out = [];
    let added = false;
    for (const ln of text.split('\n')) {
      if (HIDDEN_LINE.test(ln) || HELP_STRIP.test(ln)) continue;
      out.push(ln);
      if (!added && /^ {2}help\s/.test(ln)) { out.push(...HELP_ADD); added = true; }
    }
    if (!added) out.push(...HELP_ADD);
    it.text = out.join('\n');
  }
}

// 成功回执三词式：vendor 原文带工作区绝对路径（与 AI 任务目录同名不同盘，极易误判落点），统一替换成
// "Created/Opened: <相对会话目录文件名>"。预览链接是固定格式（<公网前缀>/preview/<会话id>/<相对路径>/），
// 调用方自拼，不再随回包附带。
function ackNote(cmd, reply, sessDir) {
  const verb = /^create\b/.test(cmd) ? 'Created' : /^open\b/.test(cmd) ? 'Opened' : '';
  if (!verb) return;
  const res = reply && reply.result;
  if (!res || res.isError || !Array.isArray(res.content)) return;
  const first = res.content.find((c) => c && typeof c.text === 'string');
  if (!first) return;
  const t = (tokenizeCmd(cmd) || []).find((x) => x.startsWith(watch.WORKSPACE + '/') && OFFICE_EXT_RE.test(x));
  if (!t) return;
  const jail = sessDir && sessDir.startsWith('/') ? path.resolve(sessDir) : '';
  first.text = verb + ': ' + (jail && t.startsWith(jail + '/') ? path.relative(jail, t) : path.basename(t));
}

// 失败文案整形：剥掉工作区路径前缀只留文件名（与任务目录同名不同盘，全路径只会诱发误判）；
// 顺带拆掉 vendor resident 异常包装（"Resident process exited. Unhandled exception: X.CliException: …"）只留内层真错
const WS_PATH_RE = new RegExp(watch.WORKSPACE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(?:[^\\s\'"`,;:()（）]+/)*', 'g');
function scrubErr(reply) {
  const res = reply && reply.result;
  if (!res || !res.isError || !Array.isArray(res.content)) return;
  for (const c of res.content) {
    if (!c || typeof c.text !== 'string') continue;
    c.text = c.text
      .replace(/Resident process exited\.\s*Unhandled exception:\s*[\w.]*Exception:\s*/g, '')
      .replace(WS_PATH_RE, '');
  }
}

// 透传报错误且引用的工作区路径确实不存在：十有八九是文件只在任务目录里 —— 拦截即教学（push 方向）
function teachOnMiss(cmd, reply) {
  const res = reply && reply.result;
  if (!res || !res.isError) return;
  const txt = (res.content || []).map((c) => (c && c.text) || '').join(' ');
  if (/unrecognized/i.test(txt)) return;
  const toks = tokenizeCmd(cmd) || [];
  // key=value 属性里的路径同样检查（如 src=/workspace/…）：缺失才附同步教学 Hint
  if (!toks.some((x) => { const v = x.includes('=') && !x.slice(0, x.indexOf('=')).includes('/') ? x.slice(x.indexOf('=') + 1) : x; return v.startsWith(watch.WORKSPACE + '/') && !fs.existsSync(v); })) return;
  const first = (res.content || []).find((c) => c && typeof c.text === 'string');
  if (first) first.text += '\nHint: ' + SYNC_TEACH;
}

// save/close 是 AI 的原生收尾仪式：成功时附限时取件链接（同 core /p/：URL 即能力），下载回任务目录的动作留给 AI
function deliverNote(cmd, reply) {
  if (!/^(save|close)\b/.test(cmd)) return;
  const res = reply && reply.result;
  if (!res || res.isError || !Array.isArray(res.content)) return;
  const toks = (tokenizeCmd(cmd) || []).filter((t) => t.startsWith(watch.WORKSPACE + '/') && OFFICE_EXT_RE.test(t) && fs.existsSync(t));
  if (!toks.length) return;
  const first = res.content.find((c) => c && typeof c.text === 'string');
  if (!first) return;
  first.text += toks.map((t) => '\ndownload url: ' + DL_BASE + '/f/' + watch.dlMint(t)).join('');
}

// ---------- 预览伪命令（桥内拦截，不落 vendor 进程）----------
// watch 族命令不走透传（常驻服务占死 stdio 会挂满超时）：从命令尾取文件参数，跳过旗标，支持引号
function watchArg(rest) {
  let s = String(rest || '').trim();
  s = s.replace(/^--port(?:\s*=|\s+)\S+\s*/, '');
  s = s.replace(/\s+--port(?:\s*=|\s+)\S+/, '');
  const m = /^"([^"]*)"|^'([^']*)'|^(\S+)/.exec(s);
  return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '';
}

// ---------- 命令治理：路径自动绝对化 / 黑名单 / 部署技能（能用代码处理的绝不写成提示词） ----------
const quoteArg = (s) => (/[\s"'\\]/.test(s) ? "'" + s.replace(/'/g, "'\\''") + "'" : s);

// 引号感知分词；引号不闭合返回 null（调用方放弃改写，不动原命令）
function tokenizeCmd(s) {
  const out = []; let cur = null, q = null;
  for (const c of s) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { if (cur === null) cur = ''; q = c; continue; }
    if (/\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    if (cur === null) cur = '';
    cur += c;
  }
  if (q !== null) return null;
  if (cur !== null) out.push(cur);
  return out;
}

const OFFICE_EXT_RE = /\.(?:docx|xlsx|pptx)$/i;
// 资源图（插图命令的参数）也要绝对化：vendor cwd 是工作区根而非会话目录，裸 logo.png 会错解到 /workspace/logo.png
const RESOURCE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
// --input 类数据文件同样要绝对化:原生 cwd 是工作区根而非会话目录,裸名永远碰不到会话目录里的文件
const DATA_EXT_RE = /\.(?:json|csv|tsv|txt|md)$/i;
// push 目标类型白名单：office + 资源图 + 常见数据；服务端不落盘执行任何内容，风险主要是工作区积灰，白名单聊胜于无
const PUSH_EXT_RE = /\.(?:docx|xlsx|pptx|pdf|csv|txt|json|md|png|jpe?g|gif|webp|bmp|tiff?)$/i;
function absToken(t, sess) {
  if (!t || t.startsWith('-') || t.startsWith('/') || /:\/\//.test(t)) return t;
  // key=value 属性（如 src=a.png）：只对值部分绝对化再拼回 key= 前缀；整体拼会把 src= 也吃进路径
  let key = '';
  let val = t;
  const eq = t.indexOf('=');
  if (eq > 0 && !t.slice(0, eq).includes('/')) { key = t.slice(0, eq + 1); val = t.slice(eq + 1); }
  if (!val || val.startsWith('-') || val.startsWith('/') || /:\/\//.test(val)) return t;
  const core = val.replace(/^(?:\.\.?\/)+/, '');
  if (!OFFICE_EXT_RE.test(core) && !RESOURCE_EXT_RE.test(core) && !DATA_EXT_RE.test(core)) return t;
  return key + sess + '/' + core;
}
// 裸文件名/相对路径 → 会话目录绝对路径（X-Session-Dir）；没有实际改动时原样返回，最小侵入 vendor 解析
function absolutize(cmd, sessDir) {
  if (!sessDir || !sessDir.startsWith('/')) return cmd;
  const sess = sessDir.replace(/\/+$/, '');
  const toks = tokenizeCmd(cmd);
  if (!toks) return cmd;
  let changed = false;
  const out = toks.map((t) => { const a = absToken(t, sess); if (a !== t) changed = true; return a; });
  return changed ? out.map(quoteArg).join(' ') : cmd;
}

// 用法指引：只讲 AI 用得上的（预览链接是固定格式、前端自拼，AI 面不出现 url；也从不要求 AI 主动 watch）
const DEPLOY_SKILL = `# office-preview usage

## Read back the user's selection
get-pos <file>
Returns the structured node the user selected in the live preview. The @id= in its path stays stable across later edits; use it directly with set / get to target the change.

## Sync: your task directory and the workspace are two separate disks
Check: files lists what the workspace (server side) already holds.
Pull in: to edit a file that already exists in your task directory, sign its link with mint_public_link first, then push <url> <file>.
Hand back: every edit is flushed to disk automatically. Before delivery, save <file> to get the download url and download it into your task directory; if you edit again afterwards, save and download again. close does the same.`;

// tools/list 时追加的唯一一句：能力 + 指针，零教条（规矩全在代码与错误文案里）
const DESC_PATCH = '\n\nExtensions: push <url> <file> pulls a URL file into the workspace; files lists the files already inside the workspace (server side); get-pos <file> reads back what the user selected in the live preview; every edit is auto-saved to disk; before delivery run save <file> and download the returned download url into your task directory. Full usage: load_skill office-preview.';
// ---------- Streamable HTTP 入口 ----------
// vendor 的 picture 类型收图片属性名为 src，AI 惯写 path=（会被报 'src' property is required）：
// --type picture/image 时把属性键 path= 别名成 src=（token 层替换，不碰值）
// --commands 内联 JSON 保护:分词器按 POSIX 规则吞词中引号,绝对化触发整行重组后
// JSON 会被剥光双引号(原生报 invalid start of property name)。在分词前从原始串
// 扫描出配平的 JSON,单引号包裹后放回(原生认单引号包裹,含内部双引号/空格)。
// 但原生不认 POSIX 的单引号转义 '\'':JSON 内含 ' 时改写会话目录点文件走 --input
// (绝对路径通道已实测可靠;点文件对 files 隐藏,随会话 purge/TTL 回收)。
// 解析不了就原样放行,桥不装懂。
function quoteInlineJson(cmd, sessDir) {
  const m = /(^|\s)--commands(?:=|[ \t]+)/.exec(cmd);
  if (!m) return cmd;
  const head = cmd.slice(0, m.index) + m[1];
  const valStart = m.index + m[0].length;
  const rest = cmd.slice(valStart);
  const lead = /^\s*/.exec(rest)[0];
  const body = rest.slice(lead.length);
  if (body[0] === "'" || body[0] === '"') return cmd; // 已自带外层引号，交给现有分词管线
  const json = scanBalancedJson(body);
  if (!json) return cmd;
  const tail = body.slice(json.length).replace(/^\s+/, '');
  let flag = '--commands', val;
  if (!json.includes("'")) val = quoteArg(json);
  else if (sessDir && sessDir.startsWith('/')) {
    const fp = sessDir.replace(/\/+$/, '') + '/.batch-inline-' + Date.now().toString(36) + '.json';
    try { fs.writeFileSync(fp, json); flag = '--input'; val = quoteArg(fp); } catch (_) { return cmd; }
  } else return cmd;
  return head + flag + ' ' + val + (tail ? ' ' + tail : '');
}

// 从首个 [ / { 起扫描 balanced JSON 片段(处理 "..." 字符串与 \ 转义);
// 配平后再 JSON.parse 验真,不成 = 返回 null 放弃改写
function scanBalancedJson(s) {
  if (s[0] !== '[' && s[0] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        const frag = s.slice(0, i + 1);
        try { JSON.parse(frag); return frag; } catch (_) { return null; }
      }
    }
  }
  return null;
}

function pictureSrcAlias(cmd) {
  if (!/(?:^|\s)--type\s+(?:picture|image)(?:\s|$)/.test(cmd)) return cmd;
  const toks = tokenizeCmd(cmd);
  if (!toks) return cmd;
  let changed = false;
  const out = toks.map((t) => { if (!/^path=/.test(t)) return t; changed = true; return 'src=' + t.slice(5); });
  return changed ? out.map(quoteArg).join(' ') : cmd;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function toolText(resObj) {
  return { content: [{ type: 'text', text: typeof resObj === 'string' ? resObj : JSON.stringify(resObj, null, 2) }], isError: false };
}
function toolErr(msg) {
  return { content: [{ type: 'text', text: 'Error: ' + (msg && msg.message || String(msg)) }], isError: true };
}

async function handle(msg, pubBase, sessDir) { // pubBase/sessDir：调用方每请求注入（X-Public-Base / X-Session-Dir）
  const isReq = msg.id !== undefined && msg.id !== null;
  let helpCmd = false; // 本次调用是否为 help 族：透传后要把文本对齐可调用面
  // 通知（含 notifications/initialized）：透传不等回包
  if (!isReq) { sendNotify(msg.method, msg.params || {}); return null; }

  if (msg.method === 'tools/call') {
    const args = msg.params && msg.params.arguments || {};
    // 命令归一：argv 数组 → 命令串；相对路径自动绝对化（会话目录由调用方头注入）
    let cmd = Array.isArray(args.command) ? args.command.map((a) => quoteArg(String(a))).join(' ') : String(args.command || '');
    cmd = absolutize(pictureSrcAlias(quoteInlineJson(cmd, sessDir)), sessDir).trim();
    args.command = cmd;
    // 会话目录在 scratch 卷里可能尚不存在（首建）：顺手补齐，create/push 才有落点（仅工作区内）；
    // 但 unwatch（含 --purge）是清理命令，不得反向重建刚删的目录
    if (sessDir && !/^unwatch\b/.test(cmd)) {
      const sd = path.resolve(sessDir);
      if (sd.startsWith(watch.WORKSPACE + '/')) { try { fs.mkdirSync(sd, { recursive: true }); } catch (_) {} }
    }

    // 本部署不合适的命令（装自己/装环境那族）：报原生风格 unrecognized，不露壳；
    // help 清单里的这些行同步在 alignHelp 删除，可见面 = 可调用面。
    const mblk = /^(mcp|skills|install|plugins)(?:\s|$)/.exec(cmd) || /^help\s+(mcp|skills|install|plugins)(?:\s|$)/.exec(cmd);
    if (mblk) return { jsonrpc: '2.0', id: msg.id, result: toolErr(unrecognized(mblk[1])) };
    helpCmd = /^help(?:\s|$)/.test(cmd) || /(?:^|\s)(?:--help|-h)(?:\s|$)/.test(cmd);
    // view 放开结构/语义模式（outline/stats/issues/text/annotated），只拦渲染族（需无头浏览器/导出插件，本环境没有）；
    // 给模型指明替代路径，别让它抱着文档里的强制渲染门反复试错。
    if (!helpCmd && /^view(?:\s|$)/.test(cmd)) {
      const vpos = (tokenizeCmd(cmd) || []).slice(1).filter((t) => !t.startsWith('-')); // [file, mode, ...]
      const vmode = String(vpos[1] || '').toLowerCase();
      if (VIEW_BLOCKED.has(vmode)) {
        return { jsonrpc: '2.0', id: msg.id, result: toolErr(
          "view " + vmode + " is disabled by environment policy. Use 'view <file> outline' or 'view <file> issues' for structural/semantic checks.") };
      }
    }
    // 部署技能：伪装进 vendor 的 load_skill 机制；无名/vendor 已知名照旧透传（清单/其它技能）
    const ms = /^load_skill\b\s*([\s\S]*)$/.exec(cmd);
    if (ms && /^(?:office[-_]?preview|preview)$/.test(ms[1].trim().replace(/^["']|["']$/g, ''))) {
      return { jsonrpc: '2.0', id: msg.id, result: toolText(DEPLOY_SKILL) };
    }
    // files（桥扩展）：列当前会话目录（工作区侧）下的文件，AI 据此判断哪些文件已同步进来；
    // 只报相对文件名，隐藏文件/目录略去，深度与条数封顶。
    if (!helpCmd && /^files(?:\s|$)/.test(cmd)) {
      const root = sessDir ? path.resolve(sessDir) : '';
      if (!root.startsWith(watch.WORKSPACE + '/')) return { jsonrpc: '2.0', id: msg.id, result: toolErr('files: no workspace session directory for this request') };
      const names = [];
      (function walk(dir, depth) {
        if (depth > 4 || names.length >= 500) return;
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
          if (e.name.startsWith('.')) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else if (names.length < 500) names.push(path.relative(root, p));
        }
      })(root, 0);
      return { jsonrpc: '2.0', id: msg.id, result: toolText('# Workspace (server-side):\n' + (names.length ? names.join('\n') : '(no files)')) };
    }
    // 桥内拦截（不占 vendor stdio；对 AI 不公示，见 DEPLOY_SKILL）：watch/unwatch <file> 仅本会话目录，
    // unwatch --session <本会话id> 供 core 会话清理钩子，get-pos 改写原生回读，push 外链拉入
    const mr = /^(watch|unwatch|get-pos|push)\b([\s\S]*)$/.exec(cmd);
    if (mr) {
      const rest = String(mr[2] || '').trim();
      const file = watchArg(rest.replace(/(?:^|\s)--session(?:\s*=|\s+)\S+/g, ' '));
      const jail = sessDir ? path.resolve(sessDir) : watch.WORKSPACE;
      const inJail = (x) => x && path.resolve(x).startsWith(jail + '/');
      try {
        if (mr[1] !== 'push' && HIDDEN_SUBS.has(file)) return { jsonrpc: '2.0', id: msg.id, result: toolErr(unrecognized(file)) };
        if (mr[1] === 'push') {
          const toks = tokenizeCmd(rest) || [];
          const url = String(toks[0] || '');
          const dest = toks[1] || '';
          if (!/^https?:\/\//i.test(url) || !dest) throw new Error('Usage: push <url> <file> (url is typically a link signed by mint_public_link)');
          const abs = pushTarget(dest, jail);
          // 成功/失败文案只带相对文件名：工作区绝对路径对 AI 是干扰项（与任务目录同名不同盘）
          let name = path.relative(jail, abs); if (name.startsWith('..')) name = path.basename(abs);
          if (fs.existsSync(abs) && !/(?:^|\s)--force\b/.test(rest)) throw new Error('File already exists: ' + name + '. Use --force to overwrite.');
          // AI 视角是把文件「上传」进工作区，不说 download
          let r;
          try { r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) }); }
          catch (e) { throw new Error('Failed to read file: ' + String(e && e.message || e).slice(0, 120) + ' (link expired or unreachable? re-sign with mint_public_link and retry)'); }
          if (!r.ok) throw new Error('Failed to read file: HTTP ' + r.status + ' (link expired? re-sign with mint_public_link and retry)');
          const data = Buffer.from(await r.arrayBuffer());
          if (data.length > PUSH_MAX_BYTES) throw new Error('File too large: limit is ' + Math.floor(PUSH_MAX_BYTES / 1048576) + ' MB');
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, data);
          return { jsonrpc: '2.0', id: msg.id, result: toolText('Imported: ' + name) };
        }
        if (mr[1] === 'watch') {
          if (!file) throw new Error('Usage: watch <file>');
          if (!inJail(file)) throw new Error('Preview is only available for documents inside the current session directory: ' + file);
          // 预览链接是固定格式、前端自拼：url/path 不透给 AI 面
          const winfo = Object.assign({}, await watch.start(file, pubBase));
          delete winfo.url; delete winfo.path;
          return { jsonrpc: '2.0', id: msg.id, result: toolText(winfo) };
        }
        if (mr[1] === 'get-pos') {
          if (!file) throw new Error('Usage: get-pos <file> (works once the user opens the preview and selects something)');
          // 文件不存在：vendor 风格失败信封 {success:false, message}，只报相对文件名，顺手带上两盘同步指引
          if (!fs.existsSync(path.resolve(file))) {
            let nm = path.relative(jail, path.resolve(file)); if (nm.startsWith('..')) nm = path.basename(file);
            return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({
              success: false,
              message: 'File not found: ' + nm + '. If it lives in your task directory, sign a link with mint_public_link and pull it in with push <url> <file>.'
            }, null, 2) }], isError: true } };
          }
          // 没有预览槽在跑 = 没有选区来源：直接回空结果（信封与 vendor 一致：{success, data}）。
          // watch 与否不需要 AI 关心，别把这事抛回给模型。
          if (![...watch.slots.values()].some((s) => s.file === path.resolve(file))) {
            return { jsonrpc: '2.0', id: msg.id, result: toolText({ success: true, data: { matches: 0, results: [] } }) };
          }
          cmd = 'get ' + quoteArg(file) + ' selected --json'; // 语义糖：改写为原生命令走原生回读实现
          args.command = cmd;
        } else {
          const msess = /(?:^|\s)--session(?:\s*=|\s+)(\S+)/.exec(rest); // core 会话清理专用：会话号必须等于本次请求的会话目录
          if (msess) {
            const sid = decSafe(msess[1]);
            // --purge（资源篮/core 删会话专用）：杀槽之外连带删会话目录副本（幂等）
            const purge = /(?:^|\s)--purge(?:\s|$)/.test(rest);
            if (sid && sid === path.basename(jail)) return { jsonrpc: '2.0', id: msg.id, result: toolText(watch.stopSession(sid, purge)) };
            return { jsonrpc: '2.0', id: msg.id, result: toolErr(unrecognized('unwatch')) };
          }
          if (!file) throw new Error('Usage: unwatch <file>');
          if (!inJail(file)) return { jsonrpc: '2.0', id: msg.id, result: toolErr(unrecognized('unwatch')) };
          return { jsonrpc: '2.0', id: msg.id, result: toolText(watch.stopOne(file)) };
        }
      } catch (e) {
        const t = String(e && e.message || e);
        return { jsonrpc: '2.0', id: msg.id, result: toolErr(/文件不存在|not found/i.test(t) ? t + ' Hint: ' + SYNC_TEACH : t) };
      }
    }
    watch.touch(cmd); // 命中的预览槽位续命
  }

  try {
    if (msg.method === 'initialize') {
      if (!ready) {
        // 子进程新鲜：客户端握手就是它的真握手（顺序天然正确）
        const fresh = await rpc('initialize', msg.params || {});
        sendNotify('notifications/initialized', {});
        ready = true; fresh.id = msg.id;
        return fresh;
      }
      // 子进程已被桥自举初始化：.NET SDK 不容二次握手、officecli 又单实例不容换新 —— 桥层合成应答
      return { jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'officecli', version: '1.0' } } };
    }
    if (!ready) { await selfInit(); ready = true; }
    const reply = await rpc(msg.method, msg.params || {});
    if (msg.method === 'tools/list' && reply.result && Array.isArray(reply.result.tools)) {
      for (const t of reply.result.tools) {
        if (t) t.description = String(t.description || '') + DESC_PATCH; // 部署侧须知随描述发给模型
      }
    }
    if (helpCmd) alignHelp(reply); // help 文本对齐可调用面：隐去命令删行，扩展命令补录
    if (msg.method === 'tools/call' && sessDir) { // 两份盘的教学与交付链都附在响应里（cmd 作用域仅限 tools/call 块，这里从参数重建）
      const c = String((msg.params && msg.params.arguments || {}).command || '');
      teachOnMiss(c, reply); deliverNote(c, reply); ackNote(c, reply, sessDir); scrubErr(reply);
    }
    reply.id = msg.id; // 桥接 id 换回调用方 id
    return reply;
  } catch (e) {
    try { if (child) child.kill(); } catch (_) {}
    resetChild(); // 桥级失败（超时/进程死）：换掉子进程，下次请求从干净状态重建
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e && e.message || e) } };
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return json(res, 200, { name: SERVER_NAME, transport: 'streamable-http->stdio', preview: { port: PREVIEW_PORT, prefix: watch.PREFIX }, preview_slots: watch.status('') });
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'POST / only' });
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg; try { msg = JSON.parse(body); } catch (_) { return json(res, 400, { error: 'bad json' }); }
    handle(msg, String(req.headers['x-public-base'] || '').replace(/\/+$/, ''), String(req.headers['x-session-dir'] || '')).then((r) => { if (r === null) { res.writeHead(202).end(); return; } json(res, 200, r); })
      .catch((e) => json(res, 500, { error: String(e && e.message || e) }));
  });
});

// ---------- 优雅退出（容器 PID1 惯例，同 web_search） ----------
function shutdown(sig) {
  console.log(`[${SERVER_NAME}] 收到 ${sig}，停止服务`);
  try { if (child) child.kill(); } catch (_) {}
  try { previewServer.close(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const previewServer = gateway.start(PREVIEW_PORT, HOST); // 预览网关：单入口按任务路径路由，槽位号不出容器

server.listen(PORT, HOST, () => {
  console.log(`${SERVER_NAME} HTTP listening on http://${HOST}:${PORT} (officecli mcp bridge, workspace=${watch.WORKSPACE}, slots=${process.env.OFFICE_SLOTS || 4}, preview=:${PREVIEW_PORT}${watch.PREFIX}/…)`);
});
