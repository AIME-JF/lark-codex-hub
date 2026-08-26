import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerAgent } from "../src/adapters/codex/codex-app-server-agent.js";
import { CodexExecAgent } from "../src/adapters/codex/codex-exec-agent.js";
import type { Logger } from "../src/observability/logger.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

describe("CodexExecAgent", () => {
  let directory: string;
  let fakeCli: string;
  let fakeAppServer: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fake-codex-"));
    fakeCli = join(directory, "fake-codex.mjs");
    fakeAppServer = join(directory, "fake-app-server.mjs");
    await writeFile(
      fakeCli,
      `let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const argv = process.argv.slice(2);
const resumed = argv.includes("resume");
if (prompt === "busy") {
  console.error("failed to acquire session write lock: another process is using it");
  process.exit(2);
}
if (resumed && argv.indexOf("--color") > argv.indexOf("resume")) {
  console.error("--color must be placed before resume");
  process.exit(2);
}
if (!argv.includes("--sandbox") || !argv.includes("workspace-write")) {
  console.error("sandbox option is required");
  process.exit(2);
}
console.log(JSON.stringify({type:"thread.started", thread_id: resumed ? "existing" : "new-session"}));
console.log(JSON.stringify({type:"item.completed", item:{type:"agent_message", text:"reply:" + prompt}}));
`,
      "utf8"
    );
    await writeFile(
      fakeAppServer,
      `import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.experimentalApi !== false) {
      send({ id: message.id, error: { code: -32602, message: "stable capability required" } });
    } else {
      send({ id: message.id, result: { userAgent: "fake-app-server" } });
    }
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [] } });
  } else if (message.method === "thread/resume") {
    if (Object.hasOwn(message.params ?? {}, "excludeTurns")) {
      send({ id: message.id, error: { code: -32602, message: "excludeTurns is experimental" } });
    } else {
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    }
  } else if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turnId = "turn-1";
    const prompt = message.params.input?.[0]?.text ?? "";
    const text = "reply:" + prompt;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: text } });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", text }] }
      }
    });
  } else if (message.method === "thread/unsubscribe") {
    send({ id: message.id, result: { status: "unsubscribed" } });
  }
}
`,
      "utf8"
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("解析新会话的 JSONL 输出", async () => {
    const agent = new CodexExecAgent(process.execPath, logger, [fakeCli]);
    const events: unknown[] = [];
    const result = await agent.run(
      {
        scopeKey: "scope",
        prompt: "hello",
        cwd: directory,
        sandbox: "workspace-write",
        timeoutMs: 5_000
      },
      async (event) => {
        events.push(event);
      }
    );
    expect(result.sessionId).toBe("new-session");
    expect(result.finalText).toBe("reply:hello");
    expect(events).toContainEqual({ type: "session", sessionId: "new-session" });
  });

  it("续接时使用已有会话", async () => {
    const agent = new CodexExecAgent(process.execPath, logger, [fakeCli]);
    const result = await agent.run(
      {
        scopeKey: "scope",
        prompt: "again",
        cwd: directory,
        sessionId: "existing",
        sandbox: "workspace-write",
        timeoutMs: 5_000
      },
      async () => undefined
    );
    expect(result.sessionId).toBe("existing");
    expect(result.finalText).toBe("reply:again");
  });

  it("把 Codex 原生 session 锁冲突转换成可理解的错误", async () => {
    const agent = new CodexExecAgent(process.execPath, logger, [fakeCli]);
    await expect(
      agent.run(
        {
          scopeKey: "scope",
          prompt: "busy",
          cwd: directory,
          sessionId: "existing",
          sandbox: "workspace-write",
          timeoutMs: 5_000
        },
        async () => undefined
      )
    ).rejects.toThrow("另一个入口使用");
  });

  it("使用稳定 App Server 协议恢复会话并执行 Turn", async () => {
    const agent = new CodexAppServerAgent(process.execPath, logger, [fakeAppServer]);
    try {
      await expect(agent.health()).resolves.toMatchObject({
        backend: "app-server",
        ready: true
      });
      const events: unknown[] = [];
      const result = await agent.run(
        {
          scopeKey: "scope",
          prompt: "hello",
          cwd: directory,
          sessionId: "existing",
          sandbox: "workspace-write",
          timeoutMs: 5_000
        },
        async (event) => {
          events.push(event);
        }
      );
      expect(result).toMatchObject({
        sessionId: "existing",
        finalText: "reply:hello",
        exitCode: 0
      });
      expect(events).toContainEqual({ type: "session", sessionId: "existing" });
    } finally {
      await agent.shutdown(2_000);
    }
  });
});
