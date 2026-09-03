import type { ConversationLink, InboundMessage } from "../contracts/events.js";
import type { ReactionEmoji } from "../contracts/presentation.js";
import type {
  DeliveryRecord,
  DeliveryRequest,
  InboundJobPayload,
  InboundJobRecord,
  TurnJobRecord,
  TurnJobState
} from "../contracts/jobs.js";
import type {
  LifecycleEventRecord,
  LifecycleStateRecord,
  LifecycleStopReason
} from "../contracts/lifecycle.js";
import type {
  SessionConflictChoice,
  SessionConflictPatch,
  SessionConflictRecord,
  SessionConflictState,
  TurnTarget
} from "../contracts/session-routing.js";

export interface RunRecord {
  id: string;
  scopeKey: string;
  sessionId?: string;
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface OutboxRecord {
  id: number;
  idempotencyKey: string;
  targetType: "open_id" | "chat_id";
  targetId: string;
  text: string;
  attempts: number;
}

export interface PendingActionRecord {
  id: string;
  idempotencyKey: string;
  actionJson: string;
  confirmationJson: string;
  operatorOpenId: string;
  chatId: string;
  scopeKey: string;
}

export interface ActiveReactionRecord {
  trackerId: string;
  messageId: string;
  reactionId: string;
  emoji: ReactionEmoji;
  updatedAt: number;
}

export interface LiveCardRecord {
  runId: string;
  scopeKey: string;
  sourceMessageId: string;
  cardMessageId: string;
  cardJson: string;
  state: "active" | "completed";
  updatedAt: number;
}

export interface TurnLaneRecord {
  laneKey: string;
  scopeKey: string;
}

export interface SessionConflictRetryResult {
  updated: boolean;
  inserted: number;
  retargeted: number;
}

export interface PendingPromptRecord {
  scopeKey: string;
  message: InboundMessage;
  prompt: string;
  expiresAt: number;
  createdAt: number;
}

export interface NewSessionIntentRecord {
  scopeKey: string;
  cwd: string;
  updatedAt: number;
}

export interface StateRepository {
  migrate(): void;
  close(): void;
  beginLifecycleInstance(record: LifecycleStateRecord): LifecycleStateRecord | undefined;
  heartbeatLifecycle(instanceId: string, now: number): boolean;
  finishLifecycle(instanceId: string, reason: LifecycleStopReason, now: number): boolean;
  recordLifecycleEvent(record: LifecycleEventRecord): boolean;
  getLatestLifecycleEvent(after: number): LifecycleEventRecord | undefined;
  markLifecycleEventDelivered(key: string, at: number): void;
  claimInbox(eventId: string, messageId: string, now: number): boolean;
  pruneInbox(before: number): number;
  enqueueInbound(eventId: string, messageId: string, payload: InboundJobPayload, now: number): boolean;
  claimInbound(holder: string, now: number, ttlMs: number): InboundJobRecord | undefined;
  heartbeatInbound(id: number, holder: string, now: number, ttlMs: number): boolean;
  completeInbound(id: number, holder: string, now: number): void;
  failInbound(id: number, holder: string, now: number, error: string): void;
  recoverInbound(now: number): { interruptedMessages: InboundJobRecord[]; requeued: number };
  getConversation(scopeKey: string): ConversationLink | undefined;
  listConversations(scopeKey: string, limit: number): ConversationLink[];
  bindConversation(link: ConversationLink): void;
  clearConversation(scopeKey: string): void;
  getNewSessionIntent(scopeKey: string): NewSessionIntentRecord | undefined;
  setNewSessionIntent(record: NewSessionIntentRecord): void;
  clearNewSessionIntent(scopeKey: string): void;
  getProject(scopeKey: string): string | undefined;
  setProject(scopeKey: string, cwd: string, now: number): void;
  clearProject(scopeKey: string): void;
  /** @deprecated 使用 getProject。 */
  getWorkspace(scopeKey: string): string | undefined;
  /** @deprecated 使用 setProject。 */
  setWorkspace(scopeKey: string, cwd: string, now: number): void;
  savePendingPrompt(record: PendingPromptRecord): void;
  getPendingPrompt(scopeKey: string, now: number): PendingPromptRecord | undefined;
  consumePendingPrompt(scopeKey: string, now: number): PendingPromptRecord | undefined;
  clearPendingPrompt(scopeKey: string): void;
  rememberP2pScope(openId: string, scopeKey: string, now: number): void;
  resolveP2pScope(openId: string): string | undefined;
  acquireLease(scopeKey: string, holder: string, now: number, ttlMs: number): boolean;
  heartbeatLease(scopeKey: string, holder: string, now: number, ttlMs: number): boolean;
  releaseLease(scopeKey: string, holder: string): void;
  createRun(run: RunRecord): void;
  finishRun(id: string, state: RunRecord["state"], finishedAt: number, error?: string): void;
  getLatestRun(scopeKey: string): RunRecord | undefined;
  interruptRunningRuns(now: number): number;
  enqueueTurnJob(record: TurnJobRecord): boolean;
  getTurnJob(id: string): TurnJobRecord | undefined;
  /** Retarget deferred pending jobs without changing their event identity. */
  retargetPendingTurnJobs(
    ids: readonly string[],
    target: TurnTarget,
    laneKey: string,
    now: number
  ): number;
  getRetryableTurn(scopeKey: string, id?: string): TurnJobRecord | undefined;
  listReadyTurnLanes(before: number, limit: number): TurnLaneRecord[];
  claimTurnBatch(
    laneKey: string,
    scopeKey: string,
    holder: string,
    now: number,
    coalesceMs: number
  ): TurnJobRecord[];
  finishTurnJobs(
    ids: readonly string[],
    state: Exclude<TurnJobState, "pending" | "running">,
    now: number,
    error?: string
  ): void;
  cancelPendingTurns(scopeKey: string, now: number): TurnJobRecord[];
  listPendingTurns(scopeKey: string, limit: number): TurnJobRecord[];
  countPendingTurns(scopeKey: string): number;
  recoverTurnJobs(now: number): TurnJobRecord[];
  /** Persist and inspect an external-writer conflict decision. */
  saveSessionConflict(record: SessionConflictRecord): void;
  getSessionConflict(id: string): SessionConflictRecord | undefined;
  listSessionConflicts(
    states: readonly SessionConflictState[]
  ): SessionConflictRecord[];
  getOpenSessionConflict(scopeKey: string, now?: number): SessionConflictRecord | undefined;
  /**
   * Atomically consume the one-time card token and record the user's choice.
   * Returns the updated record, or undefined for a stale/unauthorized click.
   */
  claimSessionConflict(
    id: string,
    token: string,
    operatorOpenId: string,
    chatId: string,
    scopeKey: string,
    choice: SessionConflictChoice,
    now: number,
    cardMessageId?: string
  ): SessionConflictRecord | undefined;
  updateSessionConflict(
    id: string,
    patch: SessionConflictPatch,
    now: number,
    expectedStates?: readonly SessionConflictState[]
  ): boolean;
  /** Rotate a conflict card token so previously rendered cards cannot act on a new attempt. */
  rotateSessionConflictToken(
    id: string,
    expectedToken: string,
    nextToken: string,
    now: number
  ): boolean;
  /** Atomically transition a conflict and persist its retry child batch. */
  commitSessionConflictRetry(
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
  ): SessionConflictRetryResult;
  listTurnJobsByConflict(scopeKey: string, conflictId: string): TurnJobRecord[];
  saveLiveCard(record: LiveCardRecord): void;
  getLiveCard(runId: string): LiveCardRecord | undefined;
  listActiveLiveCards(): LiveCardRecord[];
  finishLiveCard(runId: string, now: number): void;
  saveActiveReaction(record: ActiveReactionRecord): void;
  getActiveReaction(trackerId: string): ActiveReactionRecord | undefined;
  listActiveReactions(): ActiveReactionRecord[];
  clearActiveReaction(trackerId: string): void;
  enqueueOutbox(record: Omit<OutboxRecord, "id" | "attempts">, now: number): boolean;
  nextOutbox(now: number, limit: number): OutboxRecord[];
  completeOutbox(id: number): void;
  retryOutbox(id: number, attempts: number, retryAt: number, error: string): void;
  failOutbox(id: number, attempts: number, error: string): void;
  enqueueDelivery(record: DeliveryRequest, now: number): boolean;
  claimDelivery(holder: string, now: number, ttlMs: number): DeliveryRecord | undefined;
  /** Mark a claimed delivery complete; false means it was stale/superseded. */
  completeDelivery(id: number, holder: string, now: number): boolean;
  retryDelivery(id: number, holder: string, attempts: number, retryAt: number, error: string): void;
  failDelivery(id: number, holder: string, attempts: number, now: number, error: string): void;
  savePendingAction(record: PendingActionRecord, now: number): void;
  getPendingAction(id: string): PendingActionRecord | undefined;
  claimPendingAction(id: string, operatorOpenId: string, chatId: string, scopeKey: string, now: number): PendingActionRecord | undefined;
  rejectPendingAction(id: string, operatorOpenId: string, chatId: string, scopeKey: string, now: number): boolean;
  finishAction(id: string, state: "approved" | "rejected" | "completed" | "failed", now: number): void;
  interruptExecutingActions(now: number): number;
  health(): { journalMode: string; schemaVersion: number; integrity: string };
}
