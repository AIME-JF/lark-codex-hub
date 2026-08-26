import { record, stringValue, type JsonRecord } from "./app-server-protocol.js";

export function textInput(text: string): JsonRecord {
  return { type: "text", text, text_elements: [] };
}

export function statusType(value: unknown): string | undefined {
  return stringValue(record(value)?.status) ?? stringValue(value);
}

function compactDetail(value: unknown, limit = 120): string | undefined {
  const text = stringValue(value)?.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, limit) : undefined;
}

function fileChangeDetail(item: JsonRecord): string | undefined {
  if (!Array.isArray(item.changes)) {
    return undefined;
  }
  const paths = item.changes
    .map((change) => compactDetail(record(change)?.path, 80))
    .filter((path): path is string => Boolean(path));
  if (!paths.length) {
    return undefined;
  }
  return `${paths.slice(0, 3).join("、")}${paths.length > 3 ? ` 等 ${paths.length} 个文件` : ""}`;
}

export function progressLabel(itemValue: unknown, completed = false): string {
  const item = record(itemValue);
  const type = stringValue(item?.type);
  const status = stringValue(item?.status);
  const failed = status === "failed" || status === "declined";
  const phase = completed ? (failed ? "失败" : "完成") : "正在执行";
  if (type === "commandExecution") {
    const command = compactDetail(item?.command);
    return `${phase === "正在执行" ? "正在运行命令" : `命令执行${phase}`}${command ? `：${command}` : ""}`;
  }
  if (type === "fileChange") {
    const files = fileChangeDetail(item ?? {});
    return `${completed ? `文件修改${phase}` : "正在修改文件"}${files ? `：${files}` : ""}`;
  }
  if (type === "mcpToolCall") {
    const tool = [compactDetail(item?.server, 60), compactDetail(item?.tool, 60)]
      .filter(Boolean)
      .join("/");
    return `${completed ? `工具调用${phase}` : "正在调用工具"}${tool ? `：${tool}` : ""}`;
  }
  if (type === "dynamicToolCall") {
    const tool = [compactDetail(item?.namespace, 60), compactDetail(item?.tool, 60)]
      .filter(Boolean)
      .join("/");
    return `${completed ? `工具调用${phase}` : "正在调用工具"}${tool ? `：${tool}` : ""}`;
  }
  if (type === "agentMessage") {
    return "正在组织回复";
  }
  return "正在处理";
}
