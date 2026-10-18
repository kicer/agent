// 核心引擎：会话管理、模型池调度（优先级选 key：无排队、无独占）、Agent 主循环、任务目录。
// 单进程内存模型：JS 单线程 + better-sqlite3 同步 API，不存在跨进程竞争。
const fs = require('fs');
const path = require('path');
const { buildMessages, callModel, encodeBlocks, decodeBlocks, compressMessages, titleMessages, setProfilePrompts } = require('./llm');
const { executeTool, resolveInTask } = require('./tools/executor');
const publicFiles = require('./public-files');
const mcp = require('./mcp');
const log = require('./log');
const profile = require('./user-profile');
const memory = require('./memory');

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
    model_id: s.model_id,
  });
}

// ---------- 模型池（启动重建与恢复） ----------
function syncModelPool() {
  registerProfilePrompts(); // profile 自定义 prompt 注册进 llm（文本已随配置加载读入）
  const stmt = db.prepare(
    'INSERT INTO model_pool (id, display_name, is_busy, current_session_id) VALUES (?,?,0,NULL) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name'
  );
  // 池槽位按物理 key 拆分：槽位 id = 「平台#key下标」，key 为共享资源（同平台模型共用，也可多会话同时用，见 chooseKey）。
  // enable:false 的模型不进池：平台下模型全禁用则该平台不建槽位（与其他模型配置一致，重启生效）。
  const seen = new Set();
  for (const m of cfg.models) if (m.enable !== false) seen.add(m.platform + '#' + m.key_index);
  for (const slot of seen) stmt.run(slot, slot.split('#')[0]);
  // 清理配置中已删除/已禁用的平台 key（含旧版按模型拆的槽位行，重启后自动重建）
  for (const row of db.prepare('SELECT id FROM model_pool').all()) {
    if (!seen.has(row.id)) db.prepare('DELETE FROM model_pool WHERE id = ?').run(row.id);
  }
  // 进程重启后：key 非独占，所有会话的绑定保持不动（顶部展示的模型持续可见，直到用户手动断开/换绑）。
  // active（重启后必无回合进程）与遗留 queued 会话统一归位 held；指向已被删除/禁用模型的绑定，
  // 下次发消息时由 ensureBinding 自动改选（优先留原平台），用户无感。
  db.prepare('UPDATE model_pool SET is_busy = 0, current_session_id = NULL').run(); // 旧版独占列清残留（调度已不读）
  db.prepare("UPDATE sessions SET status='held', held_at=COALESCE(held_at, updated_at), updated_at=? WHERE status IN ('active','queued')").run(now());
  startHeldSweeper();
}

// ---------- 会话闲置处理（30min held 归档 + 4h 记忆收口） ----------
// 阶段一 held 自动收口：held 自「key 共享非独占」后不再持有任何资源（旧 model_hold 租约已废弃，见 config.js 注释），
// 只是给用户留着「还能追问」的视觉信号；但长期挂着会显得会话永不收口。超时翻 completed 是零行为影响的纯状态动作：
// 历史与模型绑定都不动，用户再发言走 postUserMessage 的 completed 分支照常原模型续跑。
// 阶段二 记忆收口（长期日记）：从未收口（journaled_at 空）且静默超 memory.wrap_idle_ms（默认 4h）的
// held/completed 会话 → 后台异步 journalFragment 摘要落碎片（fire-and-forget，绝不阻塞消息路径），
// 落地即占坑不再二次收口；顺手归档 held、删 channel_sessions 绑定行——微信下条消息经 ensureSession
// 自然新建工作台（网页无绑定行，DELETE 空操作；用户抢先复活旧会话则不撤台，只丢记忆不再补）。
// 共用护栏：阈值远大于 AUTO_COMPRESS_GRACE_MS，不挤掉自动压缩提议确认窗口；判据只看 status
//（held/completed 定义上不在输出中，抢先发言已把状态翻离）；held_at 为 NULL 的阶段一存量跳过；
// agent.auto_complete_ms / memory.wrap_idle_ms 各自 0 = 关对应阶段；updated_at 门槛越过即永远成立，
// 「不重复收口」全靠 journaled_at 物理标记（防陈年 completed 会话每轮扫描重复烧摘要 LLM）。
// 扫描间隔随两阈值较小者自适应：生产封顶 60s，测试调小阈值即得分钟以下节奏；
// 运行期改阈值不重调间隔，重启生效（阈值每次 tick 重读，支持热关/热改）。
const HOLD_SWEEP_MIN_MS = 1000, HOLD_SWEEP_MAX_MS = 60000;
const WRAP_SWEEP_BATCH = 5; // 收口单轮上限：摘要要发 LLM，服务重启后存量陈年会话分批消化，不成风暴
let holdSweeper = null;
function startHeldSweeper() {
  if (holdSweeper) return; // init 重复调用幂等
  const th = Math.floor(Number((cfg.agent || {}).auto_complete_ms) || 0);
  const wh = Math.floor(Number((cfg.memory || {}).wrap_idle_ms) || 0);
  if (th <= 0 && wh <= 0) return; // 两阶段全关不建定时器
  const step = Math.min(th > 0 ? th : Infinity, wh > 0 ? wh : Infinity);
  const interval = Math.max(HOLD_SWEEP_MIN_MS, Math.min(HOLD_SWEEP_MAX_MS, Math.floor(step / 4)));
  holdSweeper = setInterval(sweepIdleSessions, interval);
  if (holdSweeper.unref) holdSweeper.unref(); // 同 scheduler：常驻轮询不阻止进程退出
}
function sweepIdleSessions() {
  sweepAutoComplete();
  sweepJournalWrap();
}
function sweepAutoComplete() {
  try {
    const ms = Math.floor(Number((cfg.agent || {}).auto_complete_ms) || 0);
    if (ms <= 0) return;
    const rows = db.prepare("SELECT id FROM sessions WHERE status='held' AND held_at IS NOT NULL AND held_at <= ?").all(now() - ms);
    for (const r of rows) {
      touch(r.id, { status: 'completed', completed_at: now(), held_at: null });
      bus.emit(r.id, 'done', { status: 'completed' }); // 与手动 releaseHold 同链路，前端胶囊/列表自然收起
      emitStatus(r.id);
      wrapTitleFallback(r.id); // 翻 completed = 本会话退出 finalize 循环，标题在此兑底补一次
    }
    if (rows.length) log.info('engine', 'held 超时自动收口 ' + rows.length + ' 个会话（阈值 ' + ms + 'ms）');
  } catch (e) {
    log.warn('engine', 'held 收口扫描异常: ' + (e && e.message || e));
  }
}
function sweepJournalWrap() {
  try {
    const ms = Math.floor(Number((cfg.memory || {}).wrap_idle_ms) || 0);
    if (ms <= 0) return;
    const rows = db.prepare(
      "SELECT id FROM sessions WHERE journaled_at IS NULL AND status IN ('held','completed') AND updated_at <= ?"
      + ' ORDER BY updated_at LIMIT ?'
    ).all(now() - ms, WRAP_SWEEP_BATCH);
    for (const r of rows) {
      wrapTitleFallback(r.id); // 收口退位前同样补题（阶段一空转/auto_complete_ms=0 时的兑底；已有题则秒跳）
      // 摘要落地（新增或去重命中）才解绑归档；生成中抢先发言（active）则本次撤台跳过，不打扰用户当下工作台。
      journalFragment(r.id).then(landed => {
        if (!landed) return;
        const s = getSession(r.id);
        if (!s || s.status === 'active') return;
        if (s.status === 'held') { try { releaseHold(r.id); } catch (_) { /* 并发断开/删除，忽略 */ } }
        db.prepare('DELETE FROM channel_sessions WHERE session_id = ?').run(r.id);
        log.info('memory', r.id + ' 空闲收口：碎片已入日记，通道解绑退位（阈值 ' + ms + 'ms）');
      });
    }
  } catch (e) {
    log.warn('memory', '空闲收口扫描异常: ' + (e && e.message || e));
  }
}

// ---------- 模型池调度（优先级选择，无排队、无独占） ----------
// key 是共享资源：同一个 key 可同时服务多个 looping 会话（上游 key 本身支持多并发），
// 调度只是挑「最不 active」的一个：looping 回合数少 → 在用（active/held）会话数少 → 最久未用（轮转摊平）→ id。
// preferPlatform：优先留在原平台（绑定模型失效改选、用户手动选模时用）；
// strict=true 时限定该平台（没有该平台的槽位就返回 null，供手动绑定「就要这个模型」的语义）。
function chooseKey(preferPlatform, strict) {
  const rows = db.prepare('SELECT id, last_used_at FROM model_pool').all();
  if (!rows.length) return null;
  const users = {};   // slot -> 在用会话数（active/held）
  for (const r of db.prepare("SELECT model_slot AS s, COUNT(*) AS c FROM sessions WHERE model_slot IS NOT NULL AND status IN ('active','held') GROUP BY model_slot").all()) users[r.s] = r.c;
  const looping = {}; // slot -> 回合执行中的会话数（内存 runs，库里无此状态）
  for (const [id, run] of runs) {
    if (!run || !run.looping) continue;
    const s = db.prepare('SELECT model_slot FROM sessions WHERE id = ?').get(id);
    if (s && s.model_slot) looping[s.model_slot] = (looping[s.model_slot] || 0) + 1;
  }
  const ranked = rows.slice().sort((a, b) =>
    ((looping[a.id] || 0) - (looping[b.id] || 0)) ||
    ((users[a.id] || 0) - (users[b.id] || 0)) ||
    ((a.last_used_at || 0) - (b.last_used_at || 0)) ||
    (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
  if (preferPlatform) {
    const sub = ranked.filter(r => platformOf(r.id) === preferPlatform);
    if (sub.length) return sub[0];
    if (strict) return null;
  }
  return ranked[0];
}

// 模型 id「平台/模型」或池槽位 id「平台#key下标」→ 平台名。
function platformOf(id) {
  const s = String(id || '');
  const h = s.indexOf('#');
  if (h >= 0) return s.slice(0, h);
  const sl = s.indexOf('/');
  return sl >= 0 ? s.slice(0, sl) : s;
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

// 本轮生效的 profile 名：模型配置默认（cfg.models[].profile）> ''（默认全量，profile-default.txt）。
// 运行期手动切换已全部移除（消息级 profile 参数、sessions.profile 会话绑定均已废弃）；
// 原 advising 阶段强制组合已随顾问模式一并移除。
function resolveProfileName(session) {
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

// ---------- 绑定 ----------
// 写入绑定：会话粘住自己的 key+模型（断开/结版/终止不清，跨重启沿用，追问免选），
// 并刷新槽位 last_used_at（「最久未用先上」的轮转依据）。model_id 同时用于展示/统计。
function applyBinding(sessionId, key, modelId) {
  db.prepare('UPDATE model_pool SET last_used_at = ? WHERE id = ?').run(now(), key.id);
  db.prepare('UPDATE sessions SET model_id=?, model_slot=?, last_model_id=?, updated_at=? WHERE id=?')
    .run(modelId, key.id, modelId, now(), sessionId);
}

// 会话绑定的 key+模型是否仍有效：槽位在池里（配置冷加载，改配置需重启，重启后池已重建）、
// 模型在启用列表里（enable:false / 改名 / 整平台删除都会命中失效）。
function bindingValid(session) {
  if (!session || !session.model_slot || !session.model_id) return false;
  if (!db.prepare('SELECT 1 FROM model_pool WHERE id = ?').get(session.model_slot)) return false;
  return platformModels(platformOf(session.model_slot)).includes(session.model_id);
}

// 开回合前确保有效绑定：配置改动导致原模型失效时自动改选「最不 active」的 key，优先留在原平台
//（chooseModel 同平台还偏好旧模型），对用户透明；池完全为空时报错（配置问题，比静默挂起诚实）。
function ensureBinding(session) {
  if (bindingValid(session)) return;
  const old = session.model_id || session.last_model_id || '';
  const key = chooseKey(platformOf(old), false);
  if (!key) throw Object.assign(new Error('无可用模型：请检查配置并重启服务'), { status_code: 503 });
  const plat = platformOf(key.id);
  const modelId = chooseModel(plat, plat === platformOf(old) ? old : '');
  if (!modelId) throw Object.assign(new Error('无可用模型：请检查配置并重启服务'), { status_code: 503 });
  applyBinding(session.id, key, modelId);
  log.info('model', session.id + ' 原绑定失效（' + (old || '无') + '），自动改选 ' + modelId + '（key ' + key.id + '）');
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

// 手动为会话指定模型（前端弹窗任意可点，已无「占用」概念）：仅回合正在输出时拒绝（换绑语义不明）。
// 模型需在启用配置中且其平台有槽位；已结版/已终止会话换绑后继续（held 待发），
// 若有未回应消息（如终止时留下未回答的提问）则直接 active 并立刻开跑。
function bindToSession(sessionId, modelId) {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const run = runs.get(sessionId);
  if (run && run.looping) throw Object.assign(new Error('会话正在输出，请先终止再切换模型'), { status_code: 409 });
  const want = String(modelId || '');
  const plat = platformOf(want);
  if (!platformModels(plat).includes(want)) throw Object.assign(new Error('模型不存在或已禁用'), { status_code: 409 });
  const key = chooseKey(plat, true);
  if (!key) throw Object.assign(new Error('该平台暂无可用 key（请检查配置并重启）'), { status_code: 409 });
  touch(sessionId, { cancelled_at: null, completed_at: null });
  applyBinding(sessionId, key, want);
  const pending = hasPendingUser(sessionId);
  touch(sessionId, { status: pending ? 'active' : 'held', held_at: pending ? null : now() });
  emitStatus(sessionId);
  log.info('model', sessionId + ' 手动绑定模型 ' + want + '（key ' + key.id + '）');
  if (pending) runLoop(sessionId);
  return { ok: true, model_id: want };
}

// ---------- 断开（held → completed） ----------
// 纯状态动作：key 已无独占与租约，没有任何要「释放」的东西；绑定保持，断开后再发消息仍直接沿用原模型。
// 存在的意义只是把顶部「保持中 · 模型」的状态胶囊收起来（用户确认不再追问）。
function releaseHold(sessionId) {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  if (s.status !== 'held') throw Object.assign(new Error('会话不在保持中'), { status_code: 409 });
  touch(sessionId, { status: 'completed', completed_at: now(), held_at: null });
  bus.emit(sessionId, 'done', { status: 'completed' });
  emitStatus(sessionId);
  return { ok: true };
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
    runs.delete(sessionId);
    bus.emit(sessionId, 'done', { status: 'cancelled' });
    emitStatus(sessionId);
    return;
  }
  // 正常结束：进入 held，绑定保持（key 非独占、无租约，不再自动到期）；用户追问直接复用模型，唯一出口是手动「断开」。
  touch(sessionId, { status: 'held', held_at: now(), completed_at: null, cancelled_at: null });
  runs.delete(sessionId);
  bus.emit(sessionId, 'done', { status: 'held' });
  emitStatus(sessionId);
  maybeGenerateTitle(sessionId, s, run);
  // 定时即下班：本回合创建过定时任务 → done 广播后收口（attachBus 监听已在 done 回调里同步捕获绑定入队投递，
  // 此时删绑定不影响微信本次回复送达）。
  if (run.taskWrap) taskClockOut(sessionId);
}

// 自动生成标题：每回合结束（finalize 成功分支）过门槛才触发，fire-and-forget 不阻塞收尾。
// 门槛（防「你好」开局把题定了）：
// ① 本轮真实执行过工具（run.toolWorked）→ 立题；
// ② 零工具纯聊不加计数器、由历史现推（重启/压缩免疫）：非注入 user 正文行（type IS NULL，
//    天然排掉 [CTX] channel/memory/scheduler 与 task_brief）≥3 条且总字数 ≥30 才立题，
//    连环「嗯」不算有效对话；不满足等下个 finalize 再判。
// 不带 system prompt：历史 user/assistant 原文（注入行不进，白名单见 llm.titleMessages）+
// 末尾一条标题指令 user，用会话当前 model_id 发一次不传 tools 的调用。
// 失败静默（title 仍空，下个回合结束自动重试）；已有标题（建会话时填写或手动重命名）不再覆盖。
// force=true（仅收口兑底 wrapTitleFallback 传）：跳过 n/chars 现推门槛无条件立题——
// 收口是最后一站，没有下个回合了，差一点的标题也比永远无名强；其余守卫（非空即跳/防重入/
// 清空校验）不受 force 影响，finalize 路径不传维持原门槛。
function maybeGenerateTitle(sessionId, s, run, force) {
  try {
    if (s.title) return;
    const modelId = s.model_id;
    if (!modelId || titling.has(sessionId)) return;
    const history = loadHistory(sessionId);
    if (!force && (!run || !run.toolWorked)) {
      let n = 0, chars = 0;
      for (const r of history) {
        if (r.role === 'user' && !r.type) { n++; chars += String(r.content || '').trim().length; }
      }
      if (n < 3 || chars < 30) return;
    }
    titling.add(sessionId);
    const messages = titleMessages(history, cfg.agent.language);
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

// 收口补题（finalize 的兑底）：finalize 是唯一的立题触发点，而纯聊未过门槛、标题 LLM
// 失败（注释里的「下回合重试」）、取消收尾等路径会让会话带着空 title 被空闲扫描收口，
// 此后再无触发点。两个 sweep（翻 completed / 记忆收口退位）各补一次，force 无条件立题：
// 收口是最后一站，没有下个回合，现推门槛（防「你好」抢题）在此不再适用——差标题也比没标题强。
// 非空即跳/防重入/清空校验等守卫仍由 maybeGenerateTitle 自带；fire-and-forget，
// 与碎片摘要并行各发各的 LLM，无先后耦合（journalFragment 不读 title）。
function wrapTitleFallback(sessionId) {
  try {
    const s = getSession(sessionId);
    if (!s || s.title || !s.model_id) return;
    maybeGenerateTitle(sessionId, s, null, true);
  } catch (e) {
    log.warn('task', sessionId + ' 收口补题异常：' + String(e && e.message || e));
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
    // 发送形态摘要（debug）：只打角色/块类型/数量，不打 URL 与内容；定位「图没到模型」时
    // 一眼区分发送侧没拼上图（image 计数为 0）与上游吞图（计数正确但模型说没看到）。
    if (log.isDebugEnabled && log.isDebugEnabled()) {
      log.debug('req', sessionId + ' 发送形态: ' + messages.map(m => {
        if (Array.isArray(m.content)) {
          const imgs = m.content.filter(b => b && b.type === 'image_url').length;
          const unmin = m.content.filter(b => b && b.type === 'image_ref').length;
          const dead = m.content.filter(b => b && b.type === 'text' && String(b.text || '').indexOf('[图片外链不可用') === 0).length;
          return m.role + '(块 ' + m.content.length + (imgs ? ', image ' + imgs : '') + (unmin ? ', 漏签 ' + unmin : '') + (dead ? ', 断链 ' + dead : '') + ')';
        }
        const txt = String(m.content || '');
        return m.role + (m.tool_calls ? '[calls]' : '')
          + (txt.includes('图片数据已省略') ? '[图已省]' : '')
          + (txt.includes('本回合已投递过') ? '[图重复读挡回]' : '');
      }).join(' '));
    }
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
          log.debug('tool', sessionId + ' ' + tc.name + ' 参数包裹外层已自动解包（原形头: ' + String(tc.arguments).slice(0, 120).replace(/\s+/g, ' ') + '）');
          tc.arguments = JSON.stringify(fixed);
        }
        // schedule 兑底（有意识的务实特例）：GLM 系模型习惯把 op 当「操作名的一部分」省略（思考链里写
        // "Use schedule create"）——op 缺失但 create 参数形齐（brief 只属于 create）时推断补全并
        // 写回，让落库/送检/历史回放三处一致；形状有歧义仍走 Missing 报错，绝不猜。
        if (tc.name === 'schedule' && tc.arguments) {
          try {
            const a = JSON.parse(tc.arguments);
            if (a && typeof a === 'object' && a.op == null && a.brief && a.cron_expr && a.prompt) {
              a.op = 'create';
              tc.arguments = JSON.stringify(a);
              log.debug('tool', sessionId + ' schedule 缺 op，按 create 参数形推断补全并写回');
            }
          } catch (_) { /* 非法 JSON 交给预检报错 */ }
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
        if (checkToolArgs(tools, tc.name, tc.arguments).error) {
          isErrAck = true;
          // 落一条现场拍证：解包后仍缺参的原始拼接串头——区分「模型真没写」与「写到哪被弄丢」，日志不再靠猜。
          log.debug('tool', sessionId + ' 参数预检失败 ' + tc.name + '（拼接串头: ' + String(tc.arguments || '').slice(0, 160).replace(/\s+/g, ' ') + '）');
          break;
        }
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
    // 标题门槛信号：本批参数预检通过并真实执行 = 会话在干实事（finalize 据此判是否立题，
    // 见 maybeGenerateTitle）；errAck 批（参数畸形、下轮整轮对模型不可见）不算。
    if (!isErrAck) run.toolWorked = true;
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
          output = await executeTool({ sessionId, taskDir: taskDirOf(sessionId), run, cfg, db, vision,
            onTaskCreated: () => { run.taskWrap = true; } }, // 定时即下班：工具只打标记，收口在 finalize（回合结束后才能解绑归档）

            tc.function.name, chk.args);
        } catch (err) {
          output = 'Error: ' + (err && err.message || String(err));
          isError = true;
        }
      }
      // 工具可返回 {text, image_rel}（read_file 读图且模型支持 vision，压缩产物在 .imgcache/）：
      // 落库时以 image_ref 内容块拼进 tool 消息（哨兵 JSON，见 llm.js encodeBlocks）；
      // buildMessages 发请求前把未消费的图现签成公网外链 image_url 块，并入该批回执之后的
      // 一条 user 消息发送（tool 角色带图非标准形态，上游支持度差）；前端工具卡走带 cookie 的下载路由渲染。
      let outText;
      let imageRel = null;
      if (output && typeof output === 'object' && output.image_rel) {
        outText = String(output.text || '');
        imageRel = String(output.image_rel);
      } else {
        outText = String(output == null ? '' : output);
      }
      if (run.cancelled && !isError) outText = (outText ? outText + '\n' : '') + '（用户已终止任务）';
      // 死循环护栏：同回合内同一张图只投递一次——上游能认多图（探针实测同消息双外链全对），
      // 不再按批次限流；但模型若因惯性叙事反复重读同一文件，每轮都签新图就是纯烧 token，
      // 故已投递过的图再读只回文字提示（run 随回合销毁，新回合自动重置，追问重看不受影响）。
      if (imageRel) {
        if (!run.imgDelivered) run.imgDelivered = new Set();
        if (run.imgDelivered.has(imageRel)) {
          outText += '\n[该图片本回合已投递过，不再重复携带；若你未看到它，请直接告知用户，勿反复重读同一文件]';
          imageRel = null;
        } else {
          run.imgDelivered.add(imageRel);
        }
      }
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
    }
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
  if (missing.length) {
    // 错误回显面向弱模型：点名缺失字段 + 枚举候选值 + 指出必须落在参数顶层（信封形错误现场教学）。
    const props = (def && def.function.parameters && def.function.parameters.properties) || {};
    const hints = missing.map(k => (props[k] && Array.isArray(props[k].enum)) ? k + '（可选值：' + props[k].enum.join('|') + '）' : k);
    return { args: null, error: 'Error: ToolCall Missing Params: ' + hints.join('、') + '。必填参数缺失，请补全后重新调用（参数必须直接放在顶层，不要包在 arguments 等外层里）。' };
  }
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
    // {"name": "...", "arguments": {...}} 信封（arguments 为字符串时先解一层再判）：若顶层除信封键外还有
    // 兄弟键（如模型把 op 落在包裹外），必须合并保留——只剥层不吞键；
    // 曾因吞掉顶层 op 造成「Missing Params: op」无限重试死循环。
    if (!inner && !hasArgProp && cur.arguments != null && !Array.isArray(cur.arguments)) {
      let a = cur.arguments;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = null; } }
      if (a && typeof a === 'object') {
        if (Object.keys(cur).length === 1) inner = a;
        else {
          inner = Object.assign({}, cur);
          delete inner.arguments;
          Object.assign(inner, a);
        }
      }
    }
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
// 新建即绑模（无排队）：指定了优先模型（welcome 预选）就取其平台「最不 active」的 key；
// 模型无效或平台无槽位退回全局优先级选。池完全为空直接报错（配置问题），不建吊儿郎当的会话。
function createSession(title, preferModelId, assistantType, user) {
  const want = String(preferModelId || '');
  let key = null, modelId = '';
  if (want && platformModels(platformOf(want)).includes(want)) {
    key = chooseKey(platformOf(want), true);
    if (key) modelId = want;
    else log.warn('model', '新建会话指定模型 ' + want + ' 的平台暂无可用 key，退回全局选择');
  }
  if (!key) {
    key = chooseKey('', false);
    if (!key) throw Object.assign(new Error('无可用模型：请检查配置并重启服务'), { status_code: 503 });
    modelId = chooseModel(platformOf(key.id), '') || '';
    if (!modelId) throw Object.assign(new Error('无可用模型：请检查配置并重启服务'), { status_code: 503 });
  }
  const id = genTaskId();
  const dir = taskDirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  db.prepare(
    "INSERT INTO sessions (id, title, status, model_id, model_slot, last_model_id, held_at, assistant_type, user, created_at, updated_at) VALUES (?,?,'held',?,?,?,?,?,?,?,?)"
  ).run(id, title || '', modelId, key.id, modelId, now(), assistantType || 'secretary', user || '', now(), now());
  db.prepare('UPDATE model_pool SET last_used_at = ? WHERE id = ?').run(now(), key.id);
  profile.freezeSnapshot(db, id); // 冻结画像快照：仅创建/清空时点注入，会话内恒定（见 user-profile.js）
  // 新建会话默认走模型配置的 profile（未配 = 全量默认组合 + profile-default.txt），不再有顾问阶段
  emitStatus(id);
  const session = getSession(id);
  return session;
}

// 用户消息入口：不再排队——任意非 looping 状态都是「拿模型立即开跑」（delivered 恒 live）；
// 绑定失效（配置改动后原模型被删/禁用）由 ensureBinding 自动改选，用户无感。
// opts.deepThink: true 时启用模型该「深度思考」参数（记在会话 run 上，正在跑的回合下一轮迭代会取到最新值）。
// 新建会话需在 runLoop 之前先预建 run 以携带该值。
function postUserMessage(sessionId, content, opts) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const messageId = saveMessage(sessionId, { role: 'user', content });
  // 预建/更新 run 记录，记下本轮的 deepThink（被 runLoop / callModel 读取）
  const run = getRun(sessionId, true);
  run.deepThink = !!(opts && opts.deepThink);
  // 真实用户消息到达：若还有个「尚未开跑」的压缩回合（见 summarizeContext），
  // 让它作废，避免新消息被误当成压缩回合处理；已在跑（looping）的不动，
  // 由其收尾时自行清空 summarizing。
  if (run.summarizing && !run.looping) run.summarizing = null;
  if (session.status === 'active' && run.looping) {
    // 正在跑：下一轮迭代会从 DB 重新加载历史，自动带上这条消息
    return { message_id: messageId, delivered: 'live' };
  }
  // 其余全部状态（held/active 闲置/completed/cancelled/遗留 queued）：确保有效绑定后直接开跑
  ensureBinding(session);
  touch(sessionId, { status: 'active', held_at: null, completed_at: null, cancelled_at: null });
  emitStatus(sessionId);
  runLoop(sessionId);
  return { message_id: messageId, delivered: 'live' };
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
  if (session.status === 'active') {
    // run 在循环退出处会 finalize；若无循环在跑则直接收尾（绑定保持，追问仍可换绑后继续用原模型）
    if (!run || !run.looping) {
      touch(sessionId, { status: 'cancelled', cancelled_at: now(), held_at: null });
      runs.delete(sessionId);
      bus.emit(sessionId, 'done', { status: 'cancelled' });
    }
  } else {
    touch(sessionId, { status: 'cancelled', cancelled_at: now(), held_at: null, completed_at: null });
  }
  emitStatus(sessionId);
  return { ok: true };
}

// 重命名会话：标题必填，最长 100 字。
function renameSession(sessionId, title) {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const t = String(title || '').trim();
  if (!t) throw Object.assign(new Error('名称不能为空'), { status_code: 400 });
  if (t.length > 100) throw Object.assign(new Error('名称不能超过 100 字'), { status_code: 400 });
  // 手动改名即上锁：显式留痕「标题为用户所起」。自动标题（maybeGenerateTitle）本就见非空即跳，
  // 锁不改现有行为，仅为后续可能覆写标题的逻辑留一道防线。
  touch(sessionId, { title: t, title_locked: 1 });
  log.info('task', sessionId + ' 重命名为「' + t + '」');
  return { ok: true, title: t };
}

function deleteSession(sessionId, deleteDir) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  stop(sessionId);
  // 尽力清理该会话在 officecli 桥里的预览槽位（没配 officecli 则静默；失败只记日志，不阻断删除）
  mcp.notifyTool('officecli', { command: 'unwatch --session ' + String(sessionId).replace(/[^0-9A-Za-z_-]/g, '') }, 5000, { 'X-Session-Dir': taskDirOf(sessionId) });
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM files WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  const frags = memory.dropFragment(db, sessionId); // 日记随会话一并销毁：删掉的会话不该还活在长期记忆里
  if (frags) log.info('task', sessionId + ' 连带删除日记碎片 ' + frags + ' 条');
  autoCompressProposed.delete(sessionId); // 提议闸门随会话销毁
  if (deleteDir) {
    try { fs.rmSync(taskDirOf(sessionId), { recursive: true, force: true }); } catch (_) {}
  }
  bus.closeAll(sessionId);
  return { ok: true };
}

// 上下文压缩：phase-bar「压缩」按钮触发。不再往会话里插入指令消息：
// 压缩回合沿用默认 system prompt + 正常历史消息，末尾追加一条 user
//（templates/prompt-compress.txt 原文，见 llm.compressMessages），且不传 tools
//（见 runLoopInner 的 compressing 分支），模型直接基于历史输出摘要。
// 识别标记 = run.summarizing（仅在内存 run 上，不入库）：runLoopInner 据此换 prompt/去 tools，
// 并在压缩回合的收尾答复 emit 时带 is_summary: true，前端据此把气泡装进摘要卡片并淡出存档旧历史。
// 收尾落库：摘要行标 type='summary'，它之前的全部消息标 type='archived'
//（UI 保留展示、不再发给模型，后续对话从摘要开始）。
// 注意：压缩回合标记（run.summarizing）只在内存，服务重启即丢；旧版靠库里的指令行存活。
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
  // 与 postUserMessage 同样的唤醒语义（不再排队、不落消息行）；run.summarizing 标记本回合为压缩回合，摘要产出后由 runLoopInner 清空。
  // 状态流转时顺带重置 deepThink：压缩回合不需要思考参数，避免沿用上一轮的残留值。
  const r = getRun(sessionId, true);
  r.summarizing = true;
  r.deepThink = false;
  ensureBinding(session);
  touch(sessionId, { status: 'active', held_at: null, completed_at: null, cancelled_at: null });
  emitStatus(sessionId);
  runLoop(sessionId);
  return { prompt, delivered: 'live' };
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
// 延迟期间用户抢先发言/手动压缩/终止、手动断开都会改动 status 或 held_at，回调里校验后放弃推送；
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

// ---------- 长期记忆碎片（日记）：会话收口（下班）时为其生成一条事件碎片 ----------
// 与自动标题同模式：fire-and-forget + 内存防重入；绝不阻塞轮换路径（微信先回信，
// 日记后台慢慢落）。一片一行入 memory_fragments，day=事件日（会话最后活跃日），
// 去重靠 (user, session_id) 主键；渲染/检索全在 memory.js。
// /clear 不记也不留：用户主动清零历史 = 不要这段记忆（已定调），旧碎片随清空一并撕掉（闹钟专柜除外，见 clearSessionMessages）。
// 摘要模型走候选链兜底（用户定调：日记错过即丢，不能死于会话原绑模型这一个单点）：
// 原绑 → 同平台其它 → 配置序其它，最多 3 个；全链失败/无可用模型才记带真实原因的降级占坑。
const journaling = new Set(); // 正在生成碎片的会话（防双发）
// 存档、系统注入与开场日记都不是对话本体——尤其 memory_note：不跳会把上一本日记摘要进新日记，雪球增殖。
const JOURNAL_SKIP_TYPES = new Set(['archived', 'channel_note', 'scheduler_note', 'memory_note']);
const JOURNAL_BUDGET = 24000; // 转录输入字数预算：超长旧会话取首尾、截中段

// 任务目录顶层文件清单已退出摘要输入与降级碎片（评审定稿）：目录里多是临时/中间文件，
// 喂给模型反诱导它把杂物当成果；成果由摘要从对话本身识别，M3 回忆时现查目录即天然存在性判定。

// 转录文本：只留 user/assistant 纯文本行（多模态块拆文本，工具调用/回执/系统注入不进日记），每条截 400 字。
// 不再带「会话标题」元信息：标题无信息量且会把摘要往复述标题的方向带（定稿）。
function journalTranscript(hist) {
  const lines = [];
  for (const row of hist) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    if (JOURNAL_SKIP_TYPES.has(row.type)) continue;
    let content = row.content || '';
    const blocks = decodeBlocks(content);
    if (blocks) content = blocks.map(b => (b && b.type === 'text' ? b.text : '[图片]')).join('\n');
    content = String(content).replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!content) continue;
    lines.push((row.role === 'user' ? '用户' : '我') + ': ' + content);
  }
  let body = lines.join('\n');
  if (body.length > JOURNAL_BUDGET) {
    const half = Math.floor(JOURNAL_BUDGET / 2);
    body = body.slice(0, half) + '\n……(中段省略)……\n' + body.slice(body.length - half);
  }
  return body;
}

function journalMessages(hist) {
  const lang = (cfg.agent && cfg.agent.language) || '';
  const sys = '你是 AI 助理的日记写手：一次工作会话收口（下班）时，把它压缩成第一人称的日记片段'
    + '（这个 AI 记自己帮用户做过什么）。\n规则：\n'
    + '- 只写「发生了什么/交付了什么/有什么悬着没办完」，1~4 行，每行以 "- " 开头，一行一件事；\n'
    + '- 从对话本身识别真正交付的成果并点名（文件名原样）；临时文件与中间产物不算成果，不要提及；\n'
    + '- 不写感想与空泛总结；纯文本，总长不超过 180 字；不要标题、不要解释、不要时间前缀。'
    + (lang ? '\n使用语言：' + lang : '');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: '--- 对话转录 ---\n' + journalTranscript(hist) },
  ];
}

// 清洗模型返回的日记体：剥围栏包裹、限 6 行、每行强制 "- " 头；空返 '' 触发降级。
function cleanJournalText(raw) {
  let t = String(raw || '').replace(/^\s*```[^\n]*\n?/, '').replace(/\n?\s*```\s*$/, '').trim();
  if (!t) return '';
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 6);
  return lines.map(x => '- ' + x.replace(/^-+\s*/, '')).join('\n');
}

// 摘要候选模型链：原绑仍在配置且未禁用 → 首选（日记口吻贴合本会话风格）；
// 其后再取最多 2 个可用模型（同平台优先——避免整链死在同一家抖动的上游上）。
// 会话 model_id 为空/指向已删禁用模型都很常见（换配置、删平台、重启归位），日记不能因此报废。
const JOURNAL_MODEL_TRIES = 3;
function journalCandidateModels(s) {
  const all = (cfg.models || []).filter(m => m.enable !== false);
  const cands = [];
  const bound = s.model_id ? all.find(m => m.id === s.model_id) : null;
  if (bound) cands.push({ id: bound.id, key_slot: s.model_slot || (bound.platform + '#' + bound.key_index) });
  const plat = bound ? bound.platform : '';
  const others = all.filter(m => !cands.some(c => c.id === m.id))
    .sort((a, b) => (a.platform === plat ? 0 : 1) - (b.platform === plat ? 0 : 1));
  for (const m of others) {
    if (cands.length >= JOURNAL_MODEL_TRIES) break;
    cands.push({ id: m.id, key_slot: m.platform + '#' + m.key_index });
  }
  return cands;
}

// 生成并落库一个会话的日记碎片；返回 Promise<boolean>（是否写入）。调用方不需要等它。
function journalFragment(sessionId) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    try {
      if (journaling.has(sessionId)) return done(false);
      const s = getSession(sessionId);
      if (!s || s.journaled_at) return done(false); // 已收口的会话不二次碎片（每会话唯一碎片的入口保证）
      const day = memory.dayString(s.updated_at || now()); // 事件日=会话最后活跃日（C 定稿）：人回忆问哪天干的活，不是哪天补记
      // 无论成败都落一条：降级版写明真实原因（调试页可见）；来源会话 id 是表列，正文零元数据。
      const finish = (body, reason) => {
        journaling.delete(sessionId);
        const r = memory.appendFragment(db, cfg, s.user, s.id, day,
          body || '- 本次工作未能生成摘要（' + (reason || '原因未知') + '），详情可按会话 id 回忆');
        if (r === 'added' || r === 'dupe') memory.markJournaled(db, sessionId, now()); // dupe 也算收口，不重试
        return r === 'added' || r === 'dupe';
      };
      const cands = journalCandidateModels(s);
      if (!cands.length) return done(finish(null, '配置中无可用模型'));
      journaling.add(sessionId);
      const messages = journalMessages(loadHistory(sessionId));
      // 候选逐个试：空回/报错即换下一个，全链失败才降级（单次失败不再杀日记）。
      const attempt = i => {
        const pick = cands[i];
        return callModel(cfg, pick.id, messages, null, { key_slot: pick.key_slot })
          .then(r => {
            const body = cleanJournalText(r && r.content);
            if (body) return body;
            throw new Error('空回复');
          })
          .catch(e => {
            log.warn('memory', sessionId + ' 日记摘要失败(' + pick.id + '): ' + (e && e.message || e));
            return i + 1 < cands.length ? attempt(i + 1) : null;
          });
      };
      attempt(0)
        .then(body => done(finish(body, body ? null : '候选模型均调用失败')))
        .catch(e => {
          log.warn('memory', sessionId + ' 日记摘要链异常: ' + (e && e.message || e));
          done(finish(null, '摘要过程异常'));
        });
    } catch (e) {
      journaling.delete(sessionId);
      log.warn('memory', sessionId + ' 日记碎片异常: ' + (e && e.message || e));
      done(false);
    }
  });
}

// 定时即下班（定稿）：创建定时任务 = 本工作台会话收口，碎片用任务 brief 纯模板，零 LLM。
// 由 finalize 在回合 done 广播后调用（时序安全：attachBus 监听在 done 回调里已同步捕获绑定并入队投递，
// 删 channel_sessions 不影响本次微信回复；投递只依赖 wechat_bindings 表）。
// 收口三件套：碎片按事件日入表（一片一行，本会话从此退出 4h 空闲流程；任务执行痕迹不落日记，
// 用户拿「任务是什么 + 成果文件」即可回溯全貌）+ 顺手归档 + 解绑退位。
// 回合内任务又被删的边缘：查无任务即放弃，退回 4h 空闲轨道。
function taskClockOut(sessionId) {
  try {
    const s = getSession(sessionId);
    if (!s || s.journaled_at) return; // 空闲收口抢先落地过，不重复
    const t = db.prepare('SELECT cron_expr, prompt, brief FROM scheduled_tasks WHERE session_id = ?').get(sessionId);
    if (!t) return;
    const what = String(t.brief || t.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const r = memory.appendFragment(db, cfg, s.user, s.id, memory.dayString(s.updated_at || now()),
      '- 用户让我设了个闹钟：' + what + '（频率 ' + t.cron_expr + '）');
    if (r === 'added' || r === 'dupe') memory.markJournaled(db, sessionId, now());
    if (s.status === 'held') { try { releaseHold(sessionId); } catch (_) { /* 并发归档 */ } }
    const un = db.prepare('DELETE FROM channel_sessions WHERE session_id = ?').run(sessionId);
    log.info('memory', sessionId + ' 定时即下班：闹钟碎片入日记' + (un.changes ? '，通道解绑退位' : ''));
  } catch (e) {
    log.warn('memory', sessionId + ' 定时收口异常: ' + (e && e.message || e));
  }
}

// 会话级 /tmp 的宿主机实体：<任务目录>/.tmp（executor wrapper 把它 bind 进容器 /tmp，HOME/TMPDIR 也指这里，
// 跨 /exec 保留）。清空对话时一并抹掉：临时产物不该带进新一轮；删了下次执行 executor 懒重建，无副作用。
// 尽力而为：不存在不动；符号链接只断不跟进；失败只记日志不阻断清空。
function wipeSessionTmp(sessionId) {
  try {
    const dir = path.join(taskDirOf(sessionId), '.tmp');
    let st;
    try { st = fs.lstatSync(dir); } catch (_) { return; } // 不存在 = 无可清理
    if (st.isSymbolicLink()) { fs.unlinkSync(dir); return; }
    fs.rmSync(dir, { recursive: st.isDirectory(), force: true });
  } catch (e) {
    log.warn('msg', sessionId + ' 清理会话 .tmp 失败（不影响清空）：' + (e && e.message || e));
  }
}

// 清空会话的对话内容：删除该会话的全部消息记录，但保留会话本身与任务目录文件（绑定也保持，下次发言沿用原模型）；
// 会话级 /tmp（宿主机即 <任务目录>/.tmp，执行容器 bind 成容器内 /tmp）一并清空：清空的语义是“从零开始”，
// 上一轮留下的临时产物不该带进新一轮；执行容器遇到不存在的 .tmp 会懒重建，无副作用。
// 状态收尾为 completed；此后再次发言从零开始，不再携带旧历史。执行中的会话不允许清空，需先「终止」。
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
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  wipeSessionTmp(sessionId);   // 会话级 /tmp 随清空一并抹掉（尽力而为，失败只记日志不阻断）
  autoCompressProposed.delete(sessionId); // 历史清零，恢复自动压缩提议额度
  // 标题随历史一并清零：旧标题描述的是已删除的对话，留着会让新对话文不对题；
  // 新一轮交互结束后 maybeGenerateTitle 见 title 为空会自动重新生成。
  // journaled_at 清零：清空 = 这单作业被撕掉，旧碎片随对话作废，新一轮将来可再收口。
  // 旧碎片要物理删除而非只清标记：(user, session_id) 主键 + INSERT OR IGNORE 下旧碎片会拦住新一轮
  // 收口（dupe 即占坑），日记里永远留的是那段已被抹掉的对话。
  // 例外：闹钟专柜（本会话仍挂定时任务）——/clear 不取消任务，它的 brief 碎片是「我有这个周期活」
  // 的唯一记录，撕不得；同时保持 journaled_at 占坑，免得空转录白烧一次摘要 LLM（结果仍是 dupe）。
  const isTaskHome = !!db.prepare('SELECT 1 FROM scheduled_tasks WHERE session_id = ?').get(sessionId);
  if (!isTaskHome) {
    const frags = memory.dropFragment(db, sessionId);
    if (frags) log.info('task', sessionId + ' 清空连带删除日记碎片 ' + frags + ' 条');
  }
  const reset = { status: 'completed', completed_at: now(), cancelled_at: null, held_at: null,
    title: null, title_locked: 0, journaled_at: null };
  if (isTaskHome) delete reset.journaled_at; // touch 会把 undefined 写成 NULL，这里直接不送这个键
  touch(sessionId, reset);
  profile.freezeSnapshot(db, sessionId); // 新一轮开始：画像快照随新一轮重新冻结
  bus.emit(sessionId, 'done', { status: 'completed' });
  bus.emit(sessionId, 'title', { title: null }); // 供其他打开同一会话的窗口同步清掉旧标题
  emitStatus(sessionId);
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
  checkToolArgs, // 参数预检/信封解包两个纯函数：导出供探针与回归验证（运行链路由 runLoopInner 内部调用）
  unwrapToolArgs,
  saveMessage,
  recordModelUsage,
  modelUsageStats,
  bindToSession,
  journalFragment,
  TOOL_DEFINITIONS,
  effectiveTools,
};
