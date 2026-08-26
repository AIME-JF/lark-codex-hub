import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  AgentThreadSource,
  AgentThreadSummary,
  CodexProjectSummary,
  UnclassifiedReason,
  UnclassifiedThread
} from "../contracts/events.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { WorkspaceResolver } from "../ports/workspace-resolver.js";

const ALL_SOURCES: readonly AgentThreadSource[] = ["cli", "vscode", "exec", "appServer"];
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export interface CodexProject extends CodexProjectSummary {
  sessions: AgentThreadSummary[];
}

export interface ProjectCatalogSnapshot {
  projects: CodexProject[];
  unclassified: UnclassifiedThread[];
  loadedAt: number;
}

function pathIdentity(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function projectKey(cwd: string): string {
  return createHash("sha256").update(pathIdentity(cwd)).digest("hex").slice(0, 16);
}

function unsupportedSourceDetail(source: AgentThreadSource): string {
  return source === "cli"
    ? "该会话来自 Codex CLI，默认不作为 Desktop 项目。"
    : source === "exec"
      ? "该会话来自旧版 Exec 后端。"
      : "该会话来源无法识别。";
}

export class ProjectCatalogService {
  private cached: ProjectCatalogSnapshot | undefined;

  public constructor(
    private readonly agent: CodingAgent,
    private readonly workspaces: WorkspaceResolver,
    private readonly projectSources: readonly AgentThreadSource[],
    private readonly cacheMs: number
  ) {}

  public async snapshot(force = false): Promise<ProjectCatalogSnapshot> {
    if (!force && this.cached && Date.now() - this.cached.loadedAt < this.cacheMs) {
      return this.cached;
    }
    if (!this.agent.listThreads) {
      return { projects: [], unclassified: [], loadedAt: Date.now() };
    }

    const threads: AgentThreadSummary[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.agent.listThreads({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        sourceKinds: ALL_SOURCES,
        useStateDbOnly: false
      });
      for (const thread of result.threads) {
        if (!seen.has(thread.id)) {
          seen.add(thread.id);
          threads.push(thread);
        }
      }
      cursor = result.nextCursor;
      if (!cursor) {
        break;
      }
    }

    const projects = new Map<string, CodexProject>();
    const unclassified: UnclassifiedThread[] = [];
    for (const thread of threads) {
      const inspection = await this.workspaces.inspectProject(thread.cwd);
      let reason: UnclassifiedReason | undefined;
      let reasonDetail = "";
      if (!this.projectSources.includes(thread.source)) {
        reason = "unsupported_source";
        reasonDetail = unsupportedSourceDetail(thread.source);
      } else if (inspection.reason) {
        reason = inspection.reason;
        reasonDetail = inspection.detail ?? "工作目录不能作为项目。";
      }
      if (reason || !inspection.cwd) {
        unclassified.push({
          ...thread,
          ...(inspection.cwd ? { cwd: inspection.cwd } : {}),
          reason: reason ?? "missing_cwd",
          reasonDetail: reasonDetail || "会话没有可识别的项目目录。"
        });
        continue;
      }
      const key = projectKey(inspection.cwd);
      const existing = projects.get(key);
      const normalizedThread = { ...thread, cwd: inspection.cwd };
      if (existing) {
        existing.sessions.push(normalizedThread);
        existing.sessionCount += 1;
        existing.updatedAt = Math.max(existing.updatedAt, thread.updatedAt);
      } else {
        projects.set(key, {
          key,
          name: basename(inspection.cwd) || inspection.cwd,
          cwd: inspection.cwd,
          sessionCount: 1,
          updatedAt: thread.updatedAt,
          sessions: [normalizedThread]
        });
      }
    }
    for (const project of projects.values()) {
      project.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    }
    const snapshot = {
      projects: [...projects.values()].sort((left, right) => right.updatedAt - left.updatedAt),
      unclassified: unclassified.sort((left, right) => right.updatedAt - left.updatedAt),
      loadedAt: Date.now()
    };
    this.cached = snapshot;
    return snapshot;
  }

  public invalidate(): void {
    this.cached = undefined;
  }

  public async project(key: string): Promise<CodexProject | undefined> {
    return (await this.snapshot()).projects.find((item) => item.key === key);
  }

  public async projectByCwd(cwd: string): Promise<CodexProject | undefined> {
    const normalized = await this.workspaces.resolveProject(cwd).catch(() => undefined);
    return normalized ? this.project(projectKey(normalized)) : undefined;
  }

  public async thread(threadId: string): Promise<AgentThreadSummary | undefined> {
    const catalog = await this.snapshot();
    for (const project of catalog.projects) {
      const thread = project.sessions.find((item) => item.id === threadId);
      if (thread) {
        return thread;
      }
    }
    return catalog.unclassified.find((item) => item.id === threadId);
  }
}
