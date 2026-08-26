import type {
  AgentThreadDetails,
  AgentThreadMessage,
  AgentThreadSource,
  AgentThreadSummary,
  ExecutionRequest
} from "../../contracts/events.js";

export type JsonRecord = Record<string, unknown>;

export interface RpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface RpcInboundMessage extends JsonRecord {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcErrorShape;
}

export interface StableThreadConfig {
  cwd: string;
  approvalPolicy: "never";
  sandbox: ExecutionRequest["sandbox"];
  model?: string;
}

export interface StableThreadStartParams extends StableThreadConfig {
  serviceName: string;
}

export interface StableThreadResumeParams extends StableThreadConfig {
  threadId: string;
}

export function stableThreadConfig(request: ExecutionRequest): StableThreadConfig {
  return {
    cwd: request.cwd,
    approvalPolicy: "never",
    sandbox: request.sandbox,
    ...(request.model ? { model: request.model } : {})
  };
}

export function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object"
    ? (value as JsonRecord)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function threadIdFrom(value: unknown): string | undefined {
  const root = record(value);
  return stringValue(root?.threadId) ?? stringValue(record(root?.thread)?.id);
}

function threadStatus(value: unknown): AgentThreadSummary["status"] {
  const type = stringValue(record(value)?.type);
  return type === "notLoaded" ||
    type === "idle" ||
    type === "active" ||
    type === "systemError"
    ? type
    : "unknown";
}

function threadSource(value: unknown): AgentThreadSource {
  return value === "cli" ||
    value === "vscode" ||
    value === "exec" ||
    value === "appServer"
    ? value
    : "unknown";
}

function userInputText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      const input = record(item);
      return input?.type === "text" ? stringValue(input.text) ?? "" : "";
    })
    .filter(Boolean)
    .join("\n");
}

function threadMessages(value: unknown): AgentThreadMessage[] {
  const thread = record(value);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages: AgentThreadMessage[] = [];
  for (const turnValue of turns) {
    const turn = record(turnValue);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const itemValue of items) {
      const item = record(itemValue);
      if (item?.type === "userMessage") {
        const text = userInputText(item.content);
        if (text) {
          messages.push({ role: "user", text });
        }
      } else if (item?.type === "agentMessage") {
        const text = stringValue(item.text);
        if (text) {
          messages.push({ role: "assistant", text });
        }
      }
    }
  }
  return messages;
}

export function toThreadSummary(value: unknown): AgentThreadSummary {
  const thread = record(value);
  const id = stringValue(thread?.id);
  if (!thread || !id) {
    throw new Error("App Server 返回了无效的会话数据。");
  }
  const createdAt = numberValue(thread.createdAt) ?? 0;
  const updatedAt = numberValue(thread.updatedAt) ?? createdAt;
  const name = stringValue(thread.name);
  const sessionId = stringValue(thread.sessionId) ?? id;
  const forkedFromId = stringValue(thread.forkedFromId);
  const projectId = stringValue(thread.projectId);
  return {
    id,
    sessionId,
    source: threadSource(thread.source),
    ...(forkedFromId ? { forkedFromId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(name ? { name } : {}),
    preview: stringValue(thread.preview) ?? "",
    cwd: stringValue(thread.cwd) ?? "",
    status: threadStatus(thread.status),
    createdAt: createdAt * 1_000,
    updatedAt: updatedAt * 1_000
  };
}

export function toThreadDetails(value: unknown): AgentThreadDetails {
  return {
    ...toThreadSummary(value),
    messages: threadMessages(value)
  };
}

export function lastAgentMessage(turnValue: unknown): string | undefined {
  const turn = record(turnValue);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = record(items[index]);
    if (item?.type === "agentMessage") {
      const text = stringValue(item.text);
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}
