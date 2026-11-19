// 执行后端：全仓唯一处理「用哪个 shell 跑命令」「怎么杀整棵进程树」的地方。
//
// 为什么单开一层：POSIX 上 spawn('/bin/sh') + kill(-pid) 是刻意选的最强约束——
// /bin/sh 固定（不读 $SHELL，否则用户把 shell 设成 fish 后模型写的 POSIX 语法全废），
// 进程组让「停止」能一次带走模型起的孙进程（npm / python / ffmpeg 留下的才是麻烦）。
// Windows 没有 /bin/sh、没有进程组、也没有可发送的信号：同一个写法在那边从「有效」
// 变成「静默失效」，detached 还会多弹一个控制台。三种能力收敛成
// resolve / spawnShell / killTree，上层（terminal、skill、engine 取消）就不必出现平台分支。
//
// 默认行为与拆分前逐字节一致：不配任何 env 时仍是 /bin/sh -c + 进程组 +
// process.kill(-pid)。Windows 才走探测分支，探测不到就明确报错，绝不静默退回
// cmd.exe——cmd 的语法与模型写的 POSIX 差太远，静默降级只会让模型在报错里反复试错。
//
// 解析顺序（前面的赢，结果进程内缓存一次，与 config.js 的冷加载约定一致）：
//   1. env AGENT_SHELL         显式指定可执行文件（绝对路径或 PATH 里的名字）
//   2. config.terminal.shell   同上，给不想碰 env 的部署方式
//   3. 自动探测                Windows：git-bash → busybox-w32 → 无
//                              POSIX  ：/bin/sh
//   4. env AGENT_SHELL_ARGS    覆盖参数模板（默认 -c，如 bash 想读 rc 可写 -lc）
// 另：env AGENT_GIT_BASH / AGENT_BUSYBOX 可指定各自的固定位置（便携安装用）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

const INSTALL_HINT = IS_WIN
  ? 'Windows 需要 POSIX shell：装 Git for Windows（自带 bash），或把 busybox-w32 放到 local/bin/busybox.exe，'
    + '或用环境变量 AGENT_SHELL 指定 shell 路径'
  : '需要 POSIX shell（/bin/sh 不存在）';

// MSYS（Git for Windows）默认会把「看起来像 Unix 路径」的参数改写成 Windows 路径
// （/c/foo → C:\foo）。模型的命令里 /tmp、/c、相对路径都可能被它悄悄改掉，
// 排查起来像"命令没生效"。关掉自动转换，让字节原样过去。
const MSYS_ENV = {
  MSYS_NO_PATHCONV: '1',      // Git for Windows 旧变量
  MSYS2_ARG_CONV_EXCL: '*',   // MSYS2 新变量
};

let cacheKey = null;
let cached; // 解析结果；null = 解析过但没有可用 shell

function trimStr(v) { return typeof v === 'string' ? v.trim() : ''; }

// 参数模板按 shell 习惯切成数组（支持引号），默认 ['-c']。
function splitArgs(s) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of String(s)) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function shellArgs() {
  const custom = trimStr(process.env.AGENT_SHELL_ARGS);
  return custom ? splitArgs(custom) : ['-c'];
}

function existsExec(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// 自己遍历 PATH，不调 where.exe：少一次进程启动，也避开 where 的输出编码差异。
function whichWin(name) {
  const exts = /\.\w+$/.test(name) ? [''] : ['', '.exe', '.cmd', '.bat'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsExec(p)) return p;
    }
  }
  return null;
}

// Git for Windows 的 bash。C:\Windows\System32\bash.exe 是 WSL 启动器，明确排除：
// 它的 -c 之后是 Linux 命令，路径全在另一个文件系统里，拿它当 shell 会让每个命令都跑偏。
function findGitBash() {
  const e = process.env;
  const cands = [
    e.AGENT_GIT_BASH,
    e.ProgramFiles && path.join(e.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    e['ProgramFiles(x86)'] && path.join(e['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    e.LOCALAPPDATA && path.join(e.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    e.USERPROFILE && path.join(e.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    e.ProgramData && path.join(e.ProgramData, 'chocolatey', 'bin', 'bash.exe'),
    whichWin('bash.exe'),
  ];
  for (const c of cands) {
    if (!c) continue;
    if (/\\windows\\(system32|winsxs)\\/i.test(c) || /\\windowsapps\\/i.test(c)) continue;
    if (existsExec(c)) return c;
  }
  return null;
}

// busybox-w32：单文件原生 exe（约 600KB），需要 `busybox sh -c` 的 applet 形式。
// 固定位置放在仓库 local/bin/，由启动器下载——不进系统 PATH，卸载即净。
function findBusybox() {
  const e = process.env;
  const cands = [
    e.AGENT_BUSYBOX,
    path.join(__dirname, '..', '..', 'local', 'bin', 'busybox.exe'),
    whichWin('busybox.exe'),
  ];
  for (const c of cands) {
    if (c && existsExec(c)) return c;
  }
  return null;
}

function posixDefault() {
  return { cmd: '/bin/sh', args: shellArgs(), kind: 'sh', source: 'default', env: null, detached: true };
}

function fromExplicit(p) {
  const args = shellArgs();
  const busybox = /busybox/i.test(path.basename(p));
  return {
    cmd: p,
    // busybox 是多 applet 单文件：必须点名 sh，否则 argv[0] 是 busybox 时它会当自己的子命令解析。
    args: busybox ? ['sh', ...args] : args,
    kind: busybox ? 'busybox' : 'bash',
    source: 'explicit',
    env: IS_WIN ? MSYS_ENV : null,
    // POSIX 必须 detached（进程组是 killTree 的抓手）；Windows 上开 detached 会新建控制台
    // 并让子进程脱离 taskkill /T 的父子树，所以那边明确关掉。
    detached: !IS_WIN,
  };
}

function detectWindows() {
  const bash = findGitBash();
  if (bash) {
    return { cmd: bash, args: shellArgs(), kind: 'bash', source: 'git-bash', env: MSYS_ENV, detached: false };
  }
  const bb = findBusybox();
  if (bb) {
    return { cmd: bb, args: ['sh', ...shellArgs()], kind: 'busybox', source: 'busybox-w32', env: null, detached: false };
  }
  return null;
}

function detect(cfg) {
  const explicit = trimStr(process.env.AGENT_SHELL)
    || trimStr(cfg && cfg.terminal && cfg.terminal.shell);
  if (explicit) return fromExplicit(explicit);
  if (!IS_WIN) return posixDefault();
  return detectWindows();
}

// 解析结果（对象形态，含 cmd/args/kind/source/env/detached）。没有可用 shell 时返回 null。
// 缓存键跟着「显式指定」的三个来源走：同一个进程里 cfg 或 env 变了会重新探测，
// 避免第一次调用（可能没有 cfg，比如技能层）把结果钉死。
function resolve(cfg) {
  const key = [
    trimStr(process.env.AGENT_SHELL),
    trimStr(process.env.AGENT_SHELL_ARGS),
    trimStr(cfg && cfg.terminal && cfg.terminal.shell),
  ].join('\u0000');
  if (cacheKey !== key) {
    cacheKey = key;
    cached = detect(cfg);
  }
  return cached;
}

// 重新探测（测试与「改完立即生效」用；正常运行不需要调）。
function reset() { cacheKey = null; cached = undefined; }

function spawnShell(cfg, command, opts) {
  const o = opts || {};
  const sh = resolve(cfg);
  if (!sh) throw new Error('执行后端不可用：' + INSTALL_HINT);
  const env = sh.env ? { ...process.env, ...sh.env, ...(o.env || {}) } : { ...process.env, ...(o.env || {}) };
  return spawn(sh.cmd, [...sh.args, String(command)], {
    cwd: o.cwd,
    env,
    detached: sh.detached,
    // 仅 Windows 生效：detached 之外的第二道保险，避免每条命令弹一个控制台窗口。
    windowsHide: true,
  });
}

// 杀整棵进程树。POSIX 走进程组（原来那两行原样保留）；Windows 没有进程组，
// 用 taskkill /T 按父子树杀——不能用 child.kill()，那只会杀 shell 本身，
// 模型起的 node/python/ffmpeg 孙进程会留下来继续占端口。
function killTree(child) {
  if (!child || !child.pid) return false;
  if (!IS_WIN) {
    try { process.kill(-child.pid, 'SIGKILL'); return true; } catch (_) {
      try { child.kill('SIGKILL'); return true; } catch (__) { return false; }
    }
  }
  try {
    const p = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch (_) {
    try { child.kill(); return true; } catch (__) { return false; }
  }
}

// 一行诊断（启动日志 / 健康检查用）：告诉人「模型命令到底交给谁跑」。
function describe(cfg) {
  const sh = resolve(cfg);
  if (!sh) return '未找到（' + INSTALL_HINT + '）';
  const args = sh.args.join(' ');
  return sh.cmd + ' ' + args + '  ← ' + sh.source;
}

module.exports = { resolve, reset, spawnShell, killTree, describe, INSTALL_HINT };
