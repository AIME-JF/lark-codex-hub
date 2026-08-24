import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LarkCliActionBroker } from "../src/adapters/lark-cli/lark-cli-action-broker.js";

describe("LarkCliActionBroker", () => {
  let directory: string;
  let fakeCli: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fake-lark-cli-"));
    fakeCli = join(directory, "fake-lark-cli.mjs");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("只以 ok=true 判定成功", async () => {
    await writeFile(
      fakeCli,
      `console.log(JSON.stringify({ok:true,data:{message_id:"m1"}}));`,
      "utf8"
    );
    const broker = new LarkCliActionBroker(process.execPath, [fakeCli]);
    const result = await broker.execute(
      {
        kind: "send_message",
        identity: "bot",
        receiveIdType: "open_id",
        receiveId: "owner",
        text: "测试"
      },
      "key"
    );
    expect(result.status).toBe("completed");
  });

  it("退出码 10 转成待确认，并且只有 confirmed 才追加确认", async () => {
    await writeFile(
      fakeCli,
      `if (process.argv.includes("--yes")) {
  console.log(JSON.stringify({ok:true,data:{}}));
} else {
  console.log(JSON.stringify({ok:false,_confirm:{action:"danger",risk:"write",params:{id:1}}}));
  process.exitCode = 10;
}`,
      "utf8"
    );
    const broker = new LarkCliActionBroker(process.execPath, [fakeCli]);
    const action = {
      kind: "create_task" as const,
      identity: "user" as const,
      summary: "任务",
      description: ""
    };
    expect((await broker.execute(action, "key")).status).toBe("confirmation_required");
    expect((await broker.execute(action, "key", true)).status).toBe("completed");
  });
});
