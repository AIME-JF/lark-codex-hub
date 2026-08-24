import { describe, expect, it } from "vitest";
import { parseCodexLine } from "../src/adapters/codex/jsonl-parser.js";

describe("Codex JSONL 解析", () => {
  it("提取会话、最终文本和用量", () => {
    expect(
      parseCodexLine(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }))
    ).toEqual([{ type: "session", sessionId: "thread-1" }]);
    expect(
      parseCodexLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "完成" }
        })
      )
    ).toEqual([{ type: "message", text: "完成" }]);
    expect(
      parseCodexLine(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 12, output_tokens: 7 }
        })
      )
    ).toEqual([{ type: "usage", inputTokens: 12, outputTokens: 7 }]);
  });

  it("忽略损坏行并保留错误事件", () => {
    expect(parseCodexLine("not-json")).toEqual([]);
    expect(
      parseCodexLine(
        JSON.stringify({ type: "turn.failed", error: { message: "失败原因" } })
      )
    ).toEqual([{ type: "error", message: "失败原因" }]);
  });
});
