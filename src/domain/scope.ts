import { isAbsolute, relative, resolve } from "node:path";
import type { InboundMessage } from "../contracts/events.js";

export function conversationScope(message: InboundMessage): string {
  return `${message.chatId}:${message.senderOpenId}`;
}

export function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = resolve(candidate);
  const normalizedRoot = resolve(root);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertAllowedWorkspace(candidate: string, roots: readonly string[]): string {
  const normalized = resolve(candidate);
  if (!roots.some((root) => isPathInside(normalized, root))) {
    throw new Error(`工作目录不在允许范围内：${normalized}`);
  }
  return normalized;
}
