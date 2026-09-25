// SQLite 数据层。表结构见 README 第九章；本模块同时提供常用查询。
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      status TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'advising',
      model_id TEXT,
      last_model_id TEXT,
      assistant_type TEXT DEFAULT 'secretary',
      user TEXT DEFAULT '',
      profile TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      cancelled_at INTEGER,
      held_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      reasoning TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      name TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
  // 升级老库：早期表不带 reasoning 列，补上（重入安全；不在上面 db.exec 模板串里，免得被当作 SQL 解析）
  try { db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT'); } catch (_) { /* 已存在 */ }
  // 升级老库：type 标记特殊消息行。目前唯一取值 'errAck'——AI 的 tool call 参数错误
  // （JSON 非法/缺必填）整条标记；仍入库供 UI 展示，但 buildMessages 发请求时跳过（见 llm.js）
  try { db.exec('ALTER TABLE messages ADD COLUMN type TEXT'); } catch (_) { /* 已存在 */ }
  // 升级老库：tool 回执执行失败标记。此前只走 SSE 不落库，重进会话后 UI 丢失红色错误样式
  try { db.exec('ALTER TABLE messages ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0'); } catch (_) { /* 已存在 */ }
  // 升级老库：assistant 消息的 token 用量 {pt,ct,cached} JSON（msg-actions 展示 In/Out/缓存命中率）
  try { db.exec('ALTER TABLE messages ADD COLUMN usage TEXT'); } catch (_) { /* 已存在 */ }
  db.exec(`

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS model_pool (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      is_busy INTEGER DEFAULT 0,
      current_session_id TEXT,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS wait_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- 杂项持久计数/标记（如每日任务序号 task_seq:YYYYMMDD，删除会话后不回退复用）
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- 定时任务：AI 通过 schedule 工具为会话创建周期任务（每会话至多一个），
    -- 由 scheduler.js 轮询投递。session_id 作主键：一行代码同时实现「1 会话 1 任务」
    -- 与「防重复插入」（重复 INSERT 直接撞主键）；REFERENCES ... ON DELETE CASCADE
    -- 让删会话时任务自动消失（db 已开 foreign_keys）。next_run_at 创建时即算好，
    -- 调度器只做 <= now 比较；last_note 存给人看的中文说明，UI 原样展示。
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      cron_expr   TEXT    NOT NULL,
      prompt      TEXT    NOT NULL,
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_status TEXT,             -- ok | error | skipped | running
      last_note   TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sched_next ON scheduled_tasks(next_run_at);

    -- 模型 token 用量流水（每次模型回合一条）。故意不建会话外键：
    -- 删会话后累计统计仍需保留
    CREATE TABLE IF NOT EXISTS model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- 用户画像（user-profile.js）：一行一个登录用户，跨会话共享；未启用认证时为空串键的隐式单用户。
    -- data = {honorific,industry,preference} JSON（只记「不知道就会做错」的信息，封闭 schema）；
    -- enabled 用户级开关：关 = 新会话不冻结注入快照、也不再提取更新。
    CREATE TABLE IF NOT EXISTS user_profiles (
      user TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
    CREATE INDEX IF NOT EXISTS idx_model_usage_model_time ON model_usage(model_id, created_at);
  `);
  // 升级老库：model_usage 补 cached_tokens 列（输入 token 缓存命中量累计，算历史命中率）
  try { db.exec('ALTER TABLE model_usage ADD COLUMN cached_tokens INTEGER DEFAULT 0'); } catch (_) { /* 已存在 */ }
  // 迁移：旧库补 held_at 列（held 保持租约起始时间）
  const cols = db.prepare('PRAGMA table_info(sessions)').all();
  if (!cols.some(c => c.name === 'held_at')) db.exec('ALTER TABLE sessions ADD COLUMN held_at INTEGER');
  // 迁移：model_slot 记会话占用的具体池 key 槽位（「平台#key下标」，平台 key 为其下模型共享资源），
  // model_id 仍存模型 id 供展示/统计（见 engine.bindModel）。
  if (!cols.some(c => c.name === 'model_slot')) db.exec('ALTER TABLE sessions ADD COLUMN model_slot TEXT');
  // 迁移：model_pool 一行一个物理 key 槽位（id=「平台#下标」），last_used_at 支撑「最久未用先上」轮转（见 engine.freeModel）
  const poolCols = db.prepare('PRAGMA table_info(model_pool)').all();
  if (!poolCols.some(c => c.name === 'last_used_at')) db.exec('ALTER TABLE model_pool ADD COLUMN last_used_at INTEGER');
  // 迁移：last_model_id 记住会话最近用过的模型，释放后新消息优先回绑（见 engine.dispatchQueued）
  if (!cols.some(c => c.name === 'last_model_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN last_model_id TEXT');
    db.exec('UPDATE sessions SET last_model_id = model_id WHERE last_model_id IS NULL AND model_id IS NOT NULL');
  }
  // 迁移：assistant_type 标记会话的 AI 助手类型（secretary=文秘助理 / vision=识图专家），
  // 建档时选定，后续不可变更；存量老会话按默认文秘助理回填
  if (!cols.some(c => c.name === 'assistant_type')) {
    db.exec("ALTER TABLE sessions ADD COLUMN assistant_type TEXT DEFAULT 'secretary'");
  }
  // 迁移：user 记录建档时的登录用户，列表接口据此按用户隔离；
  // 存量老会话与未启用认证时建的会话为空串（见 routes/sessions.js 列表过滤）
  if (!cols.some(c => c.name === 'user')) {
    db.exec("ALTER TABLE sessions ADD COLUMN user TEXT DEFAULT ''");
  }
  // 迁移：profile 曾记会话绑定的 prompt+tools 组合名（bind 弹窗「模式」区）。已废弃：
  // 前端手动切换模式全部移除，profile 选取收敛为「phase 强制 + 模型配置默认」两档（见 engine.resolveProfileName）；
  // 列保留（SQLite 删列不值得），代码不再读写。
  if (!cols.some(c => c.name === 'profile')) {
    db.exec("ALTER TABLE sessions ADD COLUMN profile TEXT DEFAULT ''");
  }
  // 迁移：profile_snapshot 存会话创建/清空时冻结的用户画像注入文本（buildMessages 每轮首条 user 注入，
  // 字节恒定不破坏前缀缓存；不入 messages 表，阶段切换/压缩动不到它，见 user-profile.js）。
  if (!cols.some(c => c.name === 'profile_snapshot')) db.exec("ALTER TABLE sessions ADD COLUMN profile_snapshot TEXT DEFAULT ''");
  // 迁移：title_locked 用户手动重命名过标题（renameSession 置 1）：handoff 的自动标题见锁即跳过，
  // 不得静默冲掉用户给会话起的名字；清空会话时随标题一并复位（旧名字已文不对题）。
  if (!cols.some(c => c.name === 'title_locked')) db.exec("ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0");
  // 迁移：phase 语义重定义为 advising（顾问：澄清需求/规划）/ executing（执行）。
  // 存量会话（旧值 planning/NULL）统一回填 executing——它们都有历史，行为与改造前一致、零打扰；
  // 只有新建会话进 advising（createSession 显式写入）。幂等，每次启动一条廉价 UPDATE。
  db.exec("UPDATE sessions SET phase='executing' WHERE phase IS NULL OR phase NOT IN ('advising','executing')");
  return db;
}

module.exports = { initDb };
