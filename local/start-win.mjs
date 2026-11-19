#!/usr/bin/env node
// Windows 本机模式启动器（macOS / Linux 用 local/start.sh，两者注入同一组环境变量）。
//
// 为什么单独一个 Node 脚本：start.sh 那 1100 多行 bash 靠的是 lsof / pgrep / readlink -f /
// nohup / setsid / 进程组信号，Windows 一个都没有。与其在 Windows 上凑一套半残的 POSIX 环境，
// 不如用 Node 重写"启动器"这一层——它本来就只做进程管理，不需要 shell。
// 业务代码（app/server）一行都不分平台，平台差异只落在 app/server/shell.js 与这个文件里。
//
// 做的事，按顺序：
//   1. 自检（Node 20+）
//   2. 找 POSIX 命令执行环境：git-bash → 已有的 busybox-w32 → 都没有就下载 busybox-w32
//   3. 首次运行生成工作目录与 local/config.win.yml（之后永不覆盖）
//   4. 补技能（只补缺，不覆盖）
//   5. app/node_modules 缺失时 npm install
//   6. 拉起 core 并守护（退出自动重启）
//
// 用法：
//   node local/start-win.mjs                    # 默认工作目录 %USERPROFILE%\AgentWork
//   node local/start-win.mjs --workspace=D:\ai  # 指定工作目录
//   node local/start-win.mjs --check            # 只做自检与探测，不启动
//   node local/start-win.mjs --port=8090 --no-open

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const shellBackend = require('../app/server/shell.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const BUSYBOX_PATH = path.join(ROOT, 'local', 'bin', 'busybox.exe');
const CONFIG_PATH = path.join(ROOT, 'local', 'config.win.yml');

// ---------- 小工具 ----------
const C = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', n: '\x1b[0m' };
const say = (s) => console.log(`${C.ok}==>${C.n} ${s}`);
const warn = (s) => console.log(`${C.warn}[!]${C.n} ${s}`);
const dim = (s) => console.log(`${C.dim}    ${s}${C.n}`);
function die(s, hint) {
  console.error(`${C.err}[x]${C.n} ${s}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
}

// ---------- 参数 ----------
const opt = { workspace: '', port: 8090, open: true, check: false };
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--workspace=')) opt.workspace = a.slice('--workspace='.length);
  else if (a.startsWith('--port=')) opt.port = Number(a.slice('--port='.length)) || 8090;
  else if (a === '--no-open') opt.open = false;
  else if (a === '--check') opt.check = true;
  else if (a === '-h' || a === '--help') {
    console.log('用法: node local/start-win.mjs [--workspace=<目录>] [--port=8090] [--no-open] [--check]');
    process.exit(0);
  } else die(`未知参数：${a}`);
}

// ---------- 1. 自检 ----------
function checkNode() {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (major < 20) die(`需要 Node.js 20+，当前 ${process.version}`, '装新版：https://nodejs.org/ 或 winget install OpenJS.NodeJS.LTS');
  say(`Node ${process.version}（${process.arch}）`);
  if (!IS_WIN) warn('当前不是 Windows：这个启动器只是 Windows 用；macOS/Linux 请用 local/start.sh');
}

// ---------- 2. 命令执行环境 ----------
// 优先级由 app/server/shell.js 决定（AGENT_SHELL > 配置 > git-bash > busybox-w32）。
// 这里只负责"没有就补一个"：装到 local/bin/busybox.exe，core 那边按固定路径探测得到。
async function ensureShell() {
  shellBackend.reset();
  const found = shellBackend.resolve({});
  if (found) {
    say(`命令执行环境：${shellBackend.describe({})}`);
    return found;
  }
  if (!IS_WIN) die('找不到 POSIX shell（/bin/sh）', '这个启动器是 Windows 用的；macOS/Linux 用 local/start.sh');

  warn('没有找到 POSIX shell（git-bash 与 busybox-w32 都不在）');
  say('下载 busybox-w32（单文件，约 600KB，不需要管理员权限）');
  await downloadBusybox();

  shellBackend.reset();
  const after = shellBackend.resolve({});
  if (!after) die('busybox-w32 装好了但仍探测不到', `检查文件是否存在且可执行：${BUSYBOX_PATH}`);
  say(`命令执行环境：${shellBackend.describe({})}`);
  return after;
}

// busybox-w32 官方发布页永远指向同一个 busybox.exe；国内下载不顺时可自行换源。
// 全部候选都失败就明确报错并给出"手动放文件"的一步操作，不静默降级到 cmd.exe。
async function downloadBusybox() {
  const urls = [];
  if (process.env.AGENT_BUSYBOX_URL) urls.push(process.env.AGENT_BUSYBOX_URL);
  urls.push('https://frippery.org/files/busybox/busybox.exe');

  // 备用源：GitHub Release（release 资产名固定为 busybox.exe）。国内直连 GitHub 慢时
  // 自动走 gh-proxy 前缀重试，两者都失败才放弃。
  try {
    const gh = await githubBusyboxUrl();
    if (gh) urls.push(gh, 'https://gh-proxy.com/' + gh);
  } catch (_) { /* 拿不到 latest 就只试官方源 */ }

  fs.mkdirSync(path.dirname(BUSYBOX_PATH), { recursive: true });
  const tmp = BUSYBOX_PATH + '.download';
  let lastErr = '';
  for (const u of urls) {
    try {
      process.stdout.write(`    ${u}\n    `);
      await fetchToFile(u, tmp);
      // 只读前两个字节校验 PE 头，不把整个文件读进内存。
      const fd = fs.openSync(tmp, 'r');
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      if (head.toString('latin1') !== 'MZ') throw new Error('下载到的不是 Windows 可执行文件（缺 MZ 头）');
      fs.renameSync(tmp, BUSYBOX_PATH);
      console.log('');
      say(`已安装 ${BUSYBOX_PATH}`);
      return;
    } catch (e) {
      lastErr = e.message;
      console.log(` 失败：${e.message}`);
      try { fs.unlinkSync(tmp); } catch (_) { /* 没下载成功就没有临时文件 */ }
    }
  }
  die('busybox-w32 下载失败：' + lastErr,
    `手动下载 https://frippery.org/files/busybox/busybox.exe 存成 ${BUSYBOX_PATH} 后重跑本脚本；`
    + '或先装 Git for Windows（自带 bash，会被自动识别）');
}

async function githubBusyboxUrl() {
  const r = await fetch('https://api.github.com/repos/rmyorston/busybox-w32/releases/latest', {
    headers: { 'User-Agent': 'agent-local-launcher' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const asset = (j.assets || []).find(a => /busybox\.exe$/i.test(a.name));
  return asset ? asset.browser_download_url : null;
}

// 带进度地下载（内容长度已知时打百分比；不知道就只打字节数）。
async function fetchToFile(url, dest) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'agent-local-launcher' },
    signal: AbortSignal.timeout(120000),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length') || 0);
  const out = fs.createWriteStream(dest);
  let got = 0;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
    if (total) process.stdout.write(`\r    ${(got / 1024).toFixed(0)}KB / ${(total / 1024).toFixed(0)}KB`);
  }
  await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
  if (total && got !== total) throw new Error(`下载不完整（${got}/${total} 字节）`);
  if (got < 200 * 1024) throw new Error(`文件太小（${got} 字节），大概率不是 busybox`);
}

// ---------- 3. 工作目录与配置 ----------
function ensureWorkspace() {
  const ws = path.resolve(opt.workspace || path.join(os.homedir(), 'AgentWork'));
  const dirs = {
    root: ws,
    tasks: path.join(ws, 'tasks'),
    data: path.join(ws, 'data'),
    skills: path.join(ws, 'skills'),
  };
  for (const d of [dirs.tasks, dirs.data, dirs.skills]) fs.mkdirSync(d, { recursive: true });
  say(`工作目录：${ws}`);
  return dirs;
}

function ensureConfig(dirs) {
  if (fs.existsSync(CONFIG_PATH)) {
    dim(`复用已有配置 ${CONFIG_PATH}（不会覆盖你在网页里改的模型与密钥）`);
    return;
  }
  // YAML 里统一用正斜杠：Node 与 YAML 都不需要转义，反斜杠反而要写两遍。
  const p = (s) => s.replace(/\\/g, '/');
  const yml = `# 由 local/start-win.mjs 首次生成，之后不再覆盖。
# 字段含义与服务器版一致（见 app/config.example.yml），这里只列本机模式用到的部分。
port: ${opt.port}

# AI 的工作根：文件工具的根就是它，AI 看不到同级的 data/ 与 skills/。
workspace_root: "${p(dirs.tasks)}"

# SQLite（.agent.db）与启动 prompt dump。
data_root: "${p(dirs.data)}"

skills:
  # 内置技能由启动器首次复制过来，之后只补缺不覆盖；pip 装的依赖落在同级的 deps/。
  skills_root: "${p(dirs.skills)}"

# 留空：启动后到设置页添加平台与 API Key，再点「重启」（启动器负责把进程拉起来）。
platforms: []

log_level: info

# 同栈 MCP（网页搜索 / 图片 / 视频 / 语音）暂未由 Windows 启动器拉起，
# 需要时在设置页按卡片添加地址，或先用 local/start.sh 的机器上那份配置。
mcp_servers: []
`;
  fs.writeFileSync(CONFIG_PATH, yml, 'utf8');
  say(`已生成配置 ${CONFIG_PATH}`);
}

// ---------- 4. 技能 ----------
// 只补缺不覆盖：用户改过的技能、自己新建的技能都不能被启动器冲掉（与 start.sh 同语义）。
function syncSkills(dirs) {
  const src = path.join(ROOT, 'skills');
  if (!fs.existsSync(src)) return;
  let copied = 0;
  for (const name of fs.readdirSync(src)) {
    if (name === 'deps' || name.startsWith('.')) continue; // deps 是依赖层，按技能各自安装
    const from = path.join(src, name);
    const to = path.join(dirs.skills, name);
    if (!fs.statSync(from).isDirectory() || fs.existsSync(to)) continue;
    fs.cpSync(from, to, { recursive: true });
    copied++;
  }
  say(copied ? `补齐技能 ${copied} 个` : '技能已是最新（不覆盖已有目录）');
}

// ---------- 5. 依赖 ----------
function ensureDeps() {
  const appDir = path.join(ROOT, 'app');
  if (fs.existsSync(path.join(appDir, 'node_modules', 'better-sqlite3'))) return;
  warn('首次运行需要安装 Node 依赖（app/node_modules 缺失）');
  const npm = IS_WIN ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install'], { cwd: appDir, stdio: 'inherit', shell: IS_WIN });
  if (r.status !== 0) {
    die('npm install 失败',
      '国内网络可先换源：npm config set registry https://registry.npmmirror.com 后重试');
  }
}

// ---------- 6. 起 core 并守护 ----------
function envFor(shell, dirs) {
  const deps = path.join(dirs.skills, 'deps');
  fs.mkdirSync(deps, { recursive: true });
  return {
    ...process.env,
    PORT: String(opt.port),
    HOST: '127.0.0.1',        // 本机模式只听回环（与 start.sh 一致）
    AGENT_CONFIG: CONFIG_PATH,
    AGENT_FILE_SCOPE: 'workspace', // 文件工具的根放宽到工作目录（本地单用户形态）
    AGENT_LOCAL_PICK: '1',
    AGENT_IMAGE_INLINE: '1',  // 回环地址厂商拉不到，读图改内联 base64
    PYTHONPATH: deps,
    AGENT_SKILLS_DEPS: deps,
    // 启动器探测到的 shell 直接钉给 core：两边 PATH 可能略有差异，钉住可避免"启动器说
    // 用 git-bash、core 里却探测成 busybox"这种难查的双份事实。
    AGENT_SHELL: shell.cmd,
  };
}

function openBrowser(url) {
  if (!opt.open) return;
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch (_) { /* 打不开浏览器不影响服务 */ }
}

function startCore(shell, dirs) {
  const env = envFor(shell, dirs);
  const appDir = path.join(ROOT, 'app');
  let stopping = false;
  let restarts = 0;
  let child = null;

  const launch = () => {
    child = spawn(process.execPath, ['server/server.js'], { cwd: appDir, env, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (stopping) return;
      restarts++;
      // 连续崩 5 次就停：多半是配置错（端口被占 / 模型池空），无限重启只会刷屏。
      if (restarts > 5) die(`core 连续退出 5 次（最后退出码 ${code}）`, '看上面的报错；常见原因：端口被占用、config.win.yml 写错');
      warn(`core 退出了（code=${code}），3 秒后重启（第 ${restarts} 次）`);
      setTimeout(launch, 3000);
    });
  };

  const stop = () => {
    stopping = true;
    if (child && child.pid) shellBackend.killTree(child);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  launch();
  const url = `http://127.0.0.1:${opt.port}`;
  setTimeout(() => openBrowser(url), 1500);
  say(`启动完成：${url}（Ctrl+C 停止）`);
}

// ---------- 主流程 ----------
(async () => {
  checkNode();
  const shell = await ensureShell();
  const dirs = ensureWorkspace();
  ensureConfig(dirs);
  syncSkills(dirs);

  if (opt.check) {
    say('自检完成（--check 不启动服务）');
    dim(`配置：${CONFIG_PATH}`);
    dim(`命令执行环境：${shellBackend.describe({})}`);
    return;
  }

  ensureDeps();
  startCore(shell, dirs);
})();
