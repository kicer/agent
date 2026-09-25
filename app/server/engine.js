// 核心引擎：会话管理、模型池调度（FIFO）、Agent 主循环、任务目录。
// 单进程内存模型：JS 单线程 + better-sqlite3 同步 API，不存在跨进程竞争。
const fs = require('fs');
const path = require('path');
const { buildMessages, callModel, encodeBlocks, compressMessages, titleMessages, setProfilePrompts } = require('./llm');
const { executeTool, resolveInTask } = require('./tools/executor');
const publicFiles = require('./public-files');
const mcp = require('./mcp');
const log = require('./log');
const profile = require('./user-profile');

const TOOL_DEFINITIONS = require('./tools/definitions.json');

let cfg, db, bus;
const runs = new Map(); // session_id -> {cancelled, procs:Set, abortController, looping:boolean}
const titling = new Set(); // 正在生成标题的会话（防重入；标题落库后靠 title 非空自然不再触发）

// ---------- 小工具 ----------
const now = () => Date.now();

function genTaskId() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const day = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
  const prefix = 'task-' + day + '-';
  // 历史最大序号（防残留行碰撞）与持久计数器取大：会话删除后序号也不回退复用
  let maxSeq = 0;
  for (const r of db.prepare('SELECT id FROM sessions WHERE id LIKE ?').all(prefix + '%')) {
    const n = parseInt(r.id.slice(prefix.length), 10);
    if (n > maxSeq) maxSeq = n;
  }
  const key = 'task_seq:' + day;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  const stored = row ? Number(row.value) || 0 : 0;
  let seq = Math.max(stored, maxSeq) + 1;
  let id = prefix + String(seq).padStart(3, '0');
  while (db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)) {
    seq++;
    id = prefix + String(seq).padStart(3, '0');
  }
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).run(key, String(seq), String(seq));
  return id;
}

function taskDirOf(sessionId) {
  return path.join(cfg.workspace_root, sessionId);
}

function getSession(sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

function touch(sessionId, fields) {
  const sets = ['updated_at = ?'];
  const vals = [now()];
  for (const [k, v] of Object.entries(fields || {})) {
    sets.push(k + ' = ?');
    vals.push(v);
  }
  vals.push(sessionId);
  db.prepare('UPDATE sessions SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
}

function loadHistory(sessionId) {
  return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(sessionId);
}

function saveMessage(sessionId, msg) {
  const info = db.prepare(
    'INSERT INTO messages (session_id, role, content, reasoning, tool_calls, tool_call_id, name, type, is_error, usage, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(sessionId, msg.role, msg.content || null, msg.reasoning || null,
    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    msg.tool_call_id || null, msg.name || null, msg.type || null, msg.is_error ? 1 : 0,
    msg.usage ? JSON.stringify(msg.usage) : null, msg.created_at || now());
  // 关键动作日志：AI 每轮回复落库（含纯工具调用轮）
  if (msg.role === 'assistant') {
    const calls = msg.tool_calls || [];
    let toolDesc = '';
    if (calls.length) {
      // 按出现顺序去重，同名多次调用追加 ×N
      const counts = new Map();
      for (const c of calls) {
        const name = (c && c.function && c.function.name) || '未知工具';
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      toolDesc = '，工具调用：' + [...counts].map(([name, n]) => (n > 1 ? name + '×' + n : name)).join('、');
    }
    log.info('msg', sessionId + ' AI 回复：文本 ' + String(msg.content || '').length + ' 字' + toolDesc);
  }
  return info.lastInsertRowid;
  }

// 记录一次模型回合的 token 用量（上游未返回 usage 时跳过）。
// 写入 model_usage 表,不建会话外键：删会话后累计统计仍保留。
// cached_tokens：上游 prompt_tokens_details.cached_tokens（输入前缀缓存命中量，部分上游不报）。
function recordModelUsage(sessionId, modelId, usage) {
  if (!modelId || !usage) return;
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  const tt = usage.total_tokens || (pt + ct);
  const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  if (!pt && !ct && !tt) return;
  db.prepare(
    'INSERT INTO model_usage (session_id, model_id, prompt_tokens, completion_tokens, total_tokens, cached_tokens, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(sessionId, modelId, pt, ct, tt, cached, now());
}

// 每模型 token 用量统计:今日(本地时区自然日起)+ 累计,输入/输出/缓存命中分开。
// 返回 { [model_id]: { today_prompt, today_completion, today_cached, total_prompt, total_completion, total_cached } },
// 配置内的模型保证有零值占位。
function modelUsageStats() {
  const d = new Date();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const stats = {};
  const slot = function (id) {
    if (!stats[id]) stats[id] = { today_prompt: 0, today_completion: 0, today_cached: 0, total_prompt: 0, total_completion: 0, total_cached: 0 };
    return stats[id];
  };
  for (const m of cfg.models) slot(m.id);
  const sumSql = 'SELECT model_id, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(cached_tokens) AS k FROM model_usage';
  for (const r of db.prepare(sumSql + ' WHERE created_at >= ? GROUP BY model_id').all(dayStart)) {
    slot(r.model_id).today_prompt = r.p || 0;
    slot(r.model_id).today_completion = r.c || 0;
    slot(r.model_id).today_cached = r.k || 0;
  }
  for (const r of db.prepare(sumSql + ' GROUP BY model_id').all()) {
    slot(r.model_id).total_prompt = r.p || 0;
    slot(r.model_id).total_completion = r.c || 0;
    slot(r.model_id).total_cached = r.k || 0;
  }
  return stats;
}

function emitStatus(sessionId) {
  const s = getSession(sessionId);
  if (!s) return;
  bus.emit(sessionId, 'status', {
    session_id: sessionId,
    status: s.status,
    phase: s.phase,
    model_id: s.model_id,
    queue_pos: s.status === 'queued' ? queuePosition(sessionId) : null,
  });
}

function queuePosition(sessionId) {
  const row = db.prepare(
    'SELECT queued_at FROM wait_queue WHERE session_id = ?'
  ).get(sessionId);
  if (!row) return null;
  const better = db.prepare('SELECT COUNT(*) AS c FROM wait_queue WHERE queued_at < ?').get(row.queued_at);
  return better.c + 1;
}

// ---------- 模型池调度 ----------
function syncModelPool() {
  registerProfilePrompts(); // profile 自定义 prompt 注册进 llm（文本已随配置加载读入）
  const stmt = db.prepare(
    'INSERT INTO model_pool (id, display_name, is_busy, current_session_id) VALUES (?,?,0,NULL) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name'
  );
  // 池槽位按物理 key 拆分：槽位 id = 「平台#key下标」，一个 key 同时只服务一个会话（concurrency 仍仅记录未调度）。
  // 同平台的模型共享这批 key：平台 key 全部被占时，其下所有模型都不可再选。
  // enable:false 的模型不进池：平台下模型全禁用则该平台不建槽位（与其他模型配置一致，重启生效）。
  const seen = new Set();
  for (const m of cfg.models) if (m.enable !== false) seen.add(m.platform + '#' + m.key_index);
  for (const slot of seen) stmt.run(slot, slot.split('#')[0]);
  // 清理配置中已删除/已禁用的平台 key（含旧版按模型拆的槽位行，重启后自动重建）
  for (const row of db.prepare('SELECT id FROM model_pool').all()) {
    if (!seen.has(row.id)) db.prepare('DELETE FROM model_pool WHERE id = ?').run(row.id);
  }
  // 进程重启后：释放所有绑定、把 active 会话退回队列；held 会话直接结版（释放）。
  // 禁用模型同样走这里收尾：重启后池里已无它，绑过它的会话被退回队列/结版，后续重新分配启用中的模型。
  db.prepare('UPDATE model_pool SET is_busy = 0, current_session_id = NULL').run();
  db.prepare("UPDATE sessions SET status='completed', completed_at=?, held_at=NULL, model_id=NULL, model_slot=NULL WHERE status='held'").run(now());
  for (const s of db.prepare("SELECT id FROM sessions WHERE status = 'active'").all()) {
    db.prepare("UPDATE sessions SET status='queued', model_id=NULL, model_slot=NULL, updated_at=? WHERE id=?").run(now(), s.id);
    enqueue(s.id);
  }
  // 兑底：queued 会话必须在队列中
  for (const s of db.prepare("SELECT id FROM sessions WHERE status='queued'").all()) enqueue(s.id);
  startHoldSweeper();
}

function freeModel() {
  // 轮转：最久未用（从未用过排最前）的空闲 key 先上 → 全平台 key 自然摊平，
  // 平台 key 灌满后自动轮到下一个平台（见 pickModelFor）。
  return db.prepare('SELECT * FROM model_pool WHERE is_busy = 0 ORDER BY ifnull(last_used_at, 0), id').get();
}

// 模型 id「平台/模型」或池槽位 id「平台#key下标」→ 平台名。
function platformOf(id) {
  const s = String(id || '');
  const h = s.indexOf('#');
  if (h >= 0) return s.slice(0, h);
  const sl = s.indexOf('/');
  return sl >= 0 ? s.slice(0, sl) : s;
}

// 指定平台的空闲 key 槽位：最久未用的先上。
// 用范围比较而非 LIKE，避免平台名里的 _/% 被当通配符。
function freeKeyOf(platform) {
  if (!platform) return null;
  return db.prepare('SELECT * FROM model_pool WHERE id >= ? AND id < ? AND is_busy = 0 ORDER BY ifnull(last_used_at, 0), id LIMIT 1')
    .get(platform + '#', platform + '#\uffff');
}

// 平台下启用中的模型 id 列表（cfg.models 按 key 展开过，这里去重并保留配置顺序）。
function platformModels(platform) {
  const seen = new Set();
  const out = [];
  for (const m of cfg.models) if (m.enable !== false && m.platform === platform && !seen.has(m.id)) { seen.add(m.id); out.push(m.id); }
  return out;
}

// 在 key 所属平台的模型里选一个：preferred（会话上次用过的同平台模型）优先；
// 否则取平台内当前绑定会话数最少的（打平按配置顺序），同平台多模型也轮转摊平。
function chooseModel(platform, preferred) {
  const ms = platformModels(platform);
  if (!ms.length) return null;
  if (preferred && ms.includes(preferred)) return preferred;
  const cnt = {};
  for (const r of db.prepare('SELECT model_id, COUNT(*) AS c FROM sessions WHERE model_id IS NOT NULL GROUP BY model_id').all()) cnt[r.model_id] = r.c;
  return ms.reduce((a, b) => ((cnt[b] || 0) < (cnt[a] || 0) ? b : a), ms[0]);
}

// 会话绑定的模型是否支持 vision（图片回传）；决定 read_file 读图行为（见 tools/executor.js）。
function modelVision(session) {
  const m = session.model_id && (cfg.models || []).find(x => x.id === session.model_id);
  return !!(m && m.vision);
}

// ---------- 模型 profile（prompt+tools 组合） ----------
// 把 cfg 里预加载的自定义 prompt 文本注册给 llm（配置加载时已读入，见 config.js）；
// engine.init 调一次，运行期只按名选取，零 IO。
function registerProfilePrompts() {
  const map = {};
  for (const [name, p] of Object.entries((cfg && cfg.model_profiles) || {})) {
    if (p && p.prompt) map[name] = p.prompt;
  }
  setProfilePrompts(map);
}

// 本轮生效的 profile 名（两档）：advising 阶段强制命中内置 'advising' 组合（顾问只该看到顾问的工具）；
// 否则 = 模型配置默认（cfg.models[].profile）> ''（默认全量）。
// 运行期手动切换已全部移除（消息级 profile 参数、sessions.profile 会话绑定均已废弃），
// 顾问/执行的节奏由 sessions.phase 单一状态机控制，见 enterExecuting / archiveTaskBrief。
function resolveProfileName(session) {
  if (session && session.phase === 'advising') return 'advising';
  const m = session && session.model_id && (cfg.models || []).find(x => x.id === session.model_id);
  return m && m.profile ? String(m.profile) : '';
}

// 本轮工具定义集：内置 + MCP 全量；先 profile 的 tools_allow 白名单、再叠 tools_deny 黑名单
// （deny 赢，与 mcp_servers 同构；profile 未配 deny = 继承全局 cfg.tools_deny，DEFAULTS 默认屏蔽元工具 lab），
// 按最终名过滤（与发给模型的 tools 字段/prompt.txt dump 同源可对）。allow 空数组 = 零工具（纯文本组合，
// callModel 对空数组不发 tools 字段）；未配 = 全量。只影响模型「看得到什么」：
// 名单外但真实存在的工具若被调用，executor 照常执行（HANDLERS 全表分发），不拦不误杀。
function effectiveTools(profileName) {
  const prof = profileName && cfg.model_profiles && cfg.model_profiles[profileName];
  const allow = prof && prof.tools_allow;
  const deny = prof && Array.isArray(prof.tools_deny) ? prof.tools_deny : cfg.tools_deny;
  let out = TOOL_DEFINITIONS.concat(mcp.toolDefinitions());
  if (Array.isArray(allow)) {
    const set = new Set(allow);
    out = out.filter(t => t && t.function && set.has(t.function.name));
  }
  if (Array.isArray(deny) && deny.length) {
    const dset = new Set(deny);
    out = out.filter(t => !t || !t.function || !dset.has(t.function.name));
  }
  return out;
}

// ---------- 阶段（sessions.phase：advising 顾问 / executing 执行） ----------
// advising：新建会话与「清空」的落点。profile 被 resolveProfileName 强制为 'advising'，
// 只问答/判意图/引导澄清；唯一出口是 write_file/edit_file 把任务书 task.md 落在任务目录根（正门判定）。
// executing：一路走到底，只有清空才回 advising；压缩不碰 phase（压完仍回原模式）。

// 写类工具（write_file/edit_file）的参数是否恰好落在任务目录根的 task.md——阶段切换的正门判定。
// resolveInTask 统一解相对/绝对路径并拦越界；子目录 task.md 不算。
// 不扫文件存在性：用户随时上传同名素材不算承诺，只有 AI 亲自写一次才算（上传也永远覆盖不了
// task.md：files.js 同名自动加后缀）。
function argsHitTaskBrief(taskDir, args) {
  try {
    const abs = path.resolve(resolveInTask(taskDir, String((args && args.path) || '')));
    return abs === path.resolve(taskDir, 'task.md');
  } catch (_) { return false; }
}

// advising → executing：任务书落地，当场重建上下文——
// 全部历史标 archived（UI 照常展示、不再发模型，与压缩/定时投递同机制），
// 插一条 type='task_brief' 的 user 行（内容 = 此刻 task.md 磁盘快照，非引用：后续文件怎么改都不动锚点）
// 作为执行阶段唯一上下文起点；runLoopInner 下一迭代重读历史 + 重解 profile，天然已在执行态，AI 同回合开工。
// 幂等：phase 已是 executing 直接返回（执行中再改 task.md 只是普通文件编辑，不重存档、不重插快照）。
function enterExecuting(sessionId) {
  const session = getSession(sessionId);
  if (!session || session.phase !== 'advising') return;
  const briefPath = path.join(taskDirOf(sessionId), 'task.md');
  let snapshot;
  try {
    snapshot = fs.readFileSync(briefPath, 'utf8');
  } catch (e) {
    log.warn('engine', sessionId + ' 阶段切换放弃：读不回 task.md — ' + (e && e.message || e));
    return;
  }
  if (!snapshot.trim()) return; // 空任务书不构成承诺，继续留在顾问模式
  // 画像提取的输入：归档前的 advising 轮全量历史（归档后就拿不到了，先抓引用）
  const adviceRows = loadHistory(sessionId);
  const n = db.prepare(
    "UPDATE messages SET type = 'archived' WHERE session_id = ? AND (type IS NULL OR type != 'archived')"
  ).run(sessionId).changes;
  saveMessage(sessionId, {
    role: 'user', type: 'task_brief',
    content: '【任务书】需求澄清完毕，会话已进入执行模式。以下任务书快照（task.md）是唯一目标依据；'
      + '之前的顾问对话已存档、不再发送。执行中可修订 task.md（以文件现状为准）；'
      + '上一轮任务书归档在 .task-history/，仅限用户明确要求时查阅。\n\n' + snapshot,
  });
  db.prepare("UPDATE sessions SET phase='executing', updated_at=? WHERE id=?").run(now(), sessionId);
  bus.emit(sessionId, 'phase', { phase: 'executing' });
  emitStatus(sessionId);
  log.info('engine', sessionId + ' advising → executing：task.md 落地，存档 ' + n + ' 条消息，上下文重建为任务书快照');
  // 用户画像唯一更新时机：一轮需求尘埃落定时异步提取（fire-and-forget，永不抛出，见 user-profile.js）
  profile.runExtraction(db, cfg, { sessionId, user: session.user, modelId: session.model_id, historyRows: adviceRows, briefText: snapshot });
}

// 清空即回 advising：上一轮任务书 mv 进 .task-history/（带时间戳名，撞名再加 -N，同上传风格），
// 防旧约定污染新一轮规划。点前缀目录在文件列表默认隐藏（同 .imgcache 约定），AI/用户显式请求可查；
// 同步清掉 files 元数据表的 task.md 行（列表读磁盘不读表，清行只为不留孤儿记录）。
function archiveTaskBrief(sessionId) {
  try {
    const dir = taskDirOf(sessionId);
    const src = path.join(dir, 'task.md');
    if (!fs.existsSync(src)) return;
    const hist = path.join(dir, '.task-history');
    fs.mkdirSync(hist, { recursive: true });
    const d = new Date();
    const pad = x => String(x).padStart(2, '0');
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    let dest = path.join(hist, 'task-' + stamp + '.md');
    for (let i = 1; fs.existsSync(dest); i++) dest = path.join(hist, 'task-' + stamp + '-' + i + '.md');
    fs.renameSync(src, dest);
    db.prepare("DELETE FROM files WHERE session_id = ? AND filename = 'task.md'").run(sessionId);
    log.info('task', sessionId + ' 旧任务书归档 → ' + path.relative(dir, dest));
  } catch (e) {
    log.warn('task', sessionId + ' 旧任务书归档失败：' + (e && e.message || e));
  }
}

function enqueue(sessionId) {
  const exists = db.prepare('SELECT id FROM wait_queue WHERE session_id = ?').get(sessionId);
  if (!exists) db.prepare('INSERT INTO wait_queue (session_id, queued_at) VALUES (?,?)').run(sessionId, now());
}

function dequeue(sessionId) {
  db.prepare('DELETE FROM wait_queue WHERE session_id = ?').run(sessionId);
}

// key：占用的池 key 槽位行（id=「平台#ki」）；modelId：选定的模型 id（同平台模型共享 key，绑定时才决定用哪个）。
// status:绑定后的会话状态。
// - 'active'(默认)：绑定即开跑(有待回应消息,紧随其后 runLoop);排队派发 dispatchQueued 用。
// - 'held'：仅预留模型占位(手动选模/新建选模,尚无待回应消息),
//   用户发首条消息后由 postUserMessage 的 held 分支转 active 开跑。
function bindModel(session, key, modelId, status) {
  const st = status === 'held' ? 'held' : 'active';
  db.prepare('UPDATE model_pool SET is_busy = 1, current_session_id = ?, last_used_at = ? WHERE id = ?').run(session.id, now(), key.id);
  // model_id/last_model_id 存模型 id（展示/统计用），model_slot 记占用的具体 key 槽位；
  // last_model_id 不随释放清除：会话再次需要模型时优先回绑同平台（见 pickModelFor）
  db.prepare("UPDATE sessions SET status=?, model_id=?, model_slot=?, last_model_id=?, held_at=?, updated_at=? WHERE id=?")
    .run(st, modelId, key.id, modelId, st === 'held' ? now() : null, now(), session.id);
}

function releaseModel(sessionId) {
  db.prepare('UPDATE model_pool SET is_busy = 0, current_session_id = NULL WHERE current_session_id = ?').run(sessionId);
  db.prepare('UPDATE sessions SET model_id = NULL, model_slot = NULL, updated_at = ? WHERE id = ?').run(now(), sessionId);
}

// 手动为已结版/已终止的会话指定模型：选定的模型必须空闲。
// 绑上 ≠ 开跑：无待回应消息时进入 held（保持中，占用模型免排队），
// 用户发首条消息后才转 active 开跑；若有未回应消息（如终止时留下未回答的提问）
// 则直接 active 并立刻开跑。绑而不用同样受保持租约兑底（sweepHeld）。
function bindToSession(sessionId, modelId) {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  if (s.status !== 'completed' && s.status !== 'cancelled') {
    throw Object.assign(new Error('仅已完成/已终止的会话可手动选择模型'), { status_code: 409 });
  }
  // 手动选定模型：占用其平台任意一个空闲 key（平台 key 全满才算被占）；模型需在启用列表中。
  const want = String(modelId || '');
  const plat = platformOf(want);
  const key = freeKeyOf(plat);
  if (!key || !platformModels(plat).includes(want)) throw Object.assign(new Error('模型不存在或正被占用'), { status_code: 409 });
  touch(sessionId, { cancelled_at: null, completed_at: null, held_at: null });
  const pending = hasPendingUser(sessionId);
  bindModel(s, key, want, pending ? 'active' : 'held');
  emitStatus(sessionId);
  log.info('model', sessionId + ' 手动绑定模型 ' + want + '（key ' + key.id + '）');
  if (pending) runLoop(sessionId);
  return { ok: true, model_id: want };
}



// 是否还有待回应的新用户消息（最后一条非 tool 消息是 user）。
function hasPendingUser(sessionId) {
  const rows = loadHistory(sessionId);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'tool') continue;
    return rows[i].role === 'user';
  }
  return false;
}

// 为排队会话挑 key+模型：上次用过的模型（last_model_id）所在平台有空闲 key 则优先回该平台；
// 否则按「最久未用」取全局任意空闲 key。具体模型由 chooseModel 在 key 平台上定（同平台偏好上次模型）。
function pickModelFor(session) {
  const want = session.last_model_id || '';
  let key = want ? freeKeyOf(platformOf(want)) : null;
  if (!key) key = freeModel();
  if (!key) return null;
  const plat = platformOf(key.id);
  const model = chooseModel(plat, platformOf(want) === plat ? want : '');
  return model ? { key, model } : null;
}

// 有空闲 key 就按 FIFO 派发排队会话（每会话优先回绑上次用过的模型所在平台）。
function dispatchQueued() {
  for (;;) {
    if (!freeModel()) return;
    const head = db.prepare('SELECT session_id FROM wait_queue ORDER BY queued_at, id').get();
    if (!head) return;
    dequeue(head.session_id);
    const session = getSession(head.session_id);
    if (!session || session.status !== 'queued') continue;
    // 上面已确认有空闲 key；若目标平台无启用模型/无空闲 key 致分配失败（理论上不会），退回队尾等下次派发。
    const got = pickModelFor(session);
    if (!got) { enqueue(session.id); continue; }
    // 无待回应消息的会话（如新建后从未发言）只预留不占跑，绑成 held 等首条消息。
    // 待开跑的压缩回合（内存 run.summarizing，见 summarizeContext）也算待处理：
    // 它没有对应的用户消息行，hasPendingUser 判不到，需单独纳入。
    const run0 = runs.get(session.id);
    const pending = hasPendingUser(session.id) || !!(run0 && run0.summarizing);
    bindModel(session, got.key, got.model, pending ? 'active' : 'held');
    emitStatus(session.id);
    if (pending) runLoop(session.id);
  }
}

// ---------- 保持租约（held / active 闲置） ----------
// 回合结束后会话进入 held：继续占用模型（用户追问免排队），由 sweeper 按规则释放：
// - 页面无 SSE 观看者：超过 idle_release_ms 释放；
// - 有人观看：最长保持 active_max_ms（防止挂着页面霸占模型池）。
// 「绑定了模型但闲置」的会话（active 且无 run 在跑、无未回应消息，如新建后从未发言）
// 同样受租约管理，避免建了不用的会话无限占用模型。
function releaseHeld(sessionId) {
  const s = getSession(sessionId);
  if (!s || s.status !== 'held') return;
  touch(sessionId, { status: 'completed', completed_at: now(), held_at: null });
  releaseModel(sessionId);
  bus.emit(sessionId, 'done', { status: 'completed' });
  emitStatus(sessionId);
  dispatchQueued();
}

// 用户主动「断开」： held 会话放弃保持租约，结版为 completed（区别于终止的 cancelled）
function releaseHold(sessionId) {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  if (s.status !== 'held') throw Object.assign(new Error('会话不在保持中'), { status_code: 409 });
  releaseHeld(sessionId);
  return { ok: true };
}

// active 但闲置（从未发言/无未回应消息）→ 按租约释放，语义同 held 到期
function releaseIdleActive(sessionId) {
  const s = getSession(sessionId);
  if (!s || s.status !== 'active' || !s.model_id) return;
  const run = runs.get(sessionId);
  if (run && run.looping) return;
  touch(sessionId, { status: 'completed', completed_at: now() });
  releaseModel(sessionId);
  bus.emit(sessionId, 'done', { status: 'completed' });
  emitStatus(sessionId);
  dispatchQueued();
}

function sweepHeld() {
  const holdCfg = (cfg && cfg.model_hold) || {};
  const idleMs = holdCfg.idle_release_ms || 180000;
  const activeMs = holdCfg.active_max_ms || 1800000;
  const t = now();
  for (const s of db.prepare("SELECT * FROM sessions WHERE status='held'").all()) {
    const heldSince = t - (s.held_at || s.updated_at || 0);
    const present = bus.clientCount && bus.clientCount(s.id) > 0;
    if (heldSince >= (present ? activeMs : idleMs)) releaseHeld(s.id);
  }
  // active 闲置：绑定了模型但无 run 在跑、无未回应消息（如新建后从未发言）→ 同租约释放
  for (const s of db.prepare("SELECT * FROM sessions WHERE status='active' AND model_id IS NOT NULL").all()) {
    const run = runs.get(s.id);
    if (run && run.looping) continue;
    if (hasPendingUser(s.id)) continue; // 有消息待回应，由 runLoop 处理，不动它
    const idleSince = t - (s.updated_at || 0);
    const present = bus.clientCount && bus.clientCount(s.id) > 0;
    if (idleSince >= (present ? activeMs : idleMs)) releaseIdleActive(s.id);
  }
}

let holdTimer = null;
function startHoldSweeper() {
  if (holdTimer) return;
  const ms = (cfg && cfg.model_hold && cfg.model_hold.sweep_ms) || 10000;
  holdTimer = setInterval(sweepHeld, ms);
  if (holdTimer.unref) holdTimer.unref(); // 不阻止进程退出
}

// ---------- 运行控制 ----------
function getRun(sessionId, create) {
  let run = runs.get(sessionId);
  if (!run && create) {
    run = { cancelled: false, procs: new Set(), abortController: null, looping: false };
    runs.set(sessionId, run);
  }
  return run;
}

// 正在执行 AI 回合(looping)的会话 id 列表:供重启保护判断。
// 注意只算「回合执行中」;active 但空闲(等用户输入)与 held 都不算,重启无损失。
function activeRuns() {
  const out = [];
  for (const [id, run] of runs) if (run && run.looping) out.push(id);
  return out;
}

function killRunProcs(run) {
  for (const proc of run.procs) {
    // 远端 executor 任务句柄（remote-exec.js）：发 DELETE 取消，不能本地 kill。
    if (typeof proc.remoteKill === 'function') { try { proc.remoteKill(); } catch (_) {} continue; }
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {
      try { proc.kill('SIGKILL'); } catch (__) {}
    }
  }
  run.procs.clear();
}

// ---------- Agent 主循环 ----------
async function runLoop(sessionId) {
  const run = getRun(sessionId, true);
  if (run.looping) return; // 已有循环在跑（下一轮迭代会自动带上最新消息）
  run.looping = true;
  // 回合级 In token 峰值（整轮结束后供自动压缩检查）；记录本回合是否为压缩回合，压缩回合不再自启压缩防递归
  run.turnMaxPt = 0;
  const wasCompressTurn = !!run.summarizing;
  try {
    await runLoopInner(sessionId, run);
  } catch (err) {
    log.error('engine', 'runLoop ' + sessionId + ' 异常:', err && err.stack || err);
    bus.emit(sessionId, 'error', { message: String(err && err.message || err) });
  } finally {
    run.looping = false;
    finalize(sessionId, run);
    // 自动压缩只在回合完全结束（循环已退、finalize 已收尾）后检查：AI↔tools 交互途中绝不触发
    maybeAutoCompress(sessionId, run, wasCompressTurn);
  }
}

function finalize(sessionId, run) {
  const s = getSession(sessionId);
  if (!s || s.status !== 'active') { runs.delete(sessionId); return; }
  const cancelled = run.cancelled;
  if (cancelled) {
    touch(sessionId, { status: 'cancelled', cancelled_at: now(), completed_at: null });
    releaseModel(sessionId);
    runs.delete(sessionId);
    bus.emit(sessionId, 'done', { status: 'cancelled' });
    emitStatus(sessionId);
    dispatchQueued();
    return;
  }
  // 正常结束：进入 held 保持租约，不释放模型，用户追问可直接复用
  touch(sessionId, { status: 'held', held_at: now(), completed_at: null, cancelled_at: null });
  runs.delete(sessionId);
  bus.emit(sessionId, 'done', { status: 'held' });
  emitStatus(sessionId);
  maybeGenerateTitle(sessionId, s);
}

// 首次交互结束后自动生成会话标题：fire-and-forget，不阻塞回合收尾。
// 不带 system prompt：历史 user/assistant 原文 + 末尾一条标题指令 user（见 llm.titleMessages），
// 用会话当前 model_id 发一次不传 tools 的调用。失败静默（title 仍空，下个回合结束自动重试）。
function maybeGenerateTitle(sessionId, s) {
  try {
    if (s.title) return;
    const modelId = s.model_id;
    if (!modelId || titling.has(sessionId)) return;
    titling.add(sessionId);
    const messages = titleMessages(loadHistory(sessionId), cfg.agent.language);
    callModel(cfg, modelId, messages, null, { key_slot: s.model_slot })
      .then(r => {
        const title = cleanTitle(r && r.content);
        if (!title) return;
        if (!loadHistory(sessionId).length) return; // 生成期间会话被清空：旧历史催生的标题不再回写
        touch(sessionId, { title });
        bus.emit(sessionId, 'title', { title }); // 前端监听：刷新详情页标题 + 重拉会话列表
        log.info('task', sessionId + ' 自动生成标题「' + title + '」');
      })
      .catch(err => log.warn('task', sessionId + ' 生成标题失败：' + String(err && err.message || err)))
      .finally(() => titling.delete(sessionId));
  } catch (e) {
    titling.delete(sessionId);
    log.warn('task', sessionId + ' 生成标题异常：' + String(e && e.message || e));
  }
}

// 清洗模型返回的标题：压成单行、去包裹引号，截断到 60 字（手动重命名上限 100，留余量）。
function cleanTitle(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  const q = ['"', '\'', '“', '”', '‘', '’', '「', '」', '『', '』', '《', '》'];
  while (t.length > 2 && q.includes(t[0])) t = t.slice(1).trimStart();
  while (t.length > 1 && q.includes(t[t.length - 1])) t = t.slice(0, -1).trimEnd();
  return t.slice(0, 60);
}

async function runLoopInner(sessionId, run) {
  let iter = 0;
  // 已纳入模型请求的最大消息 id；用于判断是否有尚未被回应的新 user 消息
  // （不能用“最后一条非 tool 消息是 user”判断：流式输出期间到达的消息会排在 assistant 之前而被漏掉）
  let lastIncludedId = 0;
  const maxIter = cfg.agent.max_tool_iterations;
  while (!run.cancelled && iter < maxIter) {
    const session = getSession(sessionId);
    if (!session || session.status !== 'active' || !session.model_id) break;
    session.history = loadHistory(sessionId);
    for (const m of session.history) if (m.id > lastIncludedId) lastIncludedId = m.id;
    // 压缩回合（run.summarizing = 由「压缩」按钮发起、尚未产出摘要）：
    // 沿用默认 system prompt + 正常历史，末尾追加一条压缩指令 user（见 llm.compressMessages）；
    // 且不传 tools，模型只能输出摘要文本。
    // 发送前为历史里的 image_ref 块现签公网外链（GET /p/<id>，同 mint_public_link）：
    // 每次请求重签，回合内多轮迭代/重试永不过期；DB 只存几十字符的 rel，base64 不进库不进请求体。
    // base_url 未配/校验不过/mint 异常时返回 null，buildMessages 降级为文字占位。
    // image_rel 可能是压缩无收益时直指的原文件：与 mint_public_link 同款 realpath 复核，
    // 防任务目录里指向外部的符号链接图片被签上公网。
    const mintImageUrl = (rel) => {
      const pl = cfg.public_link || {};
      if (!pl.base_url) return null;
      try {
        const dir = taskDirOf(sessionId);
        const real = fs.realpathSync(resolveInTask(dir, rel));
        if (real !== dir && !real.startsWith(dir + path.sep)) return null;
        return pl.base_url + '/p/' + publicFiles.mint({ sessionId: sessionId, rel, ttlMs: pl.ttl_ms });
      } catch (_) { return null; }
    };
    const compressing = !!run.summarizing;
    // profile（prompt+tools 组合）：每迭代现解，前端切模式后下一个请求即生效；
    // 压缩回合同样跟随（小模型会话点「压缩」若回退默认大模板，当场撑爆）。
    const profileName = resolveProfileName(session);
    const messages = compressing
      ? compressMessages(session, (cfg.agent || {}).language, mintImageUrl, profileName)
      : buildMessages(session, (cfg.agent || {}).language, mintImageUrl, profileName);
    // 内置工具 + 启动时发现的 MCP 工具（按 profile 白名单过滤），一起随 system prompt 发给模型（压缩回合不发）
    const tools = compressing ? [] : effectiveTools(profileName);

    let result = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= cfg.agent.max_retries && !run.cancelled; attempt++) {
      try {
        result = await streamAssistant(sessionId, run, session, messages, tools);
        break;
      } catch (err) {
        lastErr = err;
        const retriable = !err.upstream_status || err.upstream_status === 429 || err.upstream_status >= 500;
        if (!retriable || attempt === cfg.agent.max_retries) break;
        await sleep(2000 * (attempt + 1));
      }
    }
    if (run.cancelled) break;
    if (!result) {
      const text = '⚠️ 模型调用失败：' + (lastErr && lastErr.message || '未知错误');
      const errId = saveMessage(sessionId, { role: 'assistant', content: text });
      bus.emit(sessionId, 'assistant_message', { id: errId, content: text, error: true, created_at: now() });
      break;
    }

    // 容错：部分模型把参数多包一层 arguments/function 外层，统一解包后再落库与执行。
    // 写回历史的 tool_calls 也是解包后的干净形状，避免模型模仿自己上一轮的错误样本。
    if (result.tool_calls) {
      for (const tc of result.tool_calls) {
        const fixed = unwrapToolArgs(tools, tc.name, tc.arguments);
        if (fixed) {
          log.debug('tool', sessionId + ' ' + tc.name + ' 参数包裹外层已自动解包');
          tc.arguments = JSON.stringify(fixed);
        }
      }
    }

    // 保存 assistant 消息
    const hasTools = result.tool_calls && result.tool_calls.length > 0;
    // 参数校验预扫描：任一 tool call 结构性错误（JSON 非法/缺必填）→ 整条标 errAck。
    // 该行仍入库（UI 可见可排查），但 buildMessages 发请求时连同关联 tool 回执整轮跳过，
    // 改以一条 user 错误提示替代，防止模型模仿自己的坏样本反复出错死循环。
    let isErrAck = false;
    if (hasTools) {
      for (const tc of result.tool_calls) {
        if (checkToolArgs(tools, tc.name, tc.arguments).error) { isErrAck = true; break; }
      }
    }
    const msgRow = {
      role: 'assistant',
      type: isErrAck ? 'errAck' : null,
      content: result.content || '',
      reasoning: result.reasoning || null,
      tool_calls: hasTools ? result.tool_calls.map(tc => ({
        // 缺 id 时补全，保证与 tool 回执落库用的 id 一致（buildMessages 按 id 配对丢弃）
        id: tc.id || ('call_' + Math.random().toString(36).slice(2, 10)), type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })) : null,
      // 落库与 SSE 事件共用同一时间戳:前端流式收尾时直接拿来渲染时间行,重进会话后时刻不跳变
      created_at: now(),
      // token 用量快照（msg-actions 展示 In/Out/命中率）：上游不报 details 时 cached 置 null 以区分“未报”与“0 命中”
      usage: result.usage ? {
        pt: result.usage.prompt_tokens || 0,
        ct: result.usage.completion_tokens || 0,
        cached: result.usage.prompt_tokens_details
          ? (result.usage.prompt_tokens_details.cached_tokens || 0) : null,
      } : null,
    };
    const assistantId = saveMessage(sessionId, msgRow);
        if (isErrAck) log.info('msg', sessionId + ' 本轮 tool call 参数错误，assistant 标记 errAck（不再进入模型上下文）');
        recordModelUsage(sessionId, session.model_id, result.usage);
        // 回合级 In token 峰值：工具迭代只会越滚越大，取各轮 prompt_tokens 最大值作自动压缩判据
        if (msgRow.usage && msgRow.usage.pt > (run.turnMaxPt || 0)) run.turnMaxPt = msgRow.usage.pt;
        // 「压缩」回合的总结判定：压缩时不传 tools，因此本回合第一条「无 tool_calls 的收尾回复」
        // 就是摘要（compressing 取自本回合的 run.summarizing 标记）；回合中间若有异常产生的
        // 工具轮（理论上不会）都是普通消息，前端照常渲染。
        const isSummary = !hasTools && compressing;
        bus.emit(sessionId, 'assistant_message', {
              id: assistantId, content: msgRow.content, reasoning: msgRow.reasoning,
              tool_calls: msgRow.tool_calls, type: msgRow.type, created_at: msgRow.created_at,
              usage: msgRow.usage, is_summary: isSummary,
            });
            if (isSummary) {
              // 摘要落地：这条收尾答复在库里标成 type='summary'
              //（前端重渲染成摘要卡片；也是模型上下文的起点），并把之前的消息存档：
              //   type='archived' 行 UI 照常展示，但 buildMessages 不再发给模型——
              //   后续对话从这条摘要开始，旧历史不再烧 token。
              // 旧摘要行（多轮压缩）一并存档：被新摘要覆盖替代，不再进上下文。
              run.summarizing = null;
              if ((msgRow.content || '').trim()) {
                db.prepare("UPDATE messages SET type = 'summary' WHERE id = ?").run(assistantId);
                const n = db.prepare(
                  "UPDATE messages SET type = 'archived' WHERE session_id = ? AND id < ?" +
                  " AND (type IS NULL OR type != 'archived')"
                ).run(sessionId, assistantId).changes;
                log.info('msg', sessionId + ' 压缩摘要 ' + assistantId + ' 落库，存档之前 ' + n + ' 条消息（不再发给模型）');
              }
            }

    if (!hasTools) {
      // 回合结束；但若期间用户又发了新消息（live 投递），继续下一轮而不是收尾
      if (!hasUserSince(sessionId, lastIncludedId)) break;
      continue;
    }

    // 执行工具
    const vision = modelVision(session);
    let taskBriefWritten = false; // 本批工具里是否有「正门落 task.md」（批量跑完统一切换，见循环尾注释）
    for (const tc of msgRow.tool_calls) {
      if (run.cancelled) break;
      const id = tc.id;
      log.debug('tool', sessionId + ' 调用 ' + tc.function.name + ' 参数: ' + String(tc.function.arguments || ''));
      bus.emit(sessionId, 'tool_call', { id, name: tc.function.name, arguments: tc.function.arguments });
      let output;
      let isError = false;
      // 参数校验：解包后仍非法（JSON 不合法/缺必填）就直接挡下，绝不把 undefined 交给 shell 执行
      const chk = checkToolArgs(tools, tc.function.name, tc.function.arguments);
      if (chk.error) {
        // 把正确形状告诉模型，替它纠正包装习惯
        output = chk.error;
        isError = true;
      } else {
        try {
          output = await executeTool({ sessionId, taskDir: taskDirOf(sessionId), run, cfg, db, vision },
            tc.function.name, chk.args);
        } catch (err) {
          output = 'Error: ' + (err && err.message || String(err));
          isError = true;
        }
      }
      // 工具可返回 {text, image_rel}（read_file 读图且模型支持 vision，压缩产物在 .imgcache/）：
      // 落库时以 image_ref 内容块拼进 tool 消息（哨兵 JSON，见 llm.js encodeBlocks），
      // buildMessages 发请求前现签成公网外链的 image_url 块；前端工具卡走带 cookie 的下载路由渲染。
      let outText;
      let imageRel = null;
      if (output && typeof output === 'object' && output.image_rel) {
        outText = String(output.text || '');
        imageRel = String(output.image_rel);
      } else {
        outText = String(output == null ? '' : output);
      }
      if (run.cancelled && !isError) outText = (outText ? outText + '\n' : '') + '（用户已终止任务）';
      log.debug('tool', sessionId + ' ' + tc.function.name + (isError ? ' 失败: ' : ' 完成: ') + outText);
      const toolContent = imageRel
        ? encodeBlocks([
            { type: 'text', text: outText },
            { type: 'image_ref', rel: imageRel },
          ])
        : outText;
      // 先落库再广播：回执带上消息行 id（msg_id），前端工具卡据此挂「删除本条」按钮
      const toolMsgId = saveMessage(sessionId, { role: 'tool', tool_call_id: id, name: tc.function.name, content: toolContent, is_error: isError });
      bus.emit(sessionId, 'tool_result', {
        tool_call_id: id, name: tc.function.name,
        // 工具卡只是实时预览切片；落库与模型上下文是全文——不加标记会被读成「工具只输出了这么多」。
        content: outText.length > 20000 ? outText.slice(0, 20000) + '\n…（工具卡仅显示前 20000 字符，完整结果见模型上下文/历史重载）' : outText,
        is_error: isError,
        // 实时工具卡预览图：带 cookie 的会话内下载路由（与历史重渲染同源），非 base64
        image_url: imageRel ? '/api/sessions/' + encodeURIComponent(sessionId) + '/files/download?path=' + encodeURIComponent(imageRel) : undefined,
        msg_id: toolMsgId,
      });
      // 阶段切换正门：advising 回合里 write_file/edit_file 成功且路径恰为根 task.md → 标记待切换。
      // 不在这里就地切：同批可能还有其它 tool_calls，其父 assistant 行若先被存档、
      // 后落库的回执就成了无主孤儿行（上游拒收）——整批跑完再统一重建上下文。
      if (!isError && (tc.function.name === 'write_file' || tc.function.name === 'edit_file')
          && argsHitTaskBrief(taskDirOf(sessionId), chk.args)) {
        taskBriefWritten = true;
      }
    }
    if (taskBriefWritten) enterExecuting(sessionId);
    iter++;
  }
  if (iter >= maxIter && !run.cancelled) {
    const text = '⚠️ 已达到最大工具迭代次数（' + maxIter + '），自动停止。可继续输入让我接着干。';
    const stopId = saveMessage(sessionId, { role: 'assistant', content: text });
    bus.emit(sessionId, 'assistant_message', { id: stopId, content: text, created_at: now() });
  }
}
// 解析单条 SSE meta 行（按第一个 ':' 切 k,v 分发），构造回调供 streamAssistant 使用。
// 状态 last_id / retry_time 跨多次调用保持（一次 streamAssistant 内），便于后续关联。
// 分发规则（来自 SSE 调试日志规范）：
//   id    → last_id = v         （静默）
//   retry → retry_time = v      （静默）
//   event → log.debug event 名  （如 'event: error'）
//   k=''  && v='ping'           → 当作 event=ping，debug 打
//   k=''  其他                  → 注释行（如 :keep-alive），debug 打
//   其它                       → 未知字段，debug 打原行
function makeSseMetaHandler(sessionId) {
  let last_id = null;
  let retry_time = null;
  return function handleSseMeta(line) {
    const t = line.trim();
    const i = t.indexOf(':');
    const k = i < 0 ? t : t.slice(0, i);
    const v = i < 0 ? '' : t.slice(i + 1).trim();
    if (k === 'id') {
      last_id = v;
    } else if (k === 'retry') {
      retry_time = v;
    } else if (k === 'event') {
          log.debug('sse', sessionId + ' event: ' + v);
        } else if (k === '' && v === 'ping') {
          log.debug('sse', sessionId + ' event: ' + v);
        } else if (k === '') {
          log.debug('sse', sessionId + ' comment: ' + v);
        } else {
          log.debug('sse', sessionId + ' meta: ' + line);
        }
  };
}


// 流式接收 assistant 输出并转发 SSE。返回 callModel 结果。
async function streamAssistant(sessionId, run, session, messages, tools) {
  run.abortController = new AbortController();
  // 工具参数流式调试计数：start 建卡次数 / 参数碎片数 / 累计字符（判断上游是否真的分片下发）
  const tcDbg = { starts: 0, frags: 0, chars: 0 };
  try {
    const handleSseMeta = makeSseMetaHandler(sessionId);
    // key_slot 定位会话占用的具体 key 副本（model_id 只到「平台/模型」）
    const result = await callModel(cfg, session.model_id, messages, tools, {
      key_slot: session.model_slot,
      signal: run.abortController.signal,
      shouldCancel: () => run.cancelled,
      onText: delta => bus.emit(sessionId, 'assistant_delta', { text: delta }),
      onReasoning: delta => bus.emit(sessionId, 'reasoning_delta', { text: delta }),
      // 工具调用早反馈：id+name 就绪即建卡，参数碎片流式下发（长参数生成期间前端不再空等）
      onToolCallStart: t => {
        tcDbg.starts++;
        log.debug('tool', sessionId + ' tool_call 早反馈：建卡 name=' + t.name + ' id=' + t.id);
        bus.emit(sessionId, 'tool_call_start', { id: t.id, name: t.name });
      },
      onToolCallArgs: t => {
        tcDbg.frags++;
        tcDbg.chars += (t.args || '').length;
        // 首片必打，其后每 20 片一行，避免超大参数刷屏
        if (tcDbg.frags === 1 || tcDbg.frags % 20 === 0)
          log.debug('tool', sessionId + ' tool_call 参数流式：第 ' + tcDbg.frags + ' 片，累计 ' + tcDbg.chars + ' 字');
        bus.emit(sessionId, 'tool_call_args', { id: t.id, args: t.args });
      },
      // 本轮是否启用深度思考；由 postUserMessage 从消息 POST 参数写进 run
      deepThink: !!run.deepThink,
      onMeta: handleSseMeta,
      onFetchParams: params => log.debug('req', JSON.stringify(params, null, 2)),
      onBadData: raw => log.warn('sse', sessionId + ' 坏帧：' + raw.slice(0, 200)),
      // data 解析成功但没有 choices 也无 usage 的怪帧（含 evt.error 的错误帧已在 callModel 内转 throw 上屏）：
      // 之前会伪装成"0 字"沉默忽略，这里 warn 把原始 evt 打出来便于定位。
      onBadEvent: evt => log.warn('sse', sessionId + ' 上游怪帧（无 choices）：' + JSON.stringify(evt).slice(0, 500)),
    });
    // 本轮上游响应总览：帧数 + 文本长度 + 工具调用 + finish + aborted。
    // sseFrames=0 且 aborted=false 表示上游未发任何 data（疑似流异常）；其他情况可快速区分
    // “上游发了一堆帧但 content 为空” 与 “根本没调用成功”。
    // 末尾附工具参数流式统计：frags=1 说明上游把整段参数打包在单帧里（前端看不到逐片效果，非链路 bug）。
    // aborted 细分来源：cancel=用户终止置位；stream=未置取消标志但流被 AbortError 掐断
    //（如上游连接异常），排查时一眼区分“被人停了”与“链路自己断了”。
    log.info('sse', sessionId + ' 本轮汇总：帧 ' + (result && result.sseFrames || 0) +
          '，finish=' + (result && result.finish_reason || '-') +
          '，aborted=' + (result && result.aborted ? (run.cancelled ? 'cancel' : 'stream') : 'false') +
          (tcDbg.starts ? '，tool_call早建卡 ' + tcDbg.starts + ' 张，参数碎片 ' + tcDbg.frags + ' 片/' + tcDbg.chars + ' 字' : ''));
    return result;
  } finally {
    run.abortController = null;
  }
}

function hasUserSince(sessionId, sinceId) {
  const r = db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user' AND id > ?"
  ).get(sessionId, sinceId);
  return r.c > 0;
}

// 校验工具调用参数，返回 { args, error }。error 非空 = 结构性错误（JSON 非法/缺必填）：
// 执行挡下，且整条 assistant 标 errAck，发请求时整轮移出模型上下文（见 llm.buildMessages），
// 防止模型模仿自己的坏样本反复出错死循环。args 为空串视为空对象（无参工具正常执行）。
function checkToolArgs(tools, name, raw) {
  const s = String(raw == null ? '' : raw).trim();
  let args;
  if (!s) args = {};
  else {
    try { args = JSON.parse(s); }
    catch (_) {
        return { args: null, error: 'Error: Invalid tool call arguments (not valid JSON).' };
    }
  }
  const def = (tools || []).find(t => t && t.function && t.function.name === name);
  const required = def && def.function.parameters && def.function.parameters.required;
  // null/undefined 都算缺；空串放行（如 write_file content:"" 写空文件合法），
  // 必填串参传空的场景由各工具自己的中文校验兑底（path 空→「路径不能为空」，url 空→「缺少参数 url」…）。
  const missing = required && required.length
    ? required.filter(k => args[k] == null) : [];
  if (missing.length) return { args: null, error: 'Error: ToolCall Missing Params: ' + missing.join('、') };
  return { args, error: null };
}

function toolSchemaOf(tools, name) {
  for (const t of tools || []) if (t && t.function && t.function.name === name) return t.function.parameters || null;
  return null;
}

// 部分弱模型会把工具参数多包一层外层（{"arguments":{...}} 甚至多层/信封形），
// 这里按工具 schema 剥回顶层载荷。返回解包后的对象；无包裹或解析失败返回 null（保留原样）。
function unwrapToolArgs(tools, name, raw) {
  const schema = toolSchemaOf(tools, name);
  let cur = raw;
  let changed = false;
  for (let i = 0; i < 5 && cur != null; i++) {
    if (typeof cur === 'string') {
      try { cur = JSON.parse(cur); changed = true; } catch (_) { return null; }
      continue;
    }
    if (typeof cur !== 'object' || Array.isArray(cur)) return null;
    const keys = Object.keys(cur);
    const hasArgProp = !!(schema && schema.properties && schema.properties.arguments);
    let inner = null;
    // {"arguments": {...}} / {"parameters": {...}}：仅当该键不是工具自身的参数名
    if (!hasArgProp && keys.length === 1 && (keys[0] === 'arguments' || keys[0] === 'parameters')
        && cur[keys[0]] && typeof cur[keys[0]] === 'object') {
      inner = cur[keys[0]];
    }
    // {"function": {...}} 信封
    if (!inner && keys.length === 1 && keys[0] === 'function' && cur.function && typeof cur.function === 'object') inner = cur.function;
    // {"name": "...", "arguments": {...}} 信封
    if (!inner && !hasArgProp && cur.arguments && typeof cur.arguments === 'object') inner = cur.arguments;
    if (!inner) break;
    cur = inner;
    changed = true;
  }
  if (typeof cur === 'string') { try { cur = JSON.parse(cur); changed = true; } catch (_) { return null; } }
  if (!changed || !cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
  return cur;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- 对外 API ----------
function createSession(title, preferModelId, assistantType, user) {
  const id = genTaskId();
  const dir = taskDirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  db.prepare(
    "INSERT INTO sessions (id, title, status, phase, model_id, assistant_type, user, created_at, updated_at) VALUES (?,?,'queued','advising',NULL,?,?,?,?)"
  ).run(id, title || '', assistantType || 'secretary', user || '', now(), now());
  profile.freezeSnapshot(db, id); // 冻结画像快照：仅创建/清空时点注入，会话内恒定（见 user-profile.js）
  // 新会话一律落 advising（顾问模式）：先聊天判意图，任务书 task.md 落地才转 executing（见 enterExecuting）
  // 指定了模型且其平台恰好有空闲 key → 直接绑定，跳过排队；否则回退到 FIFO 队列
  const prefer = preferModelId && platformModels(platformOf(preferModelId)).includes(preferModelId)
    ? freeKeyOf(platformOf(preferModelId))
    : null;
  if (prefer) {
    // 新建时指定模型 = 仅预留（此时还没有任何消息）：先绑成 held 占住 key，
    // 用户发首条消息后再转 active 开跑
    bindModel(getSession(id), prefer, preferModelId, 'held');
    emitStatus(id);
  } else {
    enqueue(id);
    dispatchQueued();
  }
  // 已绑定模型（选中的空闲模型 / 自动派发立即拿到模型）时保持 held，等首条消息再开跑。
  const session = getSession(id);
  return session;
}

// 用户消息入口。
// opts.deepThink: true 时启用模型该「深度思考」参数（记在会话 run 上，正在跑的回合下一轮迭代会取到最新值）。
// 新建会话需在 runLoop 之前先预建 run 以携带该值。
function postUserMessage(sessionId, content, opts) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const messageId = saveMessage(sessionId, { role: 'user', content });
    // 预建/更新 run 记录，记下本轮的 deepThink（被 runLoop / callModel 读取）
    const run = getRun(sessionId, true);
    run.deepThink = !!(opts && opts.deepThink);
    // 真实用户消息到达：若还有个「已排队但尚未开跑」的压缩回合（见 summarizeContext），
    // 让它作废，避免新消息被误当成压缩回合处理；已在跑（looping）的不动，
    // 由其收尾时自行清空 summarizing。
    if (run.summarizing && !run.looping) run.summarizing = null;
  if (session.status === 'active' && run.looping) {
    // 正在跑：下一轮迭代会从 DB 重新加载历史，自动带上这条消息
    return { message_id: messageId, delivered: 'live' };
  }
  if (session.status === 'held') {
    // 保持租约期内：直接复用当前绑定的模型，无需排队
    touch(sessionId, { status: 'active', held_at: null });
    emitStatus(sessionId);
    runLoop(sessionId);
    return { message_id: messageId, delivered: 'live' };
  }
  if (session.status === 'active' && !run.looping) {
    runLoop(sessionId);
    return { message_id: messageId, delivered: 'live' };
  }
  // 排队 / 已完成 / 已取消 → 重新入队；若派发后已立即拿到空闲模型，则算直接送达
  touch(sessionId, { status: 'queued', cancelled_at: null, completed_at: null, held_at: null });
  enqueue(sessionId);
  dispatchQueued();
  const after = getSession(sessionId);
  emitStatus(sessionId);
  return { message_id: messageId, delivered: after && after.status === 'active' ? 'live' : 'queued' };
}

function stop(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const run = runs.get(sessionId);
  if (run) {
    run.cancelled = true;
    killRunProcs(run);
    if (run.abortController) { try { run.abortController.abort(); } catch (_) {} }
  }
  dequeue(sessionId);
  if (session.status === 'active') {
    // run 在循环退出处会 finalize；若无循环在跑则直接收尾
    if (!run || !run.looping) {
      touch(sessionId, { status: 'cancelled', cancelled_at: now(), held_at: null });
      releaseModel(sessionId);
      runs.delete(sessionId);
      bus.emit(sessionId, 'done', { status: 'cancelled' });
    }
  } else {
    touch(sessionId, { status: 'cancelled', cancelled_at: now(), model_id: null, held_at: null, completed_at: null });
    releaseModel(sessionId); // held 会话同时释放模型保持租约
  }
  emitStatus(sessionId);
  dispatchQueued();
  return { ok: true };
}

// 重命名会话：标题必填，最长 100 字。
function renameSession(sessionId, title) {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const t = String(title || '').trim();
  if (!t) throw Object.assign(new Error('名称不能为空'), { status_code: 400 });
  if (t.length > 100) throw Object.assign(new Error('名称不能超过 100 字'), { status_code: 400 });
  touch(sessionId, { title: t });
  log.info('task', sessionId + ' 重命名为「' + t + '」');
  return { ok: true, title: t };
}

function deleteSession(sessionId, deleteDir) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  stop(sessionId);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM files WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM wait_queue WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  autoCompressProposed.delete(sessionId); // 提议闸门随会话销毁
  if (deleteDir) {
    try { fs.rmSync(taskDirOf(sessionId), { recursive: true, force: true }); } catch (_) {}
  }
  bus.closeAll(sessionId);
  return { ok: true };
}

// 上下文压缩：phase-bar「压缩」按钮触发。不再往会话里插入指令消息：
// 压缩回合沿用默认 system prompt + 正常历史消息，末尾追加一条 user
//（templates/compress-prompt.txt 原文，见 llm.compressMessages），且不传 tools
//（见 runLoopInner 的 compressing 分支），模型直接基于历史输出摘要。
// 识别标记 = run.summarizing（仅在内存 run 上，不入库）：runLoopInner 据此换 prompt/去 tools，
// 并在压缩回合的收尾答复 emit 时带 is_summary: true，前端据此把气泡装进摘要卡片并淡出存档旧历史。
// 收尾落库：摘要行标 type='summary'，它之前的全部消息标 type='archived'
//（UI 保留展示、不再发给模型，后续对话从摘要开始）。
// 注意：排队等模型的压缩回合只记在内存 run 上，服务重启会丢（旧版靠库里的指令行存活）；
// 重启后需重新点「压缩」。
// 限制：与 clearSessionMessages 类似——会话执行中(active)禁止操作，避免和正在跑的回合抢上下文。
// 响应回显 prompt：前端「开始压缩后渲染成一条普通用户消息气泡」；只回一句短提示，
// 不回完整模板（压缩指令的真实内容在压缩回合开跑时实时序列化进 system prompt，
// 与气泡无关，气泡仅供展示、不入库也不发给模型）。
function summarizeContext(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const run = runs.get(sessionId);
  if (run && run.looping) {
    throw Object.assign(new Error('任务正在执行，请先「终止」再压缩'), { status_code: 409 });
  }
  const prompt = '正在压缩上下文：AI 将基于完整对话记录生成摘要…';
  // 与 postUserMessage 同样的唤醒/排队流转，但不落任何消息行；
  // run.summarizing 标记本回合为压缩回合，摘要产出后由 runLoopInner 清空。
  // 状态流转时顺带重置 deepThink：压缩回合不需要思考参数，避免沿用上一轮的残留值。
  const r = getRun(sessionId, true);
  r.summarizing = true;
  r.deepThink = false;
  let delivered;
  if (session.status === 'held') {
    // 保持租约期内：直接复用当前绑定的模型，无需排队
    touch(sessionId, { status: 'active', held_at: null });
    emitStatus(sessionId);
    runLoop(sessionId);
    delivered = 'live';
  } else if (session.status === 'active') {
    // 上方已排除 looping；active 空闲时直接开跑
    runLoop(sessionId);
    delivered = 'live';
  } else {
    // 排队 / 已完成 / 已终止 → 重新入队；若派发后已立即拿到空闲模型，则算直接送达
    //（dispatchQueued 会把带 summarizing 的排队会话当作有待处理回合开跑）
    touch(sessionId, { status: 'queued', cancelled_at: null, completed_at: null, held_at: null });
    enqueue(sessionId);
    dispatchQueued();
    const after = getSession(sessionId);
    emitStatus(sessionId);
    delivered = after && after.status === 'active' ? 'live' : 'queued';
  }
  return { prompt, delivered };
}

// 自动压缩确认前的宽限期（ms）：超长回合刚结束时，前端还在收尾渲染（最终消息落 DOM、会话列表刷新等），
// 同一帧立刻弹窗询问会叠加卡顿，且抢先发言/手动压缩/终止都会改状态让提议过期；故满足条件后延迟再推送。
const AUTO_COMPRESS_GRACE_MS = 1500;
// 每会话至多弹一次确认框的闸门：无论用户确认还是取消，本会话都不再反复打扰
//（事件确有 SSE 观看者送达才计数；删会话/重启服务后重置。服务内存态，多实例部署不共享）。
const autoCompressProposed = new Set();

// 回合结束后的自动压缩「提议」检查（由 runLoop finally 调用，即 AI↔工具循环完全停止、finalize 收尾之后）。
// 规则：agent.auto_compress_tokens > 0 且本回合 In token 峰值（run.turnMaxPt，各模型轮 prompt_tokens 最大者）
// ≥ 阈值 → 延迟 AUTO_COMPRESS_GRACE_MS 后发 auto_compress 提议事件；服务端不再自动执行，
// 由前端弹 modal 询问，用户点「立即压缩」后才 POST /summarize 开启与手动「摘要」完全相同的压缩回合。
// 每会话至多提议一次（autoCompressProposed 闸门）：取消/忽略后不再反复弹窗，想压可手动点「压缩」。
// 护栏：压缩回合自身不再检查（防递归）；被终止的回合不触发；仅正常收尾进入 held 后触发；
// 延迟期间用户抢先发言/手动压缩/终止、租约到期释放都会改动 status 或 held_at，回调里校验后放弃推送；
// 无 SSE 观看者时事件静默丢弃且不计数（提议本就是交互式功能，下个超长回合还会再试）。
function maybeAutoCompress(sessionId, run, wasCompressTurn) {
  try {
    if (wasCompressTurn || run.cancelled) return;
    if (autoCompressProposed.has(sessionId)) return; // 本会话已弹过一次，不再提议
    const th = Math.floor(Number((cfg.agent || {}).auto_compress_tokens) || 0);
    const maxPt = run.turnMaxPt || 0;
    if (th <= 0 || maxPt < th) return;
    const s = getSession(sessionId);
    if (!s || s.status !== 'held') return; // 只有正常结束的回合才自动压缩；取消/已释放等状态不动
    const heldAt = s.held_at; // 记下本次进入 held 的时刻，延迟期间任何状态流转都会清掉或刷新它
    const timer = setTimeout(() => {
      try {
        if (run.cancelled) return;
        if (autoCompressProposed.has(sessionId)) return; // 延迟期间其他回合已弹过（双保险）
        const s2 = getSession(sessionId);
        if (!s2 || s2.status !== 'held' || s2.held_at !== heldAt) return; // 宽限期内会话有变动，撤回本次提议
        bus.emit(sessionId, 'auto_compress', { prompt_tokens: maxPt, threshold: th });
        // 确有人在看（事件送达）才消耗本会话唯一一次额度；没人看则下个回合结束仍有机会
        if (bus.clientCount(sessionId) > 0) autoCompressProposed.add(sessionId);
        log.info('msg', sessionId + ' 自动压缩提议已推送（回合 In ' + maxPt + ' ≥ 阈值 ' + th + '），等待用户确认');
      } catch (e) {
        log.warn('msg', sessionId + ' 自动压缩提议推送失败：' + (e && e.message || e));
      }
    }, AUTO_COMPRESS_GRACE_MS);
    if (timer.unref) timer.unref(); // 挂起的宽限定时器不应阻止进程退出
  } catch (e) {
    log.warn('msg', sessionId + ' 自动压缩提议检查失败：' + (e && e.message || e));
  }
}

// 清空会话的对话内容：删除该会话的全部消息记录，但保留会话本身与任务目录文件。
// 状态收尾为 completed（释放模型占用、移出等待队列）；此后再次发言从零开始，
// 不再携带旧历史。执行中的会话不允许清空，需先「终止」。
// 阶段语义：清空是 executing 唯一回头路——回到 advising 重新规划（单会话只解决一个问题），
// 旧任务书 mv 进 .task-history/ 防污染（archiveTaskBrief）；压缩不碰 phase，不在此列。
function clearSessionMessages(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const run = runs.get(sessionId);
  if (run && run.looping) {
    throw Object.assign(new Error('任务正在执行，请先「终止」再清空'), { status_code: 409 });
  }
  if (run) {
    run.cancelled = true;
    killRunProcs(run);
    if (run.abortController) { try { run.abortController.abort(); } catch (_) {} }
  }
  runs.delete(sessionId);
  dequeue(sessionId);
  releaseModel(sessionId);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  archiveTaskBrief(sessionId); // 旧任务书先归档（mv），新一轮 advising 不会被上一问题的约定污染
  autoCompressProposed.delete(sessionId); // 历史清零，恢复自动压缩提议额度
  // 标题随历史一并清零：旧标题描述的是已删除的对话，留着会让新对话文不对题；
  // 新一轮交互结束后 maybeGenerateTitle 见 title 为空会自动重新生成。
  touch(sessionId, { status: 'completed', completed_at: now(), cancelled_at: null, held_at: null, title: null, phase: 'advising' });
  profile.freezeSnapshot(db, sessionId); // 回 advising 重新规划：画像快照随新一轮重新冻结
  bus.emit(sessionId, 'done', { status: 'completed' });
  bus.emit(sessionId, 'title', { title: null }); // 供其他打开同一会话的窗口同步清掉旧标题
  bus.emit(sessionId, 'phase', { phase: 'advising' });
  emitStatus(sessionId);
  dispatchQueued();
  return { ok: true };
}

// 删除单条消息（含工具/任务消息）：消息行直接从库里消失，下次模型请求的历史里就没有它了（buildMessages 只看库）。
// assistant 带 tool_calls 时连带删掉该轮的 tool 回执：只删 assistant 会留下无 tool_call 配对的
// 孤儿 tool 行，上游会拒收整个请求。单删 tool 回执则反向配对：把它在父 assistant 的
// tool_calls 里同步摘除（见 deleteToolMessage），保证「调用↔回执」始终成对。
function deleteMessage(sessionId, messageId) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const row = db.prepare('SELECT * FROM messages WHERE id = ? AND session_id = ?').get(messageId, sessionId);
  if (!row) throw Object.assign(new Error('消息不存在'), { status_code: 404 });
  if (row.role === 'tool') return deleteToolMessage(sessionId, row);
  let removed = 0;
  if (row.tool_calls) {
    let calls = [];
    try { calls = JSON.parse(row.tool_calls) || []; } catch (_) {}
    for (const c of calls) {
      if (!c || !c.id) continue;
      removed += db.prepare("DELETE FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = ?")
        .run(sessionId, c.id).changes;
    }
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
  return { ok: true, id: messageId, removed: removed + 1 };
}

// 删工具回执（任务执行卡片）：同步把对应 tool_call 从父 assistant 的 tool_calls 里摘掉，
// 避免留下「有调用无结果」被严格上游拒收。父回合若是纯工具调用轮（无文本）且已无
// 其余调用，则整行一起删（空气泡没有意义）；有文本则保留为普通文本回复。
// tool_call_id 全局唯一，LIKE 只是初筛，命中后按 JSON 精确确认。
function deleteToolMessage(sessionId, row) {
  db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
  let removed = 1;
  const parents = db.prepare(
    "SELECT id, content, tool_calls FROM messages WHERE session_id = ? AND role = 'assistant' AND tool_calls LIKE ? ORDER BY id DESC"
  ).all(sessionId, '%' + row.tool_call_id + '%');
  for (const p of parents) {
    let calls = [];
    try { calls = JSON.parse(p.tool_calls) || []; } catch (_) { continue; }
    const left = calls.filter(c => c && c.id !== row.tool_call_id);
    if (left.length === calls.length) continue; // LIKE 误中，不是这条
    if (!left.length && !(p.content || '').trim()) {
      db.prepare('DELETE FROM messages WHERE id = ?').run(p.id);
      removed++;
    } else if (!left.length) {
      db.prepare('UPDATE messages SET tool_calls = NULL WHERE id = ?').run(p.id);
    } else {
      db.prepare('UPDATE messages SET tool_calls = ? WHERE id = ?').run(JSON.stringify(left), p.id);
    }
    break; // id 唯一，命中即止
  }
  return { ok: true, id: row.id, removed };
}

function setModelPool(cfg_, db_, bus_) { cfg = cfg_; db = db_; bus = bus_; }

module.exports = {
  setModelPool: setModelPool,
  init: syncModelPool,
  getDb: () => db,
  getBus: () => bus,
  getConfig: () => cfg,
  activeRuns,
  createSession,
  postUserMessage,
  stop,
  releaseHold,
  renameSession,
  deleteSession,
  clearSessionMessages,
  summarizeContext,
  deleteMessage,
  getSession,
  getRun,
  taskDirOf,
  loadHistory,
  saveMessage,
  queuePosition,
  recordModelUsage,
  modelUsageStats,
  dispatchQueued,
  bindToSession,
  TOOL_DEFINITIONS,
  effectiveTools,
};
