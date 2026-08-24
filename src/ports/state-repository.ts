import type { ConversationLink } from "../contracts/events.js";
import type { ReactionEmoji } from "../contracts/presentation.js";
import type {
  DeliveryRecord,
  DeliveryRequest,
  InboundJobPayload,
  InboundJobRecord
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
  getWorkspace(scopeKey: string): string | undefined;
  setWorkspace(scopeKey: string, cwd: string, now: number): void;
  rememberP2pScope(openId: string, scopeKey: string, now: number): void;
  resolveP2pScope(openId: string): string | undefined;
  acquireLease(scopeKey: string, holder: string, now: number, ttlMs: number): boolean;
  heartbeatLease(scopeKey: string, holder: string, now: number, ttlMs: number): boolean;
  releaseLease(scopeKey: string, holder: string): void;
  createRun(run: RunRecord): void;
  finishRun(id: string, state: RunRecord["state"], finishedAt: number, error?: string): void;
  interruptRunningRuns(now: number): number;
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
