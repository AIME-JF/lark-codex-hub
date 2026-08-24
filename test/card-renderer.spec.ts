import { describe, expect, it } from "vitest";
import {
  confirmationCard,
  resultCard
} from "../src/adapters/feishu/card-renderer.js";

describe("飞书卡片", () => {
  it("生成 Card 2.0 完整确认卡片", () => {
    const card = confirmationCard({
      id: "abc123",
      action: "发送消息",
      risk: "代表用户写入",
      params: { target: "owner" }
    }) as Record<string, unknown>;
    expect(card.schema).toBe("2.0");
    expect(JSON.stringify(card)).toContain("confirm");
    expect(JSON.stringify(card)).toContain("reject");
  });

  it("结果卡片不会保留旧按钮", () => {
    const card = resultCard("完成", "已执行", true);
    expect(JSON.stringify(card)).not.toContain("button");
  });
});
