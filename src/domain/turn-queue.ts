import type { InboundMessage } from "../contracts/events.js";
import type { TurnJobRecord } from "../contracts/jobs.js";
import type { SessionConflictChoice } from "../contracts/session-routing.js";

export interface TurnQueueSnapshot {
  active: boolean;
  pending: number;
  items: TurnJobRecord[];
}

export interface TurnCancelResult {
  interrupted: boolean;
  cancelledPending: number;
}

export interface TurnControl {
  enqueue(message: InboundMessage, scopeKey: string, prompt: string): Promise<number>;
  retry(scopeKey: string, id?: string): Promise<number>;
  /** Resolve a durable external-writer conflict using its frozen target. */
  resolveConflict(conflictId: string, choice: Exclude<SessionConflictChoice, "cancel">): Promise<number>;
  cancel(scopeKey: string): Promise<TurnCancelResult>;
  steer(scopeKey: string, prompt: string, message?: InboundMessage): Promise<boolean>;
  shouldSteerReply(message: InboundMessage, scopeKey: string): boolean;
  snapshot(scopeKey: string): TurnQueueSnapshot;
}
