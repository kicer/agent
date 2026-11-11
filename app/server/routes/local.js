// 本地桌面端（local/ 启动器）专用：唤起系统原生目录选择器。
// 只在 AGENT_LOCAL_PICK=1 时挂载（见 server.js），服务器形态根本不加载本文件。
//
// 为什么必须走后端：浏览器拿不到本机目录的绝对路径（<input webkitdirectory> 只给相对名），
// 要真实路径只能调系统对话框。必须 execFile 异步——同步执行会阻塞事件循环，所有会话的 SSE
// 都会卡住，直到用户关掉对话框。用户取消不是错误，回 { path: '' }；
// 其它失败（无对话框、权限被拒、超时）要带原因回给前端，别让用户以为是自己取消了。
const express = require('express');
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

// 能力探测：前端凭这个决定是否显示「工作目录」入口（拿不到就整条隐藏）。
router.get('/info', (req, res) => {
  res.json({ enabled: true, platform: process.platform, workspace_root: engine.getConfig().workspace_root });
});

router.post('/pick-dir', (req, res) => {
  pickDir().then(p => res.json({ path: p })).catch(err => sendErr(res, err));
});

module.exports = router;
