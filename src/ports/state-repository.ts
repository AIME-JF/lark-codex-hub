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
  completeDelivery(id: number, holder: string, now: number): void;
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
