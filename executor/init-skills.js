#!/usr/bin/env node
// agent-executor-init：executor 启动前的一次性技能准备。
//
// 只处理“运行期可变”的依赖：
//   - requirements.txt → 先离线探测（镜像预烘包优先），只把缺失的装进 <skills>/deps
//   - install.sh       → 在技能目录执行（生成技能自带资产，如从系统字体提取 cjk.ttf）
// 系统层依赖（apt 等）不在这里做——那部分由派生镜像 M'（executor/Dockerfile 的 skills 阶段）
// 承载，才持久且对命令只读（本容器根文件系统 read_only，系统层也写不进去）。
//
// 无特权：不做任何 mount；只挂 ./skills（不挂 ./tasks），因此看不到任何会话数据。
// 幂等：按 requirements.txt/install.sh 的内容 hash 比对 .deps_installed，命中即跳过。
// 退出码恒为 0：单个技能失败只告警，不阻断 executor 启动（该技能暂不可用，其余照常）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = process.env.SKILLS_ROOT || '/workspace/skills';
const DEPS = path.join(ROOT, 'deps');

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log('[' + new Date().toISOString() + '] [skills-init]', ...args);
}

// hash 与 marker 格式沿用原 core 实现（req:<sha1>|install:<sha1>），以便复用宿主上已有的 .deps_installed。
function hashFile(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch (_) { return ''; }
}

// 技能子进程的依赖可见性：与运行期一致（运行期由 compose 把同一个 deps 目录放进 executor 的 PYTHONPATH）。
function skillEnv() {
  const existing = process.env.PYTHONPATH;
  return Object.assign({}, process.env, { PYTHONPATH: existing ? DEPS + ':' + existing : DEPS });
}

function run(cmd, args, cwd) {
  log('run:', cmd, args.join(' '), '(cwd=' + cwd + ')');
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: skillEnv() });
  if (r.error) { log('spawn 失败：' + r.error.message); return false; }
  return r.status === 0;
}

// requirements 逐行解析：去掉注释与空行
function reqLines(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n')
      .map(l => l.replace(/#.*$/, '').trim())
      .filter(Boolean);
  } catch (_) { return []; }
}

// 离线探测一行依赖是否已可用（镜像预烘包优先，其次已在外挂层）：
// --no-index 只对当前环境求值、不联网；--dry-run 不写盘。exit 0 = 已满足。
function satisfied(line, cwd) {
  const r = spawnSync('python3', ['-m', 'pip', 'install', '--no-index', '--dry-run', line],
    { cwd, env: skillEnv(), stdio: 'pipe', encoding: 'utf8' });
  return r.status === 0;
}

function initSkill(name) {
  const dir = path.join(ROOT, name);
  const reqPath = path.join(dir, 'requirements.txt');
  const installPath = path.join(dir, 'install.sh');
  const hasReq = fs.existsSync(reqPath);
  const hasInstall = fs.existsSync(installPath);
  if (!hasReq && !hasInstall) return;

  const need = 'req:' + hashFile(reqPath) + '|install:' + hashFile(installPath);
  const markerPath = path.join(dir, '.deps_installed');
  try {
    if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8') === need) {
      log('跳过（已就绪）：' + name);
      return;
    }
  } catch (_) { /* marker 读失败按未就绪处理 */ }

  log('初始化：' + name);
  let ok = true;
  try {
    if (hasReq) {
      const lines = reqLines(reqPath);
      const missing = lines.filter(l => !satisfied(l, dir));
      if (!missing.length) {
        log('依赖全部已满足（镜像/外挂层），跳过 pip：' + name);
      } else {
        log('缺失依赖装入外挂层（' + missing.length + '/' + lines.length + '）：' + missing.join(', '));
        fs.mkdirSync(DEPS, { recursive: true });
        // --upgrade：外挂层已有旧版本时允许覆盖（--target 默认遇同名文件只告警不替换）
        ok = run('python3', ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', '--target', DEPS].concat(missing), dir) && ok;
        const still = missing.filter(l => !satisfied(l, dir));
        if (still.length) { log('安装后仍缺失：' + still.join(', ')); ok = false; }
      }
    }
    if (hasInstall) {
      ok = run('bash', ['install.sh'], dir) && ok;
    }
  } catch (e) {
    log('异常：' + name + '：' + e.message);
    ok = false;
  }
  if (ok) {
    fs.writeFileSync(markerPath, need, 'utf8');
    log('就绪：' + name);
  } else {
    log('失败（不写 marker，下次启动重试）：' + name);
  }
}

(function main() {
  try {
    if (!fs.existsSync(ROOT)) { log('技能根目录不存在，跳过：' + ROOT); return; }
    const names = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'deps')
      .map(e => e.name)
      .sort();
    log('技能根=' + ROOT + '，共 ' + names.length + ' 个技能');
    for (const n of names) initSkill(n);
    log('初始化结束');
  } catch (e) {
    log('顶层异常（忽略，不阻断 executor）：' + e.message);
  }
})();
