// 工具执行器（内置工具）。所有文件路径强制解析到任务目录内（防路径穿越）。
// 工具名与参数 schema 来自 definitions.json；MCP 工具不在这里，见 ../mcp.js。
const fs = require('fs');
const path = require('path');
const net = require('net'); // fetch SSRF 防护：IP 字面量/解析结果判私网
const dns = require('dns').promises; // 同上：主机名 → IP 后统一判定
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const mcp = require('../mcp');
const skills = require('./skills');
const Database = require('better-sqlite3'); // db 工具：会话目录下的 data.db（同步 API，与单进程模型契合）
const rexec = require('../remote-exec');
const publicFiles = require('../public-files');
const scheduler = require('../scheduler'); // 只依赖 log/cron-parser，不成环（engine→executor→scheduler 单向）
const profile = require('../user-profile'); // profile 工具的数据面（仅 llm/log 依赖，无环）
const memory = require('../memory'); // recall 工具的数据面（日记翻阅；零依赖模块，无环）
// lab 的 help 伪工具要读全量定义：与 engine 同路径 require → node 缓存同一对象，单一事实源。
const BUILTIN_TOOL_DEFS = require('./definitions.json');

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
// 全文读/编辑的硬上限：超过即拒绝整读进内存（OOM 防护，st.size 在 read 前就有），引导走 terminal。
const TEXT_FULL_READ_CAP = 32 * 1024 * 1024;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif']);

// read_file 读图（仅当会话绑定的模型 vision: true）：sharp 压缩后落盘到任务目录 .imgcache/，
// 返回 {text, image_rel}；engine 拼成 image_ref 内容块落库，llm.buildMessages 发请求前
// 现签成公网外链（GET /p/<id>）进 image_url 块，base64 不再进 DB/请求体。
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

// 用 sharp 压缩（按 EXIF 摆正、长边 ≤2000px、JPEG 质量 80）并落盘 .imgcache/。
// 成功返回 {text, image_rel}；产物文件名带源文件指纹（mtime+size），同图重复读复用同一份不增殖。
// 无收益守卫（与浏览器端压缩同款）：重编码 JPEG 反而 ≥ 原图时不落盘，image_rel 直指原文件。
// sharp 缺失或解码失败时退回纯文本提示，不让整个工具回合报错。
async function readImageAsBlocks(ctx, abs, rel, size) {
  let sharp;
  try { sharp = require('sharp'); }
  catch (_) { return '[图片文件] ' + rel + '（' + size + ' 字节）。服务端未安装 sharp，无法压缩回传图片内容。'; }
  try {
    const r = await sharp(abs)
      .rotate()
      .resize({ width: IMG_MAX_SIDE, height: IMG_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: IMG_JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
    if (r.data.length >= size) {
      // 低内容熵图（截图/线稿/纯色）JPEG 重编码可能比原图还大：不产出缓存，外链直接指向原文件
      return {
        text: '[图片文件] ' + rel + '（' + size + ' 字节，压缩无收益，按原图回传）',
        image_rel: rel,
      };
    }
    let st = null;
    try { st = await fsp.stat(abs); } catch (_) {}
    const stem = path.basename(rel).replace(/\.[^.]+$/, '').replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(0, 60);
    const cacheRel = '.imgcache/' + (stem || 'img') + '-' + size + '-' + Math.round(st ? st.mtimeMs : 0) + '.jpg';
    const outAbs = path.join(ctx.taskDir, cacheRel);
    if (!fs.existsSync(outAbs)) {
      await fsp.mkdir(path.dirname(outAbs), { recursive: true });
      await fsp.writeFile(outAbs, r.data);
    }
    return {
      text: '[图片文件] ' + rel + '（原 ' + size + ' 字节，已压缩为 ' + r.info.width + '×' + r.info.height +
        ' JPEG ' + r.data.length + ' 字节）',
      image_rel: cacheRel,
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
  if (st.isDirectory()) throw new Error(args.path + ' 是目录不是文件，请用 terminal 执行 ls 查看目录内容。');
  if (IMAGE_EXTS.has(path.extname(abs).toLowerCase())) {
    const rel = relOf(ctx.taskDir, abs);
    if (!ctx.vision) {
      return '[图片文件] ' + rel + '（' + st.size + ' 字节）。图片文件，当前模型不支持视觉识别，无法回传图片内容。';
    }
    if (st.size > IMG_MAX_INPUT_BYTES) {
      return '[图片文件] ' + rel + '（' + st.size + ' 字节）过大（上限 ' + IMG_MAX_INPUT_BYTES + ' 字节），已跳过回传。';
    }
    return await readImageAsBlocks(ctx, abs, rel, st.size);
  }
  if (isProbablyBinary(abs)) return '[二进制文件，跳过文本读取] ' + relOf(ctx.taskDir, abs);
  if (st.size > TEXT_FULL_READ_CAP) {
    return '（文件过大：' + Math.round(st.size / 1048576) + ' MB，超过 read_file 全文读取上限 '
      + (TEXT_FULL_READ_CAP / 1048576) + ' MB，拒绝整读；请用 terminal 的 grep -n / head / sed -n 定位阅读）';
  }
  const text = await fsp.readFile(abs, 'utf8');
  if (!text) return '（空文件）';
  let lines = text.split('\n');
  // CRLF 文件显示层剥去行尾 \r：模型拿到的行更干净；edit_file 精确/模糊匹配与 CRLF 归一不受影响。
  if (text.includes('\r\n')) lines = lines.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const total = lines.length;
  const startLine = Math.max(1, args.start_line || 1);
  let endLine = args.end_line || total;
  if (startLine > total) return '（文件共 ' + total + ' 行，start_line 超出范围）';
  // 显式拒绝而非 slice 出空串静默返回：空串会让模型误判文件为空/工具坏了而换路重试。
  if (endLine < startLine) throw new Error('end_line 必须 >= start_line（got start_line=' + startLine + ', end_line=' + args.end_line + '）');
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
  // 纵深防御：引擎 checkToolArgs 已把 null 判缺，但直调 executor（测试等）不经过它；
  // 旧版 `?? ''` 会把 null 洗成空串静默清空已有文件，这里显式拒绝。
  if (args.content == null) throw new Error('write_file 缺少参数 content（写空文件请显式传空字符串 ""）');
  let st = null;
  try { st = await fsp.stat(abs); } catch (_) {}
  if (st && st.isDirectory()) throw new Error('无法写入：路径是目录 ' + args.path);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, String(args.content), 'utf8');
  recordFile(ctx, abs);
  const nbytes = Buffer.byteLength(String(args.content), 'utf8');
  const rel = relOf(ctx.taskDir, abs);
  // 区分新建/覆盖：「原 M 字节」是给模型的止损信号（盲覆盖大文件时能立刻察觉）。
  return st
    ? '已覆盖文件 ' + rel + '（' + nbytes + ' 字节，原 ' + st.size + ' 字节）'
    : '已创建文件 ' + rel + '（' + nbytes + ' 字节）';
}

// ---------- edit_file 匹配（对齐 Zed edit_session/streaming_fuzzy_matcher 的终止态语义） ----------
// Zed 常量：替换代价 1，插入（buffer 多余行）3，删除（query 行未命中）10；模糊相似阈值 0.8。
const COST_REP = 1, COST_INS = 3, COST_DEL = 10, FUZZY_THRESHOLD = 0.8;
const FUZZY_DP_CELL_LIMIT = 8_000_000; // 超大文件跳过 DP，退回逐行 trim 扫描

// normalized Levenshtein 相似度（1 - lev/max_len），先做长度粗筛。
// DP 工作集复用模块级 buffer：lineSimilarity 无递归/无重入（单线程下安全），
// 避免 fuzzyLocate m×n 内层每格新建两个 typed array（触顶时是千万次临时分配）。
let simPrev = null, simCurr = null;
function lineSimilarity(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length, max = Math.max(la, lb);
  if (max === 0) return 1;
  if (1 - Math.abs(la - lb) / max < FUZZY_THRESHOLD) return 0;
  if (!simPrev || simPrev.length < lb + 1) {
    simPrev = new Int32Array(lb + 1);
    simCurr = new Int32Array(lb + 1);
  }
  let prev = simPrev, curr = simCurr; // 下面的交换只换局部引用，不动模块级变量
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
    // 升序排列并要求连续：不连续区间说明 DP 在中间跳过了无关的 buffer 行（left/13 代价 diag 路径），
    // 整段 splice 会静默删掉这些行——这类候选直接丢弃（上层报找不到，模型补上下文重试）。
    pairs.sort((a, b) => a - b);
    let contiguous = true;
    for (let k = 1; k < pairs.length; k++) {
      if (pairs[k] !== pairs[k - 1] + 1) { contiguous = false; break; }
    }
    if (!contiguous) continue;
    const startRow = pairs[0], endRow = pairs[pairs.length - 1];
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
    if (afterCRLF) {
      // 尾随 \r\n 要整对切；只切 \n 会在拼接处留下孤立的 \r
      if (repl.endsWith('\r\n')) repl = repl.slice(0, -2);
      else if (repl.endsWith('\n')) repl = repl.slice(0, -1);
    } else if (after === '\n' && repl.endsWith('\n')) {
      repl = repl.slice(0, -1);
    }
    // CRLF 文件：新内容里的行尾统一成 \r\n。
    if (text.includes('\r\n')) repl = repl.replace(/\r?\n/g, '\r\n');
    // 空 new_text 的整行删除：区间恰好行对齐（前邻行首/换行、后随换行）时把尾随行尾一并吃掉，
    // 对齐 Zed 空 new_text=删零行（否则 JS 语义会留下一个空行）。
    if (repl === '' && (after === '\n' || afterCRLF) &&
        (idx === 0 || text.charAt(idx - 1) === '\n' || text.charAt(idx - 1) === '\r')) {
      return text.slice(0, idx) + text.slice(idx + pat.length + (afterCRLF ? 2 : 1));
    }
    return text.slice(0, idx) + repl + text.slice(idx + pat.length);
  }
  // 2) 模糊匹配（逐行 trim）
  const curLines = text.split('\n');
  const oldLines = pat.split('\n');
  const oldTrim = oldLines.map(l => l.trim());
  let loc = null;
  let usedFallback = false;
  if (oldLines.length * curLines.length <= FUZZY_DP_CELL_LIMIT) {
    loc = fuzzyLocate(curLines, oldTrim);
  } else {
    usedFallback = true;
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
    throw new Error(tag + ': 在文件中找不到 old_text（可能已被之前的 edit 修改）。' + (usedFallback
      ? '文件过大，本次仅走了降级匹配（逐行 trim 精确相等、无相似度容忍）：请核对 old_text 与原文是否逐字一致，或改用 read_file 按行号定位后用 terminal 的 sed 编辑，不要以同一文本反复重试。'
      : '请重新 read_file 获取最新内容后再试。'));
  }
  if (loc.ambiguous) {
    throw new Error(tag + ': old_text 模糊匹配到多处（第 ' + loc.ambiguous.join(', ') +
      ' 行附近）。请在 old_text 中包含更多上下文以唯一定位。');
  }
  const { startRow, endRow } = loc;
  // 空 new_text=整行删除：对齐 Zed "".lines() 的零行语义（JS ''.split('\n') 是 1 个空行，会留白）；
  // new_text='\n' 仍是「替换为一个空行」，语义不合并。
  let newLines = new_text === '' ? [] : newLinesRaw;
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
  // 同 read_file 的 OOM 防护：edit_file 也要全量读入，超限拒操作。
  if (st.size > TEXT_FULL_READ_CAP) throw new Error('文件超过 ' + (TEXT_FULL_READ_CAP / 1048576) + 'MB 全文读取上限，edit_file 拒绝操作；请用 terminal 的 sed 等工具编辑');
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

// fetch：抓取并转 Markdown。超时/取消覆盖到 body 读取完成（非仅响应头）；
// 流式读取至多 cfg.fetch.max_bytes 字节（下载上限，宽松）；按响应 charset 解码（gbk 等依赖内置 full-icu）。
// 返回上限与下载解耦（cfg.fetch.max_chars/max_chars_hard）：超窗尾部拼 offset 续读提示，
// 全文缓在 ctx.run 上（回合级），续读不重抓。SSRF 防护：主机名解析结果含私网即拒，重定向逐跳复查。
// undici 网络错误的 message 恒为 "fetch failed"，真因窝在 err.cause 里——不解包模型分不清
// 域名已死/被拒连/TLS 问题（评审实测：只能靠另跑 curl 才能诊断）。常见码翻成中文直述。
const FETCH_NET_ERRORS = {
  ENOTFOUND: '域名无法解析（ENOTFOUND，域名可能已不存在）',
  EAI_AGAIN: 'DNS 暂时不可用（EAI_AGAIN，可稍后重试）',
  ECONNREFUSED: '连接被拒绝（ECONNREFUSED，端口未监听）',
  ECONNRESET: '连接被对端重置（ECONNRESET，多为服务端/中间设备拒服务）',
  ETIMEDOUT: '连接超时（ETIMEDOUT）',
  EHOSTUNREACH: '主机不可达（EHOSTUNREACH）',
  ENETUNREACH: '网络不可达（ENETUNREACH）',
  EPIPE: '管道断裂（EPIPE）',
  EPROTO: '协议错误（EPROTO）',
};
function describeFetchError(err) {
  const c = err && err.cause;
  const code = c && c.code ? String(c.code).toUpperCase() : '';
  const msg = (c && c.message) ? String(c.message) : String((err && err.message) || err);
  if (FETCH_NET_ERRORS[code]) return FETCH_NET_ERRORS[code];
  if (/self.?signed|certificate|CERT_|UNABLE_TO_/i.test(code + ' ' + msg)) return 'TLS 证书校验失败：' + msg;
  return msg + (code ? '（' + code + '）' : '');
}

function isTextualContentType(ct) {
  if (!ct) return true; // 未声明：先按文本读，读完用 NUL 字节兜底判定
  if (ct.startsWith('text/')) return true;
  if (/^application\/(?:[\w.-]+\+)?(?:json|xml|yaml|x-ndjson|ndjson)\b/.test(ct)) return true;
  if (/^application\/(?:javascript|ecmascript|xhtml\+xml)\b/.test(ct)) return true;
  return false;
}

// ---------- fetch 的 SSRF 防护 ----------
// 私网/保留地址判定（IPv4：回环/私有/链路本地含云元数据 169.254.169.254/CGNAT/基准测试/文档段/组播及保留；
// IPv6：未指定/回环/v4-mapped/ULA fc00::/7/链路本地 fe80::/10/组播）。
function isPrivateIp(ip) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 0 || b === 168)) return true;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
    if (a === 203 && b === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  const s = String(ip).toLowerCase();
  const mapped = s.replace(/^::ffff:/, '');
  if (mapped.includes('.')) return isPrivateIp(mapped);
  if (s === '::' || s === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;
  if (/^ff/.test(s)) return true;
  return false;
}

// 主机名 → 全部解析结果逐个判，任一私网即拒（不能假定 undici 会连哪一条记录）。
// 残余风险：本函数解析后 undici 建连时还会再解析一次，DNS 重绑定理论上可绕过；
// 目标是拦住直球打内网与重定向借刀这两类主要路径，不承诺硬边界。fetchUserError 标记：
// 这类已直述清楚的错误不走 describeFetchError 再包一层。
async function assertFetchTargetAllowed(u, allowPrivate) {
  const host = u.hostname.replace(/^\[|\]$/g, ''); // IPv6 字面量带方括号（URL.hostname 保留）
  if (!host) throw Object.assign(new Error('URL 无主机名：' + u.href), { fetchUserError: true });
  let ips;
  if (net.isIP(host)) ips = [host];
  else {
    let recs;
    try { recs = await dns.lookup(host, { all: true, verbatim: true }); }
    catch (e) { throw Object.assign(new Error('无法解析主机 ' + host + (e && e.code ? '（' + e.code + '）' : '')), { fetchUserError: true }); }
    ips = recs.map(r => r.address);
  }
  if (!allowPrivate && ips.some(isPrivateIp)) {
    throw Object.assign(new Error('SSRF 防护：目标解析到回环/私有/内网地址（' + host + ' → ' + ips.join(', ') + '），拒绝抓取；' +
      '确需抓内网服务请在 config 配 fetch.allow_private: true'), { fetchUserError: true });
  }
}

// ---------- fetch 的回合级缓存 ----------
// 返回窗截断时把转换后全文挂到 ctx.run（随 run 消亡，不跨轮污染）：offset 续读纯本地切片，
// 不重走网络。键为请求 URL（归一化后）；LRU 保留 3 条，每条 ≤ max_bytes，内存上限个位数 MB。
function fetchCacheGet(run, key) {
  const c = run && run.fetchCache;
  if (!c) return null;
  const e = c.get(key);
  if (e) { c.delete(key); c.set(key, e); } // 命中挪到最近使用端
  return e || null;
}
function fetchCacheSet(run, key, entry) {
  if (!run) return;
  if (!run.fetchCache) run.fetchCache = new Map();
  run.fetchCache.set(key, entry);
  while (run.fetchCache.size > 3) run.fetchCache.delete(run.fetchCache.keys().next().value);
}

// 从全文切 [off, off+maxOut) 窗，尾部拼续读提示；窗内无内容单独说明。
// 字节级截断（truncated）时本地「全文」本身就不完整，如实告知末尾可能缺失，
// 避免模型对着不完整文本用 offset 无限续读。
function fetchWindow(text, off, maxOut, hard, truncated, maxBytes) {
  if (off >= text.length) {
    return '（offset=' + off + ' 超出全文长度 ' + text.length + ' 字符，无内容可读）' +
      (truncated ? '\n（源响应体超过抓取上限 ' + maxBytes + ' 字节，可用更大 max_bytes 重抓）' : '');
  }
  const end = Math.min(text.length, off + maxOut);
  let out = text.slice(off, end);
  if (end < text.length) {
    out += '\n\n（已截断：全文 ' + text.length + ' 字符，本段 ' + off + '–' + end + '。' +
      '续读传 offset=' + end + '（不重新下载）；单段可传 max_chars 放大，硬帽 ' + hard + '）';
  }
  if (truncated) out += '\n（源响应体超过抓取上限 ' + maxBytes + ' 字节，内容末尾可能不完整）';
  return out;
}

function charsetOf(ct) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(ct || '');
  return m ? m[1].toLowerCase() : '';
}

// 流式读到 maxBytes 即停；超限 reader.cancel() 主动断开，不再继续下载。
async function readBodyLimited(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        if (maxBytes > total) chunks.push(value.subarray(0, maxBytes - total));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) { try { await reader.cancel(); } catch (_) {} }
  }
  return { buf: Buffer.concat(chunks.map(c => Buffer.from(c))), truncated };
}

async function toolFetch(ctx, args) {
  if (ctx.run.cancelled) throw new Error('已终止');
  let url = String(args.url || '').trim();
  if (!url) throw new Error('fetch 缺少参数 url');
  // 对齐 Zed normalize_url：缺 scheme 时默认补 https://；非 http(s) scheme 仍拒绝。
  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-z0-9+.-]+:\/\//i.test(url)) throw new Error('只支持 http/https URL：' + url);
    url = 'https://' + url;
  }
  const fcfg = (ctx.cfg && ctx.cfg.fetch) || {};
  const timeoutMs = fcfg.timeout_ms || 30000;
  const maxBytes = fcfg.max_bytes || 1024 * 1024;
  // 返回窗与下载上限解耦：下载不进上下文可宽松，返回收紧。模型显式传 max_chars 时夹在硬帽内，
  // 非法值（0/负数/NaN）退回默认。
  const hard = fcfg.max_chars_hard || 64000;
  const want = Math.floor(Number(args.max_chars));
  const maxOut = want > 0 ? Math.min(want, hard) : (fcfg.max_chars || 12000);
  const off = Math.max(0, Math.floor(Number(args.offset)) || 0);

  // 续读/重复抓：命中回合缓存直接本地切片，不再碰网络（回合内页面陈旧可接受，缓存续读场景）。
  const hit = fetchCacheGet(ctx.run, url);
  if (hit) {
    return truncate('HTTP ' + hit.status + '\n' +
      fetchWindow(hit.text, off, maxOut, hard, hit.byteTruncated, maxBytes), 1024 * 1024);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 与 toolTerminal 同模式：等待中用户取消也能 abort 掉进行中的请求/读流。
  const cancelWatch = setInterval(() => { if (ctx.run.cancelled) ctrl.abort(); }, 200);
  try {
    // redirect:'manual' + 逐跳 SSRF 校验：自动跟随会让外站 302 直接把我们带进内网（SSRF 主路径）。
    let res = null;
    let cur = url;
    for (let hop = 0; ; hop++) {
      await assertFetchTargetAllowed(new URL(cur), !!fcfg.allow_private);
      res = await fetch(cur, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (agent-app)' },
      });
      const loc = res.headers.get('location');
      if (!loc || res.status < 300 || res.status >= 400) break; // 非跳转：本跳即终答
      if (hop >= 5) throw Object.assign(new Error('重定向次数超过上限（5 次）：' + url), { fetchUserError: true });
      let next;
      try { next = new URL(loc, cur); }
      catch (_) { throw Object.assign(new Error('重定向 Location 非法：' + loc), { fetchUserError: true }); }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw Object.assign(new Error('重定向目标不是 http/https：' + next.href), { fetchUserError: true });
      }
      cur = next.href;
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // 非文本：不读 body，直接回报元信息（避免二进制白下载 + 乱码）。
    if (!isTextualContentType(ct)) {
      const len = Number(res.headers.get('content-length')) || 0;
      return 'HTTP ' + res.status + '\n[非文本响应] content-type=' + ct +
        (len ? '，' + len + ' 字节' : '') + '，未读取内容。';
    }
    if (!res.body) return 'HTTP ' + res.status + '\n（无响应体）';

    const { buf, truncated } = await readBodyLimited(res.body, maxBytes);
    // content-type 未声明的兜底：前 8KB 含 NUL 判为二进制（与 read_file 的 isProbablyBinary 同口径）。
    if (!ct && buf.subarray(0, 8192).includes(0)) {
      return 'HTTP ' + res.status + '\n[非文本响应] content-type 未声明，body 疑似二进制（' + buf.length + ' 字节），未返回内容。';
    }
    // 按 charset 解码；未知/非法编码名退回 UTF-8，不抛错。
    const charset = charsetOf(ct);
    let text;
    if (!charset || charset === 'utf-8' || charset === 'utf8') {
      text = buf.toString('utf8');
    } else {
      try { text = new TextDecoder(charset, { fatal: false }).decode(buf); }
      catch (_) { text = buf.toString('utf8'); }
    }
    let body = ct.includes('html') ? htmlToMarkdown(text) : text;
    // 字节截断可能切在多字节字符中间，尾部的 U+FFFD 是噪音，去掉。
    if (truncated) body = body.replace(/\uFFFD+$/, '');
    const win = fetchWindow(body, off, maxOut, hard, truncated, maxBytes);
    // 窗后本地还有未读内容才缓存（续读场景）；一窗吃下全文的不值得存。
    if (off + maxOut < body.length) {
      fetchCacheSet(ctx.run, url, { status: res.status, text: body, byteTruncated: truncated });
    }
    // engine 不截工具结果；上面的返回窗是主闸门，这行 1MB 字符只是最后兜底。
    return truncate('HTTP ' + res.status + '\n' + win, 1024 * 1024);
  } catch (err) {
    if (err && err.fetchUserError) throw err; // SSRF/重定向等已直述清楚的错误，不再套一层
    // 超时与取消都表现为 signal.aborted（body 读流阶段的报错形态不定，按信号判定最稳）。
    if (ctrl.signal.aborted) {
      if (ctx.run.cancelled) throw new Error('已终止');
      throw new Error('fetch 超时（' + timeoutMs + 'ms）：' + url);
    }
    throw new Error('fetch 失败：' + describeFetchError(err));
  } finally {
    clearTimeout(timer);
    clearInterval(cancelWatch);
  }
}

// 单遍实体解码：旧版链式 replace 会把 &amp;lt; 双重解码成 <；HTML5 全量表 2000+ 条，
// 这里只收网页文本真正常见的命名实体，数字实体（十进制/十六进制）通吃，认不出的原样保留。
const HTML_ENTITIES = {
  nbsp: ' ', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u2018',
  ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e', laquo: '\u00ab', raquo: '\u00bb',
  lsaquo: '\u2039', rsaquo: '\u203a', prime: '\u2032', Prime: '\u2033', bull: '\u2022', middot: '\u00b7',
  times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3', micro: '\u00b5', para: '\u00b6', sect: '\u00a7',
  dagger: '\u2020', Dagger: '\u2021', permil: '\u2030',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', curren: '\u00a4',
  agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2', atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5', ccedil: '\u00e7',
  egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea', euml: '\u00eb',
  igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef',
  ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5', ouml: '\u00f6',
  ugrave: '\u00f9', uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc',
  yacute: '\u00fd', yuml: '\u00ff', ntilde: '\u00f1', szlig: '\u00df',
  ne: '\u2260', le: '\u2264', ge: '\u2265', infin: '\u221e', sup: '\u2283', sub: '\u2286',
};
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);|&#(\d+);|&([a-zA-Z][a-zA-Z0-9]*);/gi, (m, hx, dec, name) => {
    try {
      if (hx) return String.fromCodePoint(parseInt(hx, 16));
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      // hasOwnProperty：防 &constructor; 这类名字踩到原型链。
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, name) ? HTML_ENTITIES[name] : m;
    } catch (_) { return m; } // 码点越界等原样保留
  });
}

function htmlToMarkdown(html) {
  // 标题在剥 head 之前取：head 整块删后页面身份只剩正文，一行标题是性价比最高的上下文。
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = tm ? decodeEntities(strip(tm[1])).trim() : '';
  let s = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    // 语义样板整块剥：导航/页眉/页脚/侧栏/表单这类页壳的正文密度普遍低于信噪比门槛。
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // class/id 命样板词的分块：按启发式整块丢（子串匹配，覆盖 navbar/comments/ad-slot 等变体；
    // 同名标签嵌套时惰匹配只删到第一个闭标签，与既有剥除同样接受不完美）。
    .replace(/<(div|section|ul|ol|article)\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*(?:nav|menu|sidebar|breadcrumb|comment|footer|related|banner|promo|advert|popup|share|subscribe|masthead|cookie|social|toolbar)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lv, t) => '\n' + '#'.repeat(Number(lv)) + ' ' + strip(t).trim() + '\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, t) => '\n- ' + strip(t).trim())
    .replace(/<a[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => '[' + strip(t).trim() + '](' + href + ')')
    .replace(/<(br|hr)[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  // 实体解码放在剥标签之后：&lt;p&gt; 这类转义文本不会被当成标签剥掉。
  const body = decodeEntities(s).replace(/\n{3,}/g, '\n\n').trim();
  return (title ? '# ' + title + '\n\n' : '') + body;
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

// mint_public_link：把当前会话目录里的文件签成一条短命公网链接（由 GET /p/<id> 取用）。
// 这是唯一的签发入口：与 core 同进程，直接调 publicFiles.mint，不必绕任何 HTTP；
// 而 ctx.taskDir 就是会话目录，relOf 的结果正是取用侧（routes/public-files.js）要的 rel。
async function toolMintPublicLink(ctx, args) {
  const pl = (ctx.cfg && ctx.cfg.public_link) || {};
  if (!pl.base_url) throw new Error('public_link.base_url 未配置，无法签发公网链接');
  const abs = resolveInTask(ctx.taskDir, args.path);
  const rel = relOf(ctx.taskDir, abs);
  if (rel === '.') throw new Error('path 要指向一个文件，不能是任务目录本身');
  let st;
  try { st = fs.statSync(abs); } catch (_) { throw new Error('文件不存在：' + rel); }
  if (!st.isFile()) throw new Error('不是文件：' + rel);
  // 符号链接外泄防护：签出去的链接是公网可拉的，realpath 必须仍在任务目录内。
  const real = fs.realpathSync(abs);
  const rootReal = fs.realpathSync(ctx.taskDir);
  if (!real.startsWith(rootReal + path.sep)) {
    throw new Error('path 经符号链接指向了任务目录之外，拒绝签发');
  }
  const id = publicFiles.mint({ sessionId: ctx.sessionId, rel, ttlMs: pl.ttl_ms });
  return pl.base_url + '/p/' + id;
}

// schedule：用户全部定时任务的生命周期（op 分派，规范见 docs/tool-design.md）。
// 任务住会话（表主键 session_id → 每会话至多一条），「哪个任务」就用所属会话 id 指认：
// id 省略/'0' = 本会话（兼容旧调用）；跨会话操作带 op=list 里看到的 id，同用户校验——
// 用户不切会话，AI 代办一切。create 只落当前会话（定时即下班，建完本会话收口退位成专柜）。
// 回执只给事实，零教学（怎么做写在 schema description 里，不每次复读）：
// list 紧凑索引/get 全量详情（编号条目 + key=value 分行，时间 ISO+08:00）；写操单一行短确认。
// list 紧凑索引：认任务、看状态够用（name/last_note/prompt 等细节归 get）
function schedEntry(t, idx) {
  return [
    idx + '. ' + (t.brief || t.title || t.session_id),
    'id=' + t.session_id + (t.current ? '（本会话）' : ''),
    'cron="' + t.cron_expr + '"',
    'next=' + scheduler.fmtIso(t.next_run_at),
    t.last_run_at ? 'last=' + scheduler.fmtIso(t.last_run_at) + ' last_status=' + (t.last_status || '-') : 'last=尚未执行',
  ].join('\n');
}
// get 详情：索引之上补 name（会话标题）、last_note、prompt（原样全量——写入侧已有 2 万字硬帽，
// 读取侧再截就废了 get 的存在意义）——详情字段只在这出现
function schedDetail(t) {
  const clip = s => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 160 ? s.slice(0, 160) + '…' : s; };
  const lines = ['id=' + t.session_id + (t.current ? '（本会话）' : '')];
  if (t.title) lines.push('name=' + t.title);
  if (t.brief) lines.push('brief=' + t.brief);
  lines.push('cron="' + t.cron_expr + '"');
  lines.push('next=' + scheduler.fmtIso(t.next_run_at));
  if (t.last_run_at) lines.push('last=' + scheduler.fmtIso(t.last_run_at) + ' last_status=' + (t.last_status || '-'));
  else lines.push('last=尚未执行');
  if (t.last_note) lines.push('last_note=' + clip(t.last_note));
  if (t.prompt) lines.push('prompt=' + t.prompt);
  return lines.join('\n');
}
function toolScheduleTask(ctx, args) {
  const op = String(args.op || '').trim().toLowerCase();
  const cronExpr = String(args.cron_expr || '').trim();
  const prompt = String(args.prompt || '').trim();
  const db = ctx.db;
  const curUser = () => String((db.prepare('SELECT user FROM sessions WHERE id = ?').get(ctx.sessionId) || {}).user || '');
  // 目标会话解析：无 id → 本会话；有 id → 存在 + 同用户，否则报错（不静默降级，防 AI 拿错目标静默误删）。
  const target = () => {
    const raw = String(args.id == null ? '' : args.id).trim();
    if (!raw || raw === '0' || raw === ctx.sessionId) return ctx.sessionId;
    const s = db.prepare('SELECT user FROM sessions WHERE id = ?').get(raw);
    if (!s) throw new Error('id 指向的会话不存在：' + raw + '（op=list 可看各任务所属会话 id）');
    if (String(s.user || '') !== curUser()) throw new Error('无权操作其他用户的会话任务');
    return raw;
  };
  switch (op) {
    case 'get': {
      const sid = target();
      const t = scheduler.getTask(db, sid);
      if (!t) return sid === ctx.sessionId ? '本会话没有定时任务。' : '会话 ' + sid + ' 没有定时任务。';
      const srow = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sid);
      return schedDetail(Object.assign({ session_id: sid, current: sid === ctx.sessionId, title: srow && srow.title }, t));
    }
    case 'create': {
      const raw = String(args.id == null ? '' : args.id).trim();
      if (raw && raw !== '0' && raw !== ctx.sessionId) throw new Error('op=create 只作用于当前会话：新任务住进本会话并于本回合收尾后收口退位成专柜（定时即下班），无需也不能指定其它会话 id');
      if (!cronExpr) throw new Error('op=create 缺少必填参数 cron_expr');
      if (!prompt) throw new Error('op=create 缺少必填参数 prompt');
      const brief = String(args.brief || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const t = scheduler.createTask(db, ctx.sessionId, cronExpr, prompt, brief);
      // 定时即下班：标记本回合收尾时由 engine 收口（brief 碎片 + 归档 + 通道解绑，见 engine.taskClockOut）。
      if (ctx.onTaskCreated) ctx.onTaskCreated();
      return '已创建 id=' + ctx.sessionId + '\ncron="' + t.cron_expr + '"\nnext=' + scheduler.fmtIso(t.next_run_at)
        + '\n本会话即收口为该任务专柜（用户无感知，下条消息自动进新会话）。';
    }
    case 'update': {
      if (!cronExpr && !prompt) throw new Error('op=update 需要 cron_expr 和 prompt 至少提供一个');
      const sid = target();
      const t = scheduler.updateTask(db, sid, {
        cronExpr: cronExpr || null,
        prompt: prompt || null,
      });
      return '已更新 id=' + sid + '\ncron="' + t.cron_expr + '"\nnext=' + scheduler.fmtIso(t.next_run_at);
    }
    case 'list': {
      // 跨会话全览：编号条目 + key=value 行，id 即行动把手（无任何教学/切会话引导）。
      const rows = scheduler.listUserTasks(db, curUser());
      if (!rows.length) return '当前没有任何定时任务。';
      return '定时任务×' + rows.length + '（按下次执行排序）\n\n'
        + rows.map((t, i) => schedEntry(Object.assign({}, t, { current: t.session_id === ctx.sessionId }), i + 1)).join('\n\n');
    }
    case 'delete': {
      const sid = target();
      const old = scheduler.deleteTask(db, sid);
      return '已删除 id=' + sid + '（原定 cron="' + old + '"）';
    }
    default:
      throw new Error('未知的 op："' + op + '"。可用：get / list（跨会话全览，每行带 id）/ create（仅当前会话；需 cron_expr、prompt、brief）/ update（需 cron_expr、prompt 至少一个，可选 id）/ delete（可选 id）');
  }
}

// profile：用户画像增量维护（op 分派同 schedule 风格）。user 取自会话行，AI 不可指定他人；
// 条件必填/帽子校验全在 user-profile.js（抛错由引擎包成 is_error 回执），停用拒写不拒读。
function toolProfile(ctx, args) {
  const op = String(args.op || '').trim().toLowerCase();
  const s = ctx.db.prepare('SELECT user FROM sessions WHERE id = ?').get(ctx.sessionId);
  if (!s) throw new Error('会话不存在');
  const user = s.user;
  switch (op) {
    case 'list': {
      const p = profile.getProfile(ctx.db, user);
      const lines = [
        '称谓：' + (p.honorific || '（未记录）'),
        '行业：' + (p.industry || '（未记录）'),
        '偏好：' + (p.preference || '（未记录）'),
      ];
      if (!p.enabled) lines.push('（该用户已停用画像注入；set/add/remove 会被拒绝）');
      lines.push('本会话已注入的快照不会因写入而变；新会话自动携带最新画像。');
      return lines.join('\n');
    }
    case 'set': {
      const keys = ['honorific', 'industry'].filter(k => typeof args[k] === 'string');
      if (keys.length !== 1) throw new Error('op=set 需要 honorific 或 industry 恰一个字符串参数（偏好标签用 add/remove）');
      return profile.setProfileField(ctx.db, user, keys[0], args[keys[0]]);
    }
    case 'add':
      return profile.addProfileTags(ctx.db, user, args.tags);
    case 'remove':
      return profile.removeProfileTags(ctx.db, user, args.tags);
    default:
      throw new Error('未知的 op："' + op + '"。可用：list / set(honorific|industry) / add(tags) / remove(tags)');
  }
}

// db：会话本地 SQLite（taskDir/data.db，随会话目录隔离，首次使用自动建库建文件）。
// 连接策略：每次调用 open→用→close，不缓存句柄（会话删目录后不留脏连接）；
// 单进程 + better-sqlite3 同步 API，同进程内不存在交叠。busy_timeout 兼容
// terminal/技能里 sqlite3 CLI 的并发访问。
// 读写分离硬校验：stmt.reader 为真（纯读）拒走 exec，写语句拒走 query；
// prepare 天然拒绝多语句，堆叠注入在入口即挡下。错误不返 {"error"} JSON 而是抛出，
// 由 engine 统一包成 "Error: ..." 并置 is_error（本库工具约定，见 engine 调用处）。
// 结构化 insert 与 exec 同义但免手写 SQL/数占位符（批量行是手写 VALUES 数 ? 的重灾区）：
// 列名先对 sqlite_master 真实列校验再 quoteIdent 转义，值全部走 ? 绑定。
// update/delete 不做结构化 op（单行 SQL 本身简单、错误率低，且 AND 等值 where 表达力
// 不够还要回退 exec）：继续走 exec，入口不拦写语句，兑底通道保持全能力。
// runTaskSql 是本工具与 routes/data-page.js（/api/db/{task_id}/query，页面前端调）共用的
// 唯一 SQL 执行入口：prepare/读写分流/事务/DDL 判定两处同一事实源，不漂移。
const DB_MAX_ROWS = 500;            // query 行数上限（docs 要求：防爆上下文）
const DB_MAX_BYTES = 100 * 1024;    // query 序列化字节上限

function openTaskDbAt(taskDir) {
  fs.mkdirSync(taskDir, { recursive: true });
  const db = new Database(path.join(taskDir, 'data.db'));
  db.pragma('busy_timeout = 5000');
  return db;
}

function openTaskDb(ctx) { return openTaskDbAt(ctx.taskDir); }

// better-sqlite3 不接受 boolean/array/object 绑定；JSON 世界 true/false ↔ SQLite 0/1 是强约定。
// 所有进入绑定位的值（params / rows / set / where）统一过这里。
function dbValue(v, label) {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new Error('db: ' + label + ' 值类型不支持：' + (Array.isArray(v) ? 'array' : typeof v) + '（可用：string/number/null/boolean）');
}

function sanitizeDbParams(params) {
  if (params == null) return [];
  if (!Array.isArray(params)) throw new Error('db: params 必须是数组（按 ? 占位符顺序）');
  return params.map((v, i) => dbValue(v, 'params[' + i + ']'));
}

// 表必须存在且取真实列名集合（仅 table，视图不可写）；返回的 Set 同时充当列名白名单。
function needTaskTableColumns(db, table) {
  const hit = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!hit) throw new Error('db: 表不存在：' + table + '（op=tables 看现有表，op=exec 建新表）');
  return new Set(db.pragma('table_info(' + quoteIdent(hit.name) + ')').map(c => c.name));
}

function requireColumns(cols, keys, label) {
  const bad = keys.filter(k => !cols.has(k));
  if (bad.length) {
    throw new Error('db: ' + label + ' 含未知列：' + bad.join(', ') + '（现有列：' + [...cols].join(', ') + '）');
  }
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// BLOB 列（Buffer）直接 JSON.stringify 会展开成 {"type":"Buffer","data":[...]} 天书，换占位符。
function jsonSafeRows(rows) {
  return rows.map(row => {
    const out = {};
    for (const k of Object.keys(row)) {
      const v = row[k];
      out[k] = Buffer.isBuffer(v) ? '<blob ' + v.length + ' bytes>' : v;
    }
    return out;
  });
}

// 500 行 / 100KB 双上限：未超限返回裸数组；超限改 {rows,...} 信封并附截断说明。
// overflow 由 runTaskSql 的行数截断给出（总行数不再探得，故信封只报 returned_rows 不报 total）；
// 字节线在此再收。
function renderQueryResult(rows, overflow) {
  let shown = rows;
  let truncated = !!overflow;
  if (Buffer.byteLength(JSON.stringify(shown, null, 2)) > DB_MAX_BYTES) {
    truncated = true;
    let bytes = 4; // "[\n]"
    const kept = [];
    for (const r of shown) {
      const s = JSON.stringify(r, null, 2).length + 3; // + 逗号与换行余量
      if (bytes + s > DB_MAX_BYTES && kept.length) break;
      kept.push(r);
      bytes += s;
    }
    shown = kept;
  }
  if (!truncated) return JSON.stringify(shown, null, 2);
  return JSON.stringify({
    rows: shown,
    returned_rows: shown.length,
    truncated: true,
    note: '结果已截断（上限 ' + DB_MAX_ROWS + ' 行或 ' + Math.floor(DB_MAX_BYTES / 1024) + ' KB）。用 WHERE 收窄列/行，或 LIMIT/OFFSET 分页。',
  }, null, 2);
}

// 任务库单语句执行的统一入口。mode：'read' 只许读（op=query）| 'write' 只许写（op=exec）|
// 'any' 按 stmt.reader 自动分流（HTTP API，SKILL.md 契约：任意单语句）。
// maxRows>0 时读取走 iterate 到量即停（防大表 SELECT * 全量物化），overflow 处置交调用方：
// 工具截断成信封，API 直接报错引导分页。错误一律抛出，不在此层包装返回形态。
function runTaskSql(taskDir, sql, params, mode, maxRows) {
  const text = String(sql || '').trim();
  if (!text) throw new Error('db: sql 不能为空');
  const db = openTaskDbAt(taskDir);
  try {
    const stmt = db.prepare(text); // 多语句在此抛错（堆叠注入入口即挡）
    const bound = sanitizeDbParams(params);
    if (stmt.reader) {
      if (mode === 'write') throw new Error('db: op=exec 收到只读语句，读取请用 op=query');
      const rows = [];
      let overflow = false;
      if (maxRows > 0) {
        const it = stmt.iterate(...bound);
        try {
          for (const r of it) {
            if (rows.length >= maxRows) { overflow = true; break; }
            rows.push(r);
          }
        } finally { try { it.return(); } catch (_) {} }
      } else {
        for (const r of stmt.all(...bound)) rows.push(r);
      }
      return { kind: 'read', rows: jsonSafeRows(rows), overflow };
    }
    if (mode === 'read') throw new Error('db: op=query 只允许读语句（SELECT 等），写操作请用 op=exec');
    db.exec('BEGIN');
    try {
      const info = stmt.run(...bound);
      db.exec('COMMIT');
      const verb = text.split(/\s+/)[0].toLowerCase();
      const out = (verb === 'create' || verb === 'alter' || verb === 'drop')
        ? { ok: true }
        : { rowsAffected: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
      return { kind: 'write', out };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw err;
    }
  } finally {
    try { db.close(); } catch (_) {}
  }
}

function toolDb(ctx, args) {
  const op = String(args.op || '').trim().toLowerCase();
  const sql = String(args.sql || '').trim();
  const table = String(args.table || '').trim();

  let db;
  try {
    switch (op) {
      case 'exec': {
        if (!sql) throw new Error('db: op=exec 缺少必填参数 sql');
        const r = runTaskSql(ctx.taskDir, sql, args.params, 'write', 0);
        return JSON.stringify(r.out);
      }
      case 'query': {
        if (!sql) throw new Error('db: op=query 缺少必填参数 sql');
        const r = runTaskSql(ctx.taskDir, sql, args.params, 'read', DB_MAX_ROWS);
        return renderQueryResult(r.rows, r.overflow);
      }
      case 'insert': {
        if (!table) throw new Error('db: op=insert 缺少必填参数 table');
        const list = args.rows;
        if (!Array.isArray(list)) throw new Error('db: op=insert 缺少必填参数 rows（行对象数组，单行也要包成数组）');
        if (!list.length) throw new Error('db: op=insert rows 是空数组，无事可做');
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (!r || typeof r !== 'object' || Array.isArray(r) || !Object.keys(r).length) {
            throw new Error('db: op=insert rows[' + i + '] 必须是非空对象 {列名: 值}');
          }
        }
        // 各行 key 必须一致：静默补 NULL 会掩盖模型笔误，宁可点名报错。
        const cols = Object.keys(list[0]);
        for (let i = 1; i < list.length; i++) {
          const ks = Object.keys(list[i]);
          if (ks.join('\u0000') !== cols.join('\u0000')) {
            throw new Error('db: op=insert 各行 key 必须一致：rows[0]=' + JSON.stringify(cols) +
              '，rows[' + i + ']=' + JSON.stringify(ks));
          }
        }
        db = openTaskDb(ctx);
        requireColumns(needTaskTableColumns(db, table), cols, 'rows');
        const sqlIns = 'INSERT INTO ' + quoteIdent(table) + ' (' + cols.map(quoteIdent).join(', ') +
          ') VALUES (' + cols.map(() => '?').join(', ') + ')';
        const stmtIns = db.prepare(sqlIns);
        db.exec('BEGIN');
        try {
          let firstId = null;
          for (const r of list) {
            const info = stmtIns.run(...cols.map(c => dbValue(r[c], 'rows.' + c)));
            if (firstId === null) firstId = Number(info.lastInsertRowid);
          }
          db.exec('COMMIT');
          return JSON.stringify({ inserted: list.length, firstInsertRowid: firstId });
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch (_) {}
          throw err;
        }
      }
      case 'tables': {
        db = openTaskDb(ctx);
        const names = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all().map(r => r.name);
        const out = names.map(n => ({ name: n, rows: db.prepare('SELECT COUNT(*) AS c FROM ' + quoteIdent(n)).get().c }));
        return JSON.stringify(out, null, 2);
      }
      case 'schema': {
        if (!table) throw new Error('db: op=schema 缺少必填参数 table');
        db = openTaskDb(ctx);
        // PRAGMA 不支持 ? 绑定：先参数化确认表存在，再用转义标识符拼入（不存在即报错，拼入的必是真实名）。
        const hit = db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
          .get(table);
        if (!hit) throw new Error('db: 表不存在：' + table);
        const cols = db.pragma('table_info(' + quoteIdent(hit.name) + ')');
        return JSON.stringify(cols.map(c => ({
          name: c.name, type: c.type, notnull: !!c.notnull, dflt_value: c.dflt_value, pk: !!c.pk,
        })), null, 2);
      }
      default:
        throw new Error('db: 未知的 op："' + op + '"。可用：exec（需 sql，params 可选）/ query（需 sql，params 可选）/ insert（需 table、rows）/ tables / schema（需 table）');
    }
  } finally {
    if (db) try { db.close(); } catch (_) {}
  }
}

// skill：技能三件套（list_skills/get_skill_info/run_skill）合并后的单工具（op 分派）。
// 同一标识空间（name）+ 同一生命周期（live 扫目录，无常驻状态可增删）→ 合并，
// 依据 docs/tool-design.md §一；技能不是「无持久状态」的动作，run 不必单独成工具。
// input_args 仅 op=run 用且可缺省：runSkill 把 null 视作 {}，真正缺哪些字段由
// 各技能 input_schema 校验点名报错（工具层再 gate 一层是双重门槛，无益）。
// visit_url（front matter 可选）：页面产物类技能声明访问路径模板，run 成功后在本层拼
// public_link.base_url（与 mint_public_link 同源）追加完整「访问地址」——技能进程跑在
// executor 隔离视图里不知道公网前缀，AI 拿到相对路径就会原样转给用户，而相对路径打不开。
async function runSkillWithVisit(ctx, name, inputArgs) {
  const out = await skills.runSkill(ctx, name, inputArgs);
  let fm;
  try {
    fm = skills.parseFrontMatter(await skills.getSkillInfo(ctx, name));
  } catch (_) {
    return out; // 描述文件异常不该废掉一次成功的 run
  }
  const tpl = fm && fm.visit_url ? String(fm.visit_url).trim() : '';
  if (!tpl) return out;
  const rel = tpl.replace(/\{task_id\}/g, ctx.sessionId || path.basename(path.resolve(ctx.taskDir || '')));
  const pl = (ctx.cfg && ctx.cfg.public_link) || {};
  const base = String(pl.base_url || '').trim().replace(/\/+$/, '');
  return out + '\n访问地址：' + (base
    ? base + rel
    : rel + '（站内路径：public_link.base_url 未配置，拼不出公网前缀）');
}

async function toolSkill(ctx, args) {
  const op = String(args.op || '').trim().toLowerCase();
  const name = String(args.name || '').trim();
  switch (op) {
    case 'list':
      return JSON.stringify(await skills.listSkills(ctx), null, 2);
    case 'get': {
      if (!name) throw new Error('op=get 缺少必填参数 name');
      return skills.getSkillInfo(ctx, name);
    }
    case 'run': {
      if (!name) throw new Error('op=run 缺少必填参数 name');
      return runSkillWithVisit(ctx, name, args.input_args);
    }
    default:
      throw new Error('未知的 op："' + op + '"。可用：list / get（需 name）/ run（需 name，input_args 可选）');
  }
}

// lab：全工具统一入口（元工具，tools 数组收缩到 1 个仍可达内置 + MCP 全部能力）。
// args 为自由对象——目标 schema 定义期不可知（docs/tool-design.md §三 的合法例外），
// 条件校验归内层 handler；错误冒泡不包装（只有一层）。help 是伪工具：不进 HANDLERS，
// 只在本函数早退。默认被全局 tools_deny 屏蔽，仅 lab profile 显式清空 deny 后下发。
async function toolLab(ctx, args) {
  const name = String(args.tool || '').trim();
  if (!name) throw new Error('lab: 缺少参数 tool。可用：' + listCallableTools().join(', '));
  if (name === 'lab') throw new Error('lab: 不允许嵌套调用 lab。');
  if (name === 'help') return runLabHelp(args.args);
  const inner = args.args;
  if (inner != null && (typeof inner !== 'object' || Array.isArray(inner))) {
    throw new Error('lab: args 必须是对象（目标工具的键值参数），收到：' + JSON.stringify(inner).slice(0, 80));
  }
  // 先自查再转发：未知名要带全清单回显（§五 报错回显），executeTool 的兑底文案没这个待遇。
  if (!HANDLERS[name] && !mcp.hasTool(name)) {
    throw new Error('未知工具 "' + name + '"。可用：' + listCallableTools().join(', '));
  }
  return executeTool(ctx, name, inner || {});
}

function listCallableTools() {
  // help 不在 HANDLERS（伪工具）；lab 自身不列（嵌套已被拒，列了只会诱导模型绕圈）。
  // MCP 侧用 toolDefinitions() 现成取名——含冲突重命名的 server__ 前缀，与实际可调用名严格一致。
  return Object.keys(HANDLERS).filter(n => n !== 'lab')
    .concat(mcp.toolDefinitions().map(t => t.function.name));
}

function runLabHelp(args) {
  const all = BUILTIN_TOOL_DEFS.concat(mcp.toolDefinitions())
    .filter(t => t && t.function && t.function.name !== 'lab');
  const target = args && String(args.tool || '').trim();
  if (!target) {
    return all.map(t => t.function.name + ' — ' + String(t.function.description || '').split('\n')[0].trim()).join('\n');
  }
  const def = all.find(t => t.function.name === target);
  if (!def) throw new Error('未知工具 "' + target + '"。可用：' + all.map(t => t.function.name).join(', '));
  return JSON.stringify(def.function, null, 2);
}

// handoff：顾问阶段唯一出口（advising 组合见 config.js）。brief 原样落盘任务目录根 task.md；
// title 直写 sessions.title（交接此刻顾问最懂这单任务，标题以此为准，finalize 的
// maybeGenerateTitle 见非空即跳过）；批尾由 engine 广播 title 事件同步已开窗口。
// 切换不在此发生——executeTool 只落盘与回执，runLoopInner 在工具批尾接成功回执触发 enterExecuting
//（其读盘取快照作锚点，幂等防重切）。phase 守卫不可省：「名单外工具照跑」是全局策略，
// 执行期幻觉调用不得覆写修订中的 task.md；reason 枚举与 brief 非空也在此兑底（checkToolArgs 只查必填键）。
async function toolHandoff(ctx, args) {
  const sess = ctx.db.prepare('SELECT phase, title_locked FROM sessions WHERE id = ?').get(ctx.sessionId);
  if (!sess || sess.phase !== 'advising') return 'Error: 当前不在顾问阶段，handoff 仅在 advising 可用';
  const reason = String((args && args.reason) || '');
  if (['ready', 'user_skip', 'user_stuck'].indexOf(reason) < 0) {
    return 'Error: reason 需为 ready / user_skip / user_stuck 之一';
  }
  const brief = typeof args.brief === 'string' ? args.brief : '';
  if (!brief.trim()) return 'Error: brief 不能为空，任务书需完整带上（user_skip/user_stuck 至少含用户原话与 Missing 清单）';
  // 标题清洗对齐 cleanTitle（engine 内函数，executor 反向引用会成环，此处同款口径）：
  // 压空白 + 截 60；引号剥除交给模型自觉（description 已明说），不做二次加工。
  const title = String(args.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!title) return 'Error: title 不能为空，给出一个概括任务的简洁标题';
  const abs = path.join(ctx.taskDir, 'task.md');
  await fsp.writeFile(abs, brief, 'utf8');
  recordFile(ctx, abs); // 同步 files 元数据表（与 write_file 同轨，任务目录列表/清理逻辑一致）
  // task.md 落盘成功后才改标题：切换半途失败不留「有名无书」的残局；
  // 用户手动重命名过（title_locked，见 engine.renameSession）则尊重用户的名字，静默跳过。
  if (!sess.title_locked) {
    ctx.db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), ctx.sessionId);
  }
  // 同批多次 handoff：后写覆盖（last-wins），批尾的切换只发生一次（enterExecuting 幂等）。
  // 回执只写事实：成功路径下本回执连同父行一起被存档、不会回到任何模型；
  // 读者只有 enterExecuting 放弃/报错后继续 advising 的模型本身（据此自纠），无行为指令可带。
  return '已接收交接（reason: ' + reason + '），本批工具跑完后系统将切换到执行阶段。';
}

// recall：长期记忆（工作日记）的回忆入口（定稿 B 方案：极简三 op，描述短不挤占工具位）。
// 日记按会话收口持久存储（memory.js），开场只注入最近 N 条；更早的条目与某次工作的成果文件由本工具按需取。
// 只读数据面：仅能碰本用户的日记与会话（id 同用户校验防互探）；link 产出的外链与 mint_public_link 同机制同时效。
function toolRecall(ctx, args) {
  const op = String(args.op || '').trim().toLowerCase();
  const db = ctx.db;
  const me = db.prepare('SELECT user FROM sessions WHERE id = ?').get(ctx.sessionId);
  const user = String((me && me.user) || '');
  // files/link 共用：解析并校验目标会话（存在 + 同用户 + id 形态），返回 {sid, title, dir}
  const resolveSession = () => {
    const sid = String(args.id || '').trim();
    if (!/^task-[0-9A-Za-z_\-]+$/.test(sid)) throw new Error('需要 id：日记碎片【编号】里的会话 id（形如 task-YYYYMMDD-NNN）');
    const s = db.prepare('SELECT id, user, title FROM sessions WHERE id = ?').get(sid);
    if (!s) throw new Error('会话 ' + sid + ' 不存在（可能已删除）');
    if (String(s.user || '') !== user) throw new Error('无权访问该会话（非当前用户）');
    const root = String((ctx.cfg && ctx.cfg.workspace_root) || '');
    if (!root) throw new Error('workspace_root 未配置');
    return { sid: sid, title: s.title || sid, dir: path.join(root, sid) };
  };
  switch (op) {
    case 'search': {
      const q = String(args.query || '').trim();
      if (!q) throw new Error('op=search 需要 query（关键词；空格分隔多个词更好，如「身份证 水印」）');
      const txt = memory.searchFragments(db, user, q, args.count);
      return txt || '日记中无「' + q + '」相关记录。';
    }
    case 'days': {
      const list = memory.daysIndex(db, user);
      if (!list.length) return '日记库为空（尚无收口碎片）。';
      return '【日记索引】共 ' + list.length + ' 天（新在前）：\n' + list.join('\n');
    }
    case 'day': {
      const date = String(args.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('op=day 需要 date（YYYY-MM-DD，先用 op=days 查有哪些天）');
      const txt = memory.dayEntry(db, user, date);
      return txt ? date + ' 的日记：\n' + txt : date + ' 无日记。';
    }
    case 'files': {
      const t = resolveSession();
      let names = [];
      try {
        names = fs.readdirSync(t.dir, { withFileTypes: true })
          .filter(d => d.isFile() && !d.name.startsWith('.'))
          .map(d => d.name)
          .sort();
      } catch (_) {
        return '「' + t.title + '」任务目录不存在，无成果文件。';
      }
      if (!names.length) return '「' + t.title + '」无成果文件。';
      const shown = names.slice(0, 80);
      return '「' + t.title + '」现存文件（顶层 ' + shown.length + (names.length > shown.length ? '/共 ' + names.length : '') + ' 个）：\n'
        + shown.map(n => '- ' + n).join('\n');
    }
    case 'link': {
      const t = resolveSession();
      const rel = String(args.path || '').trim();
      if (!rel) throw new Error('op=link 需要 path（op=files 清单里的文件名）');
      const abs = resolveInTask(t.dir, rel); // 路径沙箱：只允许该会话任务目录内
      let st;
      try { st = fs.statSync(abs); } catch (_) { throw new Error('文件不存在：' + rel + '（先 op=files 看现存清单）'); }
      if (!st.isFile()) throw new Error('不是普通文件：' + rel);
      const pl = ctx.cfg && ctx.cfg.public_link;
      if (!pl || !pl.base_url) throw new Error('public_link 未配置，无法生成外链');
      return pl.base_url + '/p/' + publicFiles.mint({ sessionId: t.sid, rel: rel, ttlMs: pl.ttl_ms });
    }
    default:
      throw new Error('未知的 op："' + op + '"。可用：search（需 query，可选 count）/ days（日期索引）/ day（需 date）/ files（需 id）/ link（需 id+path）');
  }
}

const HANDLERS = {
  read_file: toolReadFile,
  handoff: toolHandoff,
  write_file: toolWriteFile,
  edit_file: toolEditFile,
  mint_public_link: toolMintPublicLink,
  terminal: toolTerminal,
  fetch: toolFetch,
  schedule: toolScheduleTask,
  profile: toolProfile,
  recall: toolRecall,
  db: toolDb,
  skill: toolSkill,
  lab: toolLab,
};

// ctx: {sessionId, taskDir, run, cfg, db, vision}
// 返回值一般为字符串；read_file 读图且 ctx.vision 为 true 时返回 {text, image_rel}。
// 内置工具优先；未命中时交给 MCP 注册表（启动时发现的服务工具）。
async function executeTool(baseCtx, name, args) {
  const handler = HANDLERS[name];
  if (handler) return handler(baseCtx, args || {});
  if (mcp.hasTool(name)) return mcp.callTool(name, args || {});
  return 'Error: 未知工具 ' + name;
}

module.exports = { executeTool, resolveInTask, recordFile, runTaskSql };
