import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/adapters/sqlite/database.js";
import { SqliteStateStore } from "../src/adapters/sqlite/state-store.js";
import { InboundWorker } from "../src/application/inbound-worker.js";
import type { InboundMessage } from "../src/contracts/events.js";
import type { Logger } from "../src/observability/logger.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

function message(id: string): InboundMessage {
  return {
    eventId: `event-${id}`,
    messageId: `message-${id}`,
    chatId: "chat-1",
    chatKind: "p2p",
    senderOpenId: "owner",
    text: id,
    mentioned: false,
    receivedAt: Date.now()
  };
}

describe("InboundWorker", () => {
  let directory: string;
  let store: SqliteStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lark-codex-hub-inbound-"));
    store = new SqliteStateStore(openDatabase(join(directory, "hub.sqlite")));
    store.migrate();
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("持久化去重事件，并允许取消命令等消息并发进入控制器", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async (_value: InboundMessage) => gate);
    const worker = new InboundWorker(
      store,
      {
        message: handler,
        cardAction: vi.fn(async () => undefined),
        botMenu: vi.fn(async () => undefined)
      },
      30_000,
      logger,
      4
    );
    worker.start();
    worker.submitMessage(message("first"));
    worker.submitMessage(message("second"));
    worker.submitMessage(message("first"));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    release();
    await worker.stopAndDrain();

    expect(handler.mock.calls.map(([value]) => value.text).sort()).toEqual([
      "first",
      "second"
    ]);
  });
});
