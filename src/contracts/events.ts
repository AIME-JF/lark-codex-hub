export type ChatKind = "p2p" | "group";

export interface InboundMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatKind: ChatKind;
  senderOpenId: string;
  text: string;
  mentioned: boolean;
  parentMessageId?: string;
  rootMessageId?: string;
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
  | { type: "message-delta"; delta: string; text: string }
  | { type: "progress"; label: string }
  | { type: "reasoning"; label: string }
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

export interface AgentHealth {
  backend: "app-server" | "exec";
  ready: boolean;
  version?: string;
  detail: string;
}

export type AgentThreadSource =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "unknown";

export interface AgentThreadSummary {
  id: string;
  sessionId: string;
  source: AgentThreadSource;
  forkedFromId?: string;
  projectId?: string;
  name?: string;
  preview: string;
  cwd: string;
  status: "notLoaded" | "idle" | "active" | "systemError" | "unknown";
  createdAt: number;
  updatedAt: number;
}

export interface AgentThreadMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AgentThreadDetails extends AgentThreadSummary {
  messages: AgentThreadMessage[];
}

export interface AgentThreadListRequest {
  limit: number;
  cursor?: string;
  sourceKinds: readonly AgentThreadSource[];
  useStateDbOnly?: boolean;
}

export interface AgentThreadPage {
  threads: AgentThreadSummary[];
  nextCursor?: string;
}
