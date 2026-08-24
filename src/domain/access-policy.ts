import type { HubConfig } from "../contracts/config.js";
import type { InboundMessage } from "../contracts/events.js";

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
}

export class AccessPolicy {
  public constructor(private readonly config: HubConfig["feishu"]) {}

  public decide(message: InboundMessage): AccessDecision {
    const permittedUsers = new Set([
      this.config.ownerOpenId,
      ...this.config.allowedOpenIds
    ]);
    if (!permittedUsers.has(message.senderOpenId)) {
      return { allowed: false, reason: "当前用户未获授权。" };
    }
    if (
      this.config.allowedChatIds.length > 0 &&
      !this.config.allowedChatIds.includes(message.chatId)
    ) {
      return { allowed: false, reason: "当前会话未在允许列表中。" };
    }
    if (
      message.chatKind === "group" &&
      this.config.requireMentionInGroup &&
      !message.mentioned &&
      !message.text.trimStart().startsWith("/")
    ) {
      return { allowed: false, reason: "群聊中需要先提及机器人。" };
    }
    return { allowed: true };
  }
}
