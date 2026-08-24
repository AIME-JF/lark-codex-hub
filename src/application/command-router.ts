import type { HubConfig } from "../contracts/config.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { WorkspaceResolver } from "../ports/workspace-resolver.js";
import { errorMessage } from "../observability/logger.js";
import type { ActionApprovalContext } from "./lark-action-service.js";
import type { PresentationOptions } from "./presentation-factory.js";

const helpText = `**会话与任务**
- \`/new\`：结束当前会话，下条消息创建新会话
- \`/status\`：查看会话和运行状态
- \`/sessions\`：查看当前飞书会话的 Codex 历史
- \`/resume <session_id>\`：重新绑定历史会话
- \`/cancel\`：取消当前 Codex 任务

**工作目录**
- \`/workspace\`：查看当前目录
- \`/workspace <目录>\`：切换目录并新建会话

**飞书扩展**
- \`/send <身份> <类型> <ID> <内容>\`：以 bot/user 身份发送消息
- \`/task <标题>\`：以当前飞书用户身份创建任务
- \`/doc <标题>\`：下一行开始写 Markdown 正文并创建文档
- \`/action <JSON>\`：执行白名单内的结构化飞书动作
- \`/confirm <编号>\` / \`/reject <编号>\`：处理高风险操作

直接发送其他文本，即可继续当前 Codex 会话。`;

export interface CommandContext {
  scopeKey: string;
  operatorOpenId: string;
  chatId: string;
  reply(text: string, options?: PresentationOptions): Promise<void>;
}

type ConfirmAction = (
  id: string,
  context: ActionApprovalContext
) => Promise<{ success: boolean; summary: string }>;

type RejectAction = (id: string, context: ActionApprovalContext) => boolean;

export class CommandRouter {
  public constructor(
    private readonly config: HubConfig,
    private readonly agent: CodingAgent,
    private readonly store: StateRepository,
    private readonly workspaces: WorkspaceResolver,
    private readonly confirmAction: ConfirmAction,
    private readonly rejectAction: RejectAction
  ) {}

  public async handle(context: CommandContext, text: string): Promise<boolean> {
    if (!text || text === "/help" || text === "/hub" || text === "帮助") {
      await context.reply(helpText, {
        title: "命令中心",
        kind: "help",
        status: "使用帮助"
      });
      return true;
    }

    const { scopeKey } = context;
    if (text === "/new") {
      if (this.agent.activeScopes().includes(scopeKey)) {
        await context.reply("当前任务仍在运行，请先使用 `/cancel`。", {
          title: "无法新建会话",
          tone: "warning",
          status: "任务执行中"
        });
        return true;
      }
      this.store.clearConversation(scopeKey);
      await context.reply("当前会话已解除绑定，下条消息将创建新会话。", {
        title: "已新建会话",
        tone: "success",
        status: "准备就绪"
      });
      return true;
    }

    if (text === "/cancel") {
      const cancelled = this.agent.cancel(scopeKey);
      await context.reply(cancelled ? "正在取消当前任务。" : "当前没有运行中的任务。", {
        title: cancelled ? "正在取消" : "没有运行任务",
        tone: cancelled ? "warning" : "neutral",
        status: cancelled ? "处理中" : "空闲"
      });
      return true;
    }

    if (text === "/status") {
      const link = this.store.getConversation(scopeKey);
      const cwd =
        this.store.getWorkspace(scopeKey) ??
        link?.cwd ??
        this.config.workspace.defaultRoot;
      const running = this.agent.activeScopes().includes(scopeKey);
      await context.reply(
        running ? "Codex 正在处理当前会话中的任务。" : "当前会话可以接收新的 Codex 指令。",
        {
          title: "运行状态",
          kind: "status",
          tone: running ? "warning" : "success",
          status: running ? "执行中" : "空闲",
          fields: [
            { label: "工作目录", value: cwd },
            { label: "Codex 会话", value: link?.sessionId ?? "尚未创建" }
          ]
        }
      );
      return true;
    }

    if (text === "/sessions") {
      const sessions = this.store.listConversations(scopeKey, 10);
      await context.reply(
        sessions.length === 0
          ? "当前没有历史 Codex 会话。"
          : sessions
              .map(
                (session, index) =>
                  `**${index + 1}.** \`${session.sessionId}\`\n${session.cwd}\n${new Date(session.updatedAt).toLocaleString("zh-CN")}`
              )
              .join("\n\n"),
        {
          title: "历史会话",
          kind: "status",
          tone: sessions.length === 0 ? "neutral" : "info",
          status: `${sessions.length} 个会话`
        }
      );
      return true;
    }

    if (text.startsWith("/resume ")) {
      if (this.agent.activeScopes().includes(scopeKey)) {
        await context.reply("任务运行时不能切换会话，请先取消。", {
          title: "无法恢复会话",
          tone: "warning",
          status: "任务执行中"
        });
        return true;
      }
      const sessionId = text.slice(8).trim();
      const selected = this.store
        .listConversations(scopeKey, 100)
        .find((session) => session.sessionId === sessionId);
      if (!selected) {
        await context.reply("历史记录中没有找到该会话。", {
          title: "会话不存在",
          tone: "error",
          status: "恢复失败"
        });
        return true;
      }
      this.store.bindConversation({ ...selected, updatedAt: Date.now() });
      this.store.setWorkspace(scopeKey, selected.cwd, Date.now());
      await context.reply("下一条消息会继续这个 Codex 会话。", {
        title: "会话已恢复",
        tone: "success",
        status: "恢复成功",
        fields: [
          { label: "Codex 会话", value: selected.sessionId },
          { label: "工作目录", value: selected.cwd }
        ]
      });
      return true;
    }

    if (text === "/workspace") {
      const link = this.store.getConversation(scopeKey);
      const cwd =
        this.store.getWorkspace(scopeKey) ??
        link?.cwd ??
        this.config.workspace.defaultRoot;
      await context.reply("切换目录请发送：`/workspace <目录>`", {
        title: "当前工作目录",
        status: "工作区",
        fields: [{ label: "目录", value: cwd }]
      });
      return true;
    }

    if (text.startsWith("/workspace ")) {
      await this.changeWorkspace(context, text.slice(11).trim());
      return true;
    }

    if (text.startsWith("/confirm ")) {
      const result = await this.confirmAction(
        text.slice(9).trim(),
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

    if (text.startsWith("/reject ")) {
      const id = text.slice(8).trim();
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
    return false;
  }

  private async changeWorkspace(
    context: CommandContext,
    requested: string
  ): Promise<void> {
    const { scopeKey } = context;
    if (this.agent.activeScopes().includes(scopeKey)) {
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
