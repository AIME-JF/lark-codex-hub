import type { HubConfig } from "../contracts/config.js";
import type { InboundMessage } from "../contracts/events.js";

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
}

export class AccessPolicy {
  public constructor(private readonly config: HubConfig["feishu"]) {}

  public decideOperator(openId: string, chatId?: string): AccessDecision {
    const permittedUsers = new Set([
      this.config.ownerOpenId,
      ...this.config.allowedOpenIds
    ]);
    if (!permittedUsers.has(openId)) {
      return { allowed: false, reason: "当前用户未获授权。" };
    }
    if (
      chatId &&
      this.config.allowedChatIds.length > 0 &&
      !this.config.allowedChatIds.includes(chatId)
    ) {
      return { allowed: false, reason: "当前会话未在允许列表中。" };
    }
    return { allowed: true };
  }

  public decide(message: InboundMessage): AccessDecision {
    const operator = this.decideOperator(message.senderOpenId, message.chatId);
    if (!operator.allowed) {
      return operator;
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
