import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WindowsDpapiVault } from "../src/adapters/windows/dpapi-vault.js";

describe.skipIf(process.platform !== "win32")("WindowsDpapiVault", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "hub-vault-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("使用当前 Windows 用户加密并恢复密钥", async () => {
    const vault = new WindowsDpapiVault(directory);
    await vault.set("feishu.app_secret", "仅用于测试的秘密");
    expect(await vault.get("feishu.app_secret")).toBe("仅用于测试的秘密");
    await vault.delete("feishu.app_secret");
    expect(await vault.get("feishu.app_secret")).toBeUndefined();
  });
});
