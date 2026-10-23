# -*- coding: utf-8 -*-
"""审核页运行记录：会话 data.db 里的 doc_review_* 表。

为什么由技能自己写：
  - core 对 data.db 只有通用 SQL API（/api/db）和 db 工具，不认识任何业务表；
  - 技能自己拥有 schema、写入与清理，core 保持零感知（松耦合）。
约定：
  - 时间一律 ISO8601 UTC 字符串；
  - 坐标/结构一律 JSON 文本，页面用 JSON.parse；
  - 表名统一 doc_review_ 前缀，避免和用户业务表混淆。
"""
import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone

SCHEMA_VERSION = 1
DB_NAME = "data.db"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_batch_id():
    # 不含点/斜杠/空格：避免 skills.absolutizeArgs 把 batch_id 误判成路径。
    return "dr" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)


def _json(v):
    return None if v is None else json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def _loads(s, default=None):
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default


def connect(session_root):
    path = os.path.join(session_root, DB_NAME)
    conn = sqlite3.connect(path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    # core 建库时已是 WAL；这里 best-effort，不强行切换（并发打开时切换会拿写锁）。
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.DatabaseError:
        pass
    ensure_schema(conn)
    return conn


def ensure_schema(conn):
    conn.executescript("""
CREATE TABLE IF NOT EXISTS doc_review_batch (
  id TEXT PRIMARY KEY,
  output TEXT NOT NULL,
  paper TEXT,
  enhance TEXT,
  dpi TEXT,
  orientation TEXT,
  status TEXT,
  summary TEXT,
  warnings TEXT,
  schema_version INTEGER,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS doc_review_page (
  batch_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  source TEXT,
  source_w INTEGER,
  source_h INTEGER,
  w INTEGER,
  h INTEGER,
  auto_corners TEXT,
  auto_corners_norm TEXT,
  corners TEXT,
  auto_rotate INTEGER,
  rotate INTEGER,
  deleted INTEGER DEFAULT 0,
  sort INTEGER,
  status TEXT,
  reason TEXT,
  thumb TEXT,
  error TEXT,
  PRIMARY KEY (batch_id, idx)
);
CREATE TABLE IF NOT EXISTS doc_review_job (
  batch_id TEXT PRIMARY KEY,
  edits TEXT,
  status TEXT,
  message TEXT,
  requested_at TEXT,
  started_at TEXT,
  finished_at TEXT
);
""")
    conn.commit()


def upsert_batch(conn, batch_id, output, opts):
    ts = now_iso()
    conn.execute("""
INSERT INTO doc_review_batch
  (id, output, paper, enhance, dpi, orientation, status, summary, warnings,
   schema_version, created_at, updated_at)
VALUES (?,?,?,?,?,?,'running',NULL,NULL,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  output=excluded.output, paper=excluded.paper, enhance=excluded.enhance,
  dpi=excluded.dpi, orientation=excluded.orientation,
  schema_version=excluded.schema_version, updated_at=excluded.updated_at
""", (batch_id, output, opts.get("paper"), opts.get("enhance"),
      str(opts.get("dpi")), opts.get("orientation"),
      SCHEMA_VERSION, ts, ts))
    conn.commit()


def replace_pages(conn, batch_id, pages):
    conn.execute("DELETE FROM doc_review_page WHERE batch_id = ?", (batch_id,))
    for p in pages:
        conn.execute("""
INSERT INTO doc_review_page
  (batch_id, idx, source, source_w, source_h, w, h,
   auto_corners, auto_corners_norm, corners, auto_rotate, rotate,
   deleted, sort, status, reason, thumb, error)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
""", (batch_id, int(p.get("idx")), p.get("source"),
      p.get("source_w"), p.get("source_h"), p.get("w"), p.get("h"),
      _json(p.get("auto_corners")), _json(p.get("auto_corners_norm")),
      _json(p.get("corners")), int(p.get("auto_rotate") or 0),
      int(p.get("rotate") or 0), 1 if p.get("deleted") else 0,
      int(p.get("sort") or 0), p.get("status"), p.get("reason"),
      p.get("thumb"), p.get("error")))
    conn.commit()


def _row(r):
    return dict(r) if r is not None else None


def get_batch(conn, batch_id):
    return _row(conn.execute("SELECT * FROM doc_review_batch WHERE id = ?", (batch_id,)).fetchone())


def get_latest_batch(conn):
    return _row(conn.execute(
        "SELECT * FROM doc_review_batch ORDER BY created_at DESC, updated_at DESC LIMIT 1").fetchone())


def get_pages(conn, batch_id):
    rows = [_row(r) for r in conn.execute(
        "SELECT * FROM doc_review_page WHERE batch_id = ? ORDER BY sort, idx", (batch_id,))]
    for r in rows:
        r["auto_corners"] = _loads(r.get("auto_corners"))
        r["auto_corners_norm"] = _loads(r.get("auto_corners_norm"))
        r["corners"] = _loads(r.get("corners"))
    return rows


def get_job(conn, batch_id):
    r = _row(conn.execute("SELECT * FROM doc_review_job WHERE batch_id = ?", (batch_id,)).fetchone())
    if r:
        r["edits_obj"] = _loads(r.get("edits"))
    return r


def upsert_job(conn, batch_id, edits, status="queued", message=None):
    ts = now_iso()
    conn.execute("""
INSERT INTO doc_review_job(batch_id, edits, status, message, requested_at, started_at, finished_at)
VALUES (?,?,?,?,?,NULL,NULL)
ON CONFLICT(batch_id) DO UPDATE SET
  edits=excluded.edits, status=excluded.status, message=excluded.message,
  requested_at=excluded.requested_at, started_at=NULL, finished_at=NULL
""", (batch_id, _json(edits), status, message, ts))
    conn.commit()


def set_job(conn, batch_id, status, message=None):
    ts = now_iso()
    if status == "running":
        conn.execute("UPDATE doc_review_job SET status=?, message=?, started_at=?, finished_at=NULL WHERE batch_id=?",
                     (status, message, ts, batch_id))
    elif status in ("done", "error"):
        conn.execute("UPDATE doc_review_job SET status=?, message=?, finished_at=? WHERE batch_id=?",
                     (status, message, ts, batch_id))
    else:
        conn.execute("UPDATE doc_review_job SET status=?, message=? WHERE batch_id=?",
                     (status, message, batch_id))
    conn.commit()


def finish_batch(conn, batch_id, ok, summary, warnings, status=None):
    ts = now_iso()
    if status is None:
        status = "ready" if ok else "error"
    conn.execute("UPDATE doc_review_batch SET status=?, summary=?, warnings=?, updated_at=? WHERE id=?",
                 (status, summary, _json(warnings or []), ts, batch_id))
    conn.commit()


def prune(conn, keep=5, protect=None):
    """只保留最近 keep 个批次；protect 指定的批次永不删（防止在旧批次上重生成时被裁掉）。"""
    rows = conn.execute(
        "SELECT id FROM doc_review_batch ORDER BY created_at DESC, updated_at DESC").fetchall()
    kept = [r["id"] for r in rows[:keep]]
    if protect and protect not in kept:
        kept.append(protect)
    old = [r["id"] for r in rows if r["id"] not in kept]
    for bid in old:
        conn.execute("DELETE FROM doc_review_page WHERE batch_id=?", (bid,))
        conn.execute("DELETE FROM doc_review_job WHERE batch_id=?", (bid,))
        conn.execute("DELETE FROM doc_review_batch WHERE id=?", (bid,))
    if old:
        conn.commit()
    return old, kept
