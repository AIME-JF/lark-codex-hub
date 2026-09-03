import type Database from "better-sqlite3";
import type { ConversationLink } from "../../contracts/events.js";
import type {
  DeliveryRecord,
  DeliveryRequest,
  DeliveryTarget,
  InboundJobPayload,
  InboundJobRecord,
  ReactionTarget,
  TurnJobRecord,
  TurnJobState
} from "../../contracts/jobs.js";
import type {
  PresentationCard,
  TerminalReaction
} from "../../contracts/presentation.js";
import type {
  LifecycleEventRecord,
  LifecycleStateRecord,
  LifecycleStopReason
} from "../../contracts/lifecycle.js";
import type {
  SessionConflictChoice,
  SessionConflictPatch,
  SessionConflictRecord,
  SessionConflictState,
  TurnTarget
} from "../../contracts/session-routing.js";
import type {
  ActiveReactionRecord,
  LiveCardRecord,
  NewSessionIntentRecord,
  OutboxRecord,
  PendingActionRecord,
  PendingPromptRecord,
  RunRecord,
  StateRepository,
  SessionConflictRetryResult,
  TurnLaneRecord
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
  reaction_targets_json: string | null;
  target_key: string | null;
  revision: number | null;
}

// Keep all delivery lifecycle transitions on the same revision predicate. A
// row is current only when its keyed revision exactly matches the persisted
// target version; NULL/missing versions must never win over a newer card.
const deliveryLatestMatch = `
  (
    target_key IS NULL OR
    (
      revision IS NOT NULL AND EXISTS (
        SELECT 1 FROM delivery_target_versions AS latest
        WHERE latest.target_key = delivery_outbox.target_key
          AND latest.revision = delivery_outbox.revision
      )
    )
  )`;
const deliveryIsStale = `
  target_key IS NOT NULL AND NOT (
    revision IS NOT NULL AND EXISTS (
      SELECT 1 FROM delivery_target_versions AS latest
      WHERE latest.target_key = delivery_outbox.target_key
        AND latest.revision = delivery_outbox.revision
    )
  )`;

interface TurnJobRow {
  id: string;
  event_id: string;
  scope_key: string;
  lane_key: string;
  target_json: string | null;
  message_json: string;
  prompt: string;
  status: TurnJobState;
  created_at: number;
}

interface SessionConflictRow {
  id: string;
  token: string;
  scope_key: string;
  chat_id: string;
  operator_open_id: string;
  run_id: string;
  job_ids_json: string;
  target_json: string;
  state: SessionConflictState;
  choice: SessionConflictChoice | null;
  attempts: number;
  next_attempt_at: number | null;
  expires_at: number;
  card_message_id: string | null;
  holder: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

interface LiveCardRow {
  run_id: string;
  scope_key: string;
  source_message_id: string;
  card_message_id: string;
  card_json: string;
  status: "active" | "completed";
  updated_at: number;
}

interface RunRow {
  id: string;
  scope_key: string;
  session_id: string | null;
  state: RunRecord["state"];
  started_at: number;
  finished_at: number | null;
  error: string | null;
}

interface PendingPromptRow {
  scope_key: string;
  message_json: string;
  prompt: string;
  expires_at: number;
  created_at: number;
}

interface LifecycleStateRow {
  instance_id: string;
  boot_id: string;
  started_at: number;
  heartbeat_at: number;
  clean: number;
  stopped_at: number | null;
  stop_reason: LifecycleStopReason | null;
}

interface LifecycleEventRow {
  event_key: string;
  kind: LifecycleEventRecord["kind"];
  occurred_at: number;
  details_json: string;
  delivered_at: number | null;
}

function pendingPrompt(row: PendingPromptRow): PendingPromptRecord {
  return {
    scopeKey: row.scope_key,
    message: JSON.parse(row.message_json) as PendingPromptRecord["message"],
    prompt: row.prompt,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
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
    ...(row.terminal_reaction ? { terminalReaction: row.terminal_reaction } : {}),
    ...(row.reaction_targets_json
      ? { reactionTargets: JSON.parse(row.reaction_targets_json) as ReactionTarget[] }
      : {}),
    ...(row.target_key ? { targetKey: row.target_key } : {}),
    ...(row.revision === null ? {} : { revision: row.revision })
  };
}

function turnJob(row: TurnJobRow): TurnJobRecord {
  const target = parseTurnTarget(row.target_json);
  return {
    id: row.id,
    eventId: row.event_id,
    scopeKey: row.scope_key,
    laneKey: row.lane_key,
    ...(target ? { target } : {}),
    message: JSON.parse(row.message_json) as TurnJobRecord["message"],
    prompt: row.prompt,
    state: row.status,
    createdAt: row.created_at
  };
}

function liveCard(row: LiveCardRow): LiveCardRecord {
  return {
    runId: row.run_id,
    scopeKey: row.scope_key,
    sourceMessageId: row.source_message_id,
    cardMessageId: row.card_message_id,
    cardJson: row.card_json,
    state: row.status,
    updatedAt: row.updated_at
  };
}

function runRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    state: row.state,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.error ? { error: row.error } : {})
  };
}

function parseTurnTarget(value: string | null): TurnTarget | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const mode = record.mode;
    const cwd = record.cwd;
    const conflictId = typeof record.conflictId === "string" && record.conflictId
      ? record.conflictId
      : undefined;
    if (typeof cwd !== "string" || !cwd) {
      return undefined;
    }
    if (mode === "new") {
      return { mode, cwd, ...(conflictId ? { conflictId } : {}) };
    }
    if (mode === "session" && typeof record.sessionId === "string" && record.sessionId) {
      return {
        mode,
        sessionId: record.sessionId,
        cwd,
        ...(conflictId ? { conflictId } : {})
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sessionConflict(row: SessionConflictRow): SessionConflictRecord {
  const target = parseTurnTarget(row.target_json);
  if (!target || target.mode !== "session") {
    throw new Error(`会话冲突记录 ${row.id} 的执行目标无效。`);
  }
  let jobIds: string[];
  try {
    const parsed: unknown = JSON.parse(row.job_ids_json);
    jobIds = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    jobIds = [];
  }
  return {
    id: row.id,
    token: row.token,
    scopeKey: row.scope_key,
    chatId: row.chat_id,
    operatorOpenId: row.operator_open_id,
    runId: row.run_id,
    jobIds,
    target,
    state: row.state,
    ...(row.choice === null ? {} : { choice: row.choice }),
    attempts: row.attempts,
    ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
    expiresAt: row.expires_at,
    ...(row.card_message_id === null ? {} : { cardMessageId: row.card_message_id }),
    ...(row.holder === null ? {} : { holder: row.holder }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at })
  };
}

function lifecycleState(row: LifecycleStateRow): LifecycleStateRecord {
  return {
    instanceId: row.instance_id,
    bootId: row.boot_id,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    clean: row.clean === 1,
    ...(row.stopped_at === null ? {} : { stoppedAt: row.stopped_at }),
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {})
  };
}

function lifecycleEvent(row: LifecycleEventRow): LifecycleEventRecord {
  return {
    key: row.event_key,
    kind: row.kind,
    occurredAt: row.occurred_at,
    detailsJson: row.details_json,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at })
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

  public beginLifecycleInstance(
    record: LifecycleStateRecord
  ): LifecycleStateRecord | undefined {
    return this.database.transaction(() => {
      const previous = this.database
        .prepare(
          `SELECT instance_id, boot_id, started_at, heartbeat_at,
                  clean, stopped_at, stop_reason
           FROM lifecycle_state WHERE singleton = 1`
        )
        .get() as LifecycleStateRow | undefined;
      this.database
        .prepare(
          `INSERT INTO lifecycle_state(
             singleton, instance_id, boot_id, started_at, heartbeat_at,
             clean, stopped_at, stop_reason
           ) VALUES(1, ?, ?, ?, ?, 0, NULL, NULL)
           ON CONFLICT(singleton) DO UPDATE SET
             instance_id = excluded.instance_id,
             boot_id = excluded.boot_id,
             started_at = excluded.started_at,
             heartbeat_at = excluded.heartbeat_at,
             clean = 0,
             stopped_at = NULL,
             stop_reason = NULL`
        )
        .run(record.instanceId, record.bootId, record.startedAt, record.heartbeatAt);
      return previous ? lifecycleState(previous) : undefined;
    })();
  }

  public heartbeatLifecycle(instanceId: string, now: number): boolean {
    return this.database
      .prepare(
        `UPDATE lifecycle_state SET heartbeat_at = ?
         WHERE singleton = 1 AND instance_id = ? AND clean = 0`
      )
      .run(now, instanceId).changes === 1;
  }

  public finishLifecycle(
    instanceId: string,
    reason: LifecycleStopReason,
    now: number
  ): boolean {
    return this.database
      .prepare(
        `UPDATE lifecycle_state
         SET heartbeat_at = ?, clean = 1, stopped_at = ?, stop_reason = ?
         WHERE singleton = 1 AND instance_id = ? AND clean = 0`
      )
      .run(now, now, reason, instanceId).changes === 1;
  }

  public recordLifecycleEvent(record: LifecycleEventRecord): boolean {
    return this.database
      .prepare(
        `INSERT OR IGNORE INTO lifecycle_events(
           event_key, kind, occurred_at, details_json, delivered_at
         ) VALUES(?, ?, ?, ?, ?)`
      )
      .run(
        record.key,
        record.kind,
        record.occurredAt,
        record.detailsJson,
        record.deliveredAt ?? null
      ).changes === 1;
  }

  public getLatestLifecycleEvent(after: number): LifecycleEventRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT event_key, kind, occurred_at, details_json, delivered_at
         FROM lifecycle_events WHERE occurred_at >= ?
         ORDER BY occurred_at DESC LIMIT 1`
      )
      .get(after) as LifecycleEventRow | undefined;
    return row ? lifecycleEvent(row) : undefined;
  }

  public markLifecycleEventDelivered(key: string, at: number): void {
    this.database
      .prepare(
        `UPDATE lifecycle_events SET delivered_at = COALESCE(delivered_at, ?)
         WHERE event_key = ?`
      )
      .run(at, key);
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
           WHERE updated_at < ? AND status IN ('sent', 'failed', 'superseded')`
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
      const turns = this.database
        .prepare(
          `DELETE FROM turn_jobs
           WHERE updated_at < ? AND status IN (
             'completed', 'failed', 'cancelled', 'interrupted'
           )`
        )
        .run(before).changes;
      const cards = this.database
        .prepare("DELETE FROM live_cards WHERE updated_at < ? AND status = 'completed'")
        .run(before).changes;
      const conflicts = this.database
        .prepare(
          `DELETE FROM session_conflicts
           WHERE updated_at < ? AND state IN ('resolved', 'cancelled', 'failed', 'expired')`
        )
        .run(before).changes;
      const inbox = this.database
        .prepare("DELETE FROM inbox_dedup WHERE received_at < ?")
        .run(before).changes;
      return inbound + deliveries + actions + turns + cards + conflicts + inbox;
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
        .prepare("DELETE FROM new_session_intents WHERE scope_key = ?")
        .run(link.scopeKey);
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

  public getNewSessionIntent(scopeKey: string): NewSessionIntentRecord | undefined {
    const row = this.database
      .prepare("SELECT scope_key, cwd, updated_at FROM new_session_intents WHERE scope_key = ?")
      .get(scopeKey) as { scope_key: string; cwd: string; updated_at: number } | undefined;
    return row
      ? { scopeKey: row.scope_key, cwd: row.cwd, updatedAt: row.updated_at }
      : undefined;
  }

  public setNewSessionIntent(record: NewSessionIntentRecord): void {
    this.database
      .prepare(
        `INSERT INTO new_session_intents(scope_key, cwd, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           cwd = excluded.cwd, updated_at = excluded.updated_at`
      )
      .run(record.scopeKey, record.cwd, record.updatedAt);
  }

  public clearNewSessionIntent(scopeKey: string): void {
    this.database.prepare("DELETE FROM new_session_intents WHERE scope_key = ?").run(scopeKey);
  }

  public getProject(scopeKey: string): string | undefined {
    const row = this.database
      .prepare("SELECT cwd FROM project_preferences WHERE scope_key = ?")
      .get(scopeKey) as { cwd: string } | undefined;
    return row?.cwd;
  }

  public setProject(scopeKey: string, cwd: string, now: number): void {
    this.database
      .prepare(
        `INSERT INTO project_preferences(scope_key, cwd, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at`
      )
      .run(scopeKey, cwd, now);
  }

  public clearProject(scopeKey: string): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM project_preferences WHERE scope_key = ?").run(scopeKey);
      this.clearNewSessionIntent(scopeKey);
    })();
  }

  public getWorkspace(scopeKey: string): string | undefined {
    return this.getProject(scopeKey);
  }

  public setWorkspace(scopeKey: string, cwd: string, now: number): void {
    this.setProject(scopeKey, cwd, now);
  }

  public savePendingPrompt(record: PendingPromptRecord): void {
    this.database
      .prepare(
        `INSERT INTO pending_prompts(scope_key, message_json, prompt, expires_at, created_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(scope_key) DO UPDATE SET
           message_json = excluded.message_json,
           prompt = excluded.prompt,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at`
      )
      .run(
        record.scopeKey,
        JSON.stringify(record.message),
        record.prompt,
        record.expiresAt,
        record.createdAt
      );
  }

  public getPendingPrompt(scopeKey: string, now: number): PendingPromptRecord | undefined {
    this.database.prepare("DELETE FROM pending_prompts WHERE expires_at <= ?").run(now);
    const row = this.database
      .prepare(
        `SELECT scope_key, message_json, prompt, expires_at, created_at
         FROM pending_prompts WHERE scope_key = ?`
      )
      .get(scopeKey) as PendingPromptRow | undefined;
    return row ? pendingPrompt(row) : undefined;
  }

  public consumePendingPrompt(scopeKey: string, now: number): PendingPromptRecord | undefined {
    return this.database.transaction(() => {
      const record = this.getPendingPrompt(scopeKey, now);
      if (record) {
        this.clearPendingPrompt(scopeKey);
      }
      return record;
    })();
  }

  public clearPendingPrompt(scopeKey: string): void {
    this.database.prepare("DELETE FROM pending_prompts WHERE scope_key = ?").run(scopeKey);
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

  public getLatestRun(scopeKey: string): RunRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, scope_key, session_id, state, started_at, finished_at, error
         FROM runs WHERE scope_key = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`
      )
      .get(scopeKey) as RunRow | undefined;
    return row ? runRecord(row) : undefined;
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

  public enqueueTurnJob(record: TurnJobRecord): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO turn_jobs(
           id, event_id, scope_key, lane_key, target_json, message_json, prompt,
           status, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        record.id,
        record.eventId,
        record.scopeKey,
        record.laneKey,
        record.target ? JSON.stringify(record.target) : null,
        JSON.stringify(record.message),
        record.prompt,
        record.createdAt,
        record.createdAt
      );
    return result.changes === 1;
  }

  public getTurnJob(id: string): TurnJobRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, event_id, scope_key, lane_key, target_json, message_json, prompt,
                status, created_at
         FROM turn_jobs WHERE id = ?`
      )
      .get(id) as TurnJobRow | undefined;
    return row ? turnJob(row) : undefined;
  }

  public retargetPendingTurnJobs(
    ids: readonly string[],
    target: TurnTarget,
    laneKey: string,
    now: number
  ): number {
    if (ids.length === 0) {
      return 0;
    }
    const placeholders = ids.map(() => "?").join(", ");
    return this.database
      .prepare(
        `UPDATE turn_jobs
         SET target_json = ?, lane_key = ?, updated_at = ?
         WHERE status = 'pending' AND id IN (${placeholders})`
      )
      .run(JSON.stringify(target), laneKey, now, ...ids).changes;
  }

  /**
   * Atomically move a conflict into retrying and transfer all represented
   * jobs to the frozen target. Keeping the CAS, child inserts, deferred-job
   * retargeting and source supersession in one SQLite transaction prevents a
   * process crash from leaving a half-created retry batch.
   */
  public commitSessionConflictRetry(
    conflictId: string,
    expectedState: SessionConflictState,
    target: TurnTarget,
    laneKey: string,
    attempts: number,
    childRecords: readonly TurnJobRecord[],
    retargetJobIds: readonly string[],
    supersedeJobIds: readonly string[],
    supersedeError: string,
    now: number
  ): SessionConflictRetryResult {
    return this.database.transaction(() => {
      const updated = this.database
        .prepare(
          `UPDATE session_conflicts
           SET state = 'retrying', attempts = ?, next_attempt_at = ?,
               last_error = NULL, updated_at = ?
           WHERE id = ? AND state = ?`
        )
        .run(attempts, now, now, conflictId, expectedState).changes === 1;
      if (!updated) {
        return { updated: false, inserted: 0, retargeted: 0 };
      }

      const insertChild = this.database.prepare(
        `INSERT OR IGNORE INTO turn_jobs(
           id, event_id, scope_key, lane_key, target_json, message_json, prompt,
           status, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      );
      let inserted = 0;
      for (const record of childRecords) {
        inserted += insertChild.run(
          record.id,
          record.eventId,
          record.scopeKey,
          record.laneKey,
          record.target ? JSON.stringify(record.target) : null,
          JSON.stringify(record.message),
          record.prompt,
          record.createdAt,
          record.createdAt
        ).changes;
      }

      let retargeted = 0;
      if (retargetJobIds.length > 0) {
        const placeholders = retargetJobIds.map(() => "?").join(", ");
        retargeted = this.database
          .prepare(
            `UPDATE turn_jobs
             SET target_json = ?, lane_key = ?, updated_at = ?
             WHERE status = 'pending' AND id IN (${placeholders})`
          )
          .run(
            JSON.stringify(target),
            laneKey,
            now,
            ...retargetJobIds
          ).changes;
      }

      if (supersedeJobIds.length > 0) {
        const placeholders = supersedeJobIds.map(() => "?").join(", ");
        this.database
          .prepare(
            `UPDATE turn_jobs
             SET status = 'cancelled', holder = NULL, finished_at = ?,
                 updated_at = ?, last_error = ?
             WHERE status IN ('pending', 'failed', 'interrupted')
               AND id IN (${placeholders})`
          )
          .run(
            now,
            now,
            supersedeError.slice(0, 2_000),
            ...supersedeJobIds
          );
      }

      return { updated: true, inserted, retargeted };
    })();
  }

  public getRetryableTurn(scopeKey: string, id?: string): TurnJobRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, event_id, scope_key, lane_key, target_json, message_json, prompt,
                status, created_at
         FROM turn_jobs
           WHERE scope_key = ?
           AND status IN ('failed', 'interrupted')
           AND (
             last_error LIKE 'session_busy:%'
             OR (target_json IS NOT NULL AND target_json LIKE '%\"conflictId\"%')
           )
           AND (? IS NULL OR id = ?)
         ORDER BY updated_at DESC, rowid DESC LIMIT 1`
      )
      .get(scopeKey, id ?? null, id ?? null) as TurnJobRow | undefined;
    return row ? turnJob(row) : undefined;
  }

  public listReadyTurnLanes(before: number, limit: number): TurnLaneRecord[] {
    return this.database
      .prepare(
        `SELECT lane_key, scope_key
         FROM turn_jobs
         WHERE status = 'pending'
         GROUP BY lane_key, scope_key
         HAVING MIN(created_at) <= ?
         ORDER BY MIN(created_at) ASC
         LIMIT ?`
      )
      .all(before, limit)
      .map((row) => {
        const value = row as { lane_key: string; scope_key: string };
        return { laneKey: value.lane_key, scopeKey: value.scope_key };
      });
  }

  public claimTurnBatch(
    laneKey: string,
    scopeKey: string,
    holder: string,
    now: number,
    coalesceMs: number
  ): TurnJobRecord[] {
    return this.database.transaction(() => {
      const first = this.database
        .prepare(
          `SELECT id, event_id, scope_key, lane_key, target_json, message_json, prompt,
                  status, created_at
           FROM turn_jobs
           WHERE status = 'pending' AND lane_key = ? AND scope_key = ?
           ORDER BY created_at ASC, rowid ASC LIMIT 1`
        )
        .get(laneKey, scopeKey) as TurnJobRow | undefined;
      if (!first) {
        return [];
      }
      const rows = this.database
        .prepare(
          `SELECT id, event_id, scope_key, lane_key, target_json, message_json, prompt,
                  status, created_at
           FROM turn_jobs
           WHERE status = 'pending' AND lane_key = ? AND scope_key = ?
             AND created_at <= ?
           ORDER BY created_at ASC, rowid ASC LIMIT 20`
        )
        .all(laneKey, scopeKey, first.created_at + coalesceMs) as TurnJobRow[];
      if (rows.length === 0) {
        return [];
      }
      const placeholders = rows.map(() => "?").join(", ");
      const ids = rows.map((row) => row.id);
      const changed = this.database
        .prepare(
          `UPDATE turn_jobs
           SET status = 'running', holder = ?, started_at = ?, updated_at = ?
           WHERE status = 'pending' AND id IN (${placeholders})`
        )
        .run(holder, now, now, ...ids).changes;
      return changed === ids.length
        ? rows.map((row) => turnJob({ ...row, status: "running" }))
        : [];
    })();
  }

  public finishTurnJobs(
    ids: readonly string[],
    state: Exclude<TurnJobState, "pending" | "running">,
    now: number,
    error?: string
  ): void {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(", ");
    this.database
      .prepare(
        `UPDATE turn_jobs
         SET status = ?, holder = NULL, finished_at = ?, updated_at = ?, last_error = ?
         WHERE id IN (${placeholders})`
      )
      .run(state, now, now, error?.slice(0, 2_000) ?? null, ...ids);
  }

  public cancelPendingTurns(scopeKey: string, now: number): TurnJobRecord[] {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT id, event_id, scope_key, lane_key, target_json, message_json, prompt,
                  status, created_at
           FROM turn_jobs WHERE scope_key = ? AND status = 'pending'
           ORDER BY created_at ASC`
        )
        .all(scopeKey) as TurnJobRow[];
      this.database
        .prepare(
          `UPDATE turn_jobs SET status = 'cancelled', finished_at = ?, updated_at = ?
           WHERE scope_key = ? AND status = 'pending'`
        )
        .run(now, now, scopeKey);
      return rows.map(turnJob);
    })();
  }

  public listPendingTurns(scopeKey: string, limit: number): TurnJobRecord[] {
    return (
      this.database
        .prepare(
          `SELECT id, event_id, scope_key, lane_key, target_json, message_json, prompt,
                  status, created_at
           FROM turn_jobs WHERE scope_key = ? AND status = 'pending'
           ORDER BY created_at ASC LIMIT ?`
        )
        .all(scopeKey, limit) as TurnJobRow[]
    ).map(turnJob);
  }

  public countPendingTurns(scopeKey: string): number {
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM turn_jobs WHERE scope_key = ? AND status = 'pending'"
      )
      .get(scopeKey) as { count: number };
    return row.count;
  }

  public recoverTurnJobs(now: number): TurnJobRecord[] {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT id, event_id, scope_key, lane_key, target_json, message_json, prompt,
                  status, created_at
           FROM turn_jobs WHERE status = 'running' ORDER BY created_at ASC`
        )
        .all() as TurnJobRow[];
      this.database
        .prepare(
          `UPDATE turn_jobs SET status = 'interrupted', holder = NULL,
             finished_at = ?, updated_at = ?,
             last_error = COALESCE(last_error, '服务重启时任务仍处于运行状态。')
           WHERE status = 'running'`
        )
        .run(now, now);
      return rows.map(turnJob);
    })();
  }

  public saveSessionConflict(record: SessionConflictRecord): void {
    this.database
      .prepare(
        `INSERT INTO session_conflicts(
           id, token, scope_key, chat_id, operator_open_id, run_id,
           job_ids_json, target_json, state, choice, attempts,
           next_attempt_at, expires_at, card_message_id, holder,
           lease_expires_at, last_error, created_at, updated_at, resolved_at
         ) VALUES(
           @id, @token, @scopeKey, @chatId, @operatorOpenId, @runId,
           @jobIdsJson, @targetJson, @state, @choice, @attempts,
           @nextAttemptAt, @expiresAt, @cardMessageId, @holder,
           @leaseExpiresAt, @lastError, @createdAt, @updatedAt, @resolvedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           job_ids_json = excluded.job_ids_json,
           target_json = excluded.target_json,
           state = excluded.state,
           choice = excluded.choice,
           attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at,
           expires_at = excluded.expires_at,
           card_message_id = excluded.card_message_id,
           holder = excluded.holder,
           lease_expires_at = excluded.lease_expires_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at,
           resolved_at = excluded.resolved_at
         WHERE session_conflicts.token = excluded.token`
      )
      .run({
        id: record.id,
        token: record.token,
        scopeKey: record.scopeKey,
        chatId: record.chatId,
        operatorOpenId: record.operatorOpenId,
        runId: record.runId,
        jobIdsJson: JSON.stringify(record.jobIds),
        targetJson: JSON.stringify(record.target),
        state: record.state,
        choice: record.choice ?? null,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt ?? null,
        expiresAt: record.expiresAt,
        cardMessageId: record.cardMessageId ?? null,
        holder: record.holder ?? null,
        leaseExpiresAt: record.leaseExpiresAt ?? null,
        lastError: record.lastError ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        resolvedAt: record.resolvedAt ?? null
      });
  }

  public getSessionConflict(id: string): SessionConflictRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, token, scope_key, chat_id, operator_open_id, run_id,
                job_ids_json, target_json, state, choice, attempts,
                next_attempt_at, expires_at, card_message_id, holder,
                lease_expires_at, last_error, created_at, updated_at, resolved_at
         FROM session_conflicts WHERE id = ?`
      )
      .get(id) as SessionConflictRow | undefined;
    return row ? sessionConflict(row) : undefined;
  }

  public listSessionConflicts(
    states: readonly SessionConflictState[]
  ): SessionConflictRecord[] {
    if (states.length === 0) {
      return [];
    }
    const placeholders = states.map(() => "?").join(", ");
    return (
      this.database
        .prepare(
          `SELECT id, token, scope_key, chat_id, operator_open_id, run_id,
                  job_ids_json, target_json, state, choice, attempts,
                  next_attempt_at, expires_at, card_message_id, holder,
                  lease_expires_at, last_error, created_at, updated_at, resolved_at
           FROM session_conflicts
           WHERE state IN (${placeholders})
           ORDER BY updated_at ASC, rowid ASC`
        )
        .all(...states) as SessionConflictRow[]
    ).map(sessionConflict);
  }

  public getOpenSessionConflict(
    scopeKey: string,
    now = Date.now()
  ): SessionConflictRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, token, scope_key, chat_id, operator_open_id, run_id,
                job_ids_json, target_json, state, choice, attempts,
                next_attempt_at, expires_at, card_message_id, holder,
                lease_expires_at, last_error, created_at, updated_at, resolved_at
          FROM session_conflicts
          WHERE scope_key = ?
            AND state IN ('pending', 'waiting', 'branching', 'retrying')
            AND (state = 'retrying' OR expires_at > ?)
          ORDER BY updated_at DESC, rowid DESC LIMIT 1`
      )
      .get(scopeKey, now) as SessionConflictRow | undefined;
    return row ? sessionConflict(row) : undefined;
  }

  public claimSessionConflict(
    id: string,
    token: string,
    operatorOpenId: string,
    chatId: string,
    scopeKey: string,
    choice: SessionConflictChoice,
    now: number,
    cardMessageId?: string
  ): SessionConflictRecord | undefined {
    const state: SessionConflictState =
      choice === "wait" ? "waiting" : choice === "branch" ? "branching" : "cancelled";
    const result = this.database
      .prepare(
        `UPDATE session_conflicts
         SET state = ?, choice = ?, card_message_id = COALESCE(?, card_message_id), updated_at = ?,
             resolved_at = CASE WHEN ? = 'cancel' THEN ? ELSE resolved_at END,
             holder = NULL, lease_expires_at = NULL
         WHERE id = ? AND token = ? AND operator_open_id = ?
           AND chat_id = ? AND scope_key = ? AND state = 'pending'
           AND expires_at > ?`
      )
      .run(
        state,
        choice,
        cardMessageId ?? null,
        now,
        choice,
        now,
        id,
        token,
        operatorOpenId,
        chatId,
        scopeKey,
        now
      );
    if (result.changes !== 1) {
      return undefined;
    }
    return this.getSessionConflict(id);
  }

  public updateSessionConflict(
    id: string,
    patch: SessionConflictPatch,
    now: number,
    expectedStates?: readonly SessionConflictState[]
  ): boolean {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.state !== undefined) {
      assignments.push("state = ?");
      values.push(patch.state);
    }
    if (patch.choice !== undefined) {
      assignments.push("choice = ?");
      values.push(patch.choice);
    }
    if (patch.attempts !== undefined) {
      assignments.push("attempts = ?");
      values.push(patch.attempts);
    }
    if (patch.nextAttemptAt !== undefined) {
      assignments.push("next_attempt_at = ?");
      values.push(patch.nextAttemptAt);
    }
    if (patch.cardMessageId !== undefined) {
      assignments.push("card_message_id = ?");
      values.push(patch.cardMessageId);
    }
    if (patch.holder !== undefined) {
      assignments.push("holder = ?");
      values.push(patch.holder);
    }
    if (patch.leaseExpiresAt !== undefined) {
      assignments.push("lease_expires_at = ?");
      values.push(patch.leaseExpiresAt);
    }
    if (patch.lastError !== undefined) {
      assignments.push("last_error = ?");
      values.push(patch.lastError?.slice(0, 2_000) ?? null);
    }
    if (patch.resolvedAt !== undefined) {
      assignments.push("resolved_at = ?");
      values.push(patch.resolvedAt);
    }
    assignments.push("updated_at = ?");
    values.push(now);
    values.push(id);
    const stateFilter = expectedStates?.length
      ? ` AND state IN (${expectedStates.map(() => "?").join(", ")})`
      : "";
    if (expectedStates?.length) {
      values.push(...expectedStates);
    }
    return this.database
      .prepare(
        `UPDATE session_conflicts SET ${assignments.join(", ")} WHERE id = ?${stateFilter}`
      )
      .run(...values).changes === 1;
  }

  public rotateSessionConflictToken(
    id: string,
    expectedToken: string,
    nextToken: string,
    now: number
  ): boolean {
    return this.database
      .prepare(
        `UPDATE session_conflicts
         SET token = ?, updated_at = ?
         WHERE id = ? AND token = ?
           AND state IN ('pending', 'waiting', 'branching', 'retrying')`
      )
      .run(nextToken, now, id, expectedToken).changes === 1;
  }

  public listTurnJobsByConflict(
    scopeKey: string,
    conflictId: string
  ): TurnJobRecord[] {
    return (
      this.database
        .prepare(
          `SELECT id, event_id, scope_key, lane_key, target_json, message_json, prompt,
                  status, created_at
           FROM turn_jobs
           WHERE scope_key = ? AND target_json IS NOT NULL
           ORDER BY created_at ASC, rowid ASC`
        )
        .all(scopeKey) as TurnJobRow[]
    )
      .map(turnJob)
      .filter((job) => job.target?.conflictId === conflictId);
  }

  public saveLiveCard(record: LiveCardRecord): void {
    this.database
      .prepare(
        `INSERT INTO live_cards(
           run_id, scope_key, source_message_id, card_message_id,
           card_json, status, updated_at
         ) VALUES(@runId, @scopeKey, @sourceMessageId, @cardMessageId,
                  @cardJson, @state, @updatedAt)
         ON CONFLICT(run_id) DO UPDATE SET
           card_message_id = excluded.card_message_id,
           card_json = excluded.card_json,
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .run(record);
  }

  public getLiveCard(runId: string): LiveCardRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT run_id, scope_key, source_message_id, card_message_id,
                card_json, status, updated_at
         FROM live_cards WHERE run_id = ?`
      )
      .get(runId) as LiveCardRow | undefined;
    return row ? liveCard(row) : undefined;
  }

  public listActiveLiveCards(): LiveCardRecord[] {
    return (
      this.database
        .prepare(
          `SELECT run_id, scope_key, source_message_id, card_message_id,
                  card_json, status, updated_at
           FROM live_cards WHERE status = 'active' ORDER BY updated_at ASC`
        )
        .all() as LiveCardRow[]
    ).map(liveCard);
  }

  public finishLiveCard(runId: string, now: number): void {
    this.database
      .prepare(
        "UPDATE live_cards SET status = 'completed', updated_at = ? WHERE run_id = ?"
      )
      .run(now, runId);
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
    return this.database.transaction(() => {
      const existing = this.database
        .prepare("SELECT 1 FROM delivery_outbox WHERE idempotency_key = ?")
        .get(record.idempotencyKey);
      if (existing) {
        return false;
      }
      const targetKey = record.target.kind === "update"
        ? `card:${record.target.messageId}`
        : undefined;
      let revision: number | undefined;
      if (targetKey) {
        const row = this.database
          .prepare(
            `INSERT INTO delivery_target_versions(target_key, revision)
             VALUES(?, 1)
             ON CONFLICT(target_key) DO UPDATE SET revision = revision + 1
             RETURNING revision`
          )
          .get(targetKey) as { revision: number };
        revision = row.revision;
        this.database
          .prepare(
            `UPDATE delivery_outbox
             SET status = 'superseded', updated_at = ?,
                 last_error = '已被更新版本替代。'
             WHERE target_key = ? AND status = 'pending'`
          )
          .run(now, targetKey);
      }
      const result = this.database
        .prepare(
          `INSERT INTO delivery_outbox(
             idempotency_key, target_json, card_json, tracker_id, terminal_reaction,
             reaction_targets_json, target_key, revision,
             retry_at, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.idempotencyKey,
          JSON.stringify(record.target),
          JSON.stringify(record.card),
          record.trackerId ?? null,
          record.terminalReaction ?? null,
          record.reactionTargets ? JSON.stringify(record.reactionTargets) : null,
          targetKey ?? null,
          revision ?? null,
          now,
          now,
          now
        );
      return result.changes === 1;
    })();
  }

  public claimDelivery(
    holder: string,
    now: number,
    ttlMs: number
  ): DeliveryRecord | undefined {
    return this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE delivery_outbox
           SET status = 'superseded', holder = NULL, lease_expires_at = NULL, updated_at = ?,
               last_error = '已被更新版本替代。'
           WHERE target_key IS NOT NULL
             AND (
               status = 'pending' OR
               (status = 'processing' AND lease_expires_at <= ?)
             )
             AND ${deliveryIsStale}`
        )
        .run(now, now);
      const row = this.database
        .prepare(
          `SELECT id, idempotency_key, target_json, card_json, attempts,
                  tracker_id, terminal_reaction, reaction_targets_json,
                  target_key, revision
           FROM delivery_outbox
           WHERE retry_at <= ? AND (
             status = 'pending' OR
             (status = 'processing' AND lease_expires_at <= ?)
           )
             AND ${deliveryLatestMatch}
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
           )
             AND ${deliveryLatestMatch}`
        )
        .run(holder, now + ttlMs, now, row.id, now);
      return result.changes === 1
        ? { ...delivery(row), attempts: row.attempts + 1 }
        : undefined;
    })();
  }

  public completeDelivery(id: number, holder: string, now: number): boolean {
    const row = this.database
      .prepare(
        `UPDATE delivery_outbox
         SET status = CASE WHEN ${deliveryLatestMatch}
               THEN 'sent' ELSE 'superseded' END,
             last_error = CASE WHEN ${deliveryLatestMatch}
               THEN last_error ELSE '已被更新版本替代。' END,
             holder = NULL, lease_expires_at = NULL,
             sent_at = CASE WHEN ${deliveryLatestMatch} THEN ? ELSE sent_at END,
             updated_at = ?
         WHERE id = ? AND holder = ?
         RETURNING status`
      )
      .get(now, now, id, holder) as { status: "sent" | "superseded" } | undefined;
    return row?.status === "sent";
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
         SET status = CASE WHEN ${deliveryLatestMatch}
               THEN 'pending' ELSE 'superseded' END,
             holder = NULL, lease_expires_at = NULL,
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
         SET status = CASE WHEN ${deliveryLatestMatch}
               THEN 'failed' ELSE 'superseded' END,
             last_error = CASE WHEN ${deliveryLatestMatch}
               THEN ? ELSE '已被更新版本替代。' END,
             holder = NULL, lease_expires_at = NULL,
             attempts = ?, updated_at = ?
         WHERE id = ? AND holder = ?`
      )
      .run(error.slice(0, 2_000), attempts, now, id, holder);
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
