import { registeredCommandAction } from "../domain/command-registry.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { PresentationOptions } from "./presentation-factory.js";
import {
  threadSourceLabel,
  threadStatusLabel,
  type SessionCatalogService
} from "./session-catalog-service.js";

const PAGE_SIZE = 5;
const HISTORY_PAGE_SIZE = 8;

export interface NavigationView {
  content: string;
  options: PresentationOptions;
}

function validPage(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export class ProjectNavigationService {
  public constructor(
    private readonly sessions: SessionCatalogService,
    private readonly store: StateRepository
  ) {}

  public async projects(
    scopeKey: string,
    pageValue = 1,
    query = "",
    migrationThreadId?: string
  ): Promise<NavigationView> {
    const snapshot = await this.sessions.snapshot();
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const projects = normalizedQuery
      ? snapshot.projects.filter((project) =>
          `${project.name}\n${project.cwd}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
        )
      : snapshot.projects;
    const totalPages = Math.max(1, Math.ceil(projects.length / PAGE_SIZE));
    const page = Math.min(validPage(pageValue), totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const visible = projects.slice(start, start + PAGE_SIZE);
    const selected = await this.sessions.selectedProject(scopeKey);
    return {
      content: visible.length
        ? visible
            .map((project, index) => {
              const current = selected?.key === project.key ? " · 当前项目" : "";
              return `**${start + index + 1}. ${project.name}${current}**\n目录：${project.cwd}\n会话：${project.sessionCount} 个\n更新：${new Date(project.updatedAt).toLocaleString("zh-CN")}`;
            })
            .join("\n\n")
        : normalizedQuery
          ? `没有找到包含“${query.slice(0, 80)}”的项目。`
          : "还没有发现可用的 Codex CLI 项目会话。请先在任一 Codex 客户端中创建一次会话。",
      options: {
        title: migrationThreadId ? "选择迁入项目" : "Codex 项目中心",
        kind: "status",
        tone: visible.length ? "info" : "neutral",
        status: `${projects.length} 个项目 · 第 ${page}/${totalPages} 页`,
        actions: [
          ...visible.map((project) =>
            migrationThreadId
              ? registeredCommandAction(
                  project.name.slice(0, 20),
                  "migrate",
                  `${migrationThreadId} ${project.key}`,
                  "primary"
                )
              : registeredCommandAction(
                  project.name.slice(0, 20),
                  "project",
                  project.key,
                  selected?.key === project.key ? "primary" : "default"
                )
          ),
          ...(page > 1
            ? [migrationThreadId
                ? registeredCommandAction("上一页", "migrate", `${migrationThreadId} page:${page - 1}`)
                : registeredCommandAction("上一页", "projects", String(page - 1))]
            : []),
          ...(page < totalPages
            ? [migrationThreadId
                ? registeredCommandAction("下一页", "migrate", `${migrationThreadId} page:${page + 1}`)
                : registeredCommandAction("下一页", "projects", String(page + 1))]
            : []),
          ...(snapshot.unclassified.length
            ? [registeredCommandAction(`未归类 ${snapshot.unclassified.length}`, "unclassified")]
            : []),
          registeredCommandAction("控制中心", "help")
        ]
      }
    };
  }

  public async projectSessions(
    scopeKey: string,
    projectKey: string,
    pageValue = 1
  ): Promise<NavigationView> {
    const project = (await this.sessions.snapshot()).projects.find(
      (item) => item.key === projectKey
    );
    if (!project) {
      throw new Error("项目已经失效，请刷新项目中心。");
    }
    const all = await this.sessions.listProjectSessions(scopeKey, projectKey);
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const page = Math.min(validPage(pageValue), totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const visible = all.slice(start, start + PAGE_SIZE);
    return {
      content: visible.length
        ? visible
            .map((thread, index) => {
              const title = thread.name || thread.preview || `会话 ${start + index + 1}`;
              return `**${start + index + 1}. ${title.replace(/\s+/gu, " ").slice(0, 80)}**\n来源：${threadSourceLabel(thread.source)}${thread.current ? " · 当前绑定" : ""}\n状态：${threadStatusLabel(thread.status)}\n更新：${new Date(thread.updatedAt).toLocaleString("zh-CN")}`;
            })
            .join("\n\n")
        : "这个项目还没有可恢复的会话。",
      options: {
        title: project.name,
        kind: "status",
        tone: "info",
        subtitle: project.cwd,
        status: `${all.length} 个会话 · 第 ${page}/${totalPages} 页`,
        actions: [
          ...visible.map((thread, index) =>
            registeredCommandAction(
              `${thread.current ? "当前" : "恢复"} ${start + index + 1}`,
              "resume",
              `${thread.id} ${project.key}`,
              thread.current ? "primary" : "default"
            )
          ),
          ...(page > 1
            ? [registeredCommandAction("上一页", "sessions", String(page - 1))]
            : []),
          ...(page < totalPages
            ? [registeredCommandAction("下一页", "sessions", String(page + 1))]
            : []),
          registeredCommandAction("新建会话", "new", project.key, "primary"),
          registeredCommandAction("返回项目", "projects")
        ]
      }
    };
  }

  public async unclassified(pageValue = 1): Promise<NavigationView> {
    const all = await this.sessions.unclassified();
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const page = Math.min(validPage(pageValue), totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const visible = all.slice(start, start + PAGE_SIZE);
    return {
      content: visible.length
        ? visible
            .map((thread, index) => {
              const title = thread.name || thread.preview || `会话 ${start + index + 1}`;
              return `**${start + index + 1}. ${title.replace(/\s+/gu, " ").slice(0, 80)}**\n来源：${threadSourceLabel(thread.source)}\n原目录：${thread.cwd || "无"}\n原因：${thread.reasonDetail}\n更新：${new Date(thread.updatedAt).toLocaleString("zh-CN")}`;
            })
            .join("\n\n")
        : "当前没有未归类会话。",
      options: {
        title: "未归类会话",
        kind: "status",
        tone: visible.length ? "warning" : "neutral",
        status: `${all.length} 个会话 · 第 ${page}/${totalPages} 页`,
        actions: [
          ...visible.flatMap((thread, index) => [
            registeredCommandAction(`查看 ${start + index + 1}`, "inspect", thread.id),
            registeredCommandAction(`迁入 ${start + index + 1}`, "migrate", thread.id)
          ]),
          ...(page > 1
            ? [registeredCommandAction("上一页", "unclassified", String(page - 1))]
            : []),
          ...(page < totalPages
            ? [registeredCommandAction("下一页", "unclassified", String(page + 1))]
            : []),
          registeredCommandAction("项目中心", "projects")
        ]
      }
    };
  }

  public async inspect(threadId: string, pageValue = 1): Promise<NavigationView> {
    const thread = await this.sessions.readThread(threadId);
    const totalPages = Math.max(1, Math.ceil(thread.messages.length / HISTORY_PAGE_SIZE));
    const page = Math.min(validPage(pageValue), totalPages);
    const end = Math.max(0, thread.messages.length - (page - 1) * HISTORY_PAGE_SIZE);
    const start = Math.max(0, end - HISTORY_PAGE_SIZE);
    const messages = thread.messages.slice(start, end);
    return {
      content: messages.length
        ? messages
            .map((item) => `**${item.role === "user" ? "你" : "Codex"}**\n${item.text.slice(0, 2_000)}`)
            .join("\n\n---\n\n")
        : "这个会话还没有可显示的对话内容。",
      options: {
        title: thread.name || "会话历史",
        kind: "status",
        tone: "neutral",
        status: `只读 · 第 ${page}/${totalPages} 页`,
        fields: [
          { label: "来源", value: threadSourceLabel(thread.source) },
          { label: "原目录", value: thread.cwd || "无" }
        ],
        actions: [
          ...(page < totalPages
            ? [registeredCommandAction("更早消息", "inspect", `${threadId} ${page + 1}`)]
            : []),
          ...(page > 1
            ? [registeredCommandAction("较新消息", "inspect", `${threadId} ${page - 1}`, "primary")]
            : []),
          registeredCommandAction("迁入项目", "migrate", threadId, "primary"),
          registeredCommandAction("返回未归类", "unclassified")
        ]
      }
    };
  }

  public pendingConfirmation(scopeKey: string): NavigationView | undefined {
    const pending = this.store.getPendingPrompt(scopeKey, Date.now());
    if (!pending) {
      return undefined;
    }
    return {
      content: `已选择项目和会话。请确认是否执行此前暂存的消息：\n\n> ${pending.prompt.replace(/\s+/gu, " ").slice(0, 500)}`,
      options: {
        title: "确认执行暂存消息",
        kind: "confirmation",
        tone: "warning",
        status: "等待确认",
        actions: [
          registeredCommandAction("确认执行", "pending", "run", "primary"),
          registeredCommandAction("丢弃消息", "pending", "discard", "danger")
        ]
      }
    };
  }
}
