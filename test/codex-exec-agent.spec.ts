import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fake-codex-"));
    fakeCli = join(directory, "fake-codex.mjs");
    await writeFile(
      fakeCli,
      `let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const resumed = process.argv.includes("resume");
console.log(JSON.stringify({type:"thread.started", thread_id: resumed ? "existing" : "new-session"}));
console.log(JSON.stringify({type:"item.completed", item:{type:"agent_message", text:"reply:" + prompt}}));
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
});
