// 本地桌面端（local/ 启动器）专用：唤起系统原生目录选择器。
// 只在 AGENT_LOCAL_PICK=1 时挂载（见 server.js），服务器形态根本不加载本文件。
//
// 为什么必须走后端：浏览器拿不到本机目录的绝对路径（<input webkitdirectory> 只给相对名），
// 要真实路径只能调系统对话框。必须 execFile 异步——同步执行会阻塞事件循环，所有会话的 SSE
// 都会卡住，直到用户关掉对话框。用户取消不是错误，回 { path: '' }；
// 其它失败（无对话框、权限被拒、超时）要带原因回给前端，别让用户以为是自己取消了。
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const engine = require('../engine');

const router = express.Router();

function sendErr(res, err) {
  const code = (err && err.status_code) || 500;
  res.status(code).json({ error: String((err && err.message) || err) });
}

// 各平台可用的对话框后端。mac 用 osascript；Linux 依次试 zenity / kdialog。
// cancelRe / cancelExit 区分「用户取消」和「真失败」：
//   osascript 取消时 stderr 是 "User canceled. (-128)"，别的报错（如自动化权限被拒）不能当取消；
//   zenity/kdialog 取消统一退出码 1。
const CANDIDATES = process.platform === 'darwin'
  ? [{ cmd: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "选择这个会话的工作目录")'], cancelRe: /User canceled|-128/ }]
  : process.platform === 'linux'
    ? [
        { cmd: 'zenity', args: ['--file-selection', '--directory', '--title=选择这个会话的工作目录'], cancelExit: 1 },
        { cmd: 'kdialog', args: ['--getexistingdirectory', os.homedir(), '--title', '选择这个会话的工作目录'], cancelExit: 1 },
      ]
    : [];

// 跑一个对话框，resolve 出选中的路径（用户取消 → ''）。
// 超时兜底：对话框可能被用户晾在那儿，这里到点 kill，避免永远挂着一个 child。
function runPicker(cand, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cand.cmd, cand.args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout || '').trim());
      if (err.code === 'ENOENT') return reject(Object.assign(new Error('no-cmd'), { no_cmd: true }));
      if (err.killed) return reject(Object.assign(new Error('选择目录超时，请重试'), { status_code: 408 }));
      const msg = String(stderr || '').trim();
      if (cand.cancelRe && cand.cancelRe.test(msg)) return resolve('');
      if (cand.cancelExit && err.code === cand.cancelExit) return resolve('');
      reject(Object.assign(new Error('目录选择器失败：' + (msg || ('退出码 ' + err.code))), { status_code: 500 }));
    });
  });
}

async function pickDir() {
  if (!CANDIDATES.length) {
    throw Object.assign(new Error('当前系统不支持目录选择（仅支持 macOS / Linux）'), { status_code: 501 });
  }
  for (const cand of CANDIDATES) {
    try {
      const out = await runPicker(cand, 120000);
      if (!out) return '';
      // osascript 的 POSIX path 带尾斜杠，去掉让展示一致；选到根 '/' 时保底保留。
      return out.replace(/\/+$/, '') || '/';
    } catch (e) {
      if (e.no_cmd) continue; // 换下一个后端
      throw e;
    }
  }
  throw Object.assign(new Error('没有可用的目录选择器（Linux 请安装 zenity 或 kdialog）'), { status_code: 501 });
}

// ---------- 只读文件树 / 原生文件管理器（仅本机会话目录内） ----------
// 目录可能是真实项目，含 node_modules 等大目录：一律「一次只列一层」，客户端展开才请求。
// 绝不能复用 listTaskFiles 的整棵递归——同步递归会卡死单线程 core，连 SSE 一起挂。
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', 'venv',
  '__pycache__', '.next', '.cache', 'coverage', '.idea', '.vscode',
]);
const TREE_MAX = 500;

function isInside(rootAbs, abs) {
  return abs === rootAbs || abs.startsWith(rootAbs + path.sep);
}

// 会话内相对路径 → 绝对路径，双重越界校验（字面 + realpath，防符号链接跳出）。
function resolveInside(sessionId, rel) {
  const sid = String(sessionId || '').trim();
  if (!sid) throw Object.assign(new Error('缺少 session'), { status_code: 400 });
  const session = engine.getSession(sid);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const rootAbs = path.resolve(engine.taskDirOf(sid));
  const p = String(rel || '').replace(/^[\\/]+/, '');
  const abs = p ? path.resolve(rootAbs, p) : rootAbs;
  if (!isInside(rootAbs, abs)) throw Object.assign(new Error('路径越界'), { status_code: 400 });
  let real = abs, rootReal = rootAbs;
  try { real = fs.realpathSync(abs); } catch (_) {}
  try { rootReal = fs.realpathSync(rootAbs); } catch (_) {}
  if (!isInside(rootReal, real)) throw Object.assign(new Error('路径越界'), { status_code: 400 });
  return { rootAbs: rootAbs, abs: abs };
}

// 懒加载单层目录。ignored 的目录只回标记、前端灰显且不展开（避免 node_modules 那种灾难）。
router.get('/tree', (req, res) => {
  let abs;
  try { abs = resolveInside(req.query.session, req.query.dir || '').abs; }
  catch (err) { return sendErr(res, err); }
  let st;
  try { st = fs.statSync(abs); } catch (_) { return res.status(404).json({ error: '目录不存在' }); }
  if (!st.isDirectory()) return res.status(400).json({ error: '不是目录' });
  const showHidden = req.query.hidden === '1';
  const rel = String(req.query.dir || '').replace(/^[\\/]+/, '').replace(/\/+$/, '');
  const entries = [];
  try {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!showHidden && e.name.startsWith('.')) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) { entries.push({ name: e.name, rel: childRel, type: 'link' }); continue; }
      if (e.isDirectory()) {
        entries.push({ name: e.name, rel: childRel, type: 'dir', ignored: IGNORE_DIRS.has(e.name) });
      } else if (e.isFile()) {
        let size = null;
        try { size = fs.statSync(path.join(abs, e.name)).size; } catch (_) {}
        entries.push({ name: e.name, rel: childRel, type: 'file', size: size });
      }
    }
  } catch (err) { return sendErr(res, err); }
  entries.sort((a, b) =>
    (a.ignored ? 1 : 0) - (b.ignored ? 1 : 0) ||
    (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  res.json({
    root: path.resolve(engine.taskDirOf(String(req.query.session || ''))),
    dir: rel,
    total: entries.length,
    capped: entries.length > TREE_MAX,
    entries: entries.slice(0, TREE_MAX),
  });
});

// execFile 异步（同步会阻塞事件循环）；open/xdg-open 一般秒回，10s 兜底。
function runOpen(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err) => {
      if (!err) return resolve();
      if (err.code === 'ENOENT') return reject(Object.assign(new Error('no-cmd'), { no_cmd: true }));
      if (err.killed) return reject(Object.assign(new Error('系统调用超时'), { status_code: 504 }));
      reject(Object.assign(new Error('打开失败：' + (err.message || err.code)), { status_code: 500 }));
    });
  });
}

function dirOf(abs) {
  try { return fs.statSync(abs).isDirectory() ? abs : path.dirname(abs); } catch (_) { return path.dirname(abs); }
}

// 在系统文件管理器里打开：目录→直接打开；文件→定位所在目录（mac 用 open -R 直接选中该文件）。
router.post('/reveal', (req, res) => {
  let target;
  try { target = resolveInside(req.body && req.body.session, req.body && req.body.path); }
  catch (err) { return sendErr(res, err); }
  const abs = target.abs;
  let isDir = false;
  try { isDir = fs.statSync(abs).isDirectory(); } catch (_) {}
  const mac = process.platform === 'darwin';
  const cmd = mac ? 'open' : 'xdg-open';
  const args = mac && !isDir ? ['-R', abs] : [isDir ? abs : path.dirname(abs)];
  runOpen(cmd, args).then(() => res.json({ ok: true })).catch(err => sendErr(res, err));
});

// 在系统终端里打开该目录。mac 用 open -a Terminal；Linux 尽力而为。
router.post('/terminal', (req, res) => {
  let target;
  try { target = resolveInside(req.body && req.body.session, req.body && req.body.path); }
  catch (err) { return sendErr(res, err); }
  const dir = dirOf(target.abs);
  if (process.platform === 'darwin') {
    runOpen('open', ['-a', 'Terminal', dir]).then(() => res.json({ ok: true })).catch(err => sendErr(res, err));
    return;
  }
  runOpen('x-terminal-emulator', ['--working-directory=' + dir])
    .then(() => res.json({ ok: true }))
    .catch(() => runOpen('gnome-terminal', ['--working-directory=' + dir])
      .then(() => res.json({ ok: true }))
      .catch(() => sendErr(res, Object.assign(new Error('没有可用的终端程序'), { status_code: 501 }))));
});

// 能力探测：前端凭这个决定是否显示「工作目录」入口（拿不到就整条隐藏）。
router.get('/info', (req, res) => {
  res.json({ enabled: true, platform: process.platform, workspace_root: engine.getConfig().workspace_root });
});

router.post('/pick-dir', (req, res) => {
  pickDir().then(p => res.json({ path: p })).catch(err => sendErr(res, err));
});

module.exports = router;
