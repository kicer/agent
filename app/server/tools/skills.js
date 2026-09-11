// Skill Manager：发现、查看与执行技能，并在执行前自动检查与安装依赖。
// 技能统一存放于技能根目录（cfg.skills_root，所有任务/会话共享；容器内挂 ./skills → /workspace/skills），每个技能一个子目录：
//   <skill>/SKILL.md（必须）、run.py | run.sh（入口）、requirements.txt、install.sh（可选）。
// 入口脚本约定接收一个 JSON 字符串作为唯一命令行参数（含全部 input_args）。
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const YAML = require('yaml');
const log = require('../log');
const rexec = require('../remote-exec');

class SkillNotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'SkillNotFoundError'; }
}
class SkillExecutionError extends Error {
  constructor(msg, code) { super(msg); this.name = 'SkillExecutionError'; this.code = code; }
}
class DependencyInstallError extends Error {
  constructor(msg, code) { super(msg); this.name = 'DependencyInstallError'; this.code = code; }
}

// 技能根目录：优先 cfg.skills_root（config.yml 配置，所有任务共享）；缺省取 workspace_root 的同级 skills 目录。
function skillsRoot(ctx) {
  if (ctx.cfg && ctx.cfg.skills_root) return ctx.cfg.skills_root;
  if (ctx.cfg && ctx.cfg.skills && ctx.cfg.skills.skills_root) return path.resolve(ctx.cfg.skills.skills_root);
  return path.resolve(ctx.cfg.workspace_root, '..', 'skills');
}

function skillDir(ctx, skillName) {
  const name = String(skillName || '').trim();
  if (!name) throw new SkillNotFoundError('技能名为空');
  if (name.includes('/') || name.includes('..')) throw new SkillNotFoundError('非法技能名：' + name);
  return path.join(skillsRoot(ctx), name);
}

// 解析 SKILL.md 的 YAML Front Matter；无 Front Matter 返回 {}。
function parseFrontMatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return {};
  try { return YAML.parse(m[1]) || {}; } catch (_) { return {}; }
}

// 提取描述：优先 Front Matter 的 description，回退为第一个非标题文本行。
function extractDescription(content) {
  const fm = parseFrontMatter(content);
  if (fm.description && String(fm.description).trim()) return String(fm.description).trim();
  const line = content.split(/\r?\n/).map(l => l.trim()).find(l => l && !/^#/.test(l));
  return line || '(无描述)';
}

// ---------- 3.1 list_skills ----------
async function listSkills(ctx) {
  const root = skillsRoot(ctx);
  if (!fs.existsSync(root)) {
    log.warn('skills', '技能根目录不存在：' + root);
    return [];
  }
  const out = [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const mdPath = path.join(root, e.name, 'SKILL.md');
    if (!fs.existsSync(mdPath)) continue;
    let content;
    try { content = await fsp.readFile(mdPath, 'utf8'); } catch (_) { continue; }
    out.push({ name: e.name, description: extractDescription(content) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------- system prompt 注入：可用技能列表 ----------
// 把技能列表格式化成 “## Available Skills” 段落（每行一个技能：名称 + 描述，描述内换行压成空格）。
// 由 llm.setSkillListText 拼入 system prompt：启动时快照（server.js）与技能变更后
// （routes/skills.js 的创建/重命名/删除/文件变更）调用，让模型直接感知已有技能，
// 省掉先 list_skills 探索的往返；list_skills 仍保留作实时兑底查询。
function formatSkillListForPrompt(list) {
  if (!list || !list.length) return '';
  const lines = list.map(s => '- ' + s.name + ': ' + String(s.description).replace(/\s*\n\s*/g, ' '));
  return '## Available Skills\nSkills installed on this server (call directly via run_skill; no need to call list_skills first):\n' + lines.join('\n');
}

// ---------- 3.2 get_skill_info ----------
async function getSkillInfo(ctx, skillName) {
  const dir = skillDir(ctx, skillName);
  const mdPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(mdPath)) {
    throw new SkillNotFoundError('技能不存在或缺少 SKILL.md：' + skillName);
  }
  return fsp.readFile(mdPath, 'utf8');
}

// ---------- 依赖安装 ----------
// 不用虚拟环境（每个技能一份 .venv 太占空间，且容器重建后全丢）：
// pip install --target 装到技能根目录下的共享 deps 目录（容器内 /workspace/skills/deps，
// 随挂载卷持久化，重建镜像不丢）；运行时通过 PYTHONPATH 让 Python 找到它们。
function depsRoot(ctx) {
  return path.join(skillsRoot(ctx), 'deps');
}

// 技能子进程环境：PYTHONPATH 追加共享依赖目录（sys.path 的搜索路径，非标准库覆盖）。
function skillEnv(ctx) {
  const deps = depsRoot(ctx);
  const existing = process.env.PYTHONPATH;
  return Object.assign({}, process.env, { PYTHONPATH: existing ? deps + ':' + existing : deps });
}

function hashFile(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch (_) { return ''; }
}

// 在技能目录下执行一个前台命令，返回 stdout+stderr；非零退出抛 DependencyInstallError。
// 安装命令兼有硬超时（默认 10 分钟），防 pip/apt 挂死阻塞会话。
// 配了 executor：命令拼成单条 shell 行交远端执行（core 镜像已不带 python/pip）。
// 注意传 PYTHONPATH=共享 deps：远端进程原有 PYTHONPATH 会被覆盖（executor 容器不预装到 site-packages，仅影响技能依赖可见性）。
function execSyncCapture(ctx, cmd, args, cwd, timeoutMs) {
  const limit = timeoutMs || 600000;
  const cfg = ctx && ctx.cfg;
  if (cfg && rexec.isRemote(cfg)) {
    return rexec.run(cfg, { command: rexec.shellLine(cmd, args), cwd, timeout_ms: limit, env: { PYTHONPATH: depsRoot(ctx) } })
      .then(r => {
        if (r.killed_by === 'timeout') throw new DependencyInstallError('依赖安装超时（' + limit + 'ms）已终止：\n' + r.out.trim(), -1);
        if (r.code === 0) return r.out.trim();
        throw new DependencyInstallError((r.out.trim() || ('依赖命令退出码 ' + r.code)) + ' [exit: ' + r.code + ']', r.code);
      }, e => {
        if (e instanceof DependencyInstallError) throw e;
        throw new DependencyInstallError('依赖命令远程执行失败：' + e.message, -1);
      });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env, detached: true });
    let out = '';
    let settled = false;
    const onData = d => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) {} }
      reject(new DependencyInstallError('依赖安装超时（' + limit + 'ms）已终止：\n' + out.trim(), -1));
    }, limit);
    child.on('error', err => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new DependencyInstallError('依赖命令启动失败：' + err.message, -1));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new DependencyInstallError((out.trim() || ('依赖命令退出码 ' + code)) + ' [exit: ' + code + ']', code));
    });
  });
}

// 安装依赖并写缓存标记 .deps_installed（内容为依赖文件 hash，变化则重装）。
// Python 依赖装进共享 deps 目录；install.sh 用于系统级依赖，直接执行。
async function ensureDeps(ctx, dir, skillName) {
  const reqPath = path.join(dir, 'requirements.txt');
  const installPath = path.join(dir, 'install.sh');
  const hasReq = fs.existsSync(reqPath);
  const hasInstall = fs.existsSync(installPath);
  if (!hasReq && !hasInstall) return;

  const need = 'req:' + hashFile(reqPath) + '|install:' + hashFile(installPath);
  const markerPath = path.join(dir, '.deps_installed');
  if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8') === need) {
    log.debug('skills', skillName + ' 依赖已安装（命中缓存）');
    return;
  }

  try {
    if (hasReq) {
      const target = depsRoot(ctx);
      fs.mkdirSync(target, { recursive: true });
      log.debug('skills', skillName + '：pip install --target ' + target);
      await execSyncCapture(ctx, 'python3', ['-m', 'pip', 'install', '--target', target, '-r', reqPath], dir);
    }
    if (hasInstall) {
      log.debug('skills', skillName + '：执行 install.sh');
      await execSyncCapture(ctx, 'bash', ['install.sh'], dir);
    }
  } catch (e) {
    if (e instanceof DependencyInstallError) throw e;
    throw new DependencyInstallError('依赖安装失败：' + e.message, -1);
  }
  fs.writeFileSync(markerPath, need, 'utf8');
  log.debug('skills', skillName + '：依赖安装完成');
}

// ---------- 参数路径预处理 ----------
// 技能进程的工作目录是技能目录，而 Agent 习惯传相对会话任务目录的路径；
// 执行前统一把路径样式的相对参数转成绝对路径，技能脚本无感知。
// 含路径分隔符，或以字母开头的扩展名结尾（排除 "1.5" 这类数字串误判）。
function looksLikePath(v) {
  return /[\\/]/.test(v) || /\.\D\w{0,5}$/.test(v);
}

function absolutizeValue(key, v, baseDir) {
  if (typeof v !== 'string' || !v.trim()) return v;
  const looksAbs = v.startsWith('/') || v.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(v);
  if (looksAbs) return v;
  const outputish = /out|dest|target|save/i.test(key);
  const exists = fs.existsSync(path.resolve(baseDir, v));
  if (outputish || exists || looksLikePath(v)) return path.resolve(baseDir, v);
  return v;
}

function absolutizeArgs(inputArgs, baseDir) {
  const out = {};
  for (const [k, v] of Object.entries(inputArgs || {})) out[k] = absolutizeValue(k, v, baseDir);
  return out;
}

// 按 input_schema 校验 input_args（仅校验 required 字段存在且非空）。
function validateArgs(fm, inputArgs, skillName) {
  const schema = fm && fm.input_schema;
  if (!schema || !Array.isArray(schema.required)) return;
  const missing = schema.required.filter(k => inputArgs[k] === undefined || inputArgs[k] === null || inputArgs[k] === '');
  if (missing.length) {
    throw new SkillExecutionError('技能 ' + skillName + ' 缺少必填参数：' + missing.join(', '), 1);
  }
}

// 前台执行技能入口，带超时与取消支持；成功 resolve stdout，失败 reject SkillExecutionError。
// 配了 executor：入口命令拼成单条 shell 行（参数单引号转义，JSON payload 安全）交远端执行，
// cwd 由调用方给出（run_skill 传会话目录以命中 session 隔离与虚拟视图；依赖安装仍传技能目录），
// PYTHONPATH 指向共享 deps；core 与 executor 同路径挂载 skills，无需翻译。
function runEntry(ctx, entry, args, cwd, timeoutMs) {
  const cfg = ctx.cfg;
  if (cfg && rexec.isRemote(cfg)) {
    return rexec.run(cfg, {
      command: rexec.shellLine(entry, args), cwd, timeout_ms: timeoutMs,
      env: { PYTHONPATH: depsRoot(ctx) }, run: ctx.run,
    }).then(r => {
      const trimmed = r.out.replace(/\n+$/, '').trim();
      if (r.killed_by === 'timeout') throw new SkillExecutionError('技能执行超时（' + timeoutMs + 'ms）已终止：\n' + trimmed, -1);
      if (r.killed_by === 'cancelled') throw new SkillExecutionError('技能执行被用户终止', -1);
      if (r.code === 0) return trimmed || '（无输出）';
      throw new SkillExecutionError((trimmed || ('技能执行失败，退出码 ' + r.code)) + '\n[exit code: ' + r.code + ']', r.code);
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(entry, args, { cwd, env: skillEnv(ctx), detached: true });
    if (ctx.run && ctx.run.procs) ctx.run.procs.add(child);
    let out = '';
    let settled = false;
    const onData = d => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(cancelCheck);
      if (ctx.run && ctx.run.procs) ctx.run.procs.delete(child);
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) {} }
      reject(new SkillExecutionError('技能执行超时（' + timeoutMs + 'ms）已终止：\n' + out.trim(), -1));
    }, timeoutMs);

    const cancelCheck = setInterval(() => {
      if (ctx.run && ctx.run.cancelled && !settled) {
        settled = true;
        clearTimeout(timer);
        if (ctx.run && ctx.run.procs) ctx.run.procs.delete(child);
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) {} }
        reject(new SkillExecutionError('技能执行被用户终止', -1));
      }
    }, 200);

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelCheck);
      if (ctx.run && ctx.run.procs) ctx.run.procs.delete(child);
      reject(new SkillExecutionError('技能入口启动失败：' + err.message, -1));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelCheck);
      if (ctx.run && ctx.run.procs) ctx.run.procs.delete(child);
      const trimmed = out.replace(/\n+$/, '').trim();
      if (code === 0) resolve(trimmed || '（无输出）');
      else reject(new SkillExecutionError((trimmed || ('技能执行失败，退出码 ' + code)) + '\n[exit code: ' + code + ']', code));
    });
  });
}

// ---------- 3.3 run_skill ----------
async function runSkill(ctx, skillName, inputArgs) {
  const dir = skillDir(ctx, skillName);
  if (!fs.existsSync(dir)) throw new SkillNotFoundError('技能不存在：' + skillName);

  const mdPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(mdPath)) throw new SkillNotFoundError('技能缺少 SKILL.md：' + skillName);

  // 先把相对路径参数按会话任务目录转成绝对路径（缺任务目录时退回进程当前目录）。
  const args = absolutizeArgs(inputArgs || {}, ctx.taskDir || process.cwd());
  const payload = JSON.stringify(args);

  let fm = {};
  try { fm = parseFrontMatter(await fsp.readFile(mdPath, 'utf8')); } catch (_) {}
  validateArgs(fm, args, skillName);

  await ensureDeps(ctx, dir, skillName);

  let entry, cmdArgs;
  const runPy = path.join(dir, 'run.py');
  const runSh = path.join(dir, 'run.sh');
  if (fs.existsSync(runPy)) {
    // PYTHONPATH 已指向共享 deps，直接走系统 python3。
    // 入口一律用绝对路径：远端 cwd 是会话目录，相对的 'run.py' 会找不到。
    entry = 'python3';
    cmdArgs = [runPy, payload];
  } else if (fs.existsSync(runSh)) {
    entry = 'bash';
    cmdArgs = [runSh, payload];
  } else {
    throw new SkillExecutionError('技能 ' + skillName + ' 缺少入口 run.py 或 run.sh', 1);
  }

  // cwd：远端取会话目录（executor 侧命中 session 隔离，技能看到的 /workspace/tasks/<sid>
  // 与 core 侧是同一份数据，absolutizeArgs 产出的绝对路径因此有效）；缺 taskDir 时退回
  // 技能目录（退化为旧行为）。本地无隔离诉求，仍以技能目录为 cwd。
  const execCwd = rexec.isRemote(ctx.cfg) ? (ctx.taskDir || dir) : dir;
  const timeoutMs = (ctx.cfg && ctx.cfg.skills && ctx.cfg.skills.timeout_ms) || 120000;
  log.info('skills', '执行 ' + skillName + '：' + entry + ' ' + cmdArgs.join(' ') + '（cwd=' + execCwd + '）');
  return runEntry(ctx, entry, cmdArgs, execCwd, timeoutMs);
}

module.exports = { listSkills, getSkillInfo, runSkill, skillsRoot, parseFrontMatter, extractDescription, formatSkillListForPrompt };