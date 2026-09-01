// 技能 Tab:SKILL 管理(技能增删改 + 技能内文件管理)。
// 只做文件管理,不执行技能;技能是否生效由用户在任务里自行测试。
// 视图:列表(list) / 技能详情(detail) / 文件编辑器(editor,全屏覆盖本 Tab)。
'use strict';

window.tabModules = window.tabModules || {};

// 当前技能名(详情/编辑视图有效)与编辑器状态
let curSkill = null;
let editorPath = null;   // 正在编辑的文件相对路径
let editorOrig = '';     // 打开/上次保存时的内容,用于脏检测

// ---------- 视图切换 ----------
function setSkillsView(v) {
  $('skills-back-btn').classList.toggle('hidden', v === 'list');
  $('skill-new-btn').classList.toggle('hidden', v !== 'list');
  $('skill-upload-btn').classList.toggle('hidden', v !== 'detail');
  $('skills-list').classList.toggle('hidden', v !== 'list');
  $('skill-detail').classList.toggle('hidden', v !== 'detail');
  $('skill-editor').classList.toggle('hidden', v !== 'editor');
}

// ---------- 列表 ----------
async function loadSkillList() {
  curSkill = null;
  setSkillsView('list');
  $('skills-title').textContent = '技能管理';
  const el = $('skills-list');
  el.innerHTML = '<div class="empty-tip">加载中…</div>';
  try {
    const rows = await req('GET', '/api/skills');
    if (!rows.length) {
      el.innerHTML = '<div class="empty-tip">还没有技能,点右上角 + 新建一个。</div>';
      return;
    }
    el.innerHTML = rows.map(s => {
      const a = encodeURIComponent(s.name);
      return '<div class="session-card" onclick="skillsUI.open(\'' + a + '\')">' +
        '<div class="session-main">' +
          '<div class="session-name">' + esc(s.name) +
            (s.has_md ? '' : ' <span class="badge cancelled">缺 SKILL.md</span>') +
            (s.entry ? ' <span class="badge active">' + s.entry + ' 入口</span>' : '') +
          '</div>' +
          '<div class="skill-desc">' + esc(s.description || '') + '</div>' +
          '<div class="session-meta"><span>' + s.file_count + ' 个文件</span>' +
            '<span>' + fmtSize(s.size) + '</span>' +
            (s.mtime ? '<span>' + fmtTime(s.mtime) + '</span>' : '') + '</div>' +
        '</div>' +
        '<div class="card-acts">' +
          '<button class="card-act" onclick="event.stopPropagation();skillsUI.renameSkill(\'' + a + '\')">改名</button>' +
          '<button class="card-act del" onclick="event.stopPropagation();skillsUI.deleteSkill(\'' + a + '\')">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="empty-tip">加载失败:' + esc(e.message) + '</div>';
  }
}

// ---------- 详情(文件列表) ----------
async function loadSkillDetail() {
  if (!curSkill) return loadSkillList();
  const el = $('skill-detail');
  el.innerHTML = '<div class="empty-tip">加载中…</div>';
  try {
    const d = await req('GET', '/api/skills/' + encodeURIComponent(curSkill));
    $('skills-title').textContent = d.name;
    const newBtn = '<button class="primary-btn" style="width:100%;margin-top:10px" onclick="skillsUI.newFile()">+ 新建文件</button>';
    if (!d.files.length) {
      el.innerHTML = '<div class="skill-files"><div class="empty-tip">技能目录是空的</div></div>' + newBtn;
      return;
    }
    el.innerHTML = '<div class="skill-files">' + d.files.map(f => {
      const a = encodeURIComponent(f.filename);
      return '<div class="file-row" onclick="skillsUI.editFile(\'' + a + '\')">' +
        '<svg class="file-ico" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' +
        '<span class="file-name">' + esc(f.filename) + '</span>' +
        '<span class="file-size">' + fmtSize(f.size) + '</span>' +
        '<button class="file-act" onclick="event.stopPropagation();skillsUI.editFile(\'' + a + '\')">编辑</button>' +
        '<button class="file-act del" onclick="event.stopPropagation();skillsUI.deleteFile(\'' + a + '\')">删</button>' +
        '</div>';
    }).join('') + '</div>' + newBtn;
  } catch (e) {
    el.innerHTML = '<div class="empty-tip">加载失败:' + esc(e.message) + '</div>';
  }
}

async function openSkill(name) {
  curSkill = decodeURIComponent(name);
  setSkillsView('detail');
  await loadSkillDetail();
}

function backFromSkill() {
  // 编辑器内的返回由 closeEditor 处理;这里只处理顶部返回(先提醒未保存)
  loadSkillList();
}

// ---------- 技能增删改 ----------
function openCreateSkill() {
  $('skill-new-name').value = '';
  $('skill-new-desc').value = '';
  $('skill-create-modal').classList.remove('hidden');
  $('skill-new-name').focus();
}
function closeCreateSkill() { $('skill-create-modal').classList.add('hidden'); }

async function createSkill() {
  const name = $('skill-new-name').value.trim();
  if (!name) { toast('请填写技能名'); return; }
  try {
    await req('POST', '/api/skills', { name, description: $('skill-new-desc').value.trim() });
    closeCreateSkill();
    toast('已创建 ' + name);
    // 新建后直接进入详情,方便继续编辑 SKILL.md
    await openSkill(encodeURIComponent(name));
  } catch (e) { toast('创建失败:' + e.message); }
}

async function renameSkill(nameEnc) {
  const name = nameEnc ? decodeURIComponent(nameEnc) : curSkill;
  if (!name) return;
  const nn = await promptModal('重命名技能', '新的技能名', name);
  if (nn == null) return;
  const newName = nn.trim();
  if (!newName || newName === name) return;
  try {
    await req('POST', '/api/skills/' + encodeURIComponent(name) + '/rename', { newName });
    toast('已重命名为 ' + newName);
    if (curSkill === name) { curSkill = newName; await loadSkillDetail(); }
    else await loadSkillList();
  } catch (e) { toast('重命名失败:' + e.message); }
}

async function deleteSkill(nameEnc) {
  const name = nameEnc ? decodeURIComponent(nameEnc) : curSkill;
  if (!name) return;
  if (!await confirmModal('删除技能', '确定删除技能「' + name + '」?目录下所有文件将不可恢复。', '删除', true)) return;
  try {
    await req('DELETE', '/api/skills/' + encodeURIComponent(name));
    toast('已删除 ' + name);
    if (curSkill === name) curSkill = null;
    loadSkillList();
  } catch (e) { toast('删除失败:' + e.message); }
}

// ---------- 技能内文件 ----------
async function openFileEditor(path) {
  const rel = decodeURIComponent(path);
  try {
    const f = await req('GET', '/api/skills/' + encodeURIComponent(curSkill) + '/file?path=' + encodeURIComponent(rel));
    editorPath = f.path; editorOrig = f.content;
    $('skill-editor-name').textContent = curSkill + ' / ' + f.path;
    $('skill-editor-area').value = f.content;
    setSkillsView('editor');
  } catch (e) { toast('打开失败:' + e.message); }
}

async function saveSkillFile() {
  if (!curSkill || editorPath == null) return;
  const content = $('skill-editor-area').value;
  try {
    await req('PUT', '/api/skills/' + encodeURIComponent(curSkill) + '/file', { path: editorPath, content });
    editorOrig = content;
    toast('已保存 ' + editorPath);
  } catch (e) { toast('保存失败:' + e.message); }
}

async function closeSkillEditor() {
  if ($('skill-editor-area').value !== editorOrig &&
      !await confirmModal('未保存的修改', '有未保存的修改,确定关闭编辑器并丢弃?', '关闭', true)) return;
  editorPath = null; editorOrig = '';
  setSkillsView('detail');
  loadSkillDetail();
}

async function newSkillFile() {
  if (!curSkill) return;
  const p = await promptModal('新建文件', '相对技能目录的路径,可含子目录(如 scripts/run.sh)', '');
  if (p == null) return;
  const rel = p.trim();
  if (!rel) { toast('路径为空'); return; }
  editorPath = rel; editorOrig = '';
  $('skill-editor-name').textContent = curSkill + ' / ' + rel + '(新建)';
  $('skill-editor-area').value = '';
  setSkillsView('editor');
  $('skill-editor-area').focus();
}

async function deleteSkillFile(path) {
  const rel = decodeURIComponent(path);
  if (!await confirmModal('删除文件', '删除文件 ' + rel + ' ?', '删除', true)) return;
  try {
    await req('DELETE', '/api/skills/' + encodeURIComponent(curSkill) + '/file?path=' + encodeURIComponent(rel));
    toast('已删除');
    loadSkillDetail();
  } catch (e) { toast('删除失败:' + e.message); }
}

// 单文件上传;重名默认 409,询问后带 overwrite 重试
async function uploadSkillFile(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !curSkill) return;
  const send = async function (overwrite) {
    const fd = new FormData();
    fd.append('file', file);
    return req('POST', '/api/skills/' + encodeURIComponent(curSkill) + '/upload' + (overwrite ? '?overwrite=true' : ''), fd, true);
  };
  try {
    await send(false);
    toast('已上传 ' + file.name);
  } catch (e) {
    if (/已存在/.test(e.message)) {
      if (!await confirmModal('文件已存在', file.name + ' 已存在,覆盖?', '覆盖')) return;
      try { await send(true); toast('已覆盖 ' + file.name); }
      catch (e2) { toast('上传失败:' + e2.message); }
    } else {
      toast('上传失败:' + e.message);
    }
  }
  loadSkillDetail();
}

window.skillsUI = {
  back: backFromSkill,
  open: openSkill,
  openCreate: openCreateSkill,
  closeCreate: closeCreateSkill,
  createSkill: createSkill,
  renameSkill: renameSkill,
  deleteSkill: deleteSkill,
  editFile: openFileEditor,
  saveFile: saveSkillFile,
  closeEditor: closeSkillEditor,
  newFile: newSkillFile,
  deleteFile: deleteSkillFile,
  onUpload: uploadSkillFile,
};

tabModules.skills = {
  onShow() { loadSkillList(); },
};
