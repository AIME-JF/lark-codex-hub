import type {
  AgentThreadDetails,
  AgentThreadSource,
  AgentThreadSummary,
  ConversationLink
} from "../contracts/events.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { WorkspaceResolver } from "../ports/workspace-resolver.js";

const DIRECT_SOURCES = ["cli", "vscode", "exec", "appServer"] as const;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export interface SessionCatalogEntry extends AgentThreadSummary {
  current: boolean;
}

function isDirectSource(source: AgentThreadSource): boolean {
  return DIRECT_SOURCES.includes(source as (typeof DIRECT_SOURCES)[number]);
}

export function threadSourceLabel(source: AgentThreadSource): string {
  const labels: Record<AgentThreadSource, string> = {
    cli: "Codex CLI",
    vscode: "Desktop / VS Code",
    exec: "旧版 Exec",
    appServer: "App Server",
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
    private readonly workspaces: WorkspaceResolver,
    private readonly defaultRoot: string,
    private readonly allowedRoots: readonly string[]
  ) {}

  public async list(scopeKey: string, limit: number): Promise<SessionCatalogEntry[]> {
    const current = this.store.getConversation(scopeKey);
    if (!this.agent.listThreads) {
      return this.listHubHistory(scopeKey, limit, current?.sessionId);
    }

    const entries: SessionCatalogEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_PAGES && entries.length < limit; pageIndex += 1) {
      const page = await this.agent.listThreads({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        sourceKinds: DIRECT_SOURCES,
        useStateDbOnly: false
      });
      const validated = await Promise.all(
        page.threads.map(async (thread) => {
          try {
            return await this.validate(thread);
          } catch {
            return undefined;
          }
        })
      );
      for (const thread of validated) {
        if (!thread || seen.has(thread.id)) {
          continue;
        }
        seen.add(thread.id);
        entries.push({ ...thread, current: thread.id === current?.sessionId });
        if (entries.length >= limit) {
          break;
        }
      }
      cursor = page.nextCursor;
      if (!cursor) {
        break;
      }
    }

    if (current && !seen.has(current.sessionId) && this.agent.readThread) {
      try {
        const thread = await this.resolveThread(scopeKey, current.sessionId);
        entries.unshift({ ...thread, current: true });
      } catch {
        // 已失效或越过白名单的旧绑定不进入全局会话目录。
      }
    }
    return entries.slice(0, limit);
  }

  public async bind(scopeKey: string, idOrPosition: string): Promise<ConversationLink> {
    const position = /^\d+$/u.test(idOrPosition)
      ? Number.parseInt(idOrPosition, 10)
      : Number.NaN;
    const selected = Number.isInteger(position) && position > 0
      ? (await this.list(scopeKey, 100))[position - 1]
      : await this.resolveThread(scopeKey, idOrPosition);
    if (!selected) {
      throw new Error("全局会话列表中没有找到该会话。");
    }
    const link: ConversationLink = {
      scopeKey,
      sessionId: selected.id,
      cwd: selected.cwd,
      updatedAt: Date.now()
    };
    this.store.bindConversation(link);
    this.store.setWorkspace(scopeKey, selected.cwd, link.updatedAt);
    return link;
  }

  private async resolveThread(
    scopeKey: string,
    threadId: string
  ): Promise<AgentThreadDetails> {
    if (!threadId) {
      throw new Error("缺少 Codex 会话 ID。");
    }
    if (!this.agent.readThread) {
      const historical = this.store
        .listConversations(scopeKey, 100)
        .find((item) => item.sessionId === threadId);
      if (!historical) {
        throw new Error("当前执行后端不支持读取全局会话。");
      }
      return this.historyDetails(historical);
    }
    const thread = await this.agent.readThread(threadId, false);
    return this.validate(thread);
  }

  private async validate<T extends AgentThreadSummary>(thread: T): Promise<T> {
    if (!isDirectSource(thread.source)) {
      throw new Error(`不允许绑定 ${threadSourceLabel(thread.source)} 会话。`);
    }
    if (!thread.cwd) {
      throw new Error("Codex 会话没有可验证的工作目录。");
    }
    const cwd = await this.workspaces.resolveAllowed(
      thread.cwd,
      this.defaultRoot,
      this.allowedRoots
    );
    return { ...thread, cwd };
  }

  private listHubHistory(
    scopeKey: string,
    limit: number,
    currentSessionId: string | undefined
  ): SessionCatalogEntry[] {
    return this.store.listConversations(scopeKey, limit).map((item) => ({
      ...this.historyDetails(item),
      current: item.sessionId === currentSessionId
    }));
  }

  private historyDetails(item: ConversationLink): AgentThreadDetails {
    return {
      id: item.sessionId,
      sessionId: item.sessionId,
      source: "exec",
      preview: "",
      cwd: item.cwd,
      status: "unknown",
      createdAt: item.updatedAt,
      updatedAt: item.updatedAt,
      messages: []
    };
  }
}
