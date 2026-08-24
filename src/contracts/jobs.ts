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
}

export interface DeliveryRequest {
  idempotencyKey: string;
  target: DeliveryTarget;
  card: PresentationCard;
  trackerId?: string;
  terminalReaction?: TerminalReaction;
}
