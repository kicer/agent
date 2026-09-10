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
      phase TEXT NOT NULL DEFAULT 'planning',
      model_id TEXT,
      last_model_id TEXT,
      assistant_type TEXT DEFAULT 'secretary',
      user TEXT DEFAULT '',
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
      current_session_id TEXT
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

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
    CREATE INDEX IF NOT EXISTS idx_model_usage_model_time ON model_usage(model_id, created_at);
  `);
  // 升级老库：model_usage 补 cached_tokens 列（输入 token 缓存命中量累计，算历史命中率）
  try { db.exec('ALTER TABLE model_usage ADD COLUMN cached_tokens INTEGER DEFAULT 0'); } catch (_) { /* 已存在 */ }
  // 迁移：旧库补 held_at 列（held 保持租约起始时间）
  const cols = db.prepare('PRAGMA table_info(sessions)').all();
  if (!cols.some(c => c.name === 'held_at')) db.exec('ALTER TABLE sessions ADD COLUMN held_at INTEGER');
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
  return db;
}

module.exports = { initDb };
