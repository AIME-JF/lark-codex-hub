import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase, openDatabase } from "../src/adapters/sqlite/database.js";

describe("SQLite 数据库迁移", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    );
  });

  it("从 schema 3 升级到 schema 4 并保留运行与动作记录", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lark-codex-hub-migration-"));
    directories.push(directory);
    const database = openDatabase(join(directory, "hub.sqlite"));
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES(1, 1), (2, 2), (3, 3);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        session_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'cancelled')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT
      );
      CREATE INDEX runs_scope_started_idx ON runs(scope_key, started_at DESC);
      INSERT INTO runs VALUES('run-1', 'scope-1', 'session-1', 'completed', 10, 20, NULL);
      CREATE TABLE action_requests (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        action_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'rejected', 'completed', 'failed')),
        confirmation_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO action_requests VALUES(
        'action-1', 'key-1', '{}', 'pending', '{}', 30, 30
      );
    `);

    migrateDatabase(database);

    expect(
      database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()
    ).toEqual({ version: 4 });
    expect(database.prepare("SELECT state FROM runs WHERE id = 'run-1'").get()).toEqual({
      state: "completed"
    });
    expect(
      database
        .prepare(
          "SELECT state, operator_open_id, chat_id, scope_key FROM action_requests WHERE id = 'action-1'"
        )
        .get()
    ).toEqual({
      state: "interrupted",
      operator_open_id: "",
      chat_id: "",
      scope_key: ""
    });
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(
        "delivery_outbox"
      )
    ).toEqual({ name: "delivery_outbox" });
    expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    database.close();
  });
});
