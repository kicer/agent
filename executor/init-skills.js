#!/usr/bin/env node
// agent-executor-init：executor 启动前的一次性技能准备。
//
// 只处理“运行期可变”的依赖：
//   - requirements.txt → python3 -m pip install --target <skills>/deps -r ...
//   - install.sh       → 在技能目录执行（生成技能自带资产，如从系统字体提取 cjk.ttf）
// 系统层依赖（apt 等）不在这里做——那部分由派生镜像 M'（executor/Dockerfile 的 skills 阶段）
// 承载，才持久且对命令只读。
//
// 无特权：不做任何 mount；只挂 ./skills（不挂 ./tasks），因此看不到任何会话数据。
// 幂等：按 requirements.txt/install.sh 的内容 hash（与 core 的 ensureDeps 同格式）比对
//       .deps_installed，命中即跳过。
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

// 与 core（app/server/tools/skills.js 的 hashFile/ensureDeps）保持完全一致的 hash 与 marker 格式。
function hashFile(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch (_) { return ''; }
}

function run(cmd, args, cwd) {
  log('run:', cmd, args.join(' '), '(cwd=' + cwd + ')');
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
  if (r.error) { log('spawn 失败：' + r.error.message); return false; }
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
      fs.mkdirSync(DEPS, { recursive: true });
      ok = run('python3', ['-m', 'pip', 'install', '--no-cache-dir', '--target', DEPS, '-r', reqPath], dir) && ok;
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
