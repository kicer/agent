// 工具执行器（内置工具）。所有文件路径强制解析到任务目录内（防路径穿越）。
// 工具名与参数 schema 来自 definitions.json；MCP 工具不在这里，见 ../mcp.js。
const fs = require('fs');
const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { Minimatch } = require('minimatch');
const mcp = require('../mcp');
const skills = require('./skills');
const rexec = require('../remote-exec');

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

// 对齐 Zed：整读时文件字节数超过该阈值则返回大纲（outline），而非截断内容。
const AUTO_OUTLINE_SIZE = 16384;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif']);

// read_file 读图（仅当会话绑定的模型 vision: true）：sharp 压缩后转 base64 data URL，
// 由 engine 拼成下一轮请求里 tool 消息的 image_url 内容块。
const IMG_MAX_INPUT_BYTES = 50 * 1024 * 1024; // 与上传上限一致
const IMG_MAX_SIDE = 2000;                    // 长边压缩阈值（px）
const IMG_JPEG_QUALITY = 80;

// 简化版符号大纲（Zed 用 tree-sitter，这里用正则提取常见语言的顶层符号 + Markdown 标题）。
// 返回 "# File outline ..." 文本；无法提取时返回 null（调用方回退到首 1KB）。
const OUTLINE_RES = [
  /^\s*(?:export\s+default\s+|export\s+|default\s+|pub(?:\([^)]*\))?\s+)?(?:pub\s+)?(?:async\s+)?(?:function|fn|func|def|sub)\s+\*?([A-Za-z0-9_]+)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:pub\s+)?(?:abstract\s+|final\s+|open\s+|sealed\s+|data\s+|implicit\s+)*(?:class|struct|trait|interface|enum|impl|namespace|module|type|record|union)\s+([A-Za-z0-9_<>,\[\] ]{1,60}?)(?:\s*[{:<(]|\s*$)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_]+\s*=>)/,
];
function buildOutline(absPath, text) {
  const ext = path.extname(absPath).toLowerCase();
  const lines = text.split('\n');
  const items = [];
  if (ext === '.md' || ext === '.markdown' || ext === '.rst') {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
      if (m) items.push({ depth: m[1].length - 1, name: m[2].trim().slice(0, 80), line: i + 1 });
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      for (const re of OUTLINE_RES) {
        const m = re.exec(lines[i]);
        if (m) {
          const indent = (/^[ \t]*/.exec(lines[i])[0] || '').length;
          items.push({ depth: Math.min(8, Math.floor(indent / 2)), name: m[1].trim(), line: i + 1 });
          break;
        }
      }
      if (items.length >= 500) break;
    }
  }
  if (!items.length) return null;
  const body = items.map(it => ' '.repeat(it.depth) + it.name + ' [L' + it.line + ']').join('\n');
  return '# File outline for ' + absPath + '\n\n' + body +
    '\n\nShowing symbols 1-' + items.length + ' (total symbols: ' + items.length + ')\n';
}

// Zed 同款的大纲包裹文案（模型对该格式有既成预期）。
function outlineWrapper(outlineText) {
  return 'SUCCESS: File outline retrieved. This file is too large to read all at once, so the outline below shows the file\'s structure with line numbers.\n\n' +
    'IMPORTANT: Do NOT retry this call without line numbers - you will get the same outline.\n' +
    'Instead, use the line numbers below to read specific sections by calling this tool again with start_line and end_line parameters.\n\n' +
    outlineText + '\n' +
    'NEXT STEPS: To read a specific symbol\'s implementation, call read_file with the same path plus start_line and end_line from the outline above.\n' +
    'For example, to read a function shown as [L100-150], use start_line: 100 and end_line: 150.';
}

// 用 sharp 压缩（按 EXIF 摆正、长边 ≤2000px、JPEG 质量 80）并转 base64 data URL。
// 成功返回 {text, image_data_url}，engine 侧拼成 tool 消息的多模态内容块；
// sharp 缺失或解码失败时退回纯文本提示，不让整个工具回合报错。
async function readImageAsBlocks(abs, rel, size) {
  let sharp;
  try { sharp = require('sharp'); }
  catch (_) { return '[图片文件] ' + rel + '（' + size + ' 字节）。服务端未安装 sharp，无法压缩回传图片内容。'; }
  try {
    const r = await sharp(abs)
      .rotate()
      .resize({ width: IMG_MAX_SIDE, height: IMG_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: IMG_JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      text: '[图片文件] ' + rel + '（原 ' + size + ' 字节，已压缩为 ' + r.info.width + '×' + r.info.height +
        ' JPEG ' + r.data.length + ' 字节）',
      image_data_url: 'data:image/jpeg;base64,' + r.data.toString('base64'),
    };
  } catch (err) {
    return '[图片文件] ' + rel + '（' + size + ' 字节），图片解码/压缩失败：' + (err && err.message || err);
  }
}

async function toolReadFile(ctx, args) {
  const abs = resolveInTask(ctx.taskDir, args.path);
  let st;
  try { st = await fsp.stat(abs); }
  catch (_) { throw new Error('文件不存在：' + args.path); }
  if (st.isDirectory()) throw new Error(args.path + ' 是目录不是文件，请用 list_directory 工具查看目录内容。');
  if (IMAGE_EXTS.has(path.extname(abs).toLowerCase())) {
    const rel = relOf(ctx.taskDir, abs);
    if (!ctx.vision) {
      return '[图片文件] ' + rel + '（' + st.size + ' 字节）。图片文件，当前模型不支持视觉识别，无法回传图片内容。';
    }
    if (st.size > IMG_MAX_INPUT_BYTES) {
      return '[图片文件] ' + rel + '（' + st.size + ' 字节）过大（上限 ' + IMG_MAX_INPUT_BYTES + ' 字节），已跳过回传。';
    }
    return await readImageAsBlocks(abs, rel, st.size);
  }
  if (isProbablyBinary(abs)) return '[二进制文件，跳过文本读取] ' + relOf(ctx.taskDir, abs);
  const text = await fsp.readFile(abs, 'utf8');
  let lines = text.split('\n');
  const total = lines.length;
  const startLine = Math.max(1, args.start_line || 1);
  let endLine = args.end_line || total;
  if (startLine > total) return '（文件共 ' + total + ' 行，start_line 超出范围）';
  // 对齐 Zed：未指定范围且文件超过 16KB 时返回大纲；提取不到大纲则回退回首 1KB。
  if (!args.start_line && !args.end_line && Buffer.byteLength(text, 'utf8') > AUTO_OUTLINE_SIZE) {
    const outline = buildOutline(abs, text);
    if (outline) return outlineWrapper(outline);
    let head = text.slice(0, 1024);
    try { while (Buffer.byteLength(head, 'utf8') > 1024) head = head.slice(0, -1); } catch (_) {}
    return outlineWrapper('# First 1KB of ' + abs + ' (file too large to show full content, and no outline available)\n\n' + head);
  }
  lines = lines.slice(startLine - 1, Math.min(endLine, total));
  return lines.map((l, i) => String(startLine + i).padStart(6, ' ') + '\t' + l).join('\n');
}

async function toolWriteFile(ctx, args) {
  const abs = resolveInTask(ctx.taskDir, args.path);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, args.content ?? '', 'utf8');
  recordFile(ctx, abs);
  return '已成功写入文件 ' + relOf(ctx.taskDir, abs) + '（' + Buffer.byteLength(args.content || '') + ' 字节）';
}

// ---------- edit_file 匹配（对齐 Zed edit_session/streaming_fuzzy_matcher 的终止态语义） ----------
// Zed 常量：替换代价 1，插入（buffer 多余行）3，删除（query 行未命中）10；模糊相似阈值 0.8。
const COST_REP = 1, COST_INS = 3, COST_DEL = 10, FUZZY_THRESHOLD = 0.8;
const FUZZY_DP_CELL_LIMIT = 8_000_000; // 超大文件跳过 DP，退回逐行 trim 扫描

// normalized Levenshtein 相似度（1 - lev/max_len），先做长度粗筛。
function lineSimilarity(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length, max = Math.max(la, lb);
  if (max === 0) return 1;
  if (1 - Math.abs(la - lb) / max < FUZZY_THRESHOLD) return 0;
  let prev = new Int32Array(lb + 1), curr = new Int32Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = curr; curr = t;
  }
  return 1 - prev[lb] / max;
}

function diagCost(trimOld, trimCur) {
  if (trimOld === trimCur) return 0;
  if (lineSimilarity(trimOld, trimCur) >= FUZZY_THRESHOLD) return COST_REP;
  return COST_DEL + COST_INS;
}

function lineNumberOf(text, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// 全局 DP 对齐（query 行 × buffer 行，逐行 trim 比较）。
// 返回 { startRow, endRow }；找不到返回 null；多个同分候选返回 { ambiguous: [rows] }。
function fuzzyLocate(curLines, oldLinesTrim) {
  const m = oldLinesTrim.length, n = curLines.length;
  const curTrim = new Array(n);
  for (let c = 0; c < n; c++) curTrim[c] = curLines[c].trim();
  const W = n + 1;
  const INF = Number.POSITIVE_INFINITY;
  let dpPrev = new Float64Array(W), dpCur = new Float64Array(W);
  const dir = new Uint8Array((m + 1) * W); // bit1=diag bit2=up(删 query 行) bit4=left(跳过 buffer 行)
  for (let c = 0; c < W; c++) { dpPrev[c] = c * COST_INS; dir[c] = 4; }
  for (let r = 1; r <= m; r++) {
    dpCur[0] = dpPrev[0] + COST_DEL; dir[r * W] = 2;
    const qt = oldLinesTrim[r - 1];
    for (let c = 1; c <= n; c++) {
      const d = dpPrev[c - 1] + diagCost(qt, curTrim[c - 1]);
      const u = dpPrev[c] + COST_DEL;
      const l = dpCur[c - 1] + COST_INS;
      let best = d, bits = 1;
      if (u < best) { best = u; bits = 2; }
      if (l < best) { best = l; bits = 4; }
      dpCur[c] = best; dir[r * W + c] = bits;
    }
    const t = dpPrev; dpPrev = dpCur; dpCur = t;
  }
  // 末行最小代价的所有列 → 逐列回溯成候选，按 (startRow,endRow) 去重。
  let min = INF;
  for (let c = 1; c <= n; c++) if (dpPrev[c] < min) min = dpPrev[c];
  if (!isFinite(min)) return null;
  const seen = new Set(); const candidates = [];
  for (let c0 = 1; c0 <= n; c0++) {
    if (dpPrev[c0] !== min) continue;
    let r = m, c = c0;
    const pairs = [];
    while (r > 0 && c > 0) {
      const bits = dir[r * W + c];
      if (bits & 1) {
        if (diagCost(oldLinesTrim[r - 1], curTrim[c - 1]) <= COST_REP) pairs.push(c - 1);
        r--; c--;
      } else if (bits & 2) { r--; }
      else { c--; }
    }
    if (!pairs.length) continue;
    // 回溯是从下往上收集 pairs（降序），用 min/max 取区间，不依赖收集顺序。
    const startRow = Math.min(...pairs), endRow = Math.max(...pairs);
    const span = endRow - startRow + 1;
    const ratio = pairs.length / Math.max(span, m);
    if (ratio < FUZZY_THRESHOLD) continue;
    const key = startRow + ':' + endRow;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ startRow, endRow });
  }
  if (!candidates.length) return null;
  if (candidates.length > 1) return { ambiguous: candidates.map(x => x.startRow + 1) };
  return candidates[0];
}

function indentOf(l) { return /^[ \t]*/.exec(l)[0]; }

// 按“缓冲行缩进 - query 行缩进”的差值重排 new_text 缩进（空白行不动）。
function applyReindent(newLines, delta, ch) {
  if (delta === 0) return newLines;
  return newLines.map(l => {
    if (!l.trim()) return l;
    const ind = indentOf(l);
    const n = Math.max(0, ind.length + delta);
    if (n <= ind.length) return ' '.repeat(n) + l.slice(ind.length);
    return ind + ch.repeat(n - ind.length) + l.slice(ind.length);
  });
}

// 应用单条 edit；失败抛错（含 edit 序号）。对齐 Zed：先精确（含重叠计数，≥2 歧义），
// 再模糊；匹配区间不含行尾换行；new_text 末尾换行仅当缓冲区该位置后有 \n 时吃掉一个。
function applyEdit(text, edit, i) {
  const tag = 'edit #' + (i + 1);
  const old_text = edit.old_text, new_text = edit.new_text == null ? '' : String(edit.new_text);
  if (!old_text) throw new Error(tag + ': old_text 不能为空');
  // 尾部行尾换行不计入匹配区间（Zed trailing_line_ending_len）。
  let pat = String(old_text);
  if (pat.endsWith('\r\n')) pat = pat.slice(0, -2);
  else if (pat.endsWith('\n')) pat = pat.slice(0, -1);
  if (!pat) pat = String(old_text);
  // 1) 精确匹配（含重叠）
  const hits = [];
  let from = 0;
  while (hits.length < 2) {
    const idx = text.indexOf(pat, from);
    if (idx < 0) break;
    hits.push(idx); from = idx + 1;
  }
  if (hits.length >= 2) {
    throw new Error(tag + ': old_text 在文件中匹配到多处（第 ' + hits.map(h => lineNumberOf(text, h)).join(', ') +
      ' 行附近）。请在 old_text 中包含更多上下文以唯一定位。');
  }
  const newLinesRaw = new_text.split('\n');
  if (hits.length === 1) {
    // 精确匹配：原样替换，不重排缩进（Zed first_line_delta=0，精确下 rest 差值必然 0）。
    const idx = hits[0];
    let repl = new_text;
    // 尾换行摘除：匹配区间后紧跟 \n（或 CRLF 的 \r\n）时吃掉 new_text 的一个尾换行。
    const after = text.charAt(idx + pat.length);
    const afterCRLF = after === '\r' && text.charAt(idx + pat.length + 1) === '\n';
    if ((after === '\n' || afterCRLF) && repl.endsWith('\n')) repl = repl.slice(0, -1);
    // CRLF 文件：新内容里的行尾统一成 \r\n。
    if (text.includes('\r\n')) repl = repl.replace(/\r?\n/g, '\r\n');
    return text.slice(0, idx) + repl + text.slice(idx + pat.length);
  }
  // 2) 模糊匹配（逐行 trim）
  const curLines = text.split('\n');
  const oldLines = pat.split('\n');
  const oldTrim = oldLines.map(l => l.trim());
  let loc = null;
  if (oldLines.length * curLines.length <= FUZZY_DP_CELL_LIMIT) {
    loc = fuzzyLocate(curLines, oldTrim);
  } else {
    // 超大文件降级：逐行 trim 首次命中（旧行为）。
    for (let s = 0; s + oldLines.length <= curLines.length; s++) {
      let ok2 = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (curLines[s + j].trim() !== oldTrim[j]) { ok2 = false; break; }
      }
      if (ok2) { loc = { startRow: s, endRow: s + oldLines.length - 1 }; break; }
    }
  }
  if (!loc) {
    throw new Error(tag + ': 在文件中找不到 old_text（可能已被之前的 edit 修改）。请重新 read_file 获取最新内容后再试。');
  }
  if (loc.ambiguous) {
    throw new Error(tag + ': old_text 模糊匹配到多处（第 ' + loc.ambiguous.join(', ') +
      ' 行附近）。请在 old_text 中包含更多上下文以唯一定位。');
  }
  const { startRow, endRow } = loc;
  let newLines = newLinesRaw;
  // 匹配区间后紧跟换行时，吃掉 new_text 的尾换行（防止吞掉行尾）。
  const hasNewlineAfter = endRow < curLines.length - 1 || text.endsWith('\n');
  if (hasNewlineAfter && newLines.length > 1 && newLines[newLines.length - 1] === '') {
    newLines = newLines.slice(0, -1);
  }
  // 缩进差值重排（以首条匹配行为基准）。
  const bufInd = indentOf(curLines[startRow]);
  const qInd = indentOf(oldLines[0]);
  const delta = bufInd.length - qInd.length;
  if (delta !== 0) newLines = applyReindent(newLines, delta, bufInd.includes('\t') ? '\t' : ' ');
  // CRLF 文件：新增行补齐 \r。
  if (text.includes('\r\n')) newLines = newLines.map(l => (l.endsWith('\r') || l === '' ? l : l + '\r'));
  curLines.splice(startRow, endRow - startRow + 1, ...newLines);
  return curLines.join('\n');
}

// 对齐 Zed：edits 顺序应用到内存态；若第 N 条失败，前 N-1 条仍保存落盘，
// 错误信息告知模型已应用了多少、需重新 read_file。
async function toolEditFile(ctx, args) {
  const abs = resolveInTask(ctx.taskDir, args.path);
  let st;
  try { st = await fsp.stat(abs); }
  catch (_) { throw new Error('文件不存在：' + args.path); }
  if (st.isDirectory()) throw new Error('无法编辑：路径是目录 ' + args.path);
  const edits = args.edits || [];
  let text = await fsp.readFile(abs, 'utf8');
  const original = text;
  let applied = 0;
  let failure = null;
  for (let i = 0; i < edits.length; i++) {
    try { text = applyEdit(text, edits[i], i); applied++; }
    catch (err) { failure = err; break; }
  }
  if (text !== original) {
    await fsp.writeFile(abs, text, 'utf8');
    recordFile(ctx, abs);
  }
  if (failure) {
    throw new Error(failure.message + (applied > 0
      ? '（前 ' + applied + ' 处编辑已应用并保存，文件已变化，请重新 read_file 后再继续）'
      : '（文件未改动）'));
  }
  return '已成功应用 ' + applied + ' 处编辑到 ' + relOf(ctx.taskDir, abs);
}

async function toolListDirectory(ctx, args) {
  // 对齐 ls 语义：path 缺省或为空字符串时等同于当前目录（任务目录）。
  const p = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
  const abs = resolveInTask(ctx.taskDir, p);
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
  // 对齐 Zed：空 glob 视为 *；不含 / 的裸模式按文件名匹配，
  // 否则 schema 里 "*thing*.txt 匹配 directory1/a/something.txt" 的例子永远命不中。
  const glob = (args.glob || '').trim() || '*';
  const bare = !glob.includes('/');
  const matcher = makeMatcher(glob, { dot: true });
  const matched = files.filter(bare ? f => matcher(path.basename(f)) : matcher);
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
  // 对齐 Zed：分页单位是“片段”（匹配行 ±2 行上下文，相邻匹配合并），而非单行。
  const SNIPPET_CAP = 200; // 防止病态全仓匹配撞大内存
  const snippets = [];
  let capped = false;
  outer:
  for (const abs of files) {
    const rel = relOf(ctx.taskDir, abs);
    if (pattern && !pattern(rel)) continue;
    if (isProbablyBinary(abs)) continue;
    let text;
    try { text = await fsp.readFile(abs, 'utf8'); } catch (_) { continue; }
    if (text.length > 2 * 1024 * 1024) continue;
    const lines = text.split('\n');
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      if (cur && i <= cur.end) { if (i + 2 > cur.end) cur.end = Math.min(lines.length - 1, i + 2); continue; }
      if (cur) snippets.push(cur);
      if (snippets.length >= SNIPPET_CAP) { capped = true; cur = null; break outer; }
      cur = { file: rel, lines, start: Math.max(0, i - 2), end: Math.min(lines.length - 1, i + 2) };
    }
    if (cur) snippets.push(cur);
  }
  const offset = args.offset || 0;
  const page = snippets.slice(offset, offset + 20);
  if (page.length === 0) return '没有匹配';
  let outText = '';
  let lastFile = null;
  for (const s of page) {
    if (s.file !== lastFile) { outText += '\n## ' + s.file + ' 中的匹配\n'; lastFile = s.file; }
    const label = s.start === s.end ? 'L' + (s.start + 1) : 'L' + (s.start + 1) + '-' + (s.end + 1);
    outText += '\n### ' + label + '\n```\n' + s.lines.slice(s.start, s.end + 1).join('\n') + '\n```\n';
  }
  const more = capped || offset + 20 < snippets.length;
  const header = more
    ? '显示匹配 ' + (offset + 1) + '-' + (offset + page.length) + '（还有更多，用 offset=' + (offset + 20) + ' 看下一页）:\n'
    : '共找到 ' + snippets.length + ' 处匹配:\n';
  return header + outText;
}

// 对齐 Zed select_terminal_output_lines：head/tail 各自取行；同时给时中间空一行；不去重叠；0 合法。
function selectOutput(text, head, tail) {
  const hasH = typeof head === 'number' && isFinite(head);
  const hasT = typeof tail === 'number' && isFinite(tail);
  if (!hasH && !hasT) return text;
  const lines = text.split('\n');
  const parts = [];
  if (hasH) parts.push(lines.slice(0, Math.max(0, Math.floor(head))).join('\n'));
  if (hasT) parts.push(lines.slice(Math.max(0, lines.length - Math.floor(tail))).join('\n'));
  return parts.join('\n\n');
}

// terminal：spawn + 进程组 kill + 超时 + 输出截断
async function toolTerminal(ctx, args) {
  const cfg = ctx.cfg;
  const timeout = args.timeout_ms || cfg.terminal.default_timeout_ms;
  const maxChars = cfg.terminal.max_output_chars;
  let cwd = ctx.taskDir;
  if (args.cd) cwd = resolveInTask(ctx.taskDir, args.cd);
  if (!fs.existsSync(cwd)) throw new Error('工作目录不存在：' + cwd);

  // 配了 executor.url（或 env EXECUTOR_URL）：命令交给远端 agent-executor 执行，文本拼回与本地完全一致。
  if (rexec.isRemote(cfg)) {
    const r = await rexec.run(cfg, { command: args.command, cwd, timeout_ms: timeout, run: ctx.run });
    let text = selectOutput(r.out.replace(/\n+$/, ''), args.head_lines, args.tail_lines);
    if (r.killed_by === 'timeout') {
      text += (text ? '\n' : '') + '（命令超时 ' + timeout + 'ms，已终止；这是超时不是命令本身失败）';
    } else if (r.killed_by === 'cancelled') {
      text += (text ? '\n' : '') + '（用户终止任务，进程被 kill）';
    } else {
      text += (text ? '\n' : '') + '[exit code: ' + r.code + ']';
    }
    if (r.truncated) text += '\n（输出超长，已在 executor 侧截断）';
    return truncate(text || '（无输出）', maxChars);
  }

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
      // head_lines/tail_lines：对齐 Zed，在原始输出上选段（之前被完全忽略）。
      let text = selectOutput(out.replace(/\n+$/, ''), args.head_lines, args.tail_lines);
      if (killedBy === 'timeout') {
        // 超时/终止不是“执行失败”，不报 exit code（避免 -1 误导模型）。
        text += (text ? '\n' : '') + '（命令超时 ' + timeout + 'ms，已终止；这是超时不是命令本身失败）';
      } else if (killedBy === 'cancelled') {
        text += (text ? '\n' : '') + '（用户终止任务，进程被 kill）';
      } else {
        text += (text ? '\n' : '') + '[exit code: ' + code + ']';
      }
      if (extra) text += '\n' + extra;
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
  let url = String(args.url || '').trim();
  if (!url) throw new Error('fetch 缺少参数 url');
  // 对齐 Zed normalize_url：缺 scheme 时默认补 https://；非 http(s) scheme 仍拒绝。
  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-z0-9+.-]+:\/\//i.test(url)) throw new Error('只支持 http/https URL：' + url);
    url = 'https://' + url;
  }
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
  list_skills: async (ctx, args) => JSON.stringify(await skills.listSkills(ctx), null, 2),
  get_skill_info: (ctx, args) => skills.getSkillInfo(ctx, args.skill_name),
  run_skill: (ctx, args) => skills.runSkill(ctx, args.skill_name, args.input_args),
};

// ctx: {sessionId, taskDir, run, cfg, db, vision}
// 返回值一般为字符串；read_file 读图且 ctx.vision 为 true 时返回 {text, image_data_url}。
// 内置工具优先；未命中时交给 MCP 注册表（启动时发现的服务工具）。
async function executeTool(baseCtx, name, args) {
  const handler = HANDLERS[name];
  if (handler) return handler(baseCtx, args || {});
  if (mcp.hasTool(name)) return mcp.callTool(name, args || {});
  return 'Error: 未知工具 ' + name;
}

module.exports = { executeTool, resolveInTask, recordFile };
