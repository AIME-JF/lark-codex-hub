import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/adapters/sqlite/database.js";
import { SqliteStateStore } from "../src/adapters/sqlite/state-store.js";
import { DeliveryWorker } from "../src/application/delivery-worker.js";
import { ReactionProgressService } from "../src/application/reaction-progress.js";
import type { Logger } from "../src/observability/logger.js";
import type { Messenger } from "../src/ports/messenger.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

function fakeMessenger(): Messenger {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    replyCard: vi.fn(async () => "message-result"),
    sendCard: vi.fn(async () => "message-result"),
    updateCard: vi.fn(async () => undefined),
    addReaction: vi.fn(async (_messageId, emoji) => `reaction-${emoji}`),
    removeReaction: vi.fn(async () => undefined)
  };
}

describe("DeliveryWorker", () => {
  let directory: string;
  let store: SqliteStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lark-codex-hub-delivery-"));
    store = new SqliteStateStore(openDatabase(join(directory, "hub.sqlite")));
    store.migrate();
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("用稳定幂等键消除重复回复并在投递后切换终态表情", async () => {
    const messenger = fakeMessenger();
    const reactions = new ReactionProgressService(messenger, store, true, true, logger);
    const worker = new DeliveryWorker(store, messenger, reactions, 3, logger);
    const tracker = reactions.track("run-1", "message-1");
    await tracker.thinking();

    const card = {
      kind: "answer" as const,
      title: "完成",
      content: "结果",
      tone: "success" as const,
      summary: "结果"
    };
    worker.enqueueReply("message-1", card, {
      idempotencyKey: "event-1:result",
      trackerId: "run-1",
      terminalReaction: "success"
    });
    worker.enqueueReply("message-1", card, {
      idempotencyKey: "event-1:result",
      trackerId: "run-1",
      terminalReaction: "success"
    });
    await worker.flush();

    expect(messenger.replyCard).toHaveBeenCalledTimes(1);
    expect(messenger.replyCard).toHaveBeenCalledWith(
      "message-1",
      card,
      "event-1:result"
    );
    expect(messenger.removeReaction).toHaveBeenCalledWith(
      "message-1",
      "reaction-THINKING"
    );
    expect(messenger.addReaction).toHaveBeenLastCalledWith("message-1", "DONE");
    expect(store.getActiveReaction("run-1")).toBeUndefined();
  });

  it("失败后保留投递并可在下一次重试成功", async () => {
    const messenger = fakeMessenger();
    vi.mocked(messenger.replyCard)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce("message-result");
    const reactions = new ReactionProgressService(messenger, store, false, false, logger);
    const worker = new DeliveryWorker(store, messenger, reactions, 3, logger);
    worker.enqueueReply(
      "message-1",
      {
        kind: "answer",
        title: "完成",
        content: "结果",
        tone: "success",
        summary: "结果"
      },
      { idempotencyKey: "event-2:result" }
    );

    await worker.flush();
    const pending = store.claimDelivery("test-holder", Date.now() + 10_000, 1_000);
    expect(pending?.attempts).toBe(2);
    if (!pending) {
      throw new Error("应存在待重试投递");
    }
    store.retryDelivery(pending.id, "test-holder", pending.attempts, 0, "retry now");
    await worker.flush();

    expect(messenger.replyCard).toHaveBeenCalledTimes(2);
    expect(store.claimDelivery("after", Date.now() + 20_000, 1_000)).toBeUndefined();
  });
});
