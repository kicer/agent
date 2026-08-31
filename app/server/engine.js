// 核心引擎：会话管理、模型池调度（FIFO）、Agent 主循环、任务目录。
// 单进程内存模型：JS 单线程 + better-sqlite3 同步 API，不存在跨进程竞争。
const fs = require('fs');
const path = require('path');
const { buildMessages, callModel } = require('./llm');
const { executeTool, resolveInTask } = require('./tools/executor');
const mcp = require('./mcp');

const TOOL_DEFINITIONS = require('./tools/definitions.json');

const START_EXECUTION_MESSAGE =
  '我说完了，你可以开始干活了。先把我上面说的需求整理成 task.md 文件写入任务目录，然后按照 task.md 开始执行。';

// 会话上下文消息标记：动态信息（日期/任务目录/模型显示名）不再拼入 system prompt，
// 而是建会话时作为首条 user 消息自动发送，跟着会话走；它不单独触发模型回合。
const SESSION_CONTEXT_NAME = 'session_context';

let cfg, db, bus;
const runs = new Map(); // session_id -> {cancelled, procs:Set, abortController, looping:boolean}

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
    'INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(sessionId, msg.role, msg.content || null,
    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    msg.tool_call_id || null, msg.name || null, now());
  return info.lastInsertRowid;
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
  const stmt = db.prepare(
    'INSERT INTO model_pool (id, display_name, is_busy, current_session_id) VALUES (?,?,0,NULL) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name'
  );
  for (const m of cfg.models) stmt.run(m.id, m.display_name);
  // 清理配置中已删除的模型
  const ids = cfg.models.map(m => m.id);
  for (const row of db.prepare('SELECT id FROM model_pool').all()) {
    if (!ids.includes(row.id)) db.prepare('DELETE FROM model_pool WHERE id = ?').run(row.id);
  }
  // 进程重启后：释放所有绑定、把 active 会话退回队列；held 会话直接结版（释放）
  db.prepare('UPDATE model_pool SET is_busy = 0, current_session_id = NULL').run();
  db.prepare("UPDATE sessions SET status='completed', completed_at=?, held_at=NULL, model_id=NULL WHERE status='held'").run(now());
  for (const s of db.prepare("SELECT id FROM sessions WHERE status = 'active'").all()) {
    db.prepare("UPDATE sessions SET status='queued', model_id=NULL, updated_at=? WHERE id=?").run(now(), s.id);
    enqueue(s.id);
  }
  // 兑底：queued 会话必须在队列中
  for (const s of db.prepare("SELECT id FROM sessions WHERE status='queued'").all()) enqueue(s.id);
  startHoldSweeper();
}

function freeModel() {
  return db.prepare('SELECT * FROM model_pool WHERE is_busy = 0 ORDER BY id').get();
}

function modelDisplayName(modelId) {
  const row = db.prepare('SELECT display_name FROM model_pool WHERE id = ?').get(modelId);
  return row ? row.display_name : modelId;
}

function enqueue(sessionId) {
  const exists = db.prepare('SELECT id FROM wait_queue WHERE session_id = ?').get(sessionId);
  if (!exists) db.prepare('INSERT INTO wait_queue (session_id, queued_at) VALUES (?,?)').run(sessionId, now());
}

function dequeue(sessionId) {
  db.prepare('DELETE FROM wait_queue WHERE session_id = ?').run(sessionId);
}

function bindModel(session, model) {
  db.prepare('UPDATE model_pool SET is_busy = 1, current_session_id = ? WHERE id = ?').run(session.id, model.id);
  db.prepare("UPDATE sessions SET status='active', model_id=?, updated_at=? WHERE id=?").run(model.id, now(), session.id);
}

function releaseModel(sessionId) {
  db.prepare('UPDATE model_pool SET is_busy = 0, current_session_id = NULL WHERE current_session_id = ?').run(sessionId);
  db.prepare('UPDATE sessions SET model_id = NULL, updated_at = ? WHERE id = ?').run(now(), sessionId);
}

// 是否还有待回应的新用户消息（最后一条非 tool 消息是 user）。
// 会话上下文消息（role=user 但带 SESSION_CONTEXT_NAME 标记）不算待回应消息。
function hasPendingUser(sessionId) {
  const rows = loadHistory(sessionId);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'tool' || rows[i].name === SESSION_CONTEXT_NAME) continue;
    return rows[i].role === 'user';
  }
  return false;
}

// 有空闲模型就按 FIFO 派发排队会话。
function dispatchQueued() {
  for (;;) {
    const model = freeModel();
    if (!model) return;
    const head = db.prepare('SELECT session_id FROM wait_queue ORDER BY queued_at, id').get();
    if (!head) return;
    dequeue(head.session_id);
    const session = getSession(head.session_id);
    if (!session) continue;
    if (session.status !== 'queued') continue;
    bindModel(session, model);
    emitStatus(session.id);
    if (hasPendingUser(session.id)) runLoop(session.id);
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

function killRunProcs(run) {
  for (const proc of run.procs) {
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
  try {
    await runLoopInner(sessionId, run);
  } catch (err) {
    console.error('[engine] runLoop ' + sessionId + ' 异常:', err && err.stack || err);
    bus.emit(sessionId, 'error', { message: String(err && err.message || err) });
  } finally {
    run.looping = false;
    finalize(sessionId, run);
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
    const messages = buildMessages(session);
    // 内置工具 + 启动时发现的 MCP 工具，一起随 system prompt 发给模型
    const tools = TOOL_DEFINITIONS.concat(mcp.toolDefinitions());

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
      saveMessage(sessionId, { role: 'assistant', content: text });
      bus.emit(sessionId, 'assistant_message', { content: text, error: true });
      break;
    }

    // 保存 assistant 消息
    const hasTools = result.tool_calls && result.tool_calls.length > 0;
    const msgRow = {
      role: 'assistant',
      content: result.content || '',
      tool_calls: hasTools ? result.tool_calls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })) : null,
    };
    const assistantId = saveMessage(sessionId, msgRow);
    bus.emit(sessionId, 'assistant_message', { id: assistantId, content: msgRow.content, tool_calls: msgRow.tool_calls });

    if (!hasTools) {
      // 回合结束；但若期间用户又发了新消息（live 投递），继续下一轮而不是收尾
      if (!hasUserSince(sessionId, lastIncludedId)) break;
      continue;
    }

    // 执行工具
    for (const tc of msgRow.tool_calls) {
      if (run.cancelled) break;
      const id = tc.id || ('call_' + Math.random().toString(36).slice(2, 10));
      bus.emit(sessionId, 'tool_call', { id, name: tc.function.name, arguments: tc.function.arguments });
      let output;
      let isError = false;
      try {
        output = await executeTool({ sessionId, taskDir: taskDirOf(sessionId), run, cfg, db },
          tc.function.name, safeParse(tc.function.arguments));
      } catch (err) {
        output = 'Error: ' + (err && err.message || String(err));
        isError = true;
      }
      if (run.cancelled && !isError) output = (output ? output + '\n' : '') + '（用户已终止任务）';
      bus.emit(sessionId, 'tool_result', { tool_call_id: id, name: tc.function.name, content: output.slice(0, 20000), is_error: isError });
      saveMessage(sessionId, { role: 'tool', tool_call_id: id, name: tc.function.name, content: output });
    }
    iter++;
  }
  if (iter >= maxIter && !run.cancelled) {
    const text = '⚠️ 已达到最大工具迭代次数（' + maxIter + '），自动停止。可继续输入让我接着干。';
    saveMessage(sessionId, { role: 'assistant', content: text });
    bus.emit(sessionId, 'assistant_message', { content: text });
  }
}

// 流式接收 assistant 输出并转发 SSE。返回 callModel 结果。
async function streamAssistant(sessionId, run, session, messages, tools) {
  run.abortController = new AbortController();
  try {
    return await callModel(cfg, session.model_id, messages, tools, {
      signal: run.abortController.signal,
      shouldCancel: () => run.cancelled,
      onText: delta => bus.emit(sessionId, 'assistant_delta', { text: delta }),
    });
  } finally {
    run.abortController = null;
  }
}

function hasUserSince(sessionId, sinceId) {
  const r = db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user' AND id > ? AND (name IS NULL OR name <> ?)"
  ).get(sessionId, sinceId, SESSION_CONTEXT_NAME);
  return r.c > 0;
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (_) { return {}; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- 对外 API ----------
// 建会话时的动态信息：作为首条 user 消息发给模型（同时展示在聊天里），跟会话走。
function sessionContextContent(session) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  const model = session.model_id
    ? modelDisplayName(session.model_id)
    : '尚未绑定（排队中，绑定后自动开始处理）';
  return [
    '【会话上下文】以下信息由系统自动注入，无需回复本条消息。',
    '- 当前日期：' + dateStr + '（UTC）',
    '- 任务目录：' + taskDirOf(session.id) + '（本会话的文件与终端操作都在此目录内）',
    '- 当前模型：' + model,
  ].join('\n');
}

function createSession(title) {
  const id = genTaskId();
  const dir = taskDirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  db.prepare(
    "INSERT INTO sessions (id, title, status, phase, model_id, created_at, updated_at) VALUES (?,?,'queued','planning',NULL,?,?)"
  ).run(id, title || '', now(), now());
  enqueue(id);
  dispatchQueued();
  // 放在 dispatchQueued 之后：若能立即绑到空闲模型，上下文里就能带上模型显示名。
  const session = getSession(id);
  saveMessage(id, { role: 'user', name: SESSION_CONTEXT_NAME, content: sessionContextContent(session) });
  return session;
}

// 用户消息（或“开始执行”的模板消息）入口。
function postUserMessage(sessionId, content, opts) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const messageId = saveMessage(sessionId, { role: 'user', content });
  if (!session.title) {
    touch(sessionId, { title: content.slice(0, 24) });
  }
  const run = runs.get(sessionId);
  if (session.status === 'active' && run && run.looping) {
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
  if (session.status === 'active' && (!run || !run.looping)) {
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

function startExecution(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  touch(sessionId, { phase: 'execution' });
  const ret = postUserMessage(sessionId, START_EXECUTION_MESSAGE);
  bus.emit(sessionId, 'phase', { phase: 'execution' });
  return ret;
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

function deleteSession(sessionId, deleteDir) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  stop(sessionId);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM files WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM wait_queue WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  if (deleteDir) {
    try { fs.rmSync(taskDirOf(sessionId), { recursive: true, force: true }); } catch (_) {}
  }
  bus.closeAll(sessionId);
  return { ok: true };
}

function setModelPool(cfg_, db_, bus_) { cfg = cfg_; db = db_; bus = bus_; }

module.exports = {
  setModelPool: setModelPool,
  init: syncModelPool,
  getDb: () => db,
  getBus: () => bus,
  getConfig: () => cfg,
  createSession,
  postUserMessage,
  startExecution,
  stop,
  deleteSession,
  getSession,
  getRun,
  taskDirOf,
  loadHistory,
  saveMessage,
  queuePosition,
  modelDisplayName,
  dispatchQueued,
  TOOL_DEFINITIONS,
  START_EXECUTION_MESSAGE,
};
