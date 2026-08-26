import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface CodexLocalProjectMetadata {
  id: string;
  name: string;
  rootPaths: string[];
}

export interface CodexProjectMetadataSnapshot {
  projectsById: Map<string, CodexLocalProjectMetadata>;
  threadAssignments: Map<string, string>;
  projectsByRoot: Array<{
    root: string;
    identity: string;
    project: CodexLocalProjectMetadata;
  }>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function containsPath(root: string, cwd: string): boolean {
  const child = relative(root, cwd);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export class CodexProjectMetadataStore {
  public readonly path: string;

  public constructor(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {
    this.path = join(codexHome, ".codex-global-state.json");
  }

  public async snapshot(): Promise<CodexProjectMetadataSnapshot> {
    try {
      const root = record(JSON.parse(await readFile(this.path, "utf8")));
      const projects = record(root?.["local-projects"]);
      const assignments = record(root?.["thread-project-assignments"]);
      const projectsById = new Map<string, CodexLocalProjectMetadata>();
      const threadAssignments = new Map<string, string>();

      for (const [id, value] of Object.entries(projects ?? {})) {
        const project = record(value);
        const name = typeof project?.name === "string" ? project.name.trim() : "";
        const rootPaths = Array.isArray(project?.rootPaths)
          ? project.rootPaths.filter((item): item is string => typeof item === "string" && item.length > 0)
          : [];
        if (name && rootPaths.length > 0) {
          projectsById.set(id, { id, name, rootPaths: rootPaths.map((path) => resolve(path)) });
        }
      }

      for (const [threadId, value] of Object.entries(assignments ?? {})) {
        const assignment = record(value);
        const projectId = typeof assignment?.projectId === "string"
          ? assignment.projectId
          : undefined;
        if (projectId && projectsById.has(projectId)) {
          threadAssignments.set(threadId, projectId);
        }
      }

      const projectsByRoot = [...projectsById.values()]
        .flatMap((project) => project.rootPaths.map((root) => ({
          root,
          identity: pathIdentity(root),
          project
        })))
        .sort((left, right) => right.root.length - left.root.length);
      return { projectsById, threadAssignments, projectsByRoot };
    } catch {
      return {
        projectsById: new Map(),
        threadAssignments: new Map(),
        projectsByRoot: []
      };
    }
  }

  public match(
    snapshot: CodexProjectMetadataSnapshot,
    threadId: string,
    cwd: string,
    projectId?: string
  ): CodexLocalProjectMetadata | undefined {
    const assignedId = projectId ?? snapshot.threadAssignments.get(threadId);
    const assigned = assignedId ? snapshot.projectsById.get(assignedId) : undefined;
    if (assigned) {
      return assigned;
    }
    const cwdIdentity = pathIdentity(cwd);
    return snapshot.projectsByRoot.find((candidate) =>
      cwdIdentity === candidate.identity || containsPath(candidate.root, cwd)
    )?.project;
  }
}
