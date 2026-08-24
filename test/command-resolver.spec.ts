import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWindowsCmdShim } from "../src/adapters/process/command-resolver.js";

describe("Windows 命令垫片解析", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cmd-shim-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("提取 Node 入口而不通过 cmd.exe", async () => {
    const script = join(directory, "node_modules", "tool", "cli.js");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, "node_modules", "tool"), { recursive: true });
    await writeFile(script, "", "utf8");
    const shim = join(directory, "tool.cmd");
    await writeFile(
      shim,
      '"%dp0%\\node_modules\\tool\\cli.js" %*\n',
      "utf8"
    );
    const resolved = await resolveWindowsCmdShim(shim);
    expect(resolved.prefixArgs).toEqual([script]);
    expect(resolved.executable.toLowerCase()).not.toContain("cmd.exe");
  });
});
