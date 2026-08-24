import type { ExecutionEvent } from "../../contracts/events.js";

interface JsonObject {
  [key: string]: unknown;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseCodexLine(line: string): ExecutionEvent[] {
  let value: JsonObject;
  try {
    const parsed = JSON.parse(line) as unknown;
    const candidate = object(parsed);
    if (!candidate) {
      return [];
    }
    value = candidate;
  } catch {
    return [];
  }

  const type = string(value.type);
  if (type === "thread.started") {
    const sessionId = string(value.thread_id);
    return sessionId ? [{ type: "session", sessionId }] : [];
  }

  if (type === "item.completed") {
    const item = object(value.item);
    if (!item) {
      return [];
    }
    if (item.type === "agent_message") {
      const text = string(item.text);
      return text ? [{ type: "message", text }] : [];
    }
    if (item.type === "command_execution") {
      const command = string(item.command) ?? "命令";
      return [{ type: "progress", label: `已完成：${command.slice(0, 160)}` }];
    }
    if (item.type === "mcp_tool_call") {
      const server = string(item.server) ?? "MCP";
      const tool = string(item.tool) ?? "工具";
      return [{ type: "progress", label: `已调用：${server}/${tool}` }];
    }
  }

  if (type === "item.started") {
    const item = object(value.item);
    if (item?.type === "command_execution") {
      const command = string(item.command) ?? "命令";
      return [{ type: "progress", label: `正在执行：${command.slice(0, 160)}` }];
    }
  }

  if (type === "turn.completed") {
    const usage = object(value.usage);
    const inputTokens = number(usage?.input_tokens);
    const outputTokens = number(usage?.output_tokens);
    return inputTokens !== undefined && outputTokens !== undefined
      ? [{ type: "usage", inputTokens, outputTokens }]
      : [];
  }

  if (type === "turn.failed" || type === "error") {
    const details = object(value.error);
    const message = string(details?.message) ?? string(value.message) ?? "Codex 执行失败";
    return [{ type: "error", message }];
  }

  return [];
}
