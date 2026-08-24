import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { WorkspaceResolver } from "../../ports/workspace-resolver.js";

function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class NodeWorkspaceResolver implements WorkspaceResolver {
  public async resolveAllowed(
    requested: string,
    base: string,
    allowedRoots: readonly string[]
  ): Promise<string> {
    const candidatePath = resolve(base, requested);
    const candidateInfo = await stat(candidatePath);
    if (!candidateInfo.isDirectory()) {
      throw new Error("指定路径不是目录。");
    }
    const candidate = await realpath(candidatePath);
    const roots = await Promise.all(
      allowedRoots.map(async (root) => realpath(resolve(root)))
    );
    if (!roots.some((root) => isInside(candidate, root))) {
      throw new Error(`工作目录不在允许范围内：${candidate}`);
    }
    return candidate;
  }
}
