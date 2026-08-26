import type {
  AgentThreadDetails,
  AgentThreadSource,
  AgentThreadSummary,
  ConversationLink,
  UnclassifiedThread
} from "../contracts/events.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { StateRepository } from "../ports/state-repository.js";
import type {
  CodexProject,
  ProjectCatalogService,
  ProjectCatalogSnapshot
} from "./project-catalog-service.js";

export interface SessionCatalogEntry extends AgentThreadSummary {
  current: boolean;
}

export function threadSourceLabel(source: AgentThreadSource): string {
  const labels: Record<AgentThreadSource, string> = {
    cli: "Codex CLI",
    vscode: "Desktop / VS Code",
    exec: "旧版 Exec",
    appServer: "Hub / App Server",
    unknown: "未知来源"
  };
  return labels[source];
}

export function threadStatusLabel(status: AgentThreadSummary["status"]): string {
  const labels: Record<AgentThreadSummary["status"], string> = {
    notLoaded: "未加载",
    idle: "空闲",
    active: "使用中",
    systemError: "异常",
    unknown: "未知"
  };
  return labels[status];
}

export class SessionCatalogService {
  public constructor(
    private readonly agent: CodingAgent,
    private readonly store: StateRepository,
    private readonly catalog: ProjectCatalogService
  ) {}

  public snapshot(force = false): Promise<ProjectCatalogSnapshot> {
    return this.catalog.snapshot(force);
  }

  public async selectedProject(scopeKey: string): Promise<CodexProject | undefined> {
    const preferred = this.store.getProject(scopeKey);
    if (preferred) {
      const project = await this.catalog.projectByCwd(preferred);
      if (project) {
        return project;
      }
      this.store.clearProject(scopeKey);
      this.store.clearNewSessionIntent(scopeKey);
    }
    const link = this.store.getConversation(scopeKey);
    if (!link) {
      return undefined;
    }
    const project = await this.catalog.projectByCwd(link.cwd);
    if (!project) {
      this.store.clearConversation(scopeKey);
      return undefined;
    }
    this.store.setProject(scopeKey, project.cwd, Date.now());
    return project;
  }

  public async selectProject(scopeKey: string, projectKey: string): Promise<CodexProject> {
    const project = await this.catalog.project(projectKey);
    if (!project) {
      throw new Error("项目已经失效，请刷新项目列表。");
    }
    this.store.setProject(scopeKey, project.cwd, Date.now());
    this.store.clearConversation(scopeKey);
    this.store.clearNewSessionIntent(scopeKey);
    return project;
  }

  public async listProjectSessions(
    scopeKey: string,
    projectKey: string
  ): Promise<SessionCatalogEntry[]> {
    const project = await this.catalog.project(projectKey);
    if (!project) {
      throw new Error("没有找到该项目，请刷新项目列表。");
    }
    const current = this.store.getConversation(scopeKey)?.sessionId;
    return project.sessions.map((thread) => ({
      ...thread,
      current: thread.id === current
    }));
  }

  public async bind(
    scopeKey: string,
    idOrPosition: string,
    projectKey?: string
  ): Promise<ConversationLink> {
    const project = projectKey
      ? await this.catalog.project(projectKey)
      : await this.selectedProject(scopeKey);
    if (!project) {
      throw new Error("请先选择项目。");
    }
    const position = /^\d+$/u.test(idOrPosition)
      ? Number.parseInt(idOrPosition, 10)
      : Number.NaN;
    const selected = Number.isInteger(position) && position > 0
      ? project.sessions[position - 1]
      : project.sessions.find((thread) => thread.id === idOrPosition);
    if (!selected) {
      throw new Error("所选会话不属于当前项目，请刷新会话列表。");
    }
    const link: ConversationLink = {
      scopeKey,
      sessionId: selected.id,
      cwd: selected.cwd,
      updatedAt: Date.now()
    };
    this.store.bindConversation(link);
    this.store.setProject(scopeKey, project.cwd, link.updatedAt);
    return link;
  }

  public async startNew(scopeKey: string, projectKey?: string): Promise<CodexProject> {
    const project = projectKey
      ? await this.catalog.project(projectKey)
      : await this.selectedProject(scopeKey);
    if (!project) {
      throw new Error("请先选择项目。");
    }
    this.store.setProject(scopeKey, project.cwd, Date.now());
    this.store.clearConversation(scopeKey);
    this.store.setNewSessionIntent({
      scopeKey,
      cwd: project.cwd,
      updatedAt: Date.now()
    });
    return project;
  }

  public async migrate(
    scopeKey: string,
    threadId: string,
    projectKey: string
  ): Promise<ConversationLink> {
    const snapshot = await this.catalog.snapshot();
    const source = snapshot.unclassified.find((thread) => thread.id === threadId);
    if (!source) {
      throw new Error("未归类会话已经失效，请刷新列表。");
    }
    if (source.status === "active") {
      throw new Error("该会话正在执行，完成后才能迁入项目。");
    }
    const project = snapshot.projects.find((item) => item.key === projectKey);
    if (!project) {
      throw new Error("目标项目已经失效，请刷新项目列表。");
    }
    if (!this.agent.forkThread) {
      throw new Error("当前 Codex 后端不支持安全分叉会话。");
    }
    const forked = await this.agent.forkThread(source.id);
    const link: ConversationLink = {
      scopeKey,
      sessionId: forked.id,
      cwd: project.cwd,
      updatedAt: Date.now()
    };
    this.store.bindConversation(link);
    this.store.setProject(scopeKey, project.cwd, link.updatedAt);
    this.catalog.invalidate();
    return link;
  }

  public async unclassified(): Promise<UnclassifiedThread[]> {
    return (await this.catalog.snapshot()).unclassified;
  }

  public async readThread(threadId: string): Promise<AgentThreadDetails> {
    if (!this.agent.readThread) {
      throw new Error("当前 Codex 后端不支持读取全局会话。");
    }
    return this.agent.readThread(threadId, true);
  }
}
