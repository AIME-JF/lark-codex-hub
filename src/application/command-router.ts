import { basename } from "node:path";
import type { InboundMessage } from "../contracts/events.js";
import {
  commandHelp,
  looksLikeCommand,
  parseRegisteredCommand,
  registeredCommandAction
} from "../domain/command-registry.js";
import type { TurnControl } from "../domain/turn-queue.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { RunRecord, StateRepository } from "../ports/state-repository.js";
import { errorMessage } from "../observability/logger.js";
import type { ActionApprovalContext } from "./lark-action-service.js";
import type { ControlCenterService } from "./control-center-service.js";
import type { PresentationOptions } from "./presentation-factory.js";
import type { ProjectNavigationService } from "./project-navigation-service.js";
import type { SessionCatalogService } from "./session-catalog-service.js";

const HISTORY_PAGE_SIZE = 8;

export interface CommandContext {
  scopeKey: string;
  operatorOpenId: string;
  chatId: string;
  message?: InboundMessage;
  reply(text: string, options?: PresentationOptions): Promise<void>;
}

type ConfirmAction = (
  id: string,
  context: ActionApprovalContext
) => Promise<{ success: boolean; summary: string }>;

type RejectAction = (id: string, context: ActionApprovalContext) => boolean;

function runStateLabel(run: RunRecord | undefined): string {
  if (!run) {
    return "无记录";
  }
  const labels: Record<RunRecord["state"], string> = {
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断"
  };
  return `${labels[run.state]} · ${new Date(run.startedAt).toLocaleString("zh-CN")}`;
}

function pageNumber(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function splitArgs(value: string): string[] {
  return value.trim().split(/\s+/u).filter(Boolean);
}

export class CommandRouter {
  public constructor(
    private readonly agent: CodingAgent,
    private readonly store: StateRepository,
    private readonly sessions: SessionCatalogService,
    private readonly turns: TurnControl,
    private readonly navigation: ProjectNavigationService,
    private readonly controlCenter: ControlCenterService,
    private readonly confirmAction: ConfirmAction,
    private readonly rejectAction: RejectAction
  ) {}

  public async handle(context: CommandContext, text: string): Promise<boolean> {
    const parsed = parseRegisteredCommand(text || "/hub");
    if (!parsed) {
      if (!looksLikeCommand(text)) {
        return false;
      }
      await context.reply(
        `没有找到命令 \`${text.split(/\s/u, 1)[0]}\`。\n\n${commandHelp("会话与任务")}`,
        {
          title: "未知命令",
          kind: "help",
          tone: "warning",
          status: "命令不存在",
          actions: [registeredCommandAction("打开控制中心", "help", "", "primary")]
        }
      );
      return true;
    }
    if (parsed.definition.delegated) {
      return false;
    }
    const command = parsed.definition.id;
    const args = parsed.args;
    const { scopeKey } = context;

    if (command === "help") {
      const view = await this.controlCenter.home(scopeKey);
      await context.reply(view.content, view.options);
      return true;
    }
    if (command === "tools") {
      const view = this.controlCenter.tools();
      await context.reply(view.content, view.options);
      return true;
    }

    if (command === "projects") {
      const page = pageNumber(args) ?? 1;
      const query = args && pageNumber(args) === undefined ? args : "";
      const view = await this.navigation.projects(scopeKey, page, query);
      await context.reply(view.content, view.options);
      return true;
    }

    if (command === "project") {
      if (!(await this.canSwitch(context))) {
        return true;
      }
      try {
        const project = await this.sessions.selectProject(scopeKey, args);
        const view = await this.navigation.projectSessions(scopeKey, project.key);
        await context.reply(view.content, view.options);
      } catch (error) {
        await this.replyError(context, "项目无法选择", error);
      }
      return true;
    }

    if (command === "sessions") {
      const project = await this.sessions.selectedProject(scopeKey);
      if (!project) {
        const view = await this.navigation.projects(scopeKey);
        await context.reply(view.content, view.options);
        return true;
      }
      const page = args ? pageNumber(args) : 1;
      if (!page) {
        await context.reply("用法：`/sessions [页码]`", {
          title: "无效页码",
          tone: "warning",
          status: "无法翻页"
        });
        return true;
      }
      const view = await this.navigation.projectSessions(scopeKey, project.key, page);
      await context.reply(view.content, view.options);
      return true;
    }

    if (command === "unclassified") {
      const page = args ? pageNumber(args) : 1;
      if (!page) {
        await context.reply("用法：`/unclassified [页码]`", {
          title: "无效页码",
          tone: "warning",
          status: "无法翻页"
        });
        return true;
      }
      const view = await this.navigation.unclassified(page);
      await context.reply(view.content, view.options);
      return true;
    }

    if (command === "inspect") {
      const parts = splitArgs(args);
      if (!parts[0]) {
        await context.reply("缺少会话 ID。", {
          title: "无法查看会话",
          tone: "warning",
          status: "参数不完整"
        });
        return true;
      }
      try {
        const view = await this.navigation.inspect(parts[0], pageNumber(parts[1] ?? "") ?? 1);
        await context.reply(view.content, view.options);
      } catch (error) {
        await this.replyError(context, "会话历史不可用", error);
      }
      return true;
    }

    if (command === "migrate") {
      if (!(await this.canSwitch(context))) {
        return true;
      }
      const [threadId, projectKey] = splitArgs(args);
      if (!threadId) {
        await context.reply("缺少待迁移会话 ID。", {
          title: "无法迁移会话",
          tone: "warning",
          status: "参数不完整"
        });
        return true;
      }
      if (!projectKey) {
        const view = await this.navigation.projects(scopeKey, 1, "", threadId);
        await context.reply(view.content, view.options);
        return true;
      }
      if (projectKey.startsWith("page:")) {
        const page = pageNumber(projectKey.slice(5)) ?? 1;
        const view = await this.navigation.projects(scopeKey, page, "", threadId);
        await context.reply(view.content, view.options);
        return true;
      }
      try {
        const link = await this.sessions.migrate(scopeKey, threadId, projectKey);
        const pending = this.navigation.pendingConfirmation(scopeKey);
        if (pending) {
          await context.reply(pending.content, pending.options);
        } else {
          await context.reply("已从原会话安全分叉，新会话将在目标项目中继续。", {
            title: "会话已迁入项目",
            tone: "success",
            status: "迁移完成",
            fields: [
              { label: "新会话", value: link.sessionId },
              { label: "项目目录", value: link.cwd }
            ]
          });
        }
      } catch (error) {
        await this.replyError(context, "会话迁移失败", error);
      }
      return true;
    }

    if (command === "pending") {
      if (args === "discard") {
        this.store.clearPendingPrompt(scopeKey);
        await context.reply("此前暂存的消息已丢弃。", {
          title: "暂存消息已清除",
          tone: "neutral",
          status: "已结束"
        });
        return true;
      }
      if (args !== "run") {
        await context.reply("暂存消息操作已经失效。", {
          title: "无法处理暂存消息",
          tone: "warning",
          status: "操作无效"
        });
        return true;
      }
      const project = await this.sessions.selectedProject(scopeKey);
      const pending = this.store.consumePendingPrompt(scopeKey, Date.now());
      if (!project || !pending) {
        await context.reply("暂存消息已过期，或当前还没有选择项目。", {
          title: "暂存消息无法执行",
          tone: "warning",
          status: "已失效"
        });
        return true;
      }
      await this.turns.enqueue(pending.message, scopeKey, pending.prompt);
      await context.reply("暂存消息已进入当前项目的执行队列。", {
        title: "已确认执行",
        tone: "success",
        status: "已入队",
        fields: [{ label: "项目", value: project.name }]
      });
      return true;
    }

    if (command === "new") {
      if (!(await this.canSwitch(context))) {
        return true;
      }
      try {
        const project = await this.sessions.startNew(scopeKey, args || undefined);
        const pending = this.navigation.pendingConfirmation(scopeKey);
        if (pending) {
          await context.reply(pending.content, pending.options);
        } else {
          await context.reply("下条消息将在当前项目中创建新会话。", {
            title: "已准备新会话",
            tone: "success",
            status: "准备就绪",
            fields: [{ label: "项目", value: project.name }]
          });
        }
      } catch (error) {
        const view = await this.navigation.projects(scopeKey);
        await context.reply(`${errorMessage(error)}\n\n${view.content}`, view.options);
      }
      return true;
    }

    if (command === "resume") {
      if (!(await this.canSwitch(context))) {
        return true;
      }
      const [sessionId, projectKey] = splitArgs(args);
      if (!sessionId) {
        await context.reply("用法：`/resume <会话 ID 或序号>`", {
          title: "缺少会话",
          tone: "warning",
          status: "无法绑定"
        });
        return true;
      }
      try {
        const selected = await this.sessions.bind(scopeKey, sessionId, projectKey);
        const pending = this.navigation.pendingConfirmation(scopeKey);
        if (pending) {
          await context.reply(pending.content, pending.options);
        } else {
          await context.reply("下一条消息会继续这个 Codex 会话。绑定本身不会加载会话。", {
            title: "会话已绑定",
            tone: "success",
            status: "绑定成功",
            fields: [
              { label: "Codex 会话", value: selected.sessionId },
              { label: "项目目录", value: selected.cwd }
            ]
          });
        }
      } catch (error) {
        await this.replyError(context, "会话无法绑定", error);
      }
      return true;
    }

    if (command === "cancel") {
      const cancelled = await this.turns.cancel(scopeKey);
      const changed = cancelled.interrupted || cancelled.cancelledPending > 0;
      await context.reply(
        changed
          ? `正在取消当前任务；已清除 ${cancelled.cancelledPending} 条排队消息。`
          : "当前没有运行中或排队中的任务。",
        {
          title: changed ? "正在取消" : "没有运行任务",
          tone: changed ? "warning" : "neutral",
          status: changed ? "处理中" : "空闲"
        }
      );
      return true;
    }

    if (command === "queue") {
      const queue = this.turns.snapshot(scopeKey);
      await context.reply(
        queue.items.length
          ? queue.items
              .map(
                (item, index) =>
                  `**${index + 1}.** ${item.prompt.replace(/\s+/gu, " ").slice(0, 120)}\n${new Date(item.createdAt).toLocaleString("zh-CN")}`
              )
              .join("\n\n")
          : "当前没有等待执行的消息。",
        {
          title: "消息队列",
          kind: "status",
          tone: queue.active || queue.pending ? "warning" : "success",
          status: queue.active ? `执行中 · 等待 ${queue.pending}` : `等待 ${queue.pending}`,
          ...(queue.active || queue.pending
            ? { actions: [registeredCommandAction("取消全部", "cancel", "", "danger")] }
            : {})
        }
      );
      return true;
    }

    if (command === "steer") {
      if (!args) {
        await context.reply("用法：`/steer <补充指令>`", {
          title: "缺少补充指令",
          tone: "warning",
          status: "无法追加"
        });
        return true;
      }
      const steered = await this.turns.steer(scopeKey, args, context.message);
      await context.reply(
        steered ? "补充指令已发送给当前任务。" : "当前没有可追加指令的运行中任务。",
        {
          title: steered ? "补充指令已发送" : "无法追加指令",
          tone: steered ? "success" : "warning",
          status: steered ? "已追加" : "当前空闲"
        }
      );
      return true;
    }

    if (command === "status") {
      const project = await this.sessions.selectedProject(scopeKey);
      const link = this.store.getConversation(scopeKey);
      const queue = this.turns.snapshot(scopeKey);
      const running = queue.active || this.agent.activeScopes().includes(scopeKey);
      const latestRun = this.store.getLatestRun(scopeKey);
      const health = this.agent.health
        ? await this.agent.health()
        : { backend: "exec" as const, ready: true, detail: "兼容 Exec 后端" };
      await context.reply(
        !project
          ? "当前尚未选择项目，普通消息不会执行。"
          : running
            ? "Codex 正在处理当前会话中的任务。"
            : health.ready
              ? "当前项目可以接收新的 Codex 指令。"
              : "Codex 后端基础连接不可用。",
        {
          title: "运行状态",
          kind: "status",
          tone: !project || !health.ready ? "warning" : running ? "warning" : "success",
          status: !project ? "未选择项目" : running ? "执行中" : health.ready ? "空闲" : "后端不可用",
          fields: [
            { label: "当前项目", value: project?.name ?? "未选择" },
            { label: "项目目录", value: project?.cwd ?? "—" },
            { label: "Codex 会话", value: link?.sessionId ?? "尚未创建" },
            { label: "执行后端", value: health.backend },
            { label: "最近执行", value: runStateLabel(latestRun) },
            { label: "排队消息", value: String(queue.pending) },
            { label: "诊断", value: health.detail }
          ],
          actions: [
            registeredCommandAction("刷新", "status", "", "primary"),
            project
              ? registeredCommandAction("项目会话", "sessions")
              : registeredCommandAction("选择项目", "projects", "", "primary"),
            registeredCommandAction("消息队列", "queue"),
            ...(running || queue.pending > 0
              ? [registeredCommandAction("停止任务", "cancel", "", "danger")]
              : [registeredCommandAction("控制中心", "help")])
          ]
        }
      );
      return true;
    }

    if (command === "history") {
      const page = args ? pageNumber(args) : 1;
      const link = this.store.getConversation(scopeKey);
      if (!page || !link) {
        await context.reply(link ? "页码无效。" : "当前还没有可读取的 Codex 会话。", {
          title: "会话历史",
          tone: "neutral",
          status: link ? "无法翻页" : "暂无记录"
        });
        return true;
      }
      try {
        const thread = await this.sessions.readThread(link.sessionId);
        const totalPages = Math.max(1, Math.ceil(thread.messages.length / HISTORY_PAGE_SIZE));
        const currentPage = Math.min(page, totalPages);
        const end = Math.max(0, thread.messages.length - (currentPage - 1) * HISTORY_PAGE_SIZE);
        const start = Math.max(0, end - HISTORY_PAGE_SIZE);
        const messages = thread.messages.slice(start, end);
        await context.reply(
          messages.length
            ? messages
                .map((item) => `**${item.role === "user" ? "你" : "Codex"}**\n${item.text.slice(0, 2_000)}`)
                .join("\n\n---\n\n")
            : "这个会话还没有可显示的对话内容。",
          {
            title: thread.name || "最近对话",
            kind: "status",
            status: `第 ${currentPage}/${totalPages} 页 · ${thread.messages.length} 条消息`,
            fields: [
              { label: "会话", value: `${thread.id.slice(0, 8)}…` },
              { label: "项目", value: basename(thread.cwd) || thread.cwd }
            ],
            actions: [
              ...(currentPage < totalPages
                ? [registeredCommandAction("更早消息", "history", String(currentPage + 1))]
                : []),
              ...(currentPage > 1
                ? [registeredCommandAction("较新消息", "history", String(currentPage - 1), "primary")]
                : []),
              registeredCommandAction("控制中心", "help")
            ]
          }
        );
      } catch (error) {
        await this.replyError(context, "会话历史不可用", error);
      }
      return true;
    }

    if (command === "confirm") {
      const result = await this.confirmAction(args, context);
      await context.reply(result.summary, {
        title: result.success ? "操作完成" : "操作失败",
        kind: "action",
        tone: result.success ? "success" : "error",
        status: result.success ? "已完成" : "失败"
      });
      return true;
    }
    if (command === "reject") {
      if (!this.rejectAction(args, context)) {
        await context.reply("没有找到待确认操作。");
      } else {
        await context.reply(`已拒绝操作 \`${args}\`。`, {
          title: "操作已拒绝",
          tone: "neutral",
          status: "已拒绝"
        });
      }
      return true;
    }
    return true;
  }

  private async canSwitch(context: CommandContext): Promise<boolean> {
    const queue = this.turns.snapshot(context.scopeKey);
    if (!queue.active && queue.pending === 0) {
      return true;
    }
    await context.reply("任务运行时不能切换项目或会话，请先取消。", {
      title: "无法切换",
      tone: "warning",
      status: "任务执行中"
    });
    return false;
  }

  private async replyError(
    context: CommandContext,
    title: string,
    error: unknown
  ): Promise<void> {
    await context.reply(errorMessage(error), {
      title,
      tone: "error",
      status: "操作失败"
    });
  }
}
