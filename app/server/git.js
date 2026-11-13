// 只读 git 数据层：仓库探测 / 提交列表 / 提交详情 / 未提交改动详情。
// 一律 execFile + 参数数组（不经 shell），只跑 rev-parse / status / log / show / diff，不碰任何写操作。
// -c core.quotepath=false：中文路径原样返回，不转义成 \346\226\207 那种八进制。
const { execFile } = require('child_process');
const fs = require('fs');

const TIMEOUT = 8000;
const MAX_BUFFER = 8 * 1024 * 1024;
const PATCH_FILE_MAX = 120 * 1024; // 单文件 diff 字符上限
const PATCH_TOTAL_MAX = 400 * 1024; // 整页 diff 字符上限
const UNTRACKED_MAX_BYTES = 512 * 1024; // 未跟踪文件超过此大小不生成 diff
const MAX_FILES = 300; // 一次最多返回的文件数

const BASE = ['-c', 'core.quotepath=false'];

function run(dir, args) {
  return new Promise((resolve, reject) => {
    // cwd 不存在时 execFile 也报 ENOENT，会和「没装 git」混为一谈，先自己挡掉
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch (_) { isDir = false; }
    if (!isDir) return reject(Object.assign(new Error('会话目录不存在'), { reason: 'not_repo' }));
    execFile('git', BASE.concat(args), { cwd: dir, timeout: TIMEOUT, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      err.stdout = String(stdout || '');
      err.stderr = String(stderr || '').trim();
      reject(err);
    });
  });
}

function reasonOf(err) {
  if (err && err.code === 'ENOENT') return 'no_git';
  if (err && err.code === 'ETIMEDOUT') return 'timeout';
  return 'not_repo';
}

// 仓库信息：root 用 --show-toplevel（会话目录可能是仓库子目录）；空仓库没有 HEAD，不算错。
async function ensureRepo(dir) {
  let root;
  try {
    root = (await run(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    throw Object.assign(new Error(err.code === 'ENOENT' ? '未安装 git' : '当前目录不是 git 仓库'), { reason: reasonOf(err) });
  }
  if (!root) throw Object.assign(new Error('当前目录不是 git 仓库'), { reason: 'not_repo' });
  let branch = '';
  let head = '';
  try { branch = (await run(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim(); } catch (_) { /* detached */ }
  try { head = (await run(root, ['rev-parse', '--short', 'HEAD'])).trim(); } catch (_) { /* 空仓库 */ }
  // remote：列表里要能看出这个仓库推到哪。只取第一条 fetch（origin 惯例在最前）；
  // URL 里的 user:pass 脱敏，免得面板上直接暴露凭据。
  let remote = null;
  try {
    const first = (await run(root, ['remote', '-v'])).split('\n').filter(Boolean)[0] || '';
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(first);
    if (m) remote = { name: m[1], url: m[2].replace(/\/\/[^/@]+@/, '//***@') };
  } catch (_) { /* 没配 remote */ }
  // upstream：列表要把 origin/master 标在它指向的那条提交上，一眼看出本地领先几条。
  // 优先当前分支的 upstream，没配就回退 origin/master。
  let upstream = null;
  try {
    const ref = (await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    if (ref) upstream = { ref, id: (await run(root, ['rev-parse', ref])).trim() };
  } catch (_) {
    try { upstream = { ref: 'origin/master', id: (await run(root, ['rev-parse', 'origin/master'])).trim() }; } catch (__) { upstream = null; }
  }
  return { root, branch: branch || (head ? 'detached' : ''), head, remote, upstream };
}

// 把一个整段 diff 按 `diff --git` 切开，键是文件路径。
// 路径优先取 `+++ b/...`（改后），删除文件取 `--- a/...`；都没有就等于没有内容变化（仅 mode 变更）。
function patchPath(body) {
  const plus = body.match(/^\+\+\+ b\/(.+)$/m);
  if (plus) return plus[1].replace(/\t$/, '');
  const minus = body.match(/^--- a\/(.+)$/m);
  if (minus) return minus[1].replace(/\t$/, '');
  const head = body.match(/^diff --git a\/(.+) b\/(.+)$/m);
  return head ? head[2] : null;
}

function splitPatch(text) {
  const out = new Map();
  if (!text) return out;
  const parts = String(text).split(/^diff --git /m);
  for (let i = 1; i < parts.length; i++) {
    const body = 'diff --git ' + parts[i];
    const p = patchPath(body);
    if (p) out.set(p, body);
  }
  return out;
}

function countLines(patch) {
  let adds = 0;
  let dels = 0;
  for (const line of String(patch).split('\n')) {
    if (line.charAt(0) === '+' && line.charAt(1) !== '+') adds++;
    else if (line.charAt(0) === '-' && line.charAt(1) !== '-') dels++;
  }
  return { adds, dels };
}

function statusOf(patch, fallback) {
  if (/^new file mode /m.test(patch)) return 'A';
  if (/^deleted file mode /m.test(patch)) return 'D';
  if (/^rename from /m.test(patch) || /^copy from /m.test(patch)) return 'R';
  if (/^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch)) return fallback || 'M';
  return fallback || 'M';
}

function isBinary(patch) {
  return /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);
}

// 裁剪 + 汇总。逐文件先裁，再按总量裁（超出的文件保留路径与统计，patch 置空并标 truncated）。
function buildFiles(map, order, extra) {
  const files = [];
  const byPath = new Map();
  let budget = PATCH_TOTAL_MAX;
  for (const p of order) {
    if (files.length >= MAX_FILES) break;
    const raw = map.get(p) || '';
    const binary = isBinary(raw);
    let patch = raw;
    let truncated = false;
    if (patch.length > PATCH_FILE_MAX) { patch = patch.slice(0, PATCH_FILE_MAX); truncated = true; }
    if (patch.length > budget) { patch = ''; truncated = true; }
    budget -= patch.length;
    const counts = binary ? { adds: 0, dels: 0 } : countLines(patch);
    const item = {
      path: p,
      status: extra && extra[p] ? extra[p].status : statusOf(raw, extra && extra[p] && extra[p].status),
      adds: counts.adds,
      dels: counts.dels,
      binary: binary,
      truncated: truncated,
      patch: binary ? '' : patch,
    };
    if (extra && extra[p] && extra[p].old_path) item.old_path = extra[p].old_path;
    files.push(item);
    byPath.set(p, item);
  }
  return files;
}

function summarize(files) {
  let adds = 0;
  let dels = 0;
  for (const f of files) { adds += f.adds; dels += f.dels; }
  return { stats: { files: files.length, adds, dels } };
}

// git status --porcelain -z：拿未跟踪文件和状态字母（已跟踪文件的 patch 统一从 `diff HEAD` 拆）
// -z 必须加：不加引号规则下含空格的路径会被写成 "a b.txt"，和 diff 里的裸路径对不上，会多出幽灵条目。
// -z 里改名的旧路径是紧随其后的一条 NUL 分隔记录。
function worktreeEntries(out) {
  const entries = [];
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line || line.length < 4) continue;
    const xy = line.slice(0, 2);
    const p = line.slice(3);
    let oldPath = '';
    if (/[RC]/.test(xy)) {
      oldPath = parts[i + 1] || '';
      i++;
    }
    let status = 'M';
    if (xy === '??') status = 'U';
    else if (xy.indexOf('A') >= 0) status = 'A';
    else if (xy.indexOf('D') >= 0) status = 'D';
    else if (xy.indexOf('R') >= 0) status = 'R';
    entries.push({ path: p, old_path: oldPath || undefined, status });
  }
  return entries;
}

// 未跟踪文件没有 diff：用 --no-index 对 /dev/null 造一个（退出码 1 = 有差异，属正常）
async function untrackedPatch(root, rel) {
  const abs = root + '/' + rel;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > UNTRACKED_MAX_BYTES) return { patch: '', binary: st.size > UNTRACKED_MAX_BYTES };
  } catch (_) { return { patch: '', binary: false }; }
  try {
    return { patch: await run(root, ['diff', '--no-index', '--', '/dev/null', rel]), binary: false };
  } catch (err) {
    if (err.code === 1) return { patch: err.stdout, binary: false };
    return { patch: '', binary: false };
  }
}

async function worktreeDetail(root) {
  let entries = [];
  try { entries = worktreeEntries(await run(root, ['status', '--porcelain', '-z'])); }
  catch (_) { entries = []; }
  let all = '';
  try { all = await run(root, ['diff', 'HEAD']); } catch (_) { all = ''; } // 空仓库没有 HEAD
  const map = splitPatch(all);
  const extra = {};
  for (const e of entries) extra[e.path] = e;
  const order = [];
  for (const e of entries) order.push(e.path);
  for (const p of map.keys()) if (!extra[p]) { extra[p] = { status: 'M' }; order.push(p); }
  for (const e of entries) {
    if (e.status !== 'U' || map.has(e.path)) continue;
    const r = await untrackedPatch(root, e.path);
    if (r.patch) map.set(e.path, r.patch);
    else if (r.binary) extra[e.path].binary = true;
  }
  const files = buildFiles(map, order, extra);
  return { kind: 'worktree', commit: null, files: files, ...summarize(files) };
}

// git log：before 是上一页最后一条的 commit id，用 `<id>^` 翻页（git 天然不含自身）。
async function listCommits(dir, before, limit) {
  const repo = await ensureRepo(dir);
  const n = Math.max(1, Math.min(100, limit || 30));
  const args = ['log', '--max-count=' + (n + 1), '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s'];
  if (before) args.push(before + '^', '--');
  let out = '';
  try { out = await run(repo.root, args); } catch (err) {
    if (before) return { ok: true, repo, worktree: null, commits: [], next: null }; // 已经翻到底
    if (reasonOf(err) === 'no_git') throw err;
    return { ok: true, repo, worktree: null, commits: [], next: null }; // 空仓库
  }
  const rows = out.split('\n').filter(Boolean).map((line) => {
    const f = line.split('\x1f');
    return { id: f[0], short: f[1], author: f[2], time: f[3], subject: f[4] || '' };
  });
  const hasMore = rows.length > n;
  const commits = hasMore ? rows.slice(0, n) : rows;
  const next = hasMore && commits.length ? commits[commits.length - 1].id : null;
  let worktree = null;
  try {
    const st = await run(repo.root, ['status', '--porcelain']);
    worktree = { files: st.split('\n').filter(Boolean).length };
  } catch (_) { worktree = null; }
  return { ok: true, repo, worktree, commits, next };
}

async function commitDetail(dir, rev) {
  const repo = await ensureRepo(dir);
  if (rev === 'worktree') {
    const d = await worktreeDetail(repo.root);
    return { ok: true, repo, ...d };
  }
  let meta;
  try {
    meta = await run(repo.root, ['show', '-s', '--first-parent', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%b', rev]);
  } catch (err) {
    throw Object.assign(new Error('提交不存在或读取失败'), { reason: 'bad_rev' });
  }
  const f = meta.split('\x1f');
  const commit = {
    id: f[0], short: f[1], author: f[2], email: f[3], time: f[4],
    parents: String(f[5] || '').split(' ').filter(Boolean),
    subject: f[6] || '', body: (f[7] || '').replace(/\s+$/, ''),
  };
  // --first-parent：合并提交默认不出 patch，跟第一个父提交比才是"这次合并带进来什么"
  let all = '';
  try { all = await run(repo.root, ['show', '--first-parent', '--format=', '--patch', rev]); } catch (_) { all = ''; }
  const map = splitPatch(all);
  const order = [...map.keys()];
  const files = buildFiles(map, order, null);
  return { ok: true, repo, kind: 'commit', commit, files, ...summarize(files) };
}

// 统一入口：ok:false 只用于「不是仓库 / 没装 git / 会话不存在」，前端按 reason 出空状态
async function query(dir, kind, opts) {
  try {
    if (kind === 'commits') return await listCommits(dir, opts && opts.before, opts && opts.limit);
    return await commitDetail(dir, (opts && opts.rev) || '');
  } catch (err) {
    return { ok: false, reason: (err && err.reason) || 'not_repo', error: String((err && err.message) || err) };
  }
}

module.exports = { query };
