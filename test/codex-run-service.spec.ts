import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeWorkspaceResolver } from "../src/adapters/fs/node-workspace-resolver.js";
import { openDatabase } from "../src/adapters/sqlite/database.js";
import { SqliteStateStore } from "../src/adapters/sqlite/state-store.js";
import { CodexRunService } from "../src/application/codex-run-service.js";
import { DeliveryWorker } from "../src/application/delivery-worker.js";
import { ReactionProgressService } from "../src/application/reaction-progress.js";
import { createDefaultConfig } from "../src/contracts/config.js";
import type { InboundMessage } from "../src/contracts/events.js";
import type { Logger } from "../src/observability/logger.js";
import type { CodingAgent } from "../src/ports/coding-agent.js";
import type { Messenger } from "../src/ports/messenger.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

function inbound(id: string): InboundMessage {
  return {
    eventId: `event-${id}`,
    messageId: `message-${id}`,
    chatId: `chat-${id}`,
    chatKind: "p2p",
    senderOpenId: "owner",
    text: id,
    mentioned: false,
    receivedAt: Date.now()
  };
}

describe("CodexRunService", () => {
  let directory: string;
  let store: SqliteStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lark-codex-hub-run-"));
    store = new SqliteStateStore(openDatabase(join(directory, "hub.sqlite")));
    store.migrate();
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("两个飞书范围绑定同一 Codex session 时只允许一个任务执行", async () => {
    store.bindConversation({
      scopeKey: "scope-a",
      sessionId: "session-shared",
      cwd: directory,
      updatedAt: 1
    });
    store.bindConversation({
      scopeKey: "scope-b",
      sessionId: "session-shared",
      cwd: directory,
      updatedAt: 2
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      await gate;
      return {
        sessionId: "session-shared",
        finalText: "完成",
        exitCode: 0,
        durationMs: 10,
        cancelled: false
      };
    });
    const agent: CodingAgent = {
      run,
      cancel: vi.fn(() => true),
      activeScopes: () => [],
      shutdown: vi.fn(async () => undefined)
    };
    const messenger: Messenger = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      replyCard: vi.fn(async () => "reply"),
      sendCard: vi.fn(async () => "sent"),
      updateCard: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => "reaction"),
      removeReaction: vi.fn(async () => undefined)
    };
    const reactions = new ReactionProgressService(messenger, store, false, false, logger);
    const deliveries = new DeliveryWorker(store, messenger, reactions, 3, logger);
    const service = new CodexRunService(
      createDefaultConfig("owner", directory),
      agent,
      store,
      reactions,
      deliveries,
      new NodeWorkspaceResolver(),
      logger
    );

    const first = service.run(inbound("first"), "scope-a", "first");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await service.run(inbound("second"), "scope-b", "second");
    await deliveries.flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(messenger.replyCard).toHaveBeenCalledWith(
      "message-second",
      expect.objectContaining({ content: expect.stringContaining("已有任务占用") }),
      "event-second:busy"
    );

    release();
    await first;
    await deliveries.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
