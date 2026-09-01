// 版本信息:package.json 版本 + git 提交号(提交时自动生成,免维护)。
// 提交号来源:优先 .git/hooks/post-commit 写入的本目录 version.json
// (./app/server 为容器挂载卷,钩子写在宿主机、容器内直接可见);
// 宿主机直接跑 node 且无 json 时回退 git rev-parse。都拿不到则只显示 package 版本。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function readVersionJson() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')) || {}; } catch (_) { return {}; }
}
function gitInfo() {
  const opts = { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
  try {
    return {
      commit: execSync('git rev-parse --short HEAD', opts).toString().trim(),
      date: execSync('git log -1 --format=%cd --date=format:%Y-%m-%d\\ %H:%M', opts).toString().trim(),
    };
  } catch (_) { return {}; } // 容器内无 git/无 .git 属正常
}

const info = Object.assign(gitInfo(), readVersionJson());
module.exports = { commit: String(info.commit || ''), date: String(info.date || '') };
