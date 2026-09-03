/**
 * Immutable execution target captured when a turn is queued.
 *
 * A queue item must not derive its target from the current conversation link
 * at execution time: the user may switch sessions while the item is waiting.
 */
export type TurnTarget =
  | {
      mode: "session";
      sessionId: string;
      cwd: string;
      /** Conflict that caused this retry, used for idempotent resolution. */
      conflictId?: string;
    }
  | {
      mode: "new";
      cwd: string;
      /** Conflict that caused this independent-session retry. */
      conflictId?: string;
    };

export type SessionConflictChoice = "wait" | "branch" | "cancel";

/** Lifecycle of a writer-conflict decision request. */
export type SessionConflictState =
  | "pending"
  | "waiting"
  | "branching"
  | "retrying"
  | "resolved"
  | "cancelled"
  | "failed"
  | "expired";

/**
 * Durable record behind the A/B choice card shown by Feishu when an external
 * Codex client owns a thread writer.
 */
export interface SessionConflictRecord {
  id: string;
  /** Opaque one-time token embedded in the card action. */
  token: string;
  scopeKey: string;
  chatId: string;
  operatorOpenId: string;
  /** The run/job that first observed the conflict. */
  runId: string;
  /** All coalesced turn job IDs represented by the failed run. */
  jobIds: string[];
  /** The target that was attempted and must remain stable for A. */
  target: Extract<TurnTarget, { mode: "session" }>;
  state: SessionConflictState;
  choice?: SessionConflictChoice;
  attempts: number;
  nextAttemptAt?: number;
  expiresAt: number;
  cardMessageId?: string;
  holder?: string;
  leaseExpiresAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

/** Partial mutable fields accepted by the state store. */
export interface SessionConflictPatch {
  state?: SessionConflictState;
  choice?: SessionConflictChoice | null;
  attempts?: number;
  nextAttemptAt?: number | null;
  cardMessageId?: string | null;
  holder?: string | null;
  leaseExpiresAt?: number | null;
  lastError?: string | null;
  resolvedAt?: number | null;
}
