import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeWorkspaceResolver } from "../src/adapters/fs/node-workspace-resolver.js";

describe("NodeWorkspaceResolver", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    );
  });

  it("允许真实子目录并阻止通过 Junction 逃逸允许根目录", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lark-codex-hub-workspace-"));
    directories.push(directory);
    const allowed = join(directory, "allowed");
    const child = join(allowed, "child");
    const outside = join(directory, "outside");
    await mkdir(child, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(allowed, "escape"), "junction");
    const resolver = new NodeWorkspaceResolver();

    await expect(
      resolver.resolveAllowed("child", allowed, [allowed])
    ).resolves.toBe(child);
    await expect(
      resolver.resolveAllowed("escape", allowed, [allowed])
    ).rejects.toThrow("工作目录不在允许范围内");
  });
});
