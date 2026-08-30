#!/usr/bin/env node
// 从 README.md 提取 Zed System Prompt 与工具 JSON Schema，
// 生成到 app/server/templates/system-prompt.txt 与 app/server/tools/definitions.json。
// README 是这些内容的唯一事实来源（要求与 Zed 原始定义逐字一致以利用上游前缀缓存），
// 修改 README 后运行 `npm run gen`（见 app/package.json）重新生成。
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const readmePath = process.argv[2] || path.join(repoRoot, 'README.md');
const outPrompt = path.join(repoRoot, 'app', 'server', 'templates', 'system-prompt.txt');
const outTools = path.join(repoRoot, 'app', 'server', 'tools', 'definitions.json');

const lines = fs.readFileSync(readmePath, 'utf8').split('\n');

function findLineIndex(predicate, fromIdx) {
  for (let k = fromIdx; k < lines.length; k++) if (predicate(lines[k])) return k;
  return -1;
}

// ---- 1. System Prompt（章节 7.1）----
const h71 = findLineIndex(function (l) { return /^###\s+7\.1\b/.test(l); }, 0);
if (h71 < 0) throw new Error('README 中找不到 "### 7.1 System Prompt" 标题');
// 标题后第一个代码围栏开始；注意 prompt 内部含 mermaid 等嵌套围栏，
// 因此结束围栏以 "> 注：" 说明行之前的最后一个空信息围栏为准。
const start = findLineIndex(function (l) { return l.trim() === '```'; }, h71 + 1);
if (start < 0) throw new Error('找不到 System Prompt 代码块起始围栏');
const noteLine = findLineIndex(function (l) { return /^>\s*注[：:]/.test(l); }, start + 1);
if (noteLine < 0) throw new Error('找不到 System Prompt 代码块后的 "> 注：" 说明行');
let endIdx = -1;
for (let k = noteLine - 1; k > start; k--) {
  if (lines[k].trim() === '```') { endIdx = k; break; }
}
if (endIdx < 0) throw new Error('找不到 System Prompt 代码块结束围栏');
const promptText = lines.slice(start + 1, endIdx).join('\n').replace(/\n+$/, '\n');
if (!promptText.includes('You are the Zed coding agent')) {
  throw new Error('System Prompt 提取结果异常（缺少开头标识句）');
}

// ---- 2. 工具定义（章节 7.2）----
const h72 = findLineIndex(function (l) { return /^###\s+7\.2\b/.test(l); }, 0);
if (h72 < 0) throw new Error('README 中找不到 "### 7.2 工具定义" 标题');
const hNextChapter = findLineIndex(function (l) { return /^##\s+八、/.test(l); }, h72 + 1);
if (hNextChapter < 0) throw new Error('找不到第八章标题');

const tools = [];
let cur = h72 + 1;
while (cur < hNextChapter) {
  if (lines[cur].trim() === '```json') {
    let j = cur + 1;
    while (j < hNextChapter && lines[j].trim() !== '```') j++;
    const body = lines.slice(cur + 1, j).join('\n');
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error('第 ' + (cur + 1) + ' 行附近的 JSON 解析失败: ' + e.message);
    }
    tools.push(parsed);
    cur = j + 1;
  } else {
    cur++;
  }
}
if (tools.length === 0) throw new Error('未提取到任何工具定义');
for (const t of tools) {
  if (t.type !== 'function' || !t.function || !t.function.name) {
    throw new Error('工具定义结构异常: ' + JSON.stringify(t).slice(0, 200));
  }
}

fs.mkdirSync(path.dirname(outPrompt), { recursive: true });
fs.mkdirSync(path.dirname(outTools), { recursive: true });
fs.writeFileSync(outPrompt, promptText, 'utf8');
fs.writeFileSync(outTools, JSON.stringify(tools, null, 2) + '\n', 'utf8');

console.log('已生成:\n  ' + outPrompt + '  (' + promptText.split('\n').length + ' 行)\n  ' + outTools + '    (' + tools.length + ' 个工具: ' + tools.map(function (t) { return t.function.name; }).join(', ') + ')');
