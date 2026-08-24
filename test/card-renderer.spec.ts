import { describe, expect, it } from "vitest";
import { renderCardParts } from "../src/adapters/feishu/card-renderer.js";
import { splitMarkdown } from "../src/domain/markdown-chunks.js";

describe("飞书卡片", () => {
  it("生成 Card 2.0 完整确认卡片", () => {
    const part = renderCardParts({
      kind: "confirmation",
      title: "需要确认飞书操作",
      content: "代表用户发送消息",
      tone: "warning",
      status: "等待确认",
      actions: [
        {
          label: "确认执行",
          style: "primary",
          value: { command: "confirm", id: "abc123" }
        },
        {
          label: "拒绝",
          style: "danger",
          value: { command: "reject", id: "abc123" }
        }
      ]
    })[0]!;
    const { card } = part;
    const value = card as Record<string, unknown>;
    expect(value.schema).toBe("2.0");
    expect(JSON.stringify(card)).toContain("confirm");
    expect(JSON.stringify(card)).toContain("reject");
    expect(JSON.stringify(card)).toContain("behaviors");
  });

  it("结果卡片不会保留旧按钮", () => {
    const part = renderCardParts({
      kind: "answer",
      title: "Codex 回复",
      content: "已执行",
      tone: "success",
      status: "已完成"
    })[0]!;
    const { card } = part;
    expect(JSON.stringify(card)).not.toContain("button");
    expect(JSON.stringify(card)).toContain("green");
  });

  it("长 Markdown 会分段并保持代码围栏闭合", () => {
    const chunks = splitMarkdown(`\`\`\`ts\n${"const value = 1;\n".repeat(80)}\`\`\``, 300);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => (chunk.match(/```/g)?.length ?? 0) % 2 === 0)).toBe(true);
  });
});
