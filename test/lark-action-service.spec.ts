import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/adapters/sqlite/database.js";
import { SqliteStateStore } from "../src/adapters/sqlite/state-store.js";
import { DeliveryWorker } from "../src/application/delivery-worker.js";
import { LarkActionService } from "../src/application/lark-action-service.js";
import { ReactionProgressService } from "../src/application/reaction-progress.js";
import type { InboundMessage } from "../src/contracts/events.js";
import type { PresentationCard } from "../src/contracts/presentation.js";
import type { Logger } from "../src/observability/logger.js";
import type { ActionBroker } from "../src/ports/action-broker.js";
import type { Messenger } from "../src/ports/messenger.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

describe("LarkActionService", () => {
  let directory: string;
  let store: SqliteStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lark-codex-hub-action-"));
    store = new SqliteStateStore(openDatabase(join(directory, "hub.sqlite")));
    store.migrate();
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("确认动作绑定发起人，且并发确认只执行一次", async () => {
    const execute = vi
      .fn<ActionBroker["execute"]>()
      .mockResolvedValueOnce({
        status: "confirmation_required",
        summary: "需要确认",
        confirmation: { action: "发送消息", risk: "代表用户发送", params: {} }
      })
      .mockResolvedValue({ status: "completed", summary: "完成" });
    const broker: ActionBroker = { execute };
    let confirmationCard: PresentationCard | undefined;
    const messenger: Messenger = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      replyCard: vi.fn(async (_messageId, card) => {
        confirmationCard = card;
        return "reply";
      }),
      sendCard: vi.fn(async () => "sent"),
      updateCard: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => "reaction"),
      removeReaction: vi.fn(async () => undefined)
    };
    const reactions = new ReactionProgressService(messenger, store, false, false, logger);
    const deliveries = new DeliveryWorker(store, messenger, reactions, 3, logger);
    const service = new LarkActionService(broker, store, reactions, deliveries, logger);
    const message: InboundMessage = {
      eventId: "event-1",
      messageId: "message-1",
      chatId: "chat-1",
      chatKind: "p2p",
      senderOpenId: "owner",
      text: "/send bot open_id target hello",
      mentioned: false,
      receivedAt: Date.now()
    };
    await service.execute(message, "scope-1", {
      kind: "send_message",
      identity: "bot",
      receiveIdType: "open_id",
      receiveId: "target",
      text: "hello"
    });
    await deliveries.flush();
    const id = confirmationCard?.actions?.[0]?.value.id;
    expect(id).toMatch(/^[a-f0-9]{24}$/u);
    if (typeof id !== "string") {
      throw new Error("确认卡片缺少确认编号");
    }

    await expect(
      service.confirm(id, {
        operatorOpenId: "attacker",
        chatId: "chat-1",
        scopeKey: "scope-1"
      })
    ).resolves.toEqual({
      success: false,
      summary: "没有找到待确认操作，可能已经处理。"
    });
    await expect(
      service.confirm(id, {
        operatorOpenId: "owner",
        chatId: "another-chat",
        scopeKey: "scope-1"
      })
    ).resolves.toEqual({
      success: false,
      summary: "没有找到待确认操作，可能已经处理。"
    });
    const context = {
      operatorOpenId: "owner",
      chatId: "chat-1",
      scopeKey: "scope-1"
    };
    const results = await Promise.all([
      service.confirm(id, context),
      service.confirm(id, context)
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "send_message" }),
      expect.any(String),
      true
    );
  });
});
