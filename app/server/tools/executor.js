// 工具执行器。所有文件路径强制解析到任务目录内（防路径穿越）。
// 工具名与参数 schema 来自 README 7.2（生成到 definitions.json）。
const fs = require('fs');
const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { Minimatch } = require('minimatch');

function makeMatcher(pattern, opts) {
  const mm = new Minimatch(pattern, opts || {});
  return function (p) { return mm.match(p); };
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache']);

// ---------- 路径沙箱 ----------
function resolveInTask(taskDir, p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('路径不能为空');
  let abs;
  if (path.isAbsolute(p)) {
    abs = path.normalize(p);
  } else {
    abs = path.resolve(taskDir, p);
  }
  const root = path.resolve(taskDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('路径越界（只允许任务目录内操作）：' + p);
  }
  return abs;
}

function relOf(taskDir, abs) {
  return path.relative(path.resolve(taskDir), abs) || '.';
}

// ---------- 文件系统遍历 ----------
function walk(taskDir, opts) {
  const out = [];
  const maxFiles = (opts && opts.maxFiles) || 20000;
  function rec(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      if (ent.name.startsWith('.') && IGNORED_DIRS.has(ent.name)) continue;
      if (IGNORED_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        rec(abs);
      } else if (ent.isFile()) {
        out.push(abs);
      }
    }
  }
  rec(taskDir);
  return out;
}

function isProbablyBinary(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, buf.length, null);
    if (bytes === 0) return false;
    const slice = buf.slice(0, bytes);
    return slice.includes(0);
  } catch (_) {
    return true;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n...（输出已截断，共 ' + text.length + ' 字符）';
}

// ---------- 各工具实现 ----------
async function toolReadFile(ctx, args) {
  const abs = resolveInTask(ctx.taskDir, args.path);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new Error("目录不是文件: " + args.path);
  if (isProbablyBinary(abs)) return '[二进制文件，跳过文本读取] ' + relOf(ctx.taskDir, abs);
  let text = await fsp.readFile(abs, 'utf8');
  let lines = text.split('\n');
  const total = lines.length;
  const startLine = args.start_line || 1;
  let endLine = args.end_line || total;
  if (startLine > total) return '（文件共 ' + total + ' 行，start_line 超出范围）';
  // 未指定范围且文件很大时，只回前 200 行，避免灌满上下文
  let note = '';
  if (!args.start_line && !args.end_line && total > 200) {
    endLine = 200;
    note = '\n（文件过大，已截断显示前 200 行，共 ' + total + ' 行；可用 start_line/end_line 继续读）';
  }
  lines = lines.slice(startLine - 1, Math.min(endLine, total));
  return lines.map((l, i) => String(startLine + i).padStart(6, ' ') + '\t' + l).join('\n') + note;
}

async function toolWriteFile(ctx, args) {
  const abs = resolveInTask(ctx.taskDir, args.path);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, args.content ?? '', 'utf8');
  recordFile(ctx, abs);
  return '已成功写入文件 ' + relOf(ctx.taskDir, abs) + '（' + Buffer.byteLength(args.content || '') + ' 字节）';
}

function applyEditsOnce(text, edits) {
  let cur = text;
  for (let i = 0; i < edits.length; i++) {
    const { old_text, new_text } = edits[i];
    if (!old_text) throw new Error('edit #' + (i + 1) + ': old_text 不能为空');
    let idx = cur.indexOf(old_text);
    if (~idx) {
      cur = cur.slice(0, idx) + new_text + cur.slice(idx + old_text.length);
      continue;
    }
    // 模糊回退：按“每行去掉首尾空白”后逐行匹配
    const oldLines = old_text.replace(/\r\n?/g, '\n').split('\n');
    if (oldLines.length > 1 && oldLines[0].trim() === '' && oldLines[oldLines.length - 1].trim() === '') { oldLines.pop(); oldLines.shift(); }
    const normalizedOld = oldLines.map(l => l.trim());
    const curLines = cur.split('\n');
    let found = -1;
    for (let s = 0; s + oldLines.length <= curLines.length; s++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (curLines[s + j].trim() !== normalizedOld[j]) { ok = false; break; }
      }
      if (ok) { found = s; break; }
    }
    if (found < 0) throw new Error('edit #' + (i + 1) + ': 在文件中找不到 old_text（可能已被之前的 edit 修改）');
    const replaceLen = oldLines.length;
    curLines.splice(found, replaceLen, ...new_text.replace(/\r\n?/g, '\n').split('\n'));
    cur = curLines.join('\n');
  }
  return cur;
}

async function toolEditFile(ctx, args) {
  const abs = resolveInTask(ctx.taskDir, args.path);
  let text = await fsp.readFile(abs, 'utf8');
  text = applyEditsOnce(text, args.edits || []);
  await fsp.writeFile(abs, text, 'utf8');
  recordFile(ctx, abs);
  return '已成功应用 ' + ((args.edits || []).length) + ' 处编辑到 ' + relOf(ctx.taskDir, abs);
}

async function toolListDirectory(ctx, args) {
  const abs = resolveInTask(ctx.taskDir, args.path);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const dirs = []; const files = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name + '/');
    else files.push(e.name);
  }
  dirs.sort(); files.sort();
  const all = dirs.concat(files);
  const shown = all.slice(0, 500);
  let out = '目录 ' + relOf(ctx.taskDir, abs) + ' 下的文件与子目录：\n' + shown.join('\n');
  if (all.length > shown.length) out += '\n...（共 ' + all.length + ' 项，已截断）';
  if (all.length === 0) out = '（目录为空）';
  return out;
}

async function toolCreateDirectory(ctx, args) {
  const abs = resolveInTask(ctx.taskDir, args.path);
  await fsp.mkdir(abs, { recursive: true });
  return '已创建目录 ' + relOf(ctx.taskDir, abs);
}

async function toolDeletePath(ctx, args) {
  const abs = resolveInTask(ctx.taskDir, args.path);
  if (path.resolve(abs) === path.resolve(ctx.taskDir)) throw new Error('禁止删除任务目录本身');
  await fsp.rm(abs, { recursive: true, force: true });
  return '已删除 ' + relOf(ctx.taskDir, abs);
}

async function toolMovePath(ctx, args) {
  const src = resolveInTask(ctx.taskDir, args.source_path);
  const dst = resolveInTask(ctx.taskDir, args.destination_path);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
  recordFile(ctx, dst);
  return '已移动/重命名 ' + relOf(ctx.taskDir, src) + ' → ' + relOf(ctx.taskDir, dst);
}

async function toolCopyPath(ctx, args) {
  const src = resolveInTask(ctx.taskDir, args.source_path);
  const dst = resolveInTask(ctx.taskDir, args.destination_path);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.cp(src, dst, { recursive: true });
  recordFile(ctx, dst);
  return '已复制 ' + relOf(ctx.taskDir, src) + ' → ' + relOf(ctx.taskDir, dst);
}

async function toolFindPath(ctx, args) {
  const files = walk(ctx.taskDir).map(f => relOf(ctx.taskDir, f)).sort();
  const matcher = makeMatcher(args.glob, { dot: true });
  const matched = files.filter(matcher);
  const offset = args.offset || 0;
  const page = matched.slice(offset, offset + 50);
  if (page.length === 0) return '没有匹配 ' + args.glob + ' 的路径';
  return page.join('\n') + '\n（共 ' + matched.length + ' 个匹配' + (offset + 50 < matched.length ? '，用 offset=' + (offset + 50) + ' 看下一页' : '') + '）';
}

async function toolGrep(ctx, args) {
  let re;
  try { re = new RegExp(args.regex, args.case_sensitive ? '' : 'i'); } catch (e) {
    return '正则解析失败：' + e.message;
  }
  const pattern = args.include_pattern ? makeMatcher(args.include_pattern, { dot: false }) : null;
  const files = walk(ctx.taskDir);
  const matches = [];
  for (const abs of files) {
    const rel = relOf(ctx.taskDir, abs);
    if (pattern && !pattern(rel)) continue;
    if (isProbablyBinary(abs)) continue;
    let text;
    try { text = await fsp.readFile(abs, 'utf8'); } catch (_) { continue; }
    if (text.length > 2 * 1024 * 1024) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        matches.push(rel + ':' + (i + 1) + ':' + lines[i]);
        if (matches.length >= 200) break;
      }
    }
    if (matches.length >= 200) break;
  }
  const offset = args.offset || 0;
  const page = matches.slice(offset, offset + 20);
  if (page.length === 0) return '没有匹配';
  return page.join('\n') + '\n（共 ' + matches.length + ' 处匹配' + (offset + 20 < matches.length ? '，用 offset=' + (offset + 20) + ' 看下一页' : '') + '）';
}

// terminal：spawn + 进程组 kill + 超时 + 输出截断
async function toolTerminal(ctx, args) {
  const cfg = ctx.cfg;
  const timeout = args.timeout_ms || cfg.terminal.default_timeout_ms;
  const maxChars = cfg.terminal.max_output_chars;
  let cwd = ctx.taskDir;
  if (args.cd) cwd = resolveInTask(ctx.taskDir, args.cd);
  if (!fs.existsSync(cwd)) throw new Error('cd 目录不存在：' + args.cd);

  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', args.command], { cwd, detached: true, env: process.env });
    ctx.run.procs.add(child);
    let out = '';
    let killedBy = null; // 'timeout' | 'cancelled'
    let settled = false;

    const timer = setTimeout(() => {
      killedBy = 'timeout';
      killGroup(child);
    }, timeout);

    const onData = (d) => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelCheck);
      ctx.run.procs.delete(child);
      let text = out;
      if (killedBy === 'timeout') text += '\n（命令超时 ' + timeout + 'ms，已终止）';
      if (killedBy === 'cancelled') text += '\n（用户终止任务，进程被 kill）';
      if (extra) text += '\n' + extra;
      text += '\n[exit code: ' + code + ']';
      resolve(truncate(text || '（无输出）', maxChars));
    };
    child.on('error', err => finish(-1, 'spawn 失败：' + err.message));
    child.on('close', code => finish(killedBy ? -1 : (code === null ? -1 : code)));

    const cancelCheck = setInterval(() => {
      if (ctx.run.cancelled) { killedBy = 'cancelled'; killGroup(child); }
    }, 200);
  });
}

function killGroup(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) {}
  }
}

// fetch：抓取并粗略转 Markdown
async function toolFetch(ctx, args) {
  if (ctx.run.cancelled) throw new Error('已终止');
  const url = args.url;
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https URL');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (agent-app)' },
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  let body;
  if (ct.includes('html')) body = htmlToMarkdown(text);
  else if (ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('markdown')) body = text;
  else return '[非文本响应] HTTP ' + res.status + ' content-type=' + ct + '，' + text.length + ' 字节';
  if (text.length > 1024 * 1024) body += '\n（响应过大，已截断）';
  return 'HTTP ' + res.status + '\n' + truncate(body, 1024 * 1024);
}

function htmlToMarkdown(html) {
  let s = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lv, t) => '\n' + '#'.repeat(Number(lv)) + ' ' + strip(t).trim() + '\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, t) => '\n- ' + strip(t).trim())
    .replace(/<a[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => '[' + strip(t).trim() + '](' + href + ')')
    .replace(/<(br|hr)[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function strip(s) { return s.replace(/<[^>]+>/g, ''); }

// web_search：调用内网 MCP 服务（JSON-RPC over HTTP，无状态，响应为 SSE 帧包裹的 JSON）。
async function toolWebSearch(ctx, args) {
  const ws = ctx.cfg.web_search || {};
  if (!ws.url) return 'web_search 未配置：请在 config.yaml 的 web_search.url 中填写 MCP 服务地址';
  const query = args.query;
  if (!query) return 'web_search 缺少参数 query';
  const callId = Date.now();
  const rpc = {
    jsonrpc: '2.0',
    id: callId,
    method: 'tools/call',
    params: {
      name: 'web_search',
      arguments: {
        query,
        ...(args.provider ? { provider: args.provider } : {}),
        ...(args.numResults ? { numResults: args.numResults } : {}),
      },
    },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(ws.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(ws.authorization ? { Authorization: ws.authorization } : {}),
      },
      body: JSON.stringify(rpc),
    });
    const raw = await res.text();
    if (!res.ok) return 'MCP web_search HTTP ' + res.status + ': ' + raw.slice(0, 300);
    // 响应可能是 SSE 帧（多行 data: {...}），取 id 匹配或最后一条 JSON
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        try {
          const obj = JSON.parse(t.slice(5).trim());
          if (!payload || obj.id === callId) payload = obj;
        } catch (_) { /* 跳过非 JSON 帧 */ }
      }
    }
    if (!payload) return 'MCP web_search 响应无法解析：' + raw.slice(0, 300);
    if (payload.error) return 'MCP web_search 错误：' + JSON.stringify(payload.error).slice(0, 500);
    const content = payload.result && payload.result.content;
    if (Array.isArray(content)) {
      const text = content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
      if (text) return text;
    }
    return JSON.stringify(payload.result).slice(0, 20000);
  } finally {
    clearTimeout(timer);
  }
}

function recordFile(ctx, abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return;
    ctx.db.prepare(
      'INSERT INTO files (session_id, filename, size, created_at) VALUES (?,?,?,?)'
    ).run(ctx.sessionId, relOf(ctx.taskDir, abs), st.size, Date.now());
  } catch (_) { /* 文件表仅用于展示，失败不影响主流程 */ }
}

const HANDLERS = {
  read_file: toolReadFile,
  write_file: toolWriteFile,
  edit_file: toolEditFile,
  list_directory: toolListDirectory,
  create_directory: toolCreateDirectory,
  delete_path: toolDeletePath,
  move_path: toolMovePath,
  copy_path: toolCopyPath,
  find_path: toolFindPath,
  grep: toolGrep,
  terminal: toolTerminal,
  fetch: toolFetch,
  web_search: toolWebSearch,
};

// ctx: {sessionId, taskDir, run, cfg, db}
async function executeTool(baseCtx, name, args) {
  const handler = HANDLERS[name];
  if (!handler) return 'Error: 未知工具 ' + name;
  const ctx = baseCtx;
  return handler(ctx, args || {});
}

module.exports = { executeTool, resolveInTask, recordFile };
