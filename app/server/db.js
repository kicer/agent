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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      cancelled_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

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

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
  `);
  return db;
}

module.exports = { initDb };
