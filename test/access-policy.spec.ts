import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/contracts/config.js";
import type { InboundMessage } from "../src/contracts/events.js";
import { AccessPolicy } from "../src/domain/access-policy.js";

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    eventId: "event-1",
    messageId: "message-1",
    chatId: "chat-1",
    chatKind: "p2p",
    senderOpenId: "owner",
    text: "你好",
    mentioned: false,
    receivedAt: 1,
    ...overrides
  };
}

describe("AccessPolicy", () => {
  it("只允许所有者和显式授权用户", () => {
    const config = createDefaultConfig("owner", process.cwd());
    config.feishu.allowedOpenIds.push("friend");
    const policy = new AccessPolicy(config.feishu);

    expect(policy.decide(message()).allowed).toBe(true);
    expect(policy.decide(message({ senderOpenId: "friend" })).allowed).toBe(true);
    expect(policy.decide(message({ senderOpenId: "stranger" })).allowed).toBe(false);
  });

  it("群聊默认要求提及机器人，但斜杠命令可以直接处理", () => {
    const config = createDefaultConfig("owner", process.cwd());
    const policy = new AccessPolicy(config.feishu);

    expect(policy.decide(message({ chatKind: "group" })).allowed).toBe(false);
    expect(policy.decide(message({ chatKind: "group", mentioned: true })).allowed).toBe(true);
    expect(policy.decide(message({ chatKind: "group", text: "/status" })).allowed).toBe(true);
  });
});
