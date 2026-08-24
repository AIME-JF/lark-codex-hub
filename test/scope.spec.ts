import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAllowedWorkspace,
  isPathInside
} from "../src/domain/scope.js";

describe("工作目录边界", () => {
  it("接受根目录及其子目录", () => {
    const root = resolve("sandbox-root");
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(join(root, "child"), root)).toBe(true);
    expect(assertAllowedWorkspace(join(root, "child"), [root])).toBe(
      resolve(root, "child")
    );
  });

  it("拒绝相邻目录和路径前缀碰撞", () => {
    const root = resolve("sandbox-root");
    expect(isPathInside(resolve("sandbox-root-other"), root)).toBe(false);
    expect(() => assertAllowedWorkspace(resolve("outside"), [root])).toThrow(
      "不在允许范围"
    );
  });
});
