export type ChatKind = "p2p" | "group";

export interface InboundMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatKind: ChatKind;
  senderOpenId: string;
  text: string;
  mentioned: boolean;
  receivedAt: number;
}

export interface InboundCardAction {
  actionId: string;
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  value: unknown;
  receivedAt: number;
}

export interface InboundBotMenuAction {
  eventId: string;
  operatorOpenId: string;
  eventKey: string;
  receivedAt: number;
}

export interface ConversationLink {
  scopeKey: string;
  sessionId: string;
  cwd: string;
  updatedAt: number;
}

export type ExecutionEvent =
  | { type: "session"; sessionId: string }
  | { type: "message"; text: string }
  | { type: "progress"; label: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

export interface ExecutionRequest {
  scopeKey: string;
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  sandbox: "read-only" | "workspace-write";
  timeoutMs: number;
}

export interface ExecutionResult {
  sessionId?: string;
  finalText: string;
  exitCode: number;
  durationMs: number;
  cancelled: boolean;
}
