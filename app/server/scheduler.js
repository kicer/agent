// 定时任务调度器：AI 通过 schedule 工具为所在会话创建一个周期性任务
// （scheduled_tasks 表，生命周期绑定会话，CASCADE 随删），本模块常驻轮询到期任务：
// 先把会话历史整体存档（type='archived'，llm.buildMessages 会跳过 → AI 只看到本次
// prompt，等价全新会话），再经 engine.postUserMessage 投递任务 prompt 自动开跑，
// 结果留在会话里供用户次日查看。
// 形态：模块级 timer + setInterval + unref（同旧版 engine 的 holdSweeper，该定时器已随
// 「key 不独占不排队」改造删除），单次异常只记日志，绝不中断定时器。
// 启动时序：在 engine.init() 之后调 start(engine)（见 server.js）——init 先把会话状态归位，
// 首轮 tick 才不会看到脏状态。
// 依赖注入 engine 而非 require('./engine')：engine→executor→scheduler 已有引用链，
// 顶层反向 require 会成环拿到半成品 exports。
const { CronExpressionParser } = require('cron-parser'); // 锁定 v5.10.1：API 是 CronExpressionParser.parse（v4 的 parseExpression 已不存在）
const log = require('./log');

const TZ = 'Asia/Shanghai';            // 与容器 TZ（docker-compose）一致；显式传入，不依赖进程隐式时区
const TICK_MS = 30000;                 // 轮询周期：相对 1h 最小间隔足够密，无调优需求，不进 config.yml
const MIN_INTERVAL_MS = 3600000;       // cron 最小间隔 1 小时：防 AI 排出分钟级任务反复烧模型池
const PROMPT_MAX_LEN = 20000;          // prompt 长度上限，与 routes/sessions.js PATCH 口径一致

let eng = null;   // engine 引用（start 注入）
let notify = null; // 完成通知投递面（server.js 注入 wechat.notifyTask；缺位则跳过通知）
let timer = null;

function fmtTime(t) {
  return new Date(t).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
}

// ISO 带时区偏移串（schedule 工具回执用）：上海无夏令时，固定 +08:00 安全；
// formatToParts 逐件拼接，不依赖 ICU 区域格式串形状；h23 保证零点为 00:00:00 而非 24 点。
function fmtIso(t) {
  if (!t) return '';
  const p = {};
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
  for (const { type, value } of parts) p[type] = value;
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + '+08:00';
}

// 下次到期时间。一律以当前时刻为基准（而非上次 next_run_at）：
// 服务器停机跨过若干触发点后重启，算出的自然是「未来最近一次」，天然跳过补跑。
function computeNext(cronExpr) {
  return CronExpressionParser.parse(cronExpr, { tz: TZ }).next().getTime();
}

// ---------- schedule 工具实现（tools/executor.js 调） ----------
// cron 校验：可解析 + 连续两次 next() 间隔 ≥ 1h（防分钟级任务反复烧模型池）；
// 返回下次到期时间（以 now 为基准）。创建（createTask）与会话详情弹窗改频次（PATCH /:id/schedule）共用。
// 失败抛中文 Error：工具路径由 engine 转 'Error: ...' 回给 AI，HTTP 路径由 wrap 转 4xx/500 给前端 toast。
function validateCron(cronExpr) {
  let first;
  let second;
  try {
    const it = CronExpressionParser.parse(cronExpr, { tz: TZ });
    first = it.next().getTime();
    second = it.next().getTime();
  } catch (e) {
    throw new Error('cron 表达式无效: ' + cronExpr + ' → ' + (e && e.message || e));
  }
  if (second - first < MIN_INTERVAL_MS) throw new Error('定时任务间隔不能小于 1 小时：' + cronExpr + ' 相邻两次触发不足 1h');
  return first;
}

// sessionId 由调用方从工具 ctx 取（AI 无法指定别的会话）。校验顺序：
// validateCron → 本会话尚无任务 → INSERT（主键冲突兜底）。
function createTask(db, sessionId, cronExpr, prompt, brief, script, notifyChannel) {
  if (prompt.length > PROMPT_MAX_LEN) throw new Error('prompt 过长（上限 ' + PROMPT_MAX_LEN + ' 字符）');
  const first = validateCron(cronExpr);
  const exist = db.prepare('SELECT cron_expr FROM scheduled_tasks WHERE session_id = ?').get(sessionId);
  if (exist) throw new Error('本会话已有定时任务（' + exist.cron_expr + '）。改频次或提示词用 op=update；确要换新任务先 op=delete 再 op=create');
  try {
    db.prepare(
      'INSERT INTO scheduled_tasks (session_id, cron_expr, prompt, brief, script, notify_channel, next_run_at, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(sessionId, cronExpr, prompt, String(brief || '').slice(0, 40), String(script || '').replace(/\s+/g, ' ').trim().slice(0, 80), String(notifyChannel || ''), first, Date.now());
  } catch (_) {
    // 单进程同步 API 下正常到不了这里（上一步已查重），仅作主键约束重复报错的兜底
    const ex = db.prepare('SELECT cron_expr FROM scheduled_tasks WHERE session_id = ?').get(sessionId);
    throw new Error('本会话已有定时任务（' + (ex ? ex.cron_expr : cronExpr) + '）。改频次或提示词用 op=update；确要换新任务先 op=delete 再 op=create');
  }
  log.info('scheduler', sessionId + ' 创建定时任务 ' + cronExpr);
  return { cron_expr: cronExpr, next_run_at: first, next_text: fmtTime(first) };
}

// ---------- 工具侧 get/update/delete（tools/executor.js 调） ----------
// 表主键 session_id → 每会话至多一条，资源即「本会话的任务」，无 id 参数。
// 语义与 routes/sessions.js 的 PATCH/DELETE 对齐，但不落 scheduler_note：
// AI 路径的返回文本本身已进会话记录，不再重复留痕。update 允许只改其一，
// 仅当改了 cron 才重算 next_run_at。不校验 running 状态（update 天然安全，
// delete 也不打断正在跑的回合）。

// 跨会话全览（schedule op=list 的数据源）：join sessions 带出标题，
// 读清单的人据此找到任务住在哪个会话再切过去操作；改删仍绑定各自会话（生命周期不拆）。
function listUserTasks(db, user) {
  return db.prepare(
    'SELECT t.session_id, t.cron_expr, t.brief, t.prompt, t.next_run_at, t.last_run_at, t.last_status, t.last_note, s.title'
    + ' FROM scheduled_tasks t JOIN sessions s ON s.id = t.session_id WHERE s.user = ? ORDER BY t.next_run_at ASC'
  ).all(String(user || ''));
}

function getTask(db, sessionId) {
  return db.prepare(
    'SELECT cron_expr, prompt, brief, script, next_run_at, last_run_at, last_status, last_note FROM scheduled_tasks WHERE session_id = ?'
  ).get(sessionId) || null;
}

function updateTask(db, sessionId, patch) {
  const row = db.prepare('SELECT cron_expr, next_run_at FROM scheduled_tasks WHERE session_id = ?').get(sessionId);
  if (!row) throw new Error('该会话没有定时任务，要建用 op=create（只落当前会话）');
  let cron = row.cron_expr;
  let next = row.next_run_at;
  if (patch.cronExpr && patch.cronExpr !== row.cron_expr) {
    next = validateCron(patch.cronExpr);
    cron = patch.cronExpr;
  }
  const prompt = patch.prompt != null ? String(patch.prompt) : null;
  if (prompt !== null && prompt.length > PROMPT_MAX_LEN) throw new Error('prompt 过长（上限 ' + PROMPT_MAX_LEN + ' 字符）');
  db.prepare('UPDATE scheduled_tasks SET prompt = COALESCE(?, prompt), cron_expr = ?, next_run_at = ? WHERE session_id = ?')
    .run(prompt, cron, next, sessionId);
  log.info('scheduler', sessionId + ' 定时任务改为 ' + cron + '（原 ' + row.cron_expr + '）');
  return { cron_expr: cron, next_run_at: next, next_text: fmtTime(next) };
}

function deleteTask(db, sessionId) {
  const row = db.prepare('SELECT cron_expr FROM scheduled_tasks WHERE session_id = ?').get(sessionId);
  if (!row) throw new Error('该会话没有定时任务，无需 op=delete');
  db.prepare('DELETE FROM scheduled_tasks WHERE session_id = ?').run(sessionId);
  log.info('scheduler', sessionId + ' 删除定时任务 ' + row.cron_expr);
  return row.cron_expr;
}

// ---------- 投递 ----------
// 触发前把会话全部消息标为 archived：buildMessages 遇 type='archived' 直接跳过（llm.js），
// UI 照常展示全量（历次执行记录用户仍可见），AI 侧等价全新会话。
// 本库没有 session_context 这类 type 为空的常驻行，无需排除项；
// 旧摘要行（type='summary'）一并存档——跳过即回到零上下文，行为正确。
function archiveHistory(db, sessionId) {
  db.prepare("UPDATE messages SET type='archived' WHERE session_id = ?").run(sessionId);
}

// 投递 + 复活一体：postUserMessage 已按会话当时状态全量流转，无需单独复活步骤——
// 新调度下不再有排队：任意非 looping 态（held/completed/cancelled）都直接拿模型开跑（恒 delivered:'live'）；
// 绑定模型已被配置改动失效时由 ensureBinding 自动改选（优先留原平台）；
// 仅模型池整体为空会抛错（tick 捕获后标 last_status=error，不阻塞其它任务）。
function deliver(sessionId, prompt) {
  return eng.postUserMessage(sessionId, prompt);
}

// 定时轮收尾通知（阶段 A ok / 阶段 B 投递失败时调）：正文=本执行窗口内最后一条纯文本
// assistant 收尾消息（即白天交互时本会推给用户的那句），附件=触发时刻起 files 表新增记录。
// notify 由 server.js 注入（wechat.notifyTask）；任何异常只记日志，绝不动调度主流程。
function fireNotify(t, status, errNote) {
  if (!notify) return;
  try {
    const dbh = eng.getDb();
    const name = String(t.brief || t.session_id).replace(/\s+/g, ' ').trim().slice(0, 40) || t.session_id;
    let text = String(errNote || '');
    let files = [];
    if (status === 'ok') {
      const m = dbh.prepare(
        "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND type IS NULL AND created_at >= ?" +
        " AND content IS NOT NULL AND TRIM(content) != '' ORDER BY id DESC LIMIT 1"
      ).get(t.session_id, t.last_run_at || 0);
      text = String((m && m.content) || '').trim();
      files = dbh.prepare('SELECT filename FROM files WHERE session_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 10')
        .all(t.session_id, t.last_run_at || 0).map(r => r.filename);
    }
    Promise.resolve(notify({
      user: t.user, channel: t.notify_channel || '', sessionId: t.session_id,
      status, // notifyTask 的去重闸门用：ok 且会话仍是该通道当前会话 → 回复已实时投递过，不重发
      head: '`' + name + ', ' + status + '`\n---\n',
      text, files, stamp: t.last_run_at || Date.now(),
    })).catch(e => log.warn('scheduler', '任务通知入队失败: ' + (e && e.message || e)));
  } catch (e) {
    log.warn('scheduler', '任务通知组装失败: ' + (e && e.message || e));
  }
}

// ---------- tick ----------
function drop(db, sessionId) {
  db.prepare('DELETE FROM scheduled_tasks WHERE session_id = ?').run(sessionId);
  log.info('scheduler', sessionId + ' 删除定时任务（会话不存在）');
}

function tick() {
  const db = eng.getDb();
  const now = Date.now();

  // 阶段 A：收尾上一轮标记 running 的任务。runLoop 结束没有回调可挂，改为轮询推断：
  // 会话已转非 active = 回合结束 → ok（局限：异常结束的回合也会被标 ok）。
  // 会话仍 active → AI 还在跑，保持 running 等下轮再看。
  for (const t of db.prepare(
    "SELECT t.session_id, t.brief, t.prompt, t.notify_channel, t.last_run_at, s.user" +
    ' FROM scheduled_tasks t JOIN sessions s ON s.id = t.session_id WHERE t.last_status=\'running\''
  ).all()) {
    const s = eng.getSession(t.session_id);
    if (!s) { drop(db, t.session_id); continue; }
    if (s.status !== 'active') {
      db.prepare("UPDATE scheduled_tasks SET last_status='ok' WHERE session_id=?").run(t.session_id);
      fireNotify(t, 'ok'); // 跑完没人在看：把收尾那句话与成果文件主动送到微信
    }
  }

  // 阶段 B：投递到期任务。上一轮还 running 的不取（等阶段 A 收尾）；
  // 会话本身 active 直接跳过本次——防堆积以会话状态为准，不依赖 DB 标记的时序，更可靠。
  const due = db.prepare(
    "SELECT t.*, s.user FROM scheduled_tasks t JOIN sessions s ON s.id = t.session_id" +
    " WHERE t.next_run_at <= ? AND (t.last_status IS NULL OR t.last_status != 'running')"
  ).all(now);
  for (const t of due) {
    const s = eng.getSession(t.session_id);
    if (!s) { drop(db, t.session_id); continue; } // CASCADE 正常已清行；手工删 sessions 行的兜底
    if (s.status === 'active') {
      db.prepare(
        "UPDATE scheduled_tasks SET last_run_at=?, last_status='skipped', last_note='上一次仍在执行，跳过本次', next_run_at=? WHERE session_id=?"
      ).run(now, computeNext(t.cron_expr), t.session_id);
      log.info('scheduler', t.session_id + ' 跳过本次（上一次仍在执行）');
      continue;
    }
    try {
      // 顺序不可调换：先存档、后投递。postUserMessage 的 held/空闲分支会同步起 runLoop，
      // 存档晚一步，回合就会带着旧上下文开跑。
      archiveHistory(db, t.session_id);
      // 无人值守的是执行型任务：投递前强制 phase='executing'——新会话可能还停在 advising，
      // 顾问 profile 会把半夜的 prompt 当白天聊天「引导澄清并等用户回答」，永远出不了活。
      db.prepare("UPDATE sessions SET phase='executing', updated_at=? WHERE id=?").run(now, t.session_id);
      const r = deliver(t.session_id, t.prompt);
      db.prepare(
        "UPDATE scheduled_tasks SET last_run_at=?, last_status='running', last_note=NULL, next_run_at=? WHERE session_id=?"
      ).run(now, computeNext(t.cron_expr), t.session_id);
      log.info('scheduler', t.session_id + ' 触发定时任务，投递 ' + (r && r.delivered || '?'));
    } catch (err) {
      db.prepare(
        "UPDATE scheduled_tasks SET last_run_at=?, last_status='error', last_note=?, next_run_at=? WHERE session_id=?"
      ).run(now, String(err && err.message || err).slice(0, 200), computeNext(t.cron_expr), t.session_id);
      log.error('scheduler', t.session_id + ' 定时任务失败: ' + (err && err.message || err));
      fireNotify(t, 'error', String(err && err.message || err).slice(0, 200)); // 失败是最值得用户知道的通知
    }
  }
}

function start(engine, notifyFn) {
  if (timer) return;
  eng = engine;
  notify = typeof notifyFn === 'function' ? notifyFn : null;
  timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      log.error('scheduler', 'tick 异常: ' + (e && e.stack || e));
    }
  }, TICK_MS);
  if (timer.unref) timer.unref(); // 不阻止进程退出
}

module.exports = { start, createTask, getTask, listUserTasks, updateTask, deleteTask, computeNext, validateCron, fmtTime, fmtIso };
