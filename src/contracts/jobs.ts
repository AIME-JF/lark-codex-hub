import type {
  InboundBotMenuAction,
  InboundCardAction,
  InboundMessage
} from "./events.js";
import type {
  PresentationCard,
  TerminalReaction
} from "./presentation.js";

export type InboundJobPayload =
  | { kind: "message"; value: InboundMessage }
  | { kind: "card_action"; value: InboundCardAction }
  | { kind: "bot_menu"; value: InboundBotMenuAction };

export interface InboundJobRecord {
  id: number;
  eventId: string;
  payload: InboundJobPayload;
  attempts: number;
}

export type DeliveryTarget =
  | { kind: "reply"; messageId: string }
  | { kind: "send"; type: "open_id" | "chat_id"; id: string }
  | { kind: "update"; messageId: string };

export interface DeliveryRecord {
  id: number;
  idempotencyKey: string;
  target: DeliveryTarget;
  card: PresentationCard;
  attempts: number;
  trackerId?: string;
  terminalReaction?: TerminalReaction;
  reactionTargets?: ReactionTarget[];
  targetKey?: string;
  revision?: number;
}

export interface DeliveryRequest {
  idempotencyKey: string;
  target: DeliveryTarget;
  card: PresentationCard;
  trackerId?: string;
  terminalReaction?: TerminalReaction;
  reactionTargets?: ReactionTarget[];
}

export interface ReactionTarget {
  trackerId: string;
  messageId: string;
}

export type TurnJobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface TurnJobRecord {
  id: string;
  eventId: string;
  scopeKey: string;
  laneKey: string;
  message: InboundMessage;
  prompt: string;
  state: TurnJobState;
  createdAt: number;
}
