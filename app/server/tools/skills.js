// Skill Manager：发现、查看与执行技能。
// 依赖不由 core 安装：requirements.txt 与技能资产（install.sh）在 executor 启动前由 agent-executor-init
// 一次性处理——镜像已带的包跳过，缺的装进 skills/deps，运行期经 executor 容器 env 的 PYTHONPATH 可见。
// 技能统一存放于技能根目录（cfg.skills_root，所有任务/会话共享；容器内挂 ./skills → /workspace/skills），每个技能一个子目录：
//   <skill>/SKILL.md（必须）、run.py | run.sh（入口）、requirements.txt、install.sh（可选）。
// 入口脚本约定接收一个 JSON 字符串作为唯一命令行参数（含全部 input_args）。
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
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
// 把技能列表格式化成 “## Available Skills” 段落（仅名字，每行一个，省 token；
// 描述查 list_skills，参数查 get_skill_info）。
// 由 llm.setSkillListText 拼入 system prompt：启动时快照（server.js）与技能变更后
// （routes/skills.js 的创建/重命名/删除/文件变更）调用，让模型直接感知已装技能，
// 省掉先 list_skills 探索的往返；list_skills 保留作实时描述/兼容性查询。
function formatSkillListForPrompt(list) {
  if (!list || !list.length) return '';
  const lines = list.map(s => '- ' + s.name);
  return '## Available Skills\nInstalled skills (names only). To use one: `get_skill_info` for its parameters, then `run_skill` to execute. Call `list_skills` for one-line descriptions when choosing among skills.\n' + lines.join('\n');
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
// cwd 由调用方给出（run_skill 传会话目录以命中 session 隔离与虚拟视图）；
// 技能依赖的 PYTHONPATH 由 executor 容器 env 提供，core 不感知依赖层。
function runEntry(ctx, entry, args, cwd, timeoutMs) {
  const cfg = ctx.cfg;
  if (cfg && rexec.isRemote(cfg)) {
    return rexec.run(cfg, {
      command: rexec.shellLine(entry, args), cwd, timeout_ms: timeoutMs, run: ctx.run,
    }).then(r => {
      const trimmed = r.out.replace(/\n+$/, '').trim();
      if (r.killed_by === 'timeout') throw new SkillExecutionError('技能执行超时（' + timeoutMs + 'ms）已终止：\n' + trimmed, -1);
      if (r.killed_by === 'cancelled') throw new SkillExecutionError('技能执行被用户终止', -1);
      if (r.code === 0) return trimmed || '（无输出）';
      throw new SkillExecutionError((trimmed || ('技能执行失败，退出码 ' + r.code)) + '\n[exit code: ' + r.code + ']', r.code);
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(entry, args, { cwd, env: process.env, detached: true });
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
  // 非对象参数会在 absolutizeArgs 的 Object.entries 里静默错位成垃圾键值（如字符串→索引对象），显式拦下。
  if (inputArgs != null && (typeof inputArgs !== 'object' || Array.isArray(inputArgs))) {
    throw new SkillExecutionError('input_args 必须是对象（键值参数），收到：' + JSON.stringify(inputArgs).slice(0, 80), 1);
  }
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

  let entry, cmdArgs;
  const runPy = path.join(dir, 'run.py');
  const runSh = path.join(dir, 'run.sh');
  if (fs.existsSync(runPy)) {
    // 直接走系统 python3（技能依赖由 executor 容器 env 的 PYTHONPATH 提供）。
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