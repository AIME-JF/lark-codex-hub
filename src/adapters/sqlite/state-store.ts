import type Database from "better-sqlite3";
import type { ConversationLink } from "../../contracts/events.js";
import type {
  OutboxRecord,
  PendingActionRecord,
  RunRecord,
  StateRepository
} from "../../ports/state-repository.js";
import { migrateDatabase } from "./database.js";

interface ConversationRow {
  scope_key: string;
  session_id: string;
  cwd: string;
  updated_at: number;
}

interface LeaseRow {
  holder: string;
}

interface OutboxRow {
  id: number;
  idempotency_key: string;
  target_type: "open_id" | "chat_id";
  target_id: string;
  text: string;
  attempts: number;
}

interface PendingActionRow {
  id: string;
  idempotency_key: string;
  action_json: string;
  confirmation_json: string;
}

export class SqliteStateStore implements StateRepository {
  public constructor(private readonly database: Database.Database) {}

  public migrate(): void {
    migrateDatabase(this.database);
  }

  public close(): void {
    this.database.close();
  }

  public claimInbox(eventId: string, messageId: string, now: number): boolean {
    const result = this.database
      .prepare(
        "INSERT OR IGNORE INTO inbox_dedup(event_id, message_id, received_at) VALUES(?, ?, ?)"
      )
      .run(eventId, messageId, now);
    return result.changes === 1;
  }

  public pruneInbox(before: number): number {
    return this.database
      .prepare("DELETE FROM inbox_dedup WHERE received_at < ?")
      .run(before).changes;
  }

  public getConversation(scopeKey: string): ConversationLink | undefined {
    const row = this.database
      .prepare(
        "SELECT scope_key, session_id, cwd, updated_at FROM conversation_links WHERE scope_key = ?"
      )
      .get(scopeKey) as ConversationRow | undefined;
    return row
      ? {
          scopeKey: row.scope_key,
          sessionId: row.session_id,
          cwd: row.cwd,
          updatedAt: row.updated_at
        }
      : undefined;
  }

  public listConversations(scopeKey: string, limit: number): ConversationLink[] {
    const rows = this.database
      .prepare(
        `SELECT scope_key, session_id, cwd, updated_at
         FROM session_history WHERE scope_key = ?
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(scopeKey, limit) as ConversationRow[];
    return rows.map((row) => ({
      scopeKey: row.scope_key,
      sessionId: row.session_id,
      cwd: row.cwd,
      updatedAt: row.updated_at
    }));
  }

  public bindConversation(link: ConversationLink): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO conversation_links(scope_key, session_id, cwd, updated_at)
           VALUES(@scopeKey, @sessionId, @cwd, @updatedAt)
           ON CONFLICT(scope_key) DO UPDATE SET
             session_id = excluded.session_id,
             cwd = excluded.cwd,
             updated_at = excluded.updated_at`
        )
        .run(link);
      this.database
        .prepare(
          `INSERT INTO session_history(scope_key, session_id, cwd, updated_at)
           VALUES(@scopeKey, @sessionId, @cwd, @updatedAt)
           ON CONFLICT(scope_key, session_id) DO UPDATE SET
             cwd = excluded.cwd,
             updated_at = excluded.updated_at`
        )
        .run(link);
    })();
  }

  public clearConversation(scopeKey: string): void {
    this.database.prepare("DELETE FROM conversation_links WHERE scope_key = ?").run(scopeKey);
  }

  public getWorkspace(scopeKey: string): string | undefined {
    const row = this.database
      .prepare("SELECT cwd FROM workspace_preferences WHERE scope_key = ?")
      .get(scopeKey) as { cwd: string } | undefined;
    return row?.cwd;
  }

  public setWorkspace(scopeKey: string, cwd: string, now: number): void {
    this.database
      .prepare(
        `INSERT INTO workspace_preferences(scope_key, cwd, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at`
      )
      .run(scopeKey, cwd, now);
  }

  public acquireLease(scopeKey: string, holder: string, now: number, ttlMs: number): boolean {
    return this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM thread_leases WHERE scope_key = ? AND expires_at <= ?")
        .run(scopeKey, now);
      const existing = this.database
        .prepare("SELECT holder FROM thread_leases WHERE scope_key = ?")
        .get(scopeKey) as LeaseRow | undefined;
      if (!existing) {
        this.database
          .prepare(
            "INSERT INTO thread_leases(scope_key, holder, heartbeat_at, expires_at) VALUES(?, ?, ?, ?)"
          )
          .run(scopeKey, holder, now, now + ttlMs);
        return true;
      }
      if (existing.holder === holder) {
        this.database
          .prepare(
            "UPDATE thread_leases SET heartbeat_at = ?, expires_at = ? WHERE scope_key = ? AND holder = ?"
          )
          .run(now, now + ttlMs, scopeKey, holder);
        return true;
      }
      return false;
    })();
  }

  public heartbeatLease(scopeKey: string, holder: string, now: number, ttlMs: number): boolean {
    const result = this.database
      .prepare(
        "UPDATE thread_leases SET heartbeat_at = ?, expires_at = ? WHERE scope_key = ? AND holder = ?"
      )
      .run(now, now + ttlMs, scopeKey, holder);
    return result.changes === 1;
  }

  public releaseLease(scopeKey: string, holder: string): void {
    this.database
      .prepare("DELETE FROM thread_leases WHERE scope_key = ? AND holder = ?")
      .run(scopeKey, holder);
  }

  public createRun(run: RunRecord): void {
    this.database
      .prepare(
        `INSERT INTO runs(id, scope_key, session_id, state, started_at, finished_at, error)
         VALUES(@id, @scopeKey, @sessionId, @state, @startedAt, @finishedAt, @error)`
      )
      .run({
        id: run.id,
        scopeKey: run.scopeKey,
        sessionId: run.sessionId ?? null,
        state: run.state,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        error: run.error ?? null
      });
  }

  public finishRun(
    id: string,
    state: RunRecord["state"],
    finishedAt: number,
    error?: string
  ): void {
    this.database
      .prepare("UPDATE runs SET state = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(state, finishedAt, error ?? null, id);
  }

  public enqueueOutbox(
    record: Omit<OutboxRecord, "id" | "attempts">,
    now: number
  ): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO outbox(
           idempotency_key, target_type, target_id, text, retry_at, created_at
         ) VALUES(?, ?, ?, ?, ?, ?)`
      )
      .run(record.idempotencyKey, record.targetType, record.targetId, record.text, now, now);
    return result.changes === 1;
  }

  public nextOutbox(now: number, limit: number): OutboxRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, idempotency_key, target_type, target_id, text, attempts
         FROM outbox
         WHERE status = 'pending' AND retry_at <= ?
         ORDER BY id ASC LIMIT ?`
      )
      .all(now, limit) as OutboxRow[];
    return rows.map((row) => ({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      targetType: row.target_type,
      targetId: row.target_id,
      text: row.text,
      attempts: row.attempts
    }));
  }

  public completeOutbox(id: number): void {
    this.database
      .prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  public retryOutbox(id: number, attempts: number, retryAt: number, error: string): void {
    this.database
      .prepare(
        "UPDATE outbox SET attempts = ?, retry_at = ?, last_error = ? WHERE id = ?"
      )
      .run(attempts, retryAt, error.slice(0, 2000), id);
  }

  public failOutbox(id: number, attempts: number, error: string): void {
    this.database
      .prepare(
        "UPDATE outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?"
      )
      .run(attempts, error.slice(0, 2000), id);
  }

  public savePendingAction(record: PendingActionRecord, now: number): void {
    this.database
      .prepare(
        `INSERT INTO action_requests(
           id, idempotency_key, action_json, state, confirmation_json, created_at, updated_at
         ) VALUES(?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(
        record.id,
        record.idempotencyKey,
        record.actionJson,
        record.confirmationJson,
        now,
        now
      );
  }

  public getPendingAction(id: string): PendingActionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, idempotency_key, action_json, confirmation_json
         FROM action_requests WHERE id = ? AND state = 'pending'`
      )
      .get(id) as PendingActionRow | undefined;
    return row
      ? {
          id: row.id,
          idempotencyKey: row.idempotency_key,
          actionJson: row.action_json,
          confirmationJson: row.confirmation_json
        }
      : undefined;
  }

  public finishAction(
    id: string,
    state: "approved" | "rejected" | "completed" | "failed",
    now: number
  ): void {
    this.database
      .prepare("UPDATE action_requests SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, now, id);
  }

  public health(): { journalMode: string; schemaVersion: number } {
    const mode = this.database.pragma("journal_mode", { simple: true });
    const row = this.database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return { journalMode: String(mode), schemaVersion: row.version };
  }
}
