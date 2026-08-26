import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const LATEST_SCHEMA_VERSION = 7;

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

CREATE TABLE IF NOT EXISTS project_preferences (
  scope_key TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS new_session_intents (
  scope_key TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_prompts (
  scope_key TEXT PRIMARY KEY,
  message_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_prompts_expiry_idx
  ON pending_prompts(expires_at);

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

CREATE TABLE IF NOT EXISTS turn_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  scope_key TEXT NOT NULL,
  lane_key TEXT NOT NULL,
  message_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted'
  )) DEFAULT 'pending',
  holder TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS turn_jobs_ready_idx
  ON turn_jobs(status, lane_key, scope_key, created_at);

CREATE TABLE IF NOT EXISTS live_cards (
  run_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  card_message_id TEXT NOT NULL,
  card_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'completed')) DEFAULT 'active',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS live_cards_active_idx ON live_cards(status, updated_at);

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
  reaction_targets_json TEXT,
  target_key TEXT,
  revision INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'sent', 'failed', 'superseded')) DEFAULT 'pending',
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
CREATE INDEX IF NOT EXISTS delivery_outbox_target_revision_idx
  ON delivery_outbox(target_key, revision DESC);

CREATE TABLE IF NOT EXISTS delivery_target_versions (
  target_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL
);

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

function migrateToVersion5(database: Database.Database): void {
  const columns = database.pragma("table_info(delivery_outbox)") as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "reaction_targets_json")) {
    database.exec(
      "ALTER TABLE delivery_outbox ADD COLUMN reaction_targets_json TEXT"
    );
  }
  database.exec(latestSchema);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(5, ?)")
    .run(Date.now());
}

function migrateToVersion6(database: Database.Database): void {
  const columns = database.pragma("table_info(delivery_outbox)") as Array<{
    name: string;
  }>;
  const alreadyCurrent =
    columns.some((column) => column.name === "target_key") &&
    columns.some((column) => column.name === "revision");
  if (!alreadyCurrent) {
    database.exec(`
      DROP INDEX IF EXISTS delivery_outbox_ready_idx;
      DROP INDEX IF EXISTS delivery_outbox_target_revision_idx;
      ALTER TABLE delivery_outbox RENAME TO delivery_outbox_v5;
      CREATE TABLE delivery_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        target_json TEXT NOT NULL,
        card_json TEXT NOT NULL,
        tracker_id TEXT,
        terminal_reaction TEXT,
        reaction_targets_json TEXT,
        target_key TEXT,
        revision INTEGER,
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'processing', 'sent', 'failed', 'superseded'
        )) DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL,
        holder TEXT,
        lease_expires_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      INSERT INTO delivery_outbox(
        id, idempotency_key, target_json, card_json, tracker_id,
        terminal_reaction, reaction_targets_json, status, attempts,
        retry_at, holder, lease_expires_at, last_error, created_at,
        updated_at, sent_at
      )
        SELECT id, idempotency_key, target_json, card_json, tracker_id,
               terminal_reaction, reaction_targets_json, status, attempts,
               retry_at, holder, lease_expires_at, last_error, created_at,
               updated_at, sent_at
        FROM delivery_outbox_v5;
      DROP TABLE delivery_outbox_v5;
    `);
  }
  database.exec(latestSchema);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(6, ?)")
    .run(Date.now());
}

function migrateToVersion7(database: Database.Database): void {
  database.exec(latestSchema);
  database
    .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(7, ?)")
    .run(Date.now());
}

function migrateLegacyProjectPreferences(database: Database.Database): void {
  const legacy = database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'workspace_preferences'")
    .get() as { found: number } | undefined;
  if (legacy) {
    database.exec(`
      INSERT OR IGNORE INTO project_preferences(scope_key, cwd, updated_at)
        SELECT scope_key, cwd, updated_at FROM workspace_preferences;
      DELETE FROM workspace_preferences;
    `);
  }
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
    let version = currentVersion(database);
    if (version > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本 ${version} 高于当前程序支持的版本 ${LATEST_SCHEMA_VERSION}，请先升级 Lark Codex Hub。`
      );
    }
    if (version === 0) {
      database.exec(latestSchema);
      for (let applied = 1; applied <= LATEST_SCHEMA_VERSION; applied += 1) {
        database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)")
          .run(applied, Date.now());
      }
      return;
    }
    if (version < 4) {
      migrateToVersion4(database);
      version = currentVersion(database);
    }
    if (version < 5) {
      migrateToVersion5(database);
      version = currentVersion(database);
    }
    if (version < 6) {
      migrateToVersion6(database);
      version = currentVersion(database);
    }
    if (version < 7) {
      migrateToVersion7(database);
    }
    database.exec(latestSchema);
    migrateLegacyProjectPreferences(database);
  })();
}
