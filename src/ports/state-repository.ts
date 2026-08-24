import type { ConversationLink } from "../contracts/events.js";

export interface RunRecord {
  id: string;
  scopeKey: string;
  sessionId?: string;
  state: "running" | "completed" | "failed" | "cancelled";
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
}

export interface StateRepository {
  migrate(): void;
  close(): void;
  claimInbox(eventId: string, messageId: string, now: number): boolean;
  pruneInbox(before: number): number;
  getConversation(scopeKey: string): ConversationLink | undefined;
  listConversations(scopeKey: string, limit: number): ConversationLink[];
  bindConversation(link: ConversationLink): void;
  clearConversation(scopeKey: string): void;
  getWorkspace(scopeKey: string): string | undefined;
  setWorkspace(scopeKey: string, cwd: string, now: number): void;
  acquireLease(scopeKey: string, holder: string, now: number, ttlMs: number): boolean;
  heartbeatLease(scopeKey: string, holder: string, now: number, ttlMs: number): boolean;
  releaseLease(scopeKey: string, holder: string): void;
  createRun(run: RunRecord): void;
  finishRun(id: string, state: RunRecord["state"], finishedAt: number, error?: string): void;
  enqueueOutbox(record: Omit<OutboxRecord, "id" | "attempts">, now: number): boolean;
  nextOutbox(now: number, limit: number): OutboxRecord[];
  completeOutbox(id: number): void;
  retryOutbox(id: number, attempts: number, retryAt: number, error: string): void;
  failOutbox(id: number, attempts: number, error: string): void;
  savePendingAction(record: PendingActionRecord, now: number): void;
  getPendingAction(id: string): PendingActionRecord | undefined;
  finishAction(id: string, state: "approved" | "rejected" | "completed" | "failed", now: number): void;
  health(): { journalMode: string; schemaVersion: number };
}
