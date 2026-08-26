import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";
import type {
  ProjectDirectoryInspection,
  WorkspaceResolver
} from "../../ports/workspace-resolver.js";

function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function displayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice(8)}`;
  }
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  return samePath(candidate, root) || isInside(candidate, root);
}

async function canonical(path: string): Promise<string> {
  return displayPath(await realpath(resolve(path)));
}

export class NodeWorkspaceResolver implements WorkspaceResolver {
  public async inspectProject(requested: string): Promise<ProjectDirectoryInspection> {
    if (!requested.trim()) {
      return { reason: "missing_cwd", detail: "会话没有工作目录。" };
    }
    let candidate: string;
    try {
      const info = await stat(resolve(requested));
      if (!info.isDirectory()) {
        return { reason: "missing_directory", detail: "工作目录不是文件夹。" };
      }
      candidate = await canonical(requested);
    } catch {
      return { reason: "missing_directory", detail: "工作目录已不存在或不可读取。" };
    }

    const home = await canonical(homedir());
    const unsafeRoots = [
      await canonical(resolve(homedir(), ".codex")).catch(() => resolve(homedir(), ".codex")),
      await canonical(resolve(homedir(), ".lark-codex-hub")).catch(() => resolve(homedir(), ".lark-codex-hub")),
      await canonical(resolve(homedir(), ".local", "state", "codex-remote")).catch(
        () => resolve(homedir(), ".local", "state", "codex-remote")
      ),
      ...(process.platform === "win32"
        ? [resolve(process.env.SystemRoot ?? "C:\\Windows", "System32")]
        : [])
    ].map(displayPath);
    const driveRoot = displayPath(parse(candidate).root);
    if (
      samePath(candidate, driveRoot) ||
      samePath(candidate, home) ||
      unsafeRoots.some((root) => isInsideOrEqual(candidate, displayPath(root)))
    ) {
      return {
        cwd: candidate,
        reason: "unsafe_directory",
        detail: "工作目录是用户主目录、系统目录或 Codex 状态目录。"
      };
    }
    return { cwd: candidate };
  }

  public async resolveProject(requested: string): Promise<string> {
    const inspection = await this.inspectProject(requested);
    if (!inspection.cwd || inspection.reason) {
      throw new Error(inspection.detail ?? "工作目录不是可用项目。");
    }
    return inspection.cwd;
  }

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
