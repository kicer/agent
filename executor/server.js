// agent-executor：命令执行服务（独立容器，供 agent-core 调用）。单文件零依赖，仅用 Node 内置 http，默认端口 9000。
//
// 接口：
//   GET    /health   → {ok, time}
//   POST   /exec     body {command, cwd?, timeout_ms?, max_output_chars?, env?}
//                    响应 SSE：{"type":"start"|"out"|"err"|"exit", ...}；期间每 15s 发 ": ping"
//   DELETE /exec/:id → {ok:true} 杀整个进程组
//
// 安全模型（v4）：
//   1. 宿主机 ./tasks 挂载到 ISOLATION_BASE（默认 /mnt/host-tasks），该路径【永不在 ROOTS 内】。
//   2. 每条 /exec 命令都在 unshare --mount --pid --fork --propagation private 的新 mount
//      namespace 中运行，不存在“非隔离模式”——杜绝“换个 cwd 就绕过卸载”的降级旁路。
//   3. wrapper 进 ns 后：先把当前 session bind 到私有 tmpfs 上的 anchor 保命，随后用一层
//      空 tmpfs【遮盖】整个 /mnt（含 ISOLATION_BASE）。之后 AI 无论从哪条路径探测都拿不到
//      其它 session 的数据。
//
//      ⚠️ 关键教训（v4 曾因此把数据卷从父 ns 卸掉，导致服务半死）：
//        绝对不要在子 ns 里对 ISOLATION_BASE 执行 umount。Docker 容器根 mount table 默认是
//        shared，`unshare --propagation private` 并不可靠地阻断 umount 的反向传播，一旦泄漏
//        父 ns 就永久失去该挂载（只能重启容器恢复）。遮盖(mount over)是本 ns 局部操作，
//        不改动原挂载条目，ns 销毁即无痕，才是安全做法。
//   4. /tmp 与 anchor 目录都是 per-session 私有 tmpfs，跨会话不可见，崩溃残留随 ns 消失。
//   5. 只用 POSIX sh 兼容语法（镜像默认 dash）：不使用 trap ERR、不使用 bash 数组/[[ ]]。
//      隔离层自身失败以退出码 90-99 回传，便于与 AI 命令的失败区分。
//   6. DEFAULT_CWD 在父 ns 中必须是【存在的空目录】（由 Dockerfile 预建）：
//      存在才能当挂载点，为空才不会成为数据旁路。selfCheck 会校验。
//
// 约束：
//   - 设置 EXECUTOR_TOKEN 后除 /health 外必须带 Authorization: Bearer <token>；
//   - 拒绝“来自容器自身”（回环/本机网卡）的 /exec：隔离只 unshare mount+pid，**没有** unshare
//     net ns，命令与 executor 同处一个 net ns，能打到 127.0.0.1:9000；只要 token 泄漏，就能
//     借 /exec 以任意会话 cwd 起命令、绕过隔离。core 在另一个容器（源地址是其 bridge IP），不受影响。
//     EXECUTOR_ALLOW_LOCAL_ORIGIN=1 仅供本机集成测试，生产不得设置。
//   - cwd 必须落在 EXECUTOR_ROOTS（逗号分隔白名单）内，且不得是任务根本身；
//   - session 目录及其链上不得含符号链接（防解析后逃逸）；
//   - timeout_ms 夹在 [1s, EXECUTOR_MAX_TIMEOUT_MS]；stdout/stderr 各自按 max_output_chars 截断。
//
// 日志：EXECUTOR_LOG_LEVEL=debug|info|warn|error|none
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------- 配置 ----------
const PORT = parseInt(process.env.PORT, 10) || 9000;
const TOKEN = process.env.EXECUTOR_TOKEN || '';

// 本容器自身的地址集合（含回环）：用于拒绝“来自容器内部”的 /exec 调用。
// 测试用 EXECUTOR_ALLOW_LOCAL_ORIGIN=1 可放行；生产必须保持关闭。
const ALLOW_LOCAL_ORIGIN = process.env.EXECUTOR_ALLOW_LOCAL_ORIGIN === '1';
function normIp(s) { s = String(s || ''); return s.startsWith('::ffff:') ? s.slice(7) : s; }
const SELF_IPS = (() => {
  const set = new Set(['127.0.0.1', '::1']);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) set.add(normIp(a.address));
  }
  return set;
})();

const ROOTS = (process.env.EXECUTOR_ROOTS || '/workspace')
  .split(',').map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));

// 隔离基路径：宿主机 tasks 在本容器内的真实挂载点。wrapper 用空 tmpfs 遮盖它的父目录来隐藏。
const ISOLATION_BASE = path.resolve(process.env.EXECUTOR_ISOLATION_BASE || '/mnt/host-tasks');
// 虚拟任务根：AI 看到的 tasks 路径，仅在子 ns 中由 wrapper 构造。
const DEFAULT_CWD = path.resolve(process.env.EXECUTOR_CWD || path.join(ROOTS[0], 'tasks'));
// 技能目录：期望由 compose 以 :ro 挂载。
const SKILLS_DIR = path.resolve(process.env.EXECUTOR_SKILLS_DIR || path.join(ROOTS[0], 'skills'));

// server.js 所在目录（镜像 WORKDIR /app）：用 tmpfs 盖住，不让 AI 读 executor 源码。
const APP_DIR = path.resolve(__dirname);

const MAX_TIMEOUT = parseInt(process.env.EXECUTOR_MAX_TIMEOUT_MS, 10) || 30 * 60 * 1000;
const DEFAULT_MAX_OUT = parseInt(process.env.EXECUTOR_MAX_OUTPUT_CHARS, 10) || 200000;
const PING_MS = 15000;
const BODY_LIMIT = 1024 * 1024;

const runs = new Map(); // id -> { child, killedBy, started_at, cwd, timer }

// ---------- 小工具 ----------
function isUnder(p, root) { return p === root || p.startsWith(root + path.sep); }
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function brief(s, n) {
  s = String(s); n = n || 2000;
  return s.length > n ? s.slice(0, n) + '…(+' + (s.length - n) + ')' : s;
}

// ---------- 分级日志 ----------
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function parseLevel(l) {
  const s = String(l || 'info').trim().toLowerCase();
  if (s === 'none' || s === 'off') return Infinity;
  return LEVELS[s] == null ? LEVELS.info : LEVELS[s];
}
const LOG_LEVEL = parseLevel(process.env.EXECUTOR_LOG_LEVEL);

const pad = (n, w) => String(n).padStart(w || 2, '0');
function stamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
}
function emit(fn, level, args) {
  if (LEVELS[level] < LOG_LEVEL) return;
  const rest = Array.prototype.slice.call(args);
  const head = stamp() + ' [' + level + '] [executor]';
  if (typeof rest[0] === 'string') rest[0] = head + ' ' + rest[0];
  else rest.unshift(head);
  fn.apply(console, rest);
}
const log = {
  debug() { emit(console.log, 'debug', arguments); },
  info() { emit(console.log, 'info', arguments); },
  warn() { emit(console.warn, 'warn', arguments); },
  error() { emit(console.error, 'error', arguments); },
};

// 目录是否为“存在且为空”（允许作为安全的 tmpfs 挂载点）
function emptyDirState(p) {
  let st = null;
  try { st = fs.statSync(p); } catch (_) { return 'missing'; }
  if (!st.isDirectory()) return 'not_dir';
  let ents = [];
  try { ents = fs.readdirSync(p); } catch (_) { return 'unreadable'; }
  return ents.length === 0 ? 'empty' : 'nonempty';
}

// ---------- 启动自检 ----------
function selfCheck() {
  const problems = [];
  const warns = [];

  for (const r of ROOTS) {
    if (isUnder(ISOLATION_BASE, r)) {
      problems.push('ISOLATION_BASE=' + ISOLATION_BASE + ' 落在 ROOTS(' + r + ') 内，AI 可访问未卸载的基路径');
    }
    if (isUnder(r, ISOLATION_BASE)) {
      problems.push('ROOTS(' + r + ') 位于 ISOLATION_BASE 之下');
    }
  }

  let bs = null;
  try { bs = fs.statSync(ISOLATION_BASE); } catch (_) {}
  if (!bs || !bs.isDirectory()) {
    problems.push('ISOLATION_BASE=' + ISOLATION_BASE + ' 不存在或不是目录 —— compose 的 volumes 没挂到这里？');
  } else if (fs.readdirSync(ISOLATION_BASE).length === 0) {
    // v4 事故特征：挂载被 wrapper 误卸后，此处会变成一个空目录且 /proc/mounts 里无条目。
    problems.push('ISOLATION_BASE=' + ISOLATION_BASE + ' 为空 —— 数据卷可能被卸载（检查 /proc/mounts），需重建容器恢复');
  }

  // 确保基路径确实是一个独立挂载点；不是的话说明它只是普通目录，遮盖将无效。
  let mounted = false;
  try {
    const mt = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
    const esc = ISOLATION_BASE.replace(/ /g, '\\040');
    for (const line of mt) {
      const parts = line.split(' ');
      if (parts[1] === esc) { mounted = true; break; }
    }
  } catch (_) {}
  if (!mounted && bs && bs.isDirectory()) {
    problems.push('ISOLATION_BASE=' + ISOLATION_BASE + ' 不是挂载点 —— 无法确定它是宿主机数据卷');
  }

  // 防“盖到自己头上”：MNTROOT（遮盖目标）不能落在 ROOTS 内，否则会把合法工作区一并封死。
  const MNTROOT = path.parse(ISOLATION_BASE).dir || '/';
  for (const r of ROOTS) {
    if (isUnder(r, MNTROOT) || r === MNTROOT) {
      problems.push('MNTROOT=' + MNTROOT + ' 包含或等于 ROOTS(' + r + ')，遮盖会连带封死合法工作区');
    }
  }

  // 虚拟任务根必须是“存在的空目录”：存在才能当 tmpfs 挂载点，为空才不是数据旁路。
  const dcs = emptyDirState(DEFAULT_CWD);
  if (dcs === 'missing') {
    warns.push('DEFAULT_CWD=' + DEFAULT_CWD + ' 不存在（wrapper 会自动 mkdir，但建议 Dockerfile 预建）');
  } else if (dcs !== 'empty') {
    problems.push('DEFAULT_CWD=' + DEFAULT_CWD + ' 在父 ns 中非空/异常(' + dcs + ') —— 请确认没有把 ./tasks 挂到该路径');
  }



  let ss = null;
  try { ss = fs.statSync(SKILLS_DIR); } catch (_) {}
  if (!ss) warns.push('SKILLS_DIR=' + SKILLS_DIR + ' 不存在（若不使用技能可忽略）');

  if (problems.length) log.error('启动自检失败：\n  - ' + problems.join('\n  - '));
  else if (warns.length) log.warn('启动自检通过（有提示）：\n  - ' + warns.join('\n  - '));
  else log.info('启动自检通过');
  return problems.length === 0;
}

// ---------- 隔离脚本生成 ----------
// 全部为 POSIX sh 兼容语句；任一步失败由显式退出码标注（≥90 = 隔离层故障）。
// 铁律：本函数内不得出现任何对 ISOLATION_BASE / MNTROOT 的 umount。只允许 mount(遮盖)。
// 诊断原则：成功路径零输出；只在失败分支里附带最小现场信息（不报 session 名、不报内容）。
// 退出码约定：90 及以上 = 隔离层故障（各失败点用不同码区分，99 已被会话 /tmp bind 占用）。
function buildIsolation(command, plan) {
  const L = [];

  L.push('set -e');

  // --- 传播属性：确保本 ns 的挂载变更不向对等组回传（多一重保险）---
  L.push('mount --make-rprivate / 2>/dev/null || true');

  // （诊断输出改为“只在失败分支里印”，见下方 anchor / mask 等步骤；
  //   原因：无条件输出会污染每条命令的 stderr，且 entries 计数会泄露会话规模。）

  // --- proc 加固：只读 + 敏感项顶掉 ---
  L.push('mount -t proc -o nosuid,noexec,nodev proc /proc || { echo "[isolate] proc failed" >&2; exit 90; }');
  L.push('for f in kcore keys kmsg sysrq-trigger sched_debug; do if [ -e /proc/$f ]; then mount --bind /dev/null /proc/$f 2>/dev/null || true; fi; done');
  L.push('mount --bind /proc/sys /proc/sys 2>/dev/null || true');
  L.push('mount -o remount,bind,ro /proc/sys 2>/dev/null || true');

  // --- 遮盖 executor 自身代码目录（与工作区无父子关系时才做）---
  if (!(isUnder(DEFAULT_CWD, APP_DIR) || isUnder(APP_DIR, DEFAULT_CWD))) {
    L.push('mount -t tmpfs tmpfs ' + shq(APP_DIR) + ' || { echo "[isolate] hide appdir failed" >&2; exit 91; }');
  }

  // --- 私有化跨会话共享的全局 tmpfs，防止跨 /exec 泄漏（/dev/shm 与 /var/tmp 默认继承父 ns）---
  L.push('mkdir -p /dev/shm');
  L.push('mount -t tmpfs -o nosuid,nodev,mode=1777,size=256m tmpfs /dev/shm || { echo "[isolate] /dev/shm failed" >&2; exit 100; }');
  L.push('mkdir -p /var/tmp');
  L.push('mount -t tmpfs -o nosuid,nodev,mode=1777,size=256m tmpfs /var/tmp || { echo "[isolate] /var/tmp failed" >&2; exit 101; }');

  // --- 本次执行私有 tmpfs：/tmp（session 模式下随后被会话 .tmp 的 bind 覆盖）与 anchor 目录 ---
  L.push('mkdir -p /tmp');
  L.push('mount -t tmpfs -o nosuid,nodev,mode=1777 tmpfs /tmp || { echo "[isolate] /tmp failed" >&2; exit 92; }');
  L.push('RUNDIR=/run/agent-exec');
  L.push('mkdir -p "$RUNDIR"');
  L.push('mount -t tmpfs -o nosuid,nodev,mode=700 tmpfs "$RUNDIR" || { echo "[isolate] rundir failed" >&2; exit 93; }');

  // --- 数据面 ---
  if (plan.mode === 'session') {
    // 1) 【必须最先做】把真实 session 目录 bind 到本会话私有 tmpfs($RUNDIR) 上的 anchor。
    //    这一步在任何遮盖发生之前完成，拿到一份不依赖原路径的独立引用。
    L.push('ANCH=$(mktemp -d "$RUNDIR/a.XXXXXXXX")');
    // 失败时才采集现场：base_entries=0 即“数据卷被摘”特征（v4 事故），无需在正常路径上付费。
    L.push('mount --bind ' + shq(plan.realSession) + ' "$ANCH" || { _b=N; if [ -d "' + ISOLATION_BASE + '" ]; then _b=Y; fi; echo "[isolate] anchor failed base=${_b}" >&2; exit 94; }');

    // 2) 【核心】用空只读 tmpfs 遮盖整个 /mnt（ISOLATION_BASE 的父目录），使基路径及其下
    //    所有 session 对本 ns 不可见。只做 mount，永远不做 umount —— umount 可能传播回
    //    父 ns 并永久摘掉数据卷（v4 事故）。遮盖是本 ns 局部操作，ns 销毁即无痕。
    L.push('MNTROOT=' + shq(path.parse(ISOLATION_BASE).dir || '/'));
    L.push('mkdir -p "$MNTROOT"');
    L.push('mount -t tmpfs -o ro,size=0 tmpfs "$MNTROOT" || { echo "[isolate] mask mnt failed" >&2; exit 98; }');

    // 3) 重建虚拟视图：先盖住任务根，再把 anchor 内容 bind 回本 session 的虚拟路径
    L.push('mkdir -p ' + shq(DEFAULT_CWD));
    L.push('mount -t tmpfs -o nosuid,nodev tmpfs ' + shq(DEFAULT_CWD) + ' || { echo "[isolate] mask tasks failed" >&2; exit 95; }');
    L.push('mkdir -p ' + shq(plan.virtSession));
    // 虚拟 cwd 可能在 session 之下更深处（校验时按“缺失即交给这里建”处理）。
    // 必须先 bind 再建：深层目录建在 tmpfs 遮盖层上会在 rebind 时被本会话数据盖掉；
    // 而 mkdir 在已 bind 的 virtSession 下建新子目录只发生在本 ns，不会写穿到宿主盘。
    L.push('mount --bind "$ANCH" ' + shq(plan.virtSession) + ' || { echo "[isolate] rebind failed" >&2; exit 96; }');
    // 会话共享 /tmp：rebind 之后 <virtSession>/.tmp 已指向父 ns 里 executor 建好的会话 .tmp，
    // 再叠一层 bind 覆盖上面 per-exec 的 tmpfs，实现同会话跨 /exec 调用共享 /tmp。
    L.push('mount --bind ' + shq(path.join(plan.virtSession, '.tmp')) + ' /tmp || { echo "[isolate] bind session tmp failed" >&2; exit 99; }');
    L.push('mkdir -p ' + shq(plan.cwd));

    // 4) 释放锚点目录项（仅本 ns 私有的 $RUNDIR 内，可安全卸载）
    //    数据仍通过 virtSession 的 bind 存活，ns 退出时彻底回收。
    L.push('umount -l "$ANCH" 2>/dev/null || true');
    L.push('rmdir "$ANCH" 2>/dev/null || true');
  } else {
    // plain（任务根之外的命令，典型：技能依赖安装）：无需真实会话数据，遮盖 /mnt 即可
    L.push('MNTROOT=' + shq(path.parse(ISOLATION_BASE).dir || '/'));
    L.push('mkdir -p "$MNTROOT"');
    L.push('mount -t tmpfs -o ro,size=0 tmpfs "$MNTROOT" || { echo "[isolate] mask mnt failed" >&2; exit 98; }');
  }

  // --- 进入目标目录并执行 ---
  L.push('cd ' + shq(plan.cwd) + ' || { echo "[isolate] cd failed" >&2; exit 97; }');
  L.push('exec /bin/sh -c ' + shq(command));

  return L.join('\n');
}

// ---------- 运行期健康护栏 ----------
// v4 事故后加：如果基路径在运行中被（错误地）卸载，所有后续请求都会变成
// “session 不存在”的静默半死状态。这里连续失败到阈值就打 error，提醒运维。
let consecutiveSessionMiss = 0;
function noteSessionProbe(ok) {
  if (ok) { consecutiveSessionMiss = 0; return; }
  consecutiveSessionMiss += 1;
  if (consecutiveSessionMiss === 5 || consecutiveSessionMiss % 20 === 0) {
    log.error('ISOLATION_BASE=' + ISOLATION_BASE + ' 已连续 ' + consecutiveSessionMiss +
      ' 次无法访问 session 目录 —— 数据卷很可能已被卸载。' +
      '确认方法: docker exec agent-executor grep host-tasks /proc/mounts；' +
      '恢复方法: docker compose up -d --force-recreate agent-executor');
  }
}

// ---------- cwd 校验与隔离计划 ----------
function resolveCwd(raw) {
  let cwd;
  try { cwd = path.resolve(String(raw || '')); } catch (_) { return { ok: false, reason: 'cwd 无法解析' }; }
  if (!cwd.startsWith(path.sep)) return { ok: false, reason: 'cwd 必须是绝对路径' };

  // 1) 白名单
  if (!ROOTS.some(r => isUnder(cwd, r))) return { ok: false, reason: 'not_in_roots' };

  // 2) 基路径永远不允许（纵深防御，万一 ROOTS 配错）
  if (isUnder(cwd, ISOLATION_BASE) || isUnder(ISOLATION_BASE, cwd)) {
    return { ok: false, reason: 'isolation_base_forbidden' };
  }

  // 3) 禁止在根本身执行
  if (cwd === DEFAULT_CWD) return { ok: false, reason: 'cwd 不能是任务根本身' };

  // 4) 路径段合法性（统一拦截 .. / 空段 / NUL）
  //    注意：必须在 resolveCwd 入口处对“原始字符串”检查 —— path.resolve 会提前折叠掉 ..，
    //   若在归一化之后才查就永远查不到。AI 无法预知 session 名，把 .. 拼进 session 段
  //   （如 <sid>/../sessB）是唯一途径，在原始串上拦即可封死跨 session 借道。
  {
    const rawStr = String(raw || '');
    if (rawStr.indexOf('\0') >= 0) return { ok: false, reason: '非法字符' };
    for (const s of rawStr.split('/')) {
      if (s === '..') return { ok: false, reason: '非法路径段' };
    }
  }
  for (const s of cwd.split(path.sep)) {
    if (s === '..') return { ok: false, reason: '非法路径段' };
  }

  // 5) session 路径：虚拟视图在父 ns 不存在属正常，故不做 lstat，改校验其映射的真实路径
  const relFromTasks = path.relative(DEFAULT_CWD, cwd);
  const isSessionPath = relFromTasks !== '' && !relFromTasks.startsWith('..' + path.sep) && !path.isAbsolute(relFromTasks) && relFromTasks !== '..';

  if (isSessionPath) {
    const sessionName = relFromTasks.split(path.sep)[0];
    if (!sessionName || sessionName === '.' || sessionName === '..') {
      return { ok: false, reason: '非法 session 名' };
    }
    const realSession = path.join(ISOLATION_BASE, sessionName);

    let rs;
    try { rs = fs.lstatSync(realSession); } catch (_) {
      noteSessionProbe(false);
      return { ok: false, reason: 'session 不存在' };
    }
    noteSessionProbe(true);
    if (rs.isSymbolicLink()) return { ok: false, reason: 'session 不得是符号链接' };
    if (!rs.isDirectory()) return { ok: false, reason: 'session 不是目录' };

    // session 之下必须逐级是真实目录（不得文件/符号链接）；缺失的深层路径按存在处理，
    // 交给 wrapper 在子 ns 内 mkdir -p —— 它只会建在本会话 bind 里，落不到别的 session。
    if (relFromTasks.split(path.sep).length > 1) {
      let dirChk = cwd;
      for (let guard = 0; guard < 32 && dirChk !== DEFAULT_CWD; guard++) {
        let ds = null;
        try { ds = fs.lstatSync(dirChk); } catch (_) { /* ENOENT: 继续向上找第一个存在的祖先 */ }
        if (ds) {
          if (ds.isSymbolicLink()) return { ok: false, reason: 'cwd 路径链中存在符号链接' };
          if (!ds.isDirectory()) return { ok: false, reason: 'cwd 不是目录' };
          break;
        }
        const up = path.dirname(dirChk);
        if (up === dirChk) break;
        dirChk = up;
      }
    }

    let realFull;
    try { realFull = fs.realpathSync(realSession); } catch (_) { return { ok: false, reason: 'realpath 失败' }; }
    if (!isUnder(realFull, ISOLATION_BASE)) return { ok: false, reason: 'realpath 越出基路径' };

    // 5.1) session 子路径逃逸校验（修复 link_etc 漏洞）：
    //      上面只校验了 session 名本身，AI 可以在 session 内 ln -s /etc link，再把 cwd
    //      指到 <session>/link —— wrapper 的 cd 在父 ns 视图解析符号链接，直接落到 /etc。
    //      这里对 session 之下的每一级做 lstat 拒符号链接 + realpath 确认未离开本 session。
    const relInside = path.relative(path.join(DEFAULT_CWD, sessionName), cwd);
    if (relInside !== '') {
      // 从真实 session 根逐段下钻；curReal 始终是当前已验证前缀的真实路径。
      // 某级不存在时：符号链接不可能藏在其中，后续各级必然也不存在（ENOENT），
      // 直接交给 wrapper 在子 ns 里 mkdir -p（只落在本会话 bind 内）。
      let curReal = realFull;
      const segs = relInside.split(path.sep);
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (!seg || seg === '.' || seg === '..') return { ok: false, reason: '非法路径段' };
        const probe = path.join(curReal, seg);
        let ss;
        try { ss = fs.lstatSync(probe); } catch (_) { break; }   // 不存在 → 停止校验，交 wrapper 创建
        if (ss.isSymbolicLink()) return { ok: false, reason: 'session 子路径不得含符号链接' };
        if (!ss.isDirectory()) return { ok: false, reason: 'cwd 不是目录' };
        let rr;
        try { rr = fs.realpathSync(probe); } catch (_) { return { ok: false, reason: 'realpath 失败' }; }
        if (!isUnder(rr, realFull)) return { ok: false, reason: 'realpath 越出 session 边界' };
        curReal = rr;
      }
    }

    // 会话级 /tmp 共享目录：跨 /exec 调用保留，会话删除时随会话目录一起消失。
    // 在父 ns 里建并做完整校验（符号链接/类型/可写）；wrapper 只负责把它 bind 到 /tmp。
    // 路径来源已由上方的 realSession lstat 与 realpath 边界校验覆盖，.tmp 自身单独 lstat。
    const shmTmp = path.join(realFull, '.tmp');
    let ts;
    try { ts = fs.lstatSync(shmTmp); } catch (_) { ts = null; }
    if (ts) {
      if (ts.isSymbolicLink()) return { ok: false, reason: 'session .tmp 不得是符号链接' };
      if (!ts.isDirectory()) return { ok: false, reason: 'session .tmp 不是目录' };
      try { fs.accessSync(shmTmp, fs.constants.W_OK); }
      catch (e) { return { ok: false, reason: 'session .tmp 不可写：' + e.message }; }
    } else {
      try {
        fs.mkdirSync(shmTmp, { recursive: true });
        fs.chmodSync(shmTmp, 0o1777);
      } catch (e) {
        return { ok: false, reason: '创建 session .tmp 失败：' + e.message };
      }
    }

    return {
      ok: true, cwd,
      plan: {
        mode: 'session', sessionName, cwd, realSession: realFull,
        virtSession: path.join(DEFAULT_CWD, sessionName),
        sessionTmp: shmTmp,
      },
    };
  }

  // 6) 以下路径在父 ns 中真实存在，可做完整校验。
  //    深层缺失目录逐级向上找到第一个存在的祖先校验；尾部缺失则 cd 失败（plain 模式 cwd 恒存在）。
  let st;
  let exist = cwd;
  for (let guard = 0; guard < 32; guard++) {
    try { st = fs.lstatSync(exist); break; } catch (_) {}
    const up = path.dirname(exist);
    if (up === exist) return { ok: false, reason: 'cwd 不存在' };
    exist = up;
  }
  if (!st) return { ok: false, reason: 'cwd 不存在' };
  if (st.isSymbolicLink()) return { ok: false, reason: 'cwd 不得是符号链接' };
  if (!st.isDirectory()) return { ok: false, reason: 'cwd 不是目录' };

  // 父链软链检查（从实际存在的最深点往上）
  let cur = exist;
  for (let guard = 0; guard < 32; guard++) {
    let s = null;
    try { s = fs.lstatSync(cur); } catch (_) { break; }
    if (s && s.isSymbolicLink()) return { ok: false, reason: 'cwd 路径链中存在符号链接' };
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }

  try {
    const real = fs.realpathSync(exist);   // 用实际存在的最深点；缺失尾部由 wrapper 补建
    if (!ROOTS.some(r => isUnder(real, r))) return { ok: false, reason: 'realpath 越界' };
    if (isUnder(real, ISOLATION_BASE)) return { ok: false, reason: 'realpath 命中隔离基路径' };
  } catch (_) {
    return { ok: false, reason: 'realpath 失败' };
  }

  // 7) skills 必须确实只读（compose 用 :ro 保证，这里二次确认，避免误挂成 rw）
  if (isUnder(cwd, SKILLS_DIR)) {
    try {
      fs.accessSync(cwd, fs.constants.W_OK);
      return { ok: false, reason: 'skills 目录应为只读' };
    } catch (e) {
      if (e.code !== 'EROFS' && e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    }
  }

  // 8) 其余（如 /workspace/skills/<name>）→ 只跑公共加固
  return { ok: true, cwd, plan: { mode: 'plain', cwd } };
}

// ---------- HTTP ----------
// 请求是否源自本容器（回环/本机网卡）：是则拒绝，防止隔离内的命令回环调 /exec 越权。
function isSelfOrigin(req) {
  return SELF_IPS.has(normIp(req.socket && req.socket.remoteAddress));
}

function tokenOk(req) {
  if (!TOKEN) return true;
  const auth = String(req.headers.authorization || '');
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, obj) {
  log.debug('resp', status, brief(JSON.stringify(obj)));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('请求体超过 ' + BODY_LIMIT + ' 字节')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('body 不是合法 JSON：' + e.message)); }
    });
    req.on('error', reject);
  });
}

function killGroup(entry) {
  const child = entry.child;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* 已退出 */ } }
}

function sseWrite(res, obj) {
  log.debug('sse →', brief(JSON.stringify(obj)));
  if (res.writableEnded || res.destroyed) return;
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

async function handleExec(req, res) {
  let args;
  try { args = await readJsonBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
  log.debug('exec ←', brief(JSON.stringify(args)));

  const command = String(args.command || '');
  if (!command.trim()) return send(res, 400, { error: 'command 必填' });

  const rawCwd = args.cwd ? String(args.cwd) : DEFAULT_CWD;

  const rc = resolveCwd(rawCwd);
  if (!rc.ok) {
    log.warn('reject', req.socket.remoteAddress, 'cwd=' + brief(rawCwd, 200), 'reason=' + rc.reason);
    return send(res, 400, { error: 'cwd 非法或不在白名单目录内' }); // 不回吐 ROOTS，避免侦察
  }

  let timeout = parseInt(args.timeout_ms, 10);
  if (!isFinite(timeout) || timeout <= 0) timeout = 5 * 60 * 1000;
  timeout = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT);

  let maxChars = parseInt(args.max_output_chars, 10);
  if (!isFinite(maxChars) || maxChars <= 0) maxChars = DEFAULT_MAX_OUT;
  maxChars = Math.min(maxChars, DEFAULT_MAX_OUT);

  // 环境变量白名单（AI 命令与技能子进程共用；PYTHONPATH 用于技能依赖外挂层）
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'PYTHONUNBUFFERED', 'PYTHONPATH',
                     'PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX', 'MPLBACKEND']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (args.env && typeof args.env === 'object') {
    for (const [k, v] of Object.entries(args.env)) {
      const K = String(k);
      if (/^(EXECUTOR_.*|.*TOKEN|.*SECRET|.*PASSWORD|.*KEY)$/i.test(K)) continue;
      if (/^(LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|NODE_REPL_EXTERNAL_MODULE|PYTHONSTARTUP|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|BASH_ENV|ENV|PROMPT_COMMAND|GLOBIGNORE)$/.test(K)) continue;
      env[K] = String(v);
    }
  }
  if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  env.HOME = '/tmp';   // plain 模式指向 per-exec tmpfs；session 模式指向会话共享 .tmp，均不污染镜像层
  env.TMPDIR = '/tmp';
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONPYCACHEPREFIX = '/tmp/pycache';

  const script = buildIsolation(command, rc.plan);
  const id = crypto.randomUUID();

  let child;
  try {
    // spawn 的 cwd 用父 ns 下确实存在的 ROOTS[0]；真正的目标目录由 wrapper 内部 cd 完成
    //（session 的虚拟视图只存在于子 ns）。--propagation private 防止 bind 反向传播回宿主 ns。
    // --ipc 隔离 System V 共享内存/信号量/消息队列（与 /dev/shm 的 tmpfs 遮盖是不同层面，两者都要）。
    child = spawn('unshare', ['--mount', '--pid', '--ipc', '--fork', '--propagation', 'private', '/bin/sh', '-c', script],
      { cwd: ROOTS[0], env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log.error('spawn 失败', e.message);
    return send(res, 500, { error: '执行环境启动失败' });
  }

  const entry = { child, killedBy: null, started_at: Date.now(), cwd: rc.cwd, timer: null };
  runs.set(id, entry);
  log.info('start', id, 'pid=' + child.pid, 'cwd=' + rc.cwd, 'mode=' + rc.plan.mode, 'timeout=' + timeout + 'ms');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, PING_MS);
  sseWrite(res, { type: 'start', id, pid: child.pid, cwd: rc.cwd });

  const out = { stdout: 0, stderr: 0, truncated: false };
  function streamChunk(kind, chunk) {
    const key = kind === 'out' ? 'stdout' : 'stderr';
    const text = chunk.toString('utf8');
    const remain = maxChars - out[key];
    if (remain <= 0) { out.truncated = true; return; }
    if (text.length > remain) {
      out.truncated = true;
      sseWrite(res, { type: kind, chunk: text.slice(0, remain) });
      out[key] = maxChars;
      return;
    }
    out[key] += text.length;
    sseWrite(res, { type: kind, chunk: text });
  }
  child.stdout.on('data', c => streamChunk('out', c));
  child.stderr.on('data', c => streamChunk('err', c));

  entry.timer = setTimeout(() => { entry.killedBy = 'timeout'; killGroup(entry); }, timeout);

  res.on('close', () => {
    if (runs.has(id)) { entry.killedBy = entry.killedBy || 'disconnected'; killGroup(entry); }
  });

  function finish(code) {
    if (!runs.has(id)) return;
    clearTimeout(entry.timer); clearInterval(ping); runs.delete(id);
    log.info('exit ', id, 'code=' + code, 'killed_by=' + entry.killedBy);
    if (res.writableEnded || res.destroyed) return;
    sseWrite(res, {
      type: 'exit', code, signal: child.signalCode, killed_by: entry.killedBy,
      stdout_chars: out.stdout, stderr_chars: out.stderr, truncated: out.truncated,
    });
    res.end();
  }
  child.on('error', err => {
    entry.killedBy = entry.killedBy || 'spawn_error';
    log.error('spawn error', id, err.message);
    streamChunk('err', Buffer.from('执行环境启动失败\n'));
    finish(-1);
  });
  child.on('close', code => finish(entry.killedBy ? -1 : (code === null ? -1 : code)));
}

function handleKill(req, res, id) {
  const entry = runs.get(id);
  if (!entry) return send(res, 404, { error: '没有该执行任务' });
  entry.killedBy = 'cancelled';
  killGroup(entry);
  send(res, 200, { ok: true, id });
}

const server = http.createServer(async (req, res) => {
  log.debug('req ', req.method, req.url);
  const url = new URL(req.url, 'http://x');
  const seg = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/health') return send(res, 200, { ok: true, time: Date.now() });

  // 先于鉴权拒绝“容器自身来源”：即使 token 泄漏，隔离内的命令也无法借回环调用 /exec。
  if (!ALLOW_LOCAL_ORIGIN && isSelfOrigin(req)) {
    log.warn('auth', '拒绝容器自身来源', req.method, url.pathname, req.socket.remoteAddress);
    return send(res, 403, { error: '拒绝来自容器自身的请求' });
  }

  if (!tokenOk(req)) {
    log.warn('auth', '拒绝', req.method, url.pathname);
    return send(res, 401, { error: '鉴权失败' });
  }

  try {
    if (req.method === 'POST' && url.pathname === '/exec') return await handleExec(req, res);
    if (req.method === 'DELETE' && seg.length === 2 && seg[0] === 'exec') return handleKill(req, res, seg[1]);
  } catch (e) {
    log.error('处理异常：', e.message);
    if (!res.headersSent) send(res, 500, { error: '内部错误' }); else res.end();
    return;
  }
  send(res, 404, { error: '未知路由' });
});

server.listen(PORT, () => {
  log.info('listening on ' + PORT +
    '  roots=' + ROOTS.join(', ') +
    '  default_cwd=' + DEFAULT_CWD +
    '  isolation_base=' + ISOLATION_BASE +
    '  auth=' + (TOKEN ? 'on' : 'off'));
  if (ALLOW_LOCAL_ORIGIN) log.warn('EXECUTOR_ALLOW_LOCAL_ORIGIN=1：放行回环/本机来源，仅供本机集成测试，生产不得设置');
  selfCheck();
});

function shutdown(sig) {
  log.info('收到 ' + sig + '，停止服务');
  for (const entry of runs.values()) { entry.killedBy = 'shutdown'; killGroup(entry); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
