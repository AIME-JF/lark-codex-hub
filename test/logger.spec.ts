import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/observability/logger.js";

describe("结构化日志", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    );
  });

  it("脱敏凭据并按大小轮转", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lark-codex-hub-logger-"));
    directories.push(directory);
    const path = join(directory, "hub.log");
    const logger = createLogger("debug", path, {
      console: false,
      maxBytes: 180,
      retentionFiles: 2
    });
    logger.info("Authorization: Bearer very-secret-token", {
      appId: "cli_abcdefghijklmnop",
      nested: { password: "do-not-log" }
    });
    logger.info("second entry", { value: "safe" });
    logger.info("third entry", { value: "safe" });

    const files = (await readdir(directory)).filter((file) => file.startsWith("hub.log"));
    const combined = (
      await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")))
    ).join("\n");
    expect(files.length).toBeGreaterThan(1);
    expect(combined).not.toContain("very-secret-token");
    expect(combined).not.toContain("cli_abcdefghijklmnop");
    expect(combined).not.toContain("do-not-log");
    expect(combined).toContain("[REDACTED]");
  });
});
