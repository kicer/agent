// 技能管理 API(2.0 阶段 3):技能列表 / 创建 / 重命名 / 删除,以及技能内文件管理。
// 只做文件管理,不执行技能(执行仍走 tools/skills.js 的 AI 工具侧,由用户自行测试)。
// 安全:技能名与文件路径都经严格校验(无路径分隔符/无穿越/保留名拒绝);
//     在线编辑限文本文件与大小;上传走 multer 并清洗文件名。
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');
const YAML = require('yaml');
const engine = require('../engine');
const llm = require('../llm');
const { extractDescription, listSkills, formatSkillListForPrompt } = require('../tools/skills');
const { sanitizeName } = require('./files');

const router = express.Router();

const RESERVED_DIRS = new Set(['deps']); // skills_root 下的共享 pip 依赖目录,不是技能
const TEXT_READ_LIMIT = 512 * 1024;      // 在线读取上限(再大引导下载本地编辑)
const TEXT_WRITE_LIMIT = 1024 * 1024;    // 在线写入上限(再大走上传)

function sendErr(res, err) {
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: '上传失败:' + err.message });
  }
  const code = err && err.status_code || 500;
  res.status(code).json({ error: String(err && err.message || err) });
}
function httpError(code, msg) { return Object.assign(new Error(msg), { status_code: code }); }
function wrap(fn) {
  return function (req, res) {
    try {
      const r = fn(req, res);
      if (r && typeof r.catch === 'function') r.catch(err => sendErr(res, err));
    } catch (err) { sendErr(res, err); }
  };
}

function skillsRoot() {
  const cfg = engine.getConfig();
  return path.resolve((cfg && (cfg.skills_root || (cfg.skills && cfg.skills.skills_root))) || 'skills');
}

// 技能名 = 技能根目录下的单层目录名
function safeSkillName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n || n.length > 64) throw httpError(400, '技能名长度需为 1-64 字符');
  if (/[\/\\\0\r\n<>:"|?*]/.test(n)) throw httpError(400, '技能名含非法字符: ' + n);
  if (n === '.' || n === '..' || n.startsWith('.') || RESERVED_DIRS.has(n)) {
    throw httpError(400, '保留或非法技能名: ' + n);
  }
  return n;
}

function skillDirOf(name) {
  const root = skillsRoot();
  const dir = path.resolve(root, safeSkillName(name));
  if (dir === root || !dir.startsWith(root + path.sep)) throw httpError(400, '非法技能路径');
  return dir;
}

// 技能内相对路径:禁绝对路径与 .. 穿越
function safeRel(p) {
  const rel = path.posix.normalize(String(p == null ? '' : p).replace(/\\/g, '/').trim());
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) {
    throw httpError(400, '非法文件路径: ' + p);
  }
  return rel;
}

function absInSkill(dir, rel) {
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw httpError(400, '文件路径越出技能目录');
  return abs;
}

// 技能发生任何变更（创建/重命名/删除/文件增删改都经过本模块）后，
// 重建 system prompt 的 “可用技能” 段落（llm.setSkillListText）：
// 模型立即感知新技能或改名，无需重启。fire-and-forget：扫描失败不影响 API 响应，
// skill op=list 仍是实时兑底。
function refreshSkillPrompt() {
  listSkills({ cfg: engine.getConfig() })
    .then(list => llm.setSkillListText(formatSkillListForPrompt(list)))
    .catch(() => {});
}

// 递归文件列表（与任务文件同形状：filename/size/mtime；隐藏文件如 .deps_installed 不展示）
function listSkillFiles(dir) {
  const out = [];
  (function rec(d, rel) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name);
      const relPath = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) rec(abs, relPath);
      else if (e.isFile()) {
        let size = null, mtime = null;
        try { const st = fs.statSync(abs); size = st.size; mtime = st.mtimeMs; } catch (_) {}
        out.push({ filename: relPath, size, mtime });
      }
    }
  })(dir, '');
  out.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  return out;
}

// ---------- 技能 ----------

// 列表:名称 / 描述 / 入口类型 / 文件数 / 总大小 / 最近修改
router.get('/', wrap(async (req, res) => {
  const root = skillsRoot();
  if (!fs.existsSync(root)) return res.json([]);
  const out = [];
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || RESERVED_DIRS.has(e.name)) continue;
    const dir = path.join(root, e.name);
    let description = '(缺 SKILL.md)';
    let hasMd = false;
    try {
      description = extractDescription(await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8'));
      hasMd = true;
    } catch (_) {}
    const files = listSkillFiles(dir);
    out.push({
      name: e.name,
      description,
      has_md: hasMd,
      entry: fs.existsSync(path.join(dir, 'run.py')) ? 'py'
        : fs.existsSync(path.join(dir, 'run.sh')) ? 'sh' : null,
      file_count: files.length,
      size: files.reduce((s, f) => s + (f.size || 0), 0),
      mtime: files.length ? Math.max.apply(null, files.map(f => f.mtime || 0)) : null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json(out);
}));

// 创建:生成带 front matter 的 SKILL.md 骨架(YAML.stringify 保证特殊字符安全)
router.post('/', wrap(async (req, res) => {
  const name = safeSkillName(req.body && req.body.name);
  const dir = skillDirOf(name);
  if (fs.existsSync(dir)) throw httpError(409, '技能已存在: ' + name);
  const desc = String((req.body && req.body.description) || '').trim() || '待填写:何时使用这个技能';
  const tpl = [
    '---',
    YAML.stringify({ name, description: desc }).trim(),
    '---',
    '',
    '# ' + name,
    '',
    '这里描述技能做什么、什么场景下使用。',
    '',
    '## 用法',
    '',
    '- 入口脚本 `run.py` 或 `run.sh`,接收一个 JSON 字符串作为唯一命令行参数(含全部入参)。',
    '- 可选:`requirements.txt`(Python 依赖)、`install.sh`(系统依赖),首次执行前自动安装。',
    '',
  ].join('\n');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), tpl, 'utf8');
  refreshSkillPrompt();
  res.json({ ok: true, name });
}));

// 详情:文件列表 + SKILL.md 内容
router.get('/:name', wrap(async (req, res) => {
  const dir = skillDirOf(req.params.name);
  if (!fs.existsSync(dir)) throw httpError(404, '技能不存在: ' + req.params.name);
  let skill_md = null;
  try { skill_md = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8'); } catch (_) {}
  res.json({ name: path.basename(dir), files: listSkillFiles(dir), skill_md });
}));

// 重命名(改目录名;SKILL.md front matter 的 name 如有需要请自行同步)
router.post('/:name/rename', wrap(async (req, res) => {
  const from = skillDirOf(req.params.name);
  const newName = safeSkillName(req.body && req.body.newName);
  if (!fs.existsSync(from)) throw httpError(404, '技能不存在: ' + req.params.name);
  const to = path.join(path.dirname(from), newName);
  if (fs.existsSync(to)) throw httpError(409, '目标名称已存在: ' + newName);
  await fsp.rename(from, to);
  refreshSkillPrompt();
  res.json({ ok: true, name: newName });
}));

// 删除整个技能(递归,不可恢复;页面需二次确认)
router.delete('/:name', wrap(async (req, res) => {
  const dir = skillDirOf(req.params.name);
  if (!fs.existsSync(dir)) throw httpError(404, '技能不存在：' + req.params.name);
  await fsp.rm(dir, { recursive: true, force: true });
  refreshSkillPrompt();
  res.json({ ok: true });
}));

// ---------- 技能内文件 ----------

// 读文本(在线编辑用):限大小、拒绝二进制
router.get('/:name/file', wrap(async (req, res) => {
  const dir = skillDirOf(req.params.name);
  const rel = safeRel(req.query.path);
  const abs = absInSkill(dir, rel);
  let st;
  try { st = fs.statSync(abs); } catch (_) { throw httpError(404, '文件不存在: ' + rel); }
  if (!st.isFile()) throw httpError(400, '不是文件');
  if (st.size > TEXT_READ_LIMIT) throw httpError(413, '文件超过 ' + (TEXT_READ_LIMIT / 1024) + 'KB,请下载后本地编辑');
  const buf = await fsp.readFile(abs);
  if (buf.includes(0)) throw httpError(415, '二进制文件不支持在线编辑,请走上传替换');
  res.json({ path: rel, content: buf.toString('utf8'), size: st.size });
}));

// 写文本(新建或覆盖;自动建父目录)
router.put('/:name/file', wrap(async (req, res) => {
  const dir = skillDirOf(req.params.name);
  if (!fs.existsSync(dir)) throw httpError(404, '技能不存在: ' + req.params.name);
  const rel = safeRel(req.body && req.body.path);
  const content = (req.body || {}).content;
  if (typeof content !== 'string') throw httpError(400, 'body.content 必须是字符串');
  if (Buffer.byteLength(content) > TEXT_WRITE_LIMIT) throw httpError(413, '内容超过 ' + (TEXT_WRITE_LIMIT / 1024) + 'KB,请改用文件上传');
  const abs = absInSkill(dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  refreshSkillPrompt(); // 编辑 SKILL.md 会连带改描述
  res.json({ ok: true, path: rel });
}));

// 删文件(或子目录)
router.delete('/:name/file', wrap(async (req, res) => {
  const dir = skillDirOf(req.params.name);
  const rel = safeRel(req.query.path);
  const abs = absInSkill(dir, rel);
  if (!fs.existsSync(abs)) throw httpError(404, '文件不存在：' + rel);
  await fsp.rm(abs, { recursive: true, force: true });
  refreshSkillPrompt(); // 删掉 SKILL.md 会使技能从列表消失
  res.json({ ok: true });
}));

// 单文件上传:文件名清洗同任务上传;重名默认 409,?overwrite=true 才覆盖
const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      try {
        const dir = skillDirOf(req.params.name);
        if (!fs.existsSync(dir)) return cb(httpError(404, '技能不存在: ' + req.params.name));
        cb(null, dir);
      } catch (err) { cb(err); }
    },
    filename: function (req, file, cb) {
      try {
        const dir = skillDirOf(req.params.name);
        const name = sanitizeName(file.originalname);
        if (req.query.overwrite !== 'true' && fs.existsSync(path.join(dir, name))) {
          return cb(httpError(409, '文件已存在: ' + name));
        }
        cb(null, name);
      } catch (err) { cb(err); }
    },
  }),
  limits: { filesize: 50 * 1024 * 1024 },
});

router.post('/:name/upload', function (req, res) {
  upload.single('file')(req, res, function (err) {
    if (err) return sendErr(res, err);
    if (!req.file) return res.status(400).json({ error: '未收到文件(表单字段名:file)' });
    refreshSkillPrompt();
    res.json({ ok: true, path: req.file.filename, size: req.file.size });
  });
});

module.exports = router;
