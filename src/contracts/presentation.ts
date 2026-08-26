export type CardKind =
  | "answer"
  | "help"
  | "status"
  | "progress"
  | "notification"
  | "action"
  | "confirmation";

export type CardTone = "info" | "success" | "warning" | "error" | "neutral";

export interface CardField {
  label: string;
  value: string;
}

export interface CardAction {
  label: string;
  style: "primary" | "default" | "danger";
  value: Record<string, unknown>;
}

export interface PresentationCard {
  kind: CardKind;
  title: string;
  content: string;
  tone: CardTone;
  subtitle?: string;
  status?: string;
  fields?: CardField[];
  actions?: CardAction[];
  summary?: string;
}

export type ReactionEmoji =
  | "THINKING"
  | "OnIt"
  | "Typing"
  | "DONE"
  | "ERROR"
  | "CrossMark"
  | "OneSecond";

export type TerminalReaction = "success" | "error" | "cancelled" | "waiting";
