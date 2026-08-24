import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const latestSchema = `
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

CREATE TABLE IF NOT EXISTS p2p_scopes (
  open_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_leases (
  scope_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_leases (
  resource_key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  session_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_scope_started_idx ON runs(scope_key, started_at DESC);

CREATE TABLE IF NOT EXISTS active_message_reactions (
  tracker_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  reaction_id TEXT NOT NULL,
  emoji_type TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

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

CREATE TABLE IF NOT EXISTS inbound_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('message', 'card_action', 'bot_menu')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'interrupted')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  holder TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbound_jobs_ready_idx
  ON inbound_jobs(status, lease_expires_at, id);

CREATE TABLE IF NOT EXISTS delivery_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  target_json TEXT NOT NULL,
  card_json TEXT NOT NULL,
  tracker_id TEXT,
  terminal_reaction TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'sent', 'failed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL,
  holder TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS delivery_outbox_ready_idx
  ON delivery_outbox(status, retry_at, lease_expires_at, id);

CREATE TABLE IF NOT EXISTS action_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'executing', 'approved', 'rejected', 'completed', 'failed', 'interrupted')),
  confirmation_json TEXT,
  operator_open_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function currentVersion(database: Database.Database): number {
  const row = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  return row.version;
}

function migrateToVersion4(database: Database.Database): void {
  database.exec(`
    DROP INDEX IF EXISTS runs_scope_started_idx;
    ALTER TABLE runs RENAME TO runs_v3;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      session_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT
    );
    INSERT INTO runs(id, scope_key, session_id, state, started_at, finished_at, error)
      SELECT id, scope_key, session_id, state, started_at, finished_at, error FROM runs_v3;
    DROP TABLE runs_v3;
    ALTER TABLE action_requests RENAME TO action_requests_v3;
    CREATE TABLE action_requests (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      action_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'executing', 'approved', 'rejected', 'completed', 'failed', 'interrupted')),
      confirmation_json TEXT,
      operator_open_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO action_requests(
      id, idempotency_key, action_json, state, confirmation_json,
      operator_open_id, chat_id, scope_key, created_at, updated_at
    )
      SELECT id, idempotency_key, action_json,
             CASE WHEN state = 'pending' THEN 'interrupted' ELSE state END,
             confirmation_json,
             '', '', '', created_at, updated_at
      FROM action_requests_v3;
    DROP TABLE action_requests_v3;
  `);
  database.exec(latestSchema);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(4, ?)")
    .run(Date.now());
}

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
    database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
    const version = currentVersion(database);
    if (version === 0) {
      database.exec(latestSchema);
      for (const applied of [1, 2, 3, 4]) {
        database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)")
          .run(applied, Date.now());
      }
      return;
    }
    if (version < 4) {
      migrateToVersion4(database);
      return;
    }
    database.exec(latestSchema);
  })();
}
