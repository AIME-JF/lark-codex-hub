import { basename } from "node:path";
import type { HubConfig } from "../contracts/config.js";
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
import type { WorkspaceResolver } from "../ports/workspace-resolver.js";
import { errorMessage } from "../observability/logger.js";
import type { ActionApprovalContext } from "./lark-action-service.js";
import type { ControlCenterService } from "./control-center-service.js";
import type { PresentationOptions } from "./presentation-factory.js";
import {
  threadSourceLabel,
  threadStatusLabel,
  type SessionCatalogService
} from "./session-catalog-service.js";

const SESSION_CATALOG_LIMIT = 100;
const SESSION_PAGE_SIZE = 5;
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

export class CommandRouter {
  public constructor(
    private readonly config: HubConfig,
    private readonly agent: CodingAgent,
    private readonly store: StateRepository,
    private readonly sessions: SessionCatalogService,
    private readonly turns: TurnControl,
    private readonly workspaces: WorkspaceResolver,
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

    if (command === "help") {
      const view = this.controlCenter.home(context.scopeKey);
      await context.reply(view.content, view.options);
      return true;
    }

    if (command === "tools") {
      const view = this.controlCenter.tools();
      await context.reply(view.content, view.options);
      return true;
    }

    const { scopeKey } = context;
    if (command === "new") {
      const queue = this.turns.snapshot(scopeKey);
      if (queue.active || queue.pending > 0) {
        await context.reply("当前仍有运行中或排队中的任务，请先使用 `/cancel`。", {
          title: "无法新建会话",
          tone: "warning",
          status: "任务执行中"
        });
        return true;
      }
      this.store.clearConversation(scopeKey);
      await context.reply("当前会话已解除绑定，下条消息将创建新会话。", {
        title: "已解除当前会话",
        tone: "success",
        status: "准备就绪"
      });
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
      });
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
          status: queue.active
            ? `执行中 · 等待 ${queue.pending}`
            : `等待 ${queue.pending}`,
          ...(queue.active || queue.pending
            ? {
                actions: [
                  {
                    label: "取消全部",
                    style: "danger" as const,
                    value: registeredCommandAction("", "cancel").value
                  }
                ]
              }
            : {})
        }
      );
      return true;
    }

    if (command === "steer") {
      const prompt = args;
      if (!prompt) {
        await context.reply("用法：`/steer <补充指令>`", {
          title: "缺少补充指令",
          tone: "warning",
          status: "无法追加"
        });
        return true;
      }
      const steered = await this.turns.steer(scopeKey, prompt, context.message);
      if (!steered) {
        await context.reply("当前没有可追加指令的运行中任务。", {
          title: "无法追加指令",
          tone: "warning",
          status: "当前空闲"
        });
      } else {
        await context.reply("补充指令已发送给当前正在运行的 Codex 任务。", {
          title: "补充指令已发送",
          tone: "success",
          status: "已追加"
        });
      }
      return true;
    }

    if (command === "status") {
      const link = this.store.getConversation(scopeKey);
      const cwd =
        this.store.getWorkspace(scopeKey) ??
        link?.cwd ??
        this.config.workspace.defaultRoot;
      const queue = this.turns.snapshot(scopeKey);
      const running = queue.active || this.agent.activeScopes().includes(scopeKey);
      const latestRun = this.store.getLatestRun(scopeKey);
      const latestFailed = latestRun?.state === "failed";
      const health = this.agent.health
        ? await this.agent.health()
        : {
            backend: "exec" as const,
            ready: true,
            detail: "兼容 Exec 后端"
          };
      const content = running
        ? "Codex 正在处理当前会话中的任务。"
        : !health.ready
          ? "Codex 后端基础连接不可用，请先查看诊断信息。"
          : latestFailed
            ? "服务可以接收消息，但最近一次 Codex 执行失败。"
            : "当前会话可以接收新的 Codex 指令。";
      const status = running
        ? "执行中"
        : !health.ready
          ? "后端不可用"
          : latestFailed
            ? "最近执行失败"
            : "空闲";
      await context.reply(
        content,
        {
          title: "运行状态",
          kind: "status",
          tone: running ? "warning" : !health.ready || latestFailed ? "error" : "success",
          status,
          fields: [
            { label: "工作目录", value: cwd },
            { label: "Codex 会话", value: link?.sessionId ?? "尚未创建" },
            { label: "执行后端", value: health.backend },
            { label: "基础连接", value: health.ready ? "可用" : "不可用" },
            { label: "最近执行", value: runStateLabel(latestRun) },
            { label: "排队消息", value: String(queue.pending) },
            { label: "诊断", value: health.detail },
            ...(latestFailed && latestRun.error
              ? [{ label: "最近错误", value: latestRun.error.slice(0, 600) }]
              : [])
          ],
          actions: [
            registeredCommandAction("刷新", "status", "", "primary"),
            registeredCommandAction("历史会话", "sessions"),
            registeredCommandAction("消息队列", "queue"),
            ...(running || queue.pending > 0
              ? [registeredCommandAction("停止任务", "cancel", "", "danger")]
              : [registeredCommandAction("控制中心", "help")])
          ]
        }
      );
      return true;
    }

    if (command === "sessions") {
      const pageText = args;
      const requestedPage = pageText && /^\d+$/u.test(pageText)
        ? Number.parseInt(pageText, 10)
        : 1;
      if (pageText && (!Number.isSafeInteger(requestedPage) || requestedPage < 1)) {
        await context.reply("用法：`/sessions [页码]`", {
          title: "无效页码",
          tone: "warning",
          status: "无法翻页"
        });
        return true;
      }
      try {
        const sessions = await this.sessions.list(scopeKey, SESSION_CATALOG_LIMIT);
        const totalPages = Math.max(1, Math.ceil(sessions.length / SESSION_PAGE_SIZE));
        const page = Math.min(requestedPage, totalPages);
        const start = (page - 1) * SESSION_PAGE_SIZE;
        const visible = sessions.slice(start, start + SESSION_PAGE_SIZE);
        await context.reply(
          sessions.length === 0
            ? "共享白名单目录内没有可恢复的 Codex 会话。"
            : visible
                .map((session, index) => {
                  const position = start + index + 1;
                  const title = session.name || session.preview || `会话 ${position}`;
                  const current = session.current ? " · 当前绑定" : "";
                  return `**${position}. ${title.replace(/\s+/gu, " ").slice(0, 80)}**\n来源：${threadSourceLabel(session.source)}${current}\n状态：${threadStatusLabel(session.status)}\n项目：${basename(session.cwd) || session.cwd}\n更新：${new Date(session.updatedAt).toLocaleString("zh-CN")}`;
                })
                .join("\n\n"),
          {
            title: "Codex 全局会话",
            kind: "status",
            tone: sessions.length === 0 ? "neutral" : "info",
            status: sessions.length === 0
              ? "0 个可用会话"
              : `第 ${page}/${totalPages} 页 · ${sessions.length} 个可用会话`,
            actions: [
              ...visible.map((session, index) => ({
                label: `${session.current ? "当前" : "恢复"} ${start + index + 1}`,
                style: session.current ? "primary" as const : "default" as const,
                value: registeredCommandAction("", "resume", session.id).value
              })),
              ...(page > 1
                ? [{
                    label: "上一页",
                    style: "default" as const,
                    value: registeredCommandAction("", "sessions", String(page - 1)).value
                  }]
                : []),
              ...(page < totalPages
                ? [{
                    label: "下一页",
                    style: "default" as const,
                    value: registeredCommandAction("", "sessions", String(page + 1)).value
                  }]
                : []),
              {
                label: "新建会话",
                style: "primary" as const,
                value: registeredCommandAction("", "new").value
              },
              {
                label: "控制中心",
                style: "default" as const,
                value: registeredCommandAction("", "help").value
              }
            ]
          }
        );
      } catch (error) {
        await context.reply(`读取全局会话失败：${errorMessage(error)}`, {
          title: "会话目录不可用",
          tone: "error",
          status: "读取失败"
        });
      }
      return true;
    }

    if (command === "history") {
      const pageText = args;
      const requestedPage = pageText && /^\d+$/u.test(pageText)
        ? Number.parseInt(pageText, 10)
        : 1;
      if (pageText && (!Number.isSafeInteger(requestedPage) || requestedPage < 1)) {
        await context.reply("用法：`/history [页码]`", {
          title: "无效页码",
          tone: "warning",
          status: "无法翻页"
        });
        return true;
      }
      const link = this.store.getConversation(scopeKey);
      if (!link || !this.agent.readThread) {
        await context.reply("当前还没有可读取的 Codex 会话。", {
          title: "会话历史",
          tone: "neutral",
          status: "暂无记录"
        });
        return true;
      }
      try {
        const thread = await this.agent.readThread(link.sessionId, true);
        const totalPages = Math.max(1, Math.ceil(thread.messages.length / HISTORY_PAGE_SIZE));
        const page = Math.min(requestedPage, totalPages);
        const end = Math.max(0, thread.messages.length - (page - 1) * HISTORY_PAGE_SIZE);
        const start = Math.max(0, end - HISTORY_PAGE_SIZE);
        const messages = thread.messages.slice(start, end);
        await context.reply(
          messages.length
            ? messages
                .map((item) => {
                  const role = item.role === "user" ? "你" : "Codex";
                  return `**${role}**\n${item.text.slice(0, 2_000)}`;
                })
                .join("\n\n---\n\n")
            : "这个会话还没有可显示的对话内容。",
          {
            title: thread.name || "最近对话",
            kind: "status",
            status: `第 ${page}/${totalPages} 页 · ${thread.messages.length} 条消息`,
            fields: [
              { label: "会话", value: `${thread.id.slice(0, 8)}…` },
              { label: "项目", value: basename(thread.cwd) || thread.cwd }
            ],
            actions: [
              ...(page < totalPages
                ? [registeredCommandAction("更早消息", "history", String(page + 1))]
                : []),
              ...(page > 1
                ? [registeredCommandAction("较新消息", "history", String(page - 1), "primary")]
                : []),
              registeredCommandAction("控制中心", "help")
            ]
          }
        );
      } catch (error) {
        await context.reply(`读取会话失败：${errorMessage(error)}`, {
          title: "会话历史不可用",
          tone: "error",
          status: "读取失败"
        });
      }
      return true;
    }

    if (command === "resume") {
      const queue = this.turns.snapshot(scopeKey);
      if (queue.active || queue.pending > 0) {
        await context.reply("任务运行时不能切换会话，请先取消。", {
          title: "无法恢复会话",
          tone: "warning",
          status: "任务执行中"
        });
        return true;
      }
      const sessionId = args;
      if (!sessionId) {
        await context.reply("用法：`/resume <会话 ID 或序号>`", {
          title: "缺少会话",
          tone: "warning",
          status: "无法绑定"
        });
        return true;
      }
      try {
        const selected = await this.sessions.bind(scopeKey, sessionId);
        await context.reply("下一条消息会继续这个 Codex 会话。绑定本身不会加载会话或占用 writer。", {
          title: "会话已绑定",
          tone: "success",
          status: "绑定成功",
          fields: [
            { label: "Codex 会话", value: selected.sessionId },
            { label: "工作目录", value: selected.cwd }
          ]
        });
      } catch (error) {
        await context.reply(errorMessage(error), {
          title: "会话无法绑定",
          tone: "error",
          status: "恢复失败"
        });
      }
      return true;
    }

    if (command === "workspace" && !args) {
      const link = this.store.getConversation(scopeKey);
      const cwd =
        this.store.getWorkspace(scopeKey) ??
        link?.cwd ??
        this.config.workspace.defaultRoot;
      await context.reply("请选择允许目录，或发送：`/workspace <目录>`", {
        title: "当前工作目录",
        status: "工作区",
        fields: [{ label: "目录", value: cwd }],
        actions: [
          ...this.config.workspace.allowedRoots.slice(0, 6).map((root) =>
            registeredCommandAction(
              basename(root) || root,
              "workspace",
              root,
              root === cwd ? "primary" : "default"
            )
          ),
          registeredCommandAction("控制中心", "help")
        ]
      });
      return true;
    }

    if (command === "workspace") {
      await this.changeWorkspace(context, args);
      return true;
    }

    if (command === "confirm") {
      const result = await this.confirmAction(
        args,
        context
      );
      await context.reply(result.summary, {
        title: result.success ? "操作完成" : "操作失败",
        kind: "action",
        tone: result.success ? "success" : "error",
        status: result.success ? "已完成" : "失败"
      });
      return true;
    }

    if (command === "reject") {
      const id = args;
      if (!this.rejectAction(id, context)) {
        await context.reply("没有找到待确认操作。");
        return true;
      }
      await context.reply(`已拒绝操作 \`${id}\`。`, {
        title: "操作已拒绝",
        tone: "neutral",
        status: "已拒绝"
      });
      return true;
    }
    return true;
  }

  private async changeWorkspace(
    context: CommandContext,
    requested: string
  ): Promise<void> {
    const { scopeKey } = context;
    const queue = this.turns.snapshot(scopeKey);
    if (queue.active || queue.pending > 0) {
      await context.reply("任务运行时不能切换目录，请先取消。", {
        title: "无法切换目录",
        tone: "warning",
        status: "任务执行中"
      });
      return;
    }
    try {
      const link = this.store.getConversation(scopeKey);
      const base =
        this.store.getWorkspace(scopeKey) ??
        link?.cwd ??
        this.config.workspace.defaultRoot;
      const cwd = await this.workspaces.resolveAllowed(
        requested,
        base,
        this.config.workspace.allowedRoots
      );
      this.store.setWorkspace(scopeKey, cwd, Date.now());
      this.store.clearConversation(scopeKey);
      await context.reply("下条消息将在这个目录中创建新会话。", {
        title: "工作目录已切换",
        tone: "success",
        status: "切换成功",
        fields: [{ label: "目录", value: cwd }]
      });
    } catch (error) {
      await context.reply(errorMessage(error), {
        title: "目录切换失败",
        tone: "error",
        status: "无效目录"
      });
    }
  }
}
