// 核心引擎：会话管理、模型池调度（FIFO）、Agent 主循环、任务目录。
// 单进程内存模型：JS 单线程 + better-sqlite3 同步 API，不存在跨进程竞争。
const fs = require('fs');
const path = require('path');
const { buildMessages, callModel, encodeBlocks } = require('./llm');
const { executeTool, resolveInTask } = require('./tools/executor');
const mcp = require('./mcp');
const log = require('./log');

const TOOL_DEFINITIONS = require('./tools/definitions.json');

const START_EXECUTION_MESSAGE =
  '我说完了，你可以开始干活了。先把我上面说的需求整理成 task.md 文件写入任务目录，然后按照 task.md 开始执行。';

// 会话上下文消息标记：动态信息（日期/任务目录/模型显示名）不再拼入 system prompt，
// 而是作为首条 user 消息发给模型，跟着会话走；它不单独触发模型回合。
// 注入时机 = 模型绑定就绪：手动选择模型后立即注入；自动派发则在首次回复前注入，
// 避免未绑定模型时产生“尚未绑定/未知”占位（见 ensureSessionContext）。
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
    'INSERT INTO messages (session_id, role, content, reasoning, tool_calls, tool_call_id, name, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(sessionId, msg.role, msg.content || null, msg.reasoning || null,
    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    msg.tool_call_id || null, msg.name || null, now());
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
    log.info('[msg] ' + sessionId + ' AI 回复：文本 ' + String(msg.content || '').length + ' 字' + toolDesc);
  }
  return info.lastInsertRowid;
  }

// 记录一次模型回合的 token 用量（上游未返回 usage 时跳过）。
// 写入 model_usage 表,不建会话外键：删会话后累计统计仍保留。
function recordModelUsage(sessionId, modelId, usage) {
  if (!modelId || !usage) return;
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  const tt = usage.total_tokens || (pt + ct);
  if (!pt && !ct && !tt) return;
  db.prepare(
    'INSERT INTO model_usage (session_id, model_id, prompt_tokens, completion_tokens, total_tokens, created_at) VALUES (?,?,?,?,?,?)'
  ).run(sessionId, modelId, pt, ct, tt, now());
}

// 每模型 token 用量统计:今日(本地时区自然日起)+ 累计,输入/输出分开。
// 返回 { [model_id]: { today_prompt, today_completion, total_prompt, total_completion } },
// 配置内的模型保证有零值占位。
function modelUsageStats() {
  const d = new Date();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const stats = {};
  const slot = function (id) {
    if (!stats[id]) stats[id] = { today_prompt: 0, today_completion: 0, total_prompt: 0, total_completion: 0 };
    return stats[id];
  };
  for (const m of cfg.models) slot(m.id);
  const sumSql = 'SELECT model_id, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c FROM model_usage';
  for (const r of db.prepare(sumSql + ' WHERE created_at >= ? GROUP BY model_id').all(dayStart)) {
    slot(r.model_id).today_prompt = r.p || 0;
    slot(r.model_id).today_completion = r.c || 0;
  }
  for (const r of db.prepare(sumSql + ' GROUP BY model_id').all()) {
    slot(r.model_id).total_prompt = r.p || 0;
    slot(r.model_id).total_completion = r.c || 0;
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
  const stmt = db.prepare(
    'INSERT INTO model_pool (id, display_name, is_busy, current_session_id) VALUES (?,?,0,NULL) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name'
  );
  // enable:false 的模型不进池：分配/绑定均按池取模型，天然跳过禁用项（与其他模型配置一致，重启生效）。
  const enabled = cfg.models.filter(m => m.enable !== false);
  for (const m of enabled) stmt.run(m.id, m.display_name);
  // 清理配置中已删除/已禁用的模型
  const ids = enabled.map(m => m.id);
  for (const row of db.prepare('SELECT id FROM model_pool').all()) {
    if (!ids.includes(row.id)) db.prepare('DELETE FROM model_pool WHERE id = ?').run(row.id);
  }
  // 进程重启后：释放所有绑定、把 active 会话退回队列；held 会话直接结版（释放）。
  // 禁用模型同样走这里收尾：重启后池里已无它，绑过它的会话被退回队列/结版，后续重新分配启用中的模型。
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

// 会话绑定的模型是否支持 vision（图片回传）；决定 read_file 读图行为（见 tools/executor.js）。
function modelVision(session) {
  const m = session.model_id && (cfg.models || []).find(x => x.id === session.model_id);
  return !!(m && m.vision);
}

function enqueue(sessionId) {
  const exists = db.prepare('SELECT id FROM wait_queue WHERE session_id = ?').get(sessionId);
  if (!exists) db.prepare('INSERT INTO wait_queue (session_id, queued_at) VALUES (?,?)').run(sessionId, now());
}

function dequeue(sessionId) {
  db.prepare('DELETE FROM wait_queue WHERE session_id = ?').run(sessionId);
}

// status:绑定后的会话状态。
// - 'active'(默认)：绑定即开跑(有待回应消息,紧随其后 runLoop);排队派发 dispatchQueued 用。
// - 'held'：仅预留模型占位(手动选模/新建选模,尚无待回应消息),
//   用户发首条消息后由 postUserMessage 的 held 分支转 active 开跑。
function bindModel(session, model, status) {
  const st = status === 'held' ? 'held' : 'active';
  db.prepare('UPDATE model_pool SET is_busy = 1, current_session_id = ? WHERE id = ?').run(session.id, model.id);
  // last_model_id 不随释放清除：会话再次需要模型时优先回绑（见 pickModelFor）
  db.prepare("UPDATE sessions SET status=?, model_id=?, last_model_id=?, held_at=?, updated_at=? WHERE id=?")
    .run(st, model.id, model.id, st === 'held' ? now() : null, now(), session.id);
}

function releaseModel(sessionId) {
  db.prepare('UPDATE model_pool SET is_busy = 0, current_session_id = NULL WHERE current_session_id = ?').run(sessionId);
  db.prepare('UPDATE sessions SET model_id = NULL, updated_at = ? WHERE id = ?').run(now(), sessionId);
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
  const model = db.prepare('SELECT * FROM model_pool WHERE id = ? AND is_busy = 0').get(String(modelId || ''));
  if (!model) throw Object.assign(new Error('模型不存在或正被占用'), { status_code: 409 });
  touch(sessionId, { cancelled_at: null, completed_at: null, held_at: null });
  const pending = hasPendingUser(sessionId);
  bindModel(s, model, pending ? 'active' : 'held');
  emitStatus(sessionId);
  // 手动选好模型后立即注入/刷新会话上下文（换绑时更新为当前模型，避免陈旧信息）
  ensureSessionContext(sessionId);
  log.info('[model] ' + sessionId + ' 手动绑定模型 ' + model.id);
  if (pending) runLoop(sessionId);
  return { ok: true, model_id: model.id };
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

// 为排队会话挑模型：上次用过的模型（last_model_id）恰好空闲则优先回绑；
// 被占用（或从未绑过/已从配置删除）则按 id 序取任意空闲模型。
function pickModelFor(session) {
  if (session.last_model_id) {
    const pref = db.prepare('SELECT * FROM model_pool WHERE id = ? AND is_busy = 0').get(session.last_model_id);
    if (pref) return pref;
  }
  return freeModel();
}

// 有空闲模型就按 FIFO 派发排队会话（每会话优先回绑上次用过的模型）。
function dispatchQueued() {
  for (;;) {
    if (!freeModel()) return;
    const head = db.prepare('SELECT session_id FROM wait_queue ORDER BY queued_at, id').get();
    if (!head) return;
    dequeue(head.session_id);
    const session = getSession(head.session_id);
    if (!session || session.status !== 'queued') continue;
    // 上面已确认有空闲模型，pickModelFor 必能回退到 freeModel；
    // 无待回应消息的会话（如新建后从未发言）只预留不占跑，绑成 held 等首条消息
    const pending = hasPendingUser(session.id);
    bindModel(session, pickModelFor(session), pending ? 'active' : 'held');
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
    log.error('[engine] runLoop ' + sessionId + ' 异常:', err && err.stack || err);
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
  // 能到这里说明模型已绑定：先注入/刷新会话上下文（内容随当前模型与当天日期更新）
  ensureSessionContext(sessionId);
  let iter = 0;
  // 已纳入模型请求的最大消息 id；用于判断是否有尚未被回应的新 user 消息
  // （不能用“最后一条非 tool 消息是 user”判断：流式输出期间到达的消息会排在 assistant 之前而被漏掉）
  let lastIncludedId = 0;
  const maxIter = cfg.agent.max_tool_iterations;
  while (!run.cancelled && iter < maxIter) {
    const session = getSession(sessionId);
    if (!session || session.status !== 'active' || !session.model_id) break;
    session.history = loadHistoryForModel(sessionId);
    for (const m of session.history) if (m.id > lastIncludedId) lastIncludedId = m.id;
    const messages = buildMessages(session, (cfg.agent || {}).language);
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

    // 容错：部分模型把参数多包一层 arguments/function 外层，统一解包后再落库与执行。
    // 写回历史的 tool_calls 也是解包后的干净形状，避免模型模仿自己上一轮的错误样本。
    if (result.tool_calls) {
      for (const tc of result.tool_calls) {
        const fixed = unwrapToolArgs(tools, tc.name, tc.arguments);
        if (fixed) {
          log.info('[tool] ' + sessionId + ' ' + tc.name + ' 参数包裹外层已自动解包');
          tc.arguments = JSON.stringify(fixed);
        }
      }
    }

    // 保存 assistant 消息
    const hasTools = result.tool_calls && result.tool_calls.length > 0;
    const msgRow = {
      role: 'assistant',
      content: result.content || '',
      reasoning: result.reasoning || null,
      tool_calls: hasTools ? result.tool_calls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })) : null,
    };
    const assistantId = saveMessage(sessionId, msgRow);
    recordModelUsage(sessionId, session.model_id, result.usage);
    bus.emit(sessionId, 'assistant_message', { id: assistantId, content: msgRow.content, reasoning: msgRow.reasoning, tool_calls: msgRow.tool_calls });

    if (!hasTools) {
      // 回合结束；但若期间用户又发了新消息（live 投递），继续下一轮而不是收尾
      if (!hasUserSince(sessionId, lastIncludedId)) break;
      continue;
    }

    // 执行工具
    const vision = modelVision(session);
    for (const tc of msgRow.tool_calls) {
      if (run.cancelled) break;
      const id = tc.id || ('call_' + Math.random().toString(36).slice(2, 10));
      log.debug('[tool] ' + sessionId + ' 调用 ' + tc.function.name + ' 参数: ' + String(tc.function.arguments || ''));
      bus.emit(sessionId, 'tool_call', { id, name: tc.function.name, arguments: tc.function.arguments });
      let output;
      let isError = false;
      const args = safeParse(tc.function.arguments) || {};
      // 必填参数校验：解包后仍缺参就直接挡下，绝不把 undefined 交给 shell 执行
      const def = tools.find(t => t && t.function && t.function.name === tc.function.name);
      const required = def && def.function.parameters && def.function.parameters.required;
      const missing = required && required.length
        ? required.filter(k => args[k] === undefined || args[k] === '') : [];
      if (missing.length) {
        // 把正确形状告诉模型，替它纠正包装习惯
        output = 'Error: 缺少必填参数：' + missing.join('、')
          + '。参数需直接按工具 schema 在顶层传递，例如 {"' + missing[0] + '": "..."}，不要再包 arguments/function 外层。';
        isError = true;
      } else {
        try {
          output = await executeTool({ sessionId, taskDir: taskDirOf(sessionId), run, cfg, db, vision },
            tc.function.name, args);
        } catch (err) {
          output = 'Error: ' + (err && err.message || String(err));
          isError = true;
        }
      }
      // 工具可返回 {text, image_data_url}（read_file 读图且模型支持 vision）：
      // 落库时把图片以 image_url 内容块拼进 tool 消息（哨兵 JSON，见 llm.js encodeBlocks），
      // buildMessages 发请求前还原为 OpenAI 内容块数组。
      let outText;
      let imageDataUrl = null;
      if (output && typeof output === 'object' && output.image_data_url) {
        outText = String(output.text || '');
        imageDataUrl = String(output.image_data_url);
      } else {
        outText = String(output == null ? '' : output);
      }
      if (run.cancelled && !isError) outText = (outText ? outText + '\n' : '') + '（用户已终止任务）';
      log.debug('[tool] ' + sessionId + ' ' + tc.function.name + (isError ? ' 失败: ' : ' 完成: ') + outText);
      const toolContent = imageDataUrl
        ? encodeBlocks([
            { type: 'text', text: outText },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ])
        : outText;
      bus.emit(sessionId, 'tool_result', {
        tool_call_id: id, name: tc.function.name, content: outText.slice(0, 20000),
        is_error: isError, image_url: imageDataUrl || undefined,
      });
      saveMessage(sessionId, { role: 'tool', tool_call_id: id, name: tc.function.name, content: toolContent });
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
      onReasoning: delta => bus.emit(sessionId, 'reasoning_delta', { text: delta }),
      // 本轮是否启用深度思考；由 postUserMessage 从消息 POST 参数写进 run
      deepThink: !!run.deepThink,
      // 上游 SSE 调试信号：非 data 行（event:/id:/retry:/注释/未知）逐行 debug，data 坏帧 warn。
      // meta 是时间性调试信息，事件稀少；badData 是真异常，不该静默。
      onMeta: line => log.debug('[sse] ' + sessionId + ' ' + line),
      onBadData: raw => log.warn('[sse] ' + sessionId + ' 坏帧：' + raw.slice(0, 200)),
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
// 会话上下文动态信息：作为首条 user 消息发给模型（同时展示在聊天里），跟会话走；
// 在模型绑定就绪后注入/刷新（ensureSessionContext），不随未绑定会话提前产生。
function sessionContextContent(session) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const model = session.model_id
    ? modelDisplayName(session.model_id)
    : '尚未绑定（排队中，绑定后自动开始处理）';
  // vision 能力随会话上下文告知 AI：支持时 read_file 读图会回传图片内容，不支持时只能拿到文件信息
  const bound = session.model_id && cfg.models.find(m => m.id === session.model_id);
  const visionLine = bound
    ? (bound.vision ? '支持（read_file 读图会返回压缩后的图片内容）' : '不支持（read_file 读图只能拿到文件信息）')
    : '未知';
  return [
    '【会话上下文】由系统自动注入，无需回复本消息',
    '- 当前日期：' + dateStr,
    '- 任务目录：' + taskDirOf(session.id),
    '- 当前模型：' + model,
    '- 图片（vision）：' + visionLine,
  ].join('\n');
}

// 让会话恰好保有一条反映「当前绑定模型/当天日期」的会话上下文消息：
// - 未绑定模型时不注入（避免产生“尚未绑定（排队中…）/未知”这类占位信息）；
// - 已有则就地更新内容（换绑模型或跨天后保持准确，id 与位置不变）；
// - 没有则补一条（存储位置无严格要求：发给模型前统一置顶，见 loadHistoryForModel）。
function ensureSessionContext(sessionId) {
  const s = getSession(sessionId);
  if (!s || !s.model_id) return;
  const content = sessionContextContent(s);
  const rows = loadHistory(sessionId);
  let ctxIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].name === SESSION_CONTEXT_NAME) { ctxIdx = i; break; }
  }
  if (ctxIdx >= 0) {
    const row = rows[ctxIdx];
    if (row.content !== content) {
      db.prepare('UPDATE messages SET content = ?, created_at = ? WHERE id = ?')
        .run(content, now(), row.id);
    }
    return;
  }
  saveMessage(sessionId, { role: 'user', name: SESSION_CONTEXT_NAME, content });
}

// 加载给模型看的历史：会话上下文消息固定放最前（只保留最新一条），
// 避免它落在真实用户消息之后、或残留旧上下文时误导模型。
function loadHistoryForModel(sessionId) {
  const rows = loadHistory(sessionId);
  const ctxRows = rows.filter(r => r.name === SESSION_CONTEXT_NAME);
  if (!ctxRows.length) return rows;
  return [ctxRows[ctxRows.length - 1]]
    .concat(rows.filter(r => r.name !== SESSION_CONTEXT_NAME));
}

function createSession(title, preferModelId, assistantType, user) {
  const id = genTaskId();
  const dir = taskDirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  db.prepare(
    "INSERT INTO sessions (id, title, status, phase, model_id, assistant_type, user, created_at, updated_at) VALUES (?,?,'queued','planning',NULL,?,?,?,?)"
  ).run(id, title || '', assistantType || 'secretary', user || '', now(), now());
  // 指定了模型且它恰好空闲 → 直接绑定，跳过排队；否则回退到 FIFO 队列
  const prefer = preferModelId
    ? db.prepare('SELECT * FROM model_pool WHERE id = ? AND is_busy = 0').get(preferModelId)
    : null;
  if (prefer) {
    // 新建时指定模型 = 仅预留（此时还没有任何消息）：先绑成 held 占住模型，
    // 用户发首条消息后再转 active 开跑
    bindModel(getSession(id), prefer, 'held');
    emitStatus(id);
  } else {
    enqueue(id);
    dispatchQueued();
  }
  // 已绑定模型（选中的空闲模型 / 自动派发立即拿到模型）才注入会话上下文；
  // 仍在排队未绑定时不注入占位消息，等绑定后由 ensureSessionContext 补上。
  const session = getSession(id);
  ensureSessionContext(id);
  return session;
}

// 用户消息（或“开始执行”的模板消息）入口。
// opts.deepThink: true 时启用深度思考；参数会记在会话 run 上，
// 正在跑的回合下一轮迭代会取到最新值。新建会话需在 runLoop 之前先预建 run 以携带该值。
function postUserMessage(sessionId, content, opts) {
  const session = getSession(sessionId);
  if (!session) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const messageId = saveMessage(sessionId, { role: 'user', content });
  if (!session.title) {
    touch(sessionId, { title: content.slice(0, 24) });
  }
  // 预建/更新 run 记录，记下本轮的 deepThink（被 runLoop / callModel 读取）
  const run = getRun(sessionId, true);
  run.deepThink = !!(opts && opts.deepThink);
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

// 重命名会话：标题必填，最长 100 字。
function renameSession(sessionId, title) {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('会话不存在'), { status_code: 404 });
  const t = String(title || '').trim();
  if (!t) throw Object.assign(new Error('名称不能为空'), { status_code: 400 });
  if (t.length > 100) throw Object.assign(new Error('名称不能超过 100 字'), { status_code: 400 });
  touch(sessionId, { title: t });
  log.info('[task] ' + sessionId + ' 重命名为「' + t + '」');
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
  if (deleteDir) {
    try { fs.rmSync(taskDirOf(sessionId), { recursive: true, force: true }); } catch (_) {}
  }
  bus.closeAll(sessionId);
  return { ok: true };
}

// 清空会话的对话内容：删除该会话的全部消息记录，但保留会话本身与任务目录文件。
// 状态收尾为 completed（释放模型占用、移出等待队列）；此后再次发言从零开始，
// 不再携带旧历史。执行中的会话不允许清空，需先「终止」。
// 清空后不自动重建会话上下文：此时通常未绑定模型，预置只会产生“尚未绑定/未知”占位。
// 待用户选择模型（bindToSession）或再次发言并自动绑定模型（runLoop 入口）时，
// 由 ensureSessionContext 注入当时的有效信息。
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
  touch(sessionId, { status: 'completed', completed_at: now(), cancelled_at: null, held_at: null });
  bus.emit(sessionId, 'done', { status: 'completed' });
  emitStatus(sessionId);
  dispatchQueued();
  return { ok: true };
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
  startExecution,
  stop,
  releaseHold,
  renameSession,
  deleteSession,
  clearSessionMessages,
  getSession,
  getRun,
  taskDirOf,
  loadHistory,
  saveMessage,
  queuePosition,
  modelDisplayName,
  recordModelUsage,
  modelUsageStats,
  dispatchQueued,
  bindToSession,
  TOOL_DEFINITIONS,
  START_EXECUTION_MESSAGE,
};
