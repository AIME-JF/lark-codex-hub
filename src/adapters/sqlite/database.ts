import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_dedup (
  event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_message_id_uq ON inbox_dedup(message_id);

CREATE TABLE IF NOT EXISTS conversation_links (
  scope_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_history (
  scope_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope_key, session_id)
);
CREATE INDEX IF NOT EXISTS session_history_recent_idx
  ON session_history(scope_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_preferences (
  scope_key TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_leases (
  scope_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  session_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'cancelled')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_scope_started_idx ON runs(scope_key, started_at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK(target_type IN ('open_id', 'chat_id')),
  target_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, retry_at, id);

CREATE TABLE IF NOT EXISTS action_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'rejected', 'completed', 'failed')),
  confirmation_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  return database;
}

export function migrateDatabase(database: Database.Database): void {
  database.transaction(() => {
    database.exec(schema);
    database
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)")
      .run(Date.now());
  })();
}
