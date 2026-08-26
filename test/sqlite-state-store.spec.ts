import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/adapters/sqlite/database.js";
import { SqliteStateStore } from "../src/adapters/sqlite/state-store.js";

describe("SqliteStateStore", () => {
  let directory: string;
  let store: SqliteStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lark-codex-hub-"));
    store = new SqliteStateStore(openDatabase(join(directory, "state.sqlite")));
    store.migrate();
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("使用数据库唯一约束去重事件", () => {
    expect(store.claimInbox("event-1", "message-1", 1)).toBe(true);
    expect(store.claimInbox("event-1", "message-1", 2)).toBe(false);
    expect(store.claimInbox("event-2", "message-1", 3)).toBe(false);
  });

  it("同一会话只允许一个有效租约并可在过期后接管", () => {
    expect(store.acquireLease("scope", "holder-a", 1_000, 500)).toBe(true);
    expect(store.acquireLease("scope", "holder-b", 1_200, 500)).toBe(false);
    expect(store.acquireLease("scope", "holder-b", 1_501, 500)).toBe(true);
    expect(store.heartbeatLease("scope", "holder-b", 1_600, 500)).toBe(true);
    store.releaseLease("scope", "holder-b");
    expect(store.acquireLease("scope", "holder-c", 1_700, 500)).toBe(true);
  });

  it("保存会话、目录、主动通知和待确认动作", () => {
    store.bindConversation({
      scopeKey: "scope",
      sessionId: "session",
      cwd: directory,
      updatedAt: 1
    });
    store.setWorkspace("scope", join(directory, "child"), 2);
    expect(store.getConversation("scope")?.sessionId).toBe("session");
    expect(store.listConversations("scope", 10).map((item) => item.sessionId)).toEqual([
      "session"
    ]);
    expect(store.getWorkspace("scope")).toBe(join(directory, "child"));

    expect(
      store.enqueueOutbox(
        {
          idempotencyKey: "notice-1",
          targetType: "open_id",
          targetId: "owner",
          text: "完成"
        },
        3
      )
    ).toBe(true);
    expect(store.nextOutbox(3, 10)).toHaveLength(1);

    store.saveActiveReaction({
      trackerId: "run-1",
      messageId: "message-1",
      reactionId: "reaction-1",
      emoji: "THINKING",
      updatedAt: 4
    });
    expect(store.getActiveReaction("run-1")?.emoji).toBe("THINKING");
    expect(store.listActiveReactions()).toHaveLength(1);
    store.clearActiveReaction("run-1");
    expect(store.getActiveReaction("run-1")).toBeUndefined();

    store.savePendingAction(
      {
        id: "action-1",
        idempotencyKey: "key-1",
        actionJson: "{}",
        confirmationJson: "{}",
        operatorOpenId: "owner",
        chatId: "chat",
        scopeKey: "scope"
      },
      5
    );
    expect(store.getPendingAction("action-1")?.idempotencyKey).toBe("key-1");
    store.finishAction("action-1", "rejected", 6);
    expect(store.getPendingAction("action-1")).toBeUndefined();
  });

  it("按范围返回最近一次 Codex 运行结果", () => {
    store.createRun({
      id: "run-old",
      scopeKey: "scope",
      sessionId: "session",
      state: "completed",
      startedAt: 10,
      finishedAt: 20
    });
    store.createRun({
      id: "run-latest",
      scopeKey: "scope",
      sessionId: "session",
      state: "running",
      startedAt: 30
    });
    store.finishRun("run-latest", "failed", 40, "协议不兼容");

    expect(store.getLatestRun("scope")).toEqual({
      id: "run-latest",
      scopeKey: "scope",
      sessionId: "session",
      state: "failed",
      startedAt: 30,
      finishedAt: 40,
      error: "协议不兼容"
    });
    expect(store.getLatestRun("other")).toBeUndefined();
  });
});
