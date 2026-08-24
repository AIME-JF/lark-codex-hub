import type Database from "better-sqlite3";
import type { ConversationLink } from "../../contracts/events.js";
import type {
  DeliveryRecord,
  DeliveryRequest,
  DeliveryTarget,
  InboundJobPayload,
  InboundJobRecord
} from "../../contracts/jobs.js";
import type {
  PresentationCard,
  TerminalReaction
} from "../../contracts/presentation.js";
import type {
  ActiveReactionRecord,
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

interface ActiveReactionRow {
  tracker_id: string;
  message_id: string;
  reaction_id: string;
  emoji_type: ActiveReactionRecord["emoji"];
  updated_at: number;
}

interface InboundJobRow {
  id: number;
  event_id: string;
  payload_json: string;
  attempts: number;
}

interface DeliveryRow {
  id: number;
  idempotency_key: string;
  target_json: string;
  card_json: string;
  attempts: number;
  tracker_id: string | null;
  terminal_reaction: TerminalReaction | null;
}

function activeReaction(row: ActiveReactionRow): ActiveReactionRecord {
  return {
    trackerId: row.tracker_id,
    messageId: row.message_id,
    reactionId: row.reaction_id,
    emoji: row.emoji_type,
    updatedAt: row.updated_at
  };
}

function inboundJob(row: InboundJobRow): InboundJobRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    payload: JSON.parse(row.payload_json) as InboundJobPayload,
    attempts: row.attempts
  };
}

function delivery(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    target: JSON.parse(row.target_json) as DeliveryTarget,
    card: JSON.parse(row.card_json) as PresentationCard,
    attempts: row.attempts,
    ...(row.tracker_id ? { trackerId: row.tracker_id } : {}),
    ...(row.terminal_reaction ? { terminalReaction: row.terminal_reaction } : {})
  };
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
    return this.database.transaction(() => {
      const inbound = this.database
        .prepare(
          `DELETE FROM inbound_jobs
           WHERE updated_at < ? AND status IN ('completed', 'failed', 'interrupted')`
        )
        .run(before).changes;
      const deliveries = this.database
        .prepare(
          `DELETE FROM delivery_outbox
           WHERE updated_at < ? AND status IN ('sent', 'failed')`
        )
        .run(before).changes;
      const actions = this.database
        .prepare(
          `DELETE FROM action_requests
           WHERE updated_at < ? AND state IN (
             'approved', 'rejected', 'completed', 'failed', 'interrupted'
           )`
        )
        .run(before).changes;
      const inbox = this.database
        .prepare("DELETE FROM inbox_dedup WHERE received_at < ?")
        .run(before).changes;
      return inbound + deliveries + actions + inbox;
    })();
  }

  public enqueueInbound(
    eventId: string,
    messageId: string,
    payload: InboundJobPayload,
    now: number
  ): boolean {
    return this.database.transaction(() => {
      const claimed = this.claimInbox(eventId, messageId, now);
      if (!claimed) {
        return false;
      }
      this.database
        .prepare(
          `INSERT INTO inbound_jobs(
             event_id, message_id, kind, payload_json, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?)`
        )
        .run(eventId, messageId, payload.kind, JSON.stringify(payload), now, now);
      return true;
    })();
  }

  public claimInbound(
    holder: string,
    now: number,
    ttlMs: number
  ): InboundJobRecord | undefined {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT id, event_id, payload_json, attempts
           FROM inbound_jobs
           WHERE status = 'pending'
              OR (status = 'processing' AND lease_expires_at <= ?)
           ORDER BY id ASC LIMIT 1`
        )
        .get(now) as InboundJobRow | undefined;
      if (!row) {
        return undefined;
      }
      const result = this.database
        .prepare(
          `UPDATE inbound_jobs
           SET status = 'processing', holder = ?, lease_expires_at = ?,
               attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND (
             status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?)
           )`
        )
        .run(holder, now + ttlMs, now, row.id, now);
      if (result.changes !== 1) {
        return undefined;
      }
      return { ...inboundJob(row), attempts: row.attempts + 1 };
    })();
  }

  public heartbeatInbound(
    id: number,
    holder: string,
    now: number,
    ttlMs: number
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE inbound_jobs SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND holder = ? AND status = 'processing'`
        )
        .run(now + ttlMs, now, id, holder).changes === 1
    );
  }

  public completeInbound(id: number, holder: string, now: number): void {
    this.database
      .prepare(
        `UPDATE inbound_jobs
         SET status = 'completed', holder = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND holder = ?`
      )
      .run(now, id, holder);
  }

  public failInbound(
    id: number,
    holder: string,
    now: number,
    error: string
  ): void {
    this.database
      .prepare(
        `UPDATE inbound_jobs
         SET status = 'failed', holder = NULL, lease_expires_at = NULL,
             last_error = ?, updated_at = ?
         WHERE id = ? AND holder = ?`
      )
      .run(error.slice(0, 2_000), now, id, holder);
  }

  public recoverInbound(now: number): {
    interruptedMessages: InboundJobRecord[];
    requeued: number;
  } {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT id, event_id, payload_json, attempts
           FROM inbound_jobs WHERE status = 'processing'`
        )
        .all() as InboundJobRow[];
      const interruptedMessages = rows
        .map(inboundJob)
        .filter((job) => job.payload.kind === "message");
      this.database
        .prepare(
          `UPDATE inbound_jobs SET status = 'interrupted', holder = NULL,
             lease_expires_at = NULL, updated_at = ?
           WHERE status = 'processing' AND kind = 'message'`
        )
        .run(now);
      const requeued = this.database
        .prepare(
          `UPDATE inbound_jobs SET status = 'pending', holder = NULL,
             lease_expires_at = NULL, updated_at = ?
           WHERE status = 'processing' AND kind != 'message'`
        )
        .run(now).changes;
      return { interruptedMessages, requeued };
    })();
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

  public rememberP2pScope(openId: string, scopeKey: string, now: number): void {
    this.database
      .prepare(
        `INSERT INTO p2p_scopes(open_id, scope_key, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(open_id) DO UPDATE SET
           scope_key = excluded.scope_key,
           updated_at = excluded.updated_at`
      )
      .run(openId, scopeKey, now);
  }

  public resolveP2pScope(openId: string): string | undefined {
    const remembered = this.database
      .prepare("SELECT scope_key FROM p2p_scopes WHERE open_id = ?")
      .get(openId) as { scope_key: string } | undefined;
    if (remembered) {
      return remembered.scope_key;
    }
    const suffix = `:${openId}`;
    const historical = this.database
      .prepare(
        `SELECT scope_key FROM conversation_links
         WHERE substr(scope_key, -length(?)) = ?
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(suffix, suffix) as { scope_key: string } | undefined;
    return historical?.scope_key;
  }

  public acquireLease(scopeKey: string, holder: string, now: number, ttlMs: number): boolean {
    return this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM resource_leases WHERE resource_key = ? AND expires_at <= ?")
        .run(scopeKey, now);
      const existing = this.database
        .prepare("SELECT holder FROM resource_leases WHERE resource_key = ?")
        .get(scopeKey) as LeaseRow | undefined;
      if (!existing) {
        this.database
          .prepare(
            "INSERT INTO resource_leases(resource_key, holder, heartbeat_at, expires_at) VALUES(?, ?, ?, ?)"
          )
          .run(scopeKey, holder, now, now + ttlMs);
        return true;
      }
      if (existing.holder === holder) {
        this.database
          .prepare(
            "UPDATE resource_leases SET heartbeat_at = ?, expires_at = ? WHERE resource_key = ? AND holder = ?"
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
        "UPDATE resource_leases SET heartbeat_at = ?, expires_at = ? WHERE resource_key = ? AND holder = ?"
      )
      .run(now, now + ttlMs, scopeKey, holder);
    return result.changes === 1;
  }

  public releaseLease(scopeKey: string, holder: string): void {
    this.database
      .prepare("DELETE FROM resource_leases WHERE resource_key = ? AND holder = ?")
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

  public interruptRunningRuns(now: number): number {
    return this.database
      .prepare(
        `UPDATE runs SET state = 'interrupted', finished_at = ?,
           error = COALESCE(error, '服务重启时任务仍处于运行状态。')
         WHERE state = 'running'`
      )
      .run(now).changes;
  }

  public saveActiveReaction(record: ActiveReactionRecord): void {
    this.database
      .prepare(
        `INSERT INTO active_message_reactions(
           tracker_id, message_id, reaction_id, emoji_type, updated_at
         ) VALUES(@trackerId, @messageId, @reactionId, @emoji, @updatedAt)
         ON CONFLICT(tracker_id) DO UPDATE SET
           message_id = excluded.message_id,
           reaction_id = excluded.reaction_id,
           emoji_type = excluded.emoji_type,
           updated_at = excluded.updated_at`
      )
      .run(record);
  }

  public getActiveReaction(trackerId: string): ActiveReactionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT tracker_id, message_id, reaction_id, emoji_type, updated_at
         FROM active_message_reactions WHERE tracker_id = ?`
      )
      .get(trackerId) as ActiveReactionRow | undefined;
    return row ? activeReaction(row) : undefined;
  }

  public listActiveReactions(): ActiveReactionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT tracker_id, message_id, reaction_id, emoji_type, updated_at
         FROM active_message_reactions ORDER BY updated_at ASC`
      )
      .all() as ActiveReactionRow[];
    return rows.map(activeReaction);
  }

  public clearActiveReaction(trackerId: string): void {
    this.database
      .prepare("DELETE FROM active_message_reactions WHERE tracker_id = ?")
      .run(trackerId);
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

  public enqueueDelivery(record: DeliveryRequest, now: number): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO delivery_outbox(
           idempotency_key, target_json, card_json, tracker_id, terminal_reaction,
           retry_at, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.idempotencyKey,
        JSON.stringify(record.target),
        JSON.stringify(record.card),
        record.trackerId ?? null,
        record.terminalReaction ?? null,
        now,
        now,
        now
      );
    return result.changes === 1;
  }

  public claimDelivery(
    holder: string,
    now: number,
    ttlMs: number
  ): DeliveryRecord | undefined {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT id, idempotency_key, target_json, card_json, attempts,
                  tracker_id, terminal_reaction
           FROM delivery_outbox
           WHERE retry_at <= ? AND (
             status = 'pending' OR
             (status = 'processing' AND lease_expires_at <= ?)
           )
           ORDER BY id ASC LIMIT 1`
        )
        .get(now, now) as DeliveryRow | undefined;
      if (!row) {
        return undefined;
      }
      const result = this.database
        .prepare(
          `UPDATE delivery_outbox
           SET status = 'processing', holder = ?, lease_expires_at = ?,
               attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND (
             status = 'pending' OR
             (status = 'processing' AND lease_expires_at <= ?)
           )`
        )
        .run(holder, now + ttlMs, now, row.id, now);
      return result.changes === 1
        ? { ...delivery(row), attempts: row.attempts + 1 }
        : undefined;
    })();
  }

  public completeDelivery(id: number, holder: string, now: number): void {
    this.database
      .prepare(
        `UPDATE delivery_outbox
         SET status = 'sent', holder = NULL, lease_expires_at = NULL,
             sent_at = ?, updated_at = ?
         WHERE id = ? AND holder = ?`
      )
      .run(now, now, id, holder);
  }

  public retryDelivery(
    id: number,
    holder: string,
    attempts: number,
    retryAt: number,
    error: string
  ): void {
    this.database
      .prepare(
        `UPDATE delivery_outbox
         SET status = 'pending', holder = NULL, lease_expires_at = NULL,
             attempts = ?, retry_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND holder = ?`
      )
      .run(attempts, retryAt, error.slice(0, 2_000), Date.now(), id, holder);
  }

  public failDelivery(
    id: number,
    holder: string,
    attempts: number,
    now: number,
    error: string
  ): void {
    this.database
      .prepare(
        `UPDATE delivery_outbox
         SET status = 'failed', holder = NULL, lease_expires_at = NULL,
             attempts = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND holder = ?`
      )
      .run(attempts, error.slice(0, 2_000), now, id, holder);
  }

  public savePendingAction(record: PendingActionRecord, now: number): void {
    this.database
      .prepare(
        `INSERT INTO action_requests(
           id, idempotency_key, action_json, state, confirmation_json,
           operator_open_id, chat_id, scope_key, created_at, updated_at
         ) VALUES(?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.idempotencyKey,
        record.actionJson,
        record.confirmationJson,
        record.operatorOpenId,
        record.chatId,
        record.scopeKey,
        now,
        now
      );
  }

  public getPendingAction(id: string): PendingActionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, idempotency_key, action_json, confirmation_json,
                operator_open_id, chat_id, scope_key
         FROM action_requests WHERE id = ? AND state = 'pending'`
      )
      .get(id) as (PendingActionRow & {
        operator_open_id: string;
        chat_id: string;
        scope_key: string;
      }) | undefined;
    return row
      ? {
          id: row.id,
          idempotencyKey: row.idempotency_key,
          actionJson: row.action_json,
          confirmationJson: row.confirmation_json,
          operatorOpenId: row.operator_open_id,
          chatId: row.chat_id,
          scopeKey: row.scope_key
        }
      : undefined;
  }

  public claimPendingAction(
    id: string,
    operatorOpenId: string,
    chatId: string,
    scopeKey: string,
    now: number
  ): PendingActionRecord | undefined {
    return this.database.transaction(() => {
      const pending = this.getPendingAction(id);
      if (
        !pending ||
        pending.operatorOpenId !== operatorOpenId ||
        pending.chatId !== chatId ||
        pending.scopeKey !== scopeKey
      ) {
        return undefined;
      }
      const changed = this.database
        .prepare(
          `UPDATE action_requests SET state = 'executing', updated_at = ?
           WHERE id = ? AND state = 'pending' AND operator_open_id = ?
             AND chat_id = ? AND scope_key = ?`
        )
        .run(now, id, operatorOpenId, chatId, scopeKey).changes;
      return changed === 1 ? pending : undefined;
    })();
  }

  public rejectPendingAction(
    id: string,
    operatorOpenId: string,
    chatId: string,
    scopeKey: string,
    now: number
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE action_requests SET state = 'rejected', updated_at = ?
           WHERE id = ? AND state = 'pending' AND operator_open_id = ?
             AND chat_id = ? AND scope_key = ?`
        )
        .run(now, id, operatorOpenId, chatId, scopeKey).changes === 1
    );
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

  public interruptExecutingActions(now: number): number {
    return this.database
      .prepare(
        `UPDATE action_requests SET state = 'interrupted', updated_at = ?
         WHERE state = 'executing'`
      )
      .run(now).changes;
  }

  public health(): { journalMode: string; schemaVersion: number; integrity: string } {
    const mode = this.database.pragma("journal_mode", { simple: true });
    const row = this.database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    const integrity = this.database.pragma("integrity_check", { simple: true });
    return {
      journalMode: String(mode),
      schemaVersion: row.version,
      integrity: String(integrity)
    };
  }
}
