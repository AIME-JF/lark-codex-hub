import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { larkActionSchema, type LarkAction } from "../contracts/actions.js";
import type { HubConfig } from "../contracts/config.js";
import type {
  ExecutionEvent,
  InboundCardAction,
  InboundMessage
} from "../contracts/events.js";
import {
  confirmationCard,
  resultCard
} from "../adapters/feishu/card-renderer.js";
import { AccessPolicy } from "../domain/access-policy.js";
import {
  assertAllowedWorkspace,
  conversationScope
} from "../domain/scope.js";
import type { ActionBroker } from "../ports/action-broker.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { Messenger } from "../ports/messenger.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";

const helpText = `Lark Codex Hub 命令

/help                  查看帮助
/new                   结束当前会话，下条消息创建新会话
/status                查看会话和运行状态
/sessions              查看当前飞书会话的 Codex 历史
/resume <session_id>   重新绑定一个历史 Codex 会话
/cancel                取消当前 Codex 任务
/workspace <目录>      切换工作目录并新建会话
/send <身份> <类型> <ID> <内容>
                       身份为 bot/user，类型为 open_id/chat_id
/task <标题>           以当前飞书用户身份创建任务
/doc <标题>            下一行开始写 Markdown 正文并创建文档
/action <JSON>         执行白名单内的结构化飞书动作
/confirm <编号>        确认飞书高风险操作
/reject <编号>         拒绝飞书高风险操作

其他文本会发送给当前 Codex 会话。`;

function parseActionCommand(text: string): LarkAction | undefined {
  if (text.startsWith("/action ")) {
    return larkActionSchema.parse(JSON.parse(text.slice(8).trim()));
  }
  const send = text.match(/^\/send\s+(bot|user)\s+(open_id|chat_id)\s+(\S+)\s+([\s\S]+)$/);
  if (send) {
    return larkActionSchema.parse({
      kind: "send_message",
      identity: send[1],
      receiveIdType: send[2],
      receiveId: send[3],
      text: send[4]
    });
  }
  if (text.startsWith("/task ")) {
    return larkActionSchema.parse({
      kind: "create_task",
      identity: "user",
      summary: text.slice(6).trim(),
      description: ""
    });
  }
  if (text.startsWith("/doc ")) {
    const body = text.slice(5);
    const newline = body.indexOf("\n");
    const title = (newline >= 0 ? body.slice(0, newline) : body).trim();
    const markdown = newline >= 0 ? body.slice(newline + 1) : "";
    return larkActionSchema.parse({
      kind: "create_document",
      identity: "user",
      title,
      markdown
    });
  }
  return undefined;
}

export class HubController {
  private readonly accessPolicy: AccessPolicy;

  public constructor(
    private readonly config: HubConfig,
    private readonly messenger: Messenger,
    private readonly agent: CodingAgent,
    private readonly actions: ActionBroker | undefined,
    private readonly store: StateRepository,
    private readonly logger: Logger
  ) {
    this.accessPolicy = new AccessPolicy(config.feishu);
  }

  public async handle(message: InboundMessage): Promise<void> {
    if (!this.store.claimInbox(message.eventId, message.messageId, message.receivedAt)) {
      this.logger.debug("忽略重复飞书事件", { eventId: message.eventId });
      return;
    }
    const access = this.accessPolicy.decide(message);
    if (!access.allowed) {
      if (access.reason !== "群聊中需要先提及机器人。") {
        await this.messenger.replyText(message.messageId, access.reason ?? "访问被拒绝。");
      }
      return;
    }

    const text = message.text.trim();
    if (!text || text === "/help" || text === "帮助") {
      await this.messenger.replyText(message.messageId, helpText);
      return;
    }

    const scopeKey = conversationScope(message);
    if (text === "/new") {
      if (this.agent.activeScopes().includes(scopeKey)) {
        await this.messenger.replyText(message.messageId, "当前任务仍在运行，请先使用 /cancel。 ");
        return;
      }
      this.store.clearConversation(scopeKey);
      await this.messenger.replyText(message.messageId, "当前会话已解除绑定，下条消息将创建新会话。");
      return;
    }

    if (text === "/cancel") {
      const cancelled = this.agent.cancel(scopeKey);
      await this.messenger.replyText(
        message.messageId,
        cancelled ? "正在取消当前任务。" : "当前没有运行中的任务。"
      );
      return;
    }

    if (text === "/status") {
      const link = this.store.getConversation(scopeKey);
      const cwd = this.store.getWorkspace(scopeKey) ?? link?.cwd ?? this.config.workspace.defaultRoot;
      const running = this.agent.activeScopes().includes(scopeKey);
      await this.messenger.replyText(
        message.messageId,
        [
          `状态：${running ? "执行中" : "空闲"}`,
          `工作目录：${cwd}`,
          `Codex 会话：${link?.sessionId ?? "尚未创建"}`
        ].join("\n")
      );
      return;
    }

    if (text === "/sessions") {
      const sessions = this.store.listConversations(scopeKey, 10);
      await this.messenger.replyText(
        message.messageId,
        sessions.length === 0
          ? "当前没有历史 Codex 会话。"
          : sessions
              .map(
                (session, index) =>
                  `${index + 1}. ${session.sessionId}\n   ${session.cwd}\n   ${new Date(session.updatedAt).toLocaleString("zh-CN")}`
              )
              .join("\n")
      );
      return;
    }

    if (text.startsWith("/resume ")) {
      if (this.agent.activeScopes().includes(scopeKey)) {
        await this.messenger.replyText(message.messageId, "任务运行时不能切换会话，请先取消。 ");
        return;
      }
      const sessionId = text.slice(8).trim();
      const selected = this.store
        .listConversations(scopeKey, 100)
        .find((session) => session.sessionId === sessionId);
      if (!selected) {
        await this.messenger.replyText(message.messageId, "历史记录中没有找到该会话。 ");
        return;
      }
      this.store.bindConversation({ ...selected, updatedAt: Date.now() });
      this.store.setWorkspace(scopeKey, selected.cwd, Date.now());
      await this.messenger.replyText(
        message.messageId,
        `已恢复 Codex 会话：${selected.sessionId}\n工作目录：${selected.cwd}`
      );
      return;
    }

    if (text.startsWith("/workspace ")) {
      await this.changeWorkspace(message, scopeKey, text.slice(11).trim());
      return;
    }

    if (text.startsWith("/confirm ")) {
      await this.confirmAction(message, text.slice(9).trim());
      return;
    }

    if (text.startsWith("/reject ")) {
      const id = text.slice(8).trim();
      const pending = this.store.getPendingAction(id);
      if (!pending) {
        await this.messenger.replyText(message.messageId, "没有找到待确认操作。");
        return;
      }
      this.store.finishAction(id, "rejected", Date.now());
      await this.messenger.replyText(message.messageId, `已拒绝操作 ${id}。`);
      return;
    }

    try {
      const action = parseActionCommand(text);
      if (action) {
        await this.executeAction(message, action);
        return;
      }
    } catch (error) {
      await this.messenger.replyText(
        message.messageId,
        `飞书动作参数无效：${errorMessage(error)}`
      );
      return;
    }

    await this.runCodex(message, scopeKey, text);
  }

  public async handleCardAction(action: InboundCardAction): Promise<void> {
    const allowedUsers = new Set([
      this.config.feishu.ownerOpenId,
      ...this.config.feishu.allowedOpenIds
    ]);
    if (!allowedUsers.has(action.operatorOpenId)) {
      await this.messenger.updateCard(
        action.messageId,
        resultCard("操作被拒绝", "当前用户没有权限执行该操作。", false)
      );
      return;
    }
    if (
      this.config.feishu.allowedChatIds.length > 0 &&
      !this.config.feishu.allowedChatIds.includes(action.chatId)
    ) {
      return;
    }
    if (!this.store.claimInbox(action.actionId, action.actionId, action.receivedAt)) {
      return;
    }
    const value =
      action.value && typeof action.value === "object"
        ? (action.value as Record<string, unknown>)
        : undefined;
    const command = typeof value?.command === "string" ? value.command : undefined;
    const id = typeof value?.id === "string" ? value.id : undefined;
    if (!id || (command !== "confirm" && command !== "reject")) {
      await this.messenger.updateCard(
        action.messageId,
        resultCard("无效操作", "卡片动作参数不完整。", false)
      );
      return;
    }
    if (command === "reject") {
      const pending = this.store.getPendingAction(id);
      if (!pending) {
        await this.messenger.updateCard(
          action.messageId,
          resultCard("操作已失效", "没有找到待确认操作，可能已经处理。", false)
        );
        return;
      }
      this.store.finishAction(id, "rejected", Date.now());
      await this.messenger.updateCard(
        action.messageId,
        resultCard("已拒绝", `操作 ${id} 已被拒绝。`, false)
      );
      return;
    }
    const result = await this.performConfirmedAction(id);
    await this.messenger.updateCard(
      action.messageId,
      resultCard(result.success ? "操作完成" : "操作失败", result.summary, result.success)
    );
  }

  private async changeWorkspace(
    message: InboundMessage,
    scopeKey: string,
    requested: string
  ): Promise<void> {
    if (this.agent.activeScopes().includes(scopeKey)) {
      await this.messenger.replyText(message.messageId, "任务运行时不能切换目录，请先取消。 ");
      return;
    }
    try {
      const cwd = assertAllowedWorkspace(resolve(requested), this.config.workspace.allowedRoots);
      const info = await stat(cwd);
      if (!info.isDirectory()) {
        throw new Error("指定路径不是目录。");
      }
      this.store.setWorkspace(scopeKey, cwd, Date.now());
      this.store.clearConversation(scopeKey);
      await this.messenger.replyText(
        message.messageId,
        `工作目录已切换为：${cwd}\n下条消息将创建新会话。`
      );
    } catch (error) {
      await this.messenger.replyText(message.messageId, errorMessage(error));
    }
  }

  private async runCodex(
    message: InboundMessage,
    scopeKey: string,
    prompt: string
  ): Promise<void> {
    const runId = randomUUID();
    const now = Date.now();
    const leaseMs = this.config.runtime.leaseSeconds * 1_000;
    if (!this.store.acquireLease(scopeKey, runId, now, leaseMs)) {
      await this.messenger.replyText(
        message.messageId,
        "当前会话已有任务占用。租约超时后会自动恢复，也可以使用 /cancel。"
      );
      return;
    }
    const link = this.store.getConversation(scopeKey);
    const cwd = this.store.getWorkspace(scopeKey) ?? link?.cwd ?? this.config.workspace.defaultRoot;
    this.store.createRun({
      id: runId,
      scopeKey,
      ...(link?.sessionId ? { sessionId: link.sessionId } : {}),
      state: "running",
      startedAt: now
    });
    const heartbeat = setInterval(() => {
      this.store.heartbeatLease(scopeKey, runId, Date.now(), leaseMs);
    }, Math.max(10_000, Math.floor(leaseMs / 3)));
    heartbeat.unref();

    await this.messenger.replyText(message.messageId, "已开始处理，完成后会在此回复。 ");

    let currentSessionId = link?.sessionId;
    const onEvent = async (event: ExecutionEvent): Promise<void> => {
      if (event.type === "session") {
        currentSessionId = event.sessionId;
        this.store.bindConversation({
          scopeKey,
          sessionId: event.sessionId,
          cwd,
          updatedAt: Date.now()
        });
      } else if (event.type === "progress") {
        this.logger.debug("Codex 执行进度", { scopeKey, label: event.label });
      } else if (event.type === "error") {
        this.logger.warn("Codex 返回错误事件", { scopeKey, error: event.message });
      }
    };

    try {
      const result = await this.agent.run(
        {
          scopeKey,
          prompt,
          cwd,
          ...(link?.sessionId ? { sessionId: link.sessionId } : {}),
          ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
          sandbox: this.config.codex.sandbox,
          timeoutMs: this.config.codex.timeoutMinutes * 60_000
        },
        onEvent
      );
      if (result.sessionId && result.sessionId !== currentSessionId) {
        this.store.bindConversation({
          scopeKey,
          sessionId: result.sessionId,
          cwd,
          updatedAt: Date.now()
        });
      }
      const cancelled = result.finalText === "任务已取消。";
      this.store.finishRun(runId, cancelled ? "cancelled" : "completed", Date.now());
      await this.messenger.replyText(
        message.messageId,
        result.finalText || "Codex 已完成，但没有返回文本结果。"
      );
    } catch (error) {
      const detail = errorMessage(error);
      this.store.finishRun(runId, "failed", Date.now(), detail);
      this.logger.error("Codex 任务失败", { runId, scopeKey, error: detail });
      await this.messenger.replyText(message.messageId, `执行失败：${detail}`);
    } finally {
      clearInterval(heartbeat);
      this.store.releaseLease(scopeKey, runId);
    }
  }

  private async executeAction(message: InboundMessage, action: LarkAction): Promise<void> {
    if (!this.actions) {
      await this.messenger.replyText(message.messageId, "飞书扩展动作当前已禁用。");
      return;
    }
    const id = randomUUID();
    const result = await this.actions.execute(action, id);
    if (result.status === "confirmation_required" && result.confirmation) {
      const shortId = id.slice(0, 8);
      this.store.savePendingAction(
        {
          id: shortId,
          idempotencyKey: id,
          actionJson: JSON.stringify(action),
          confirmationJson: JSON.stringify(result.confirmation)
        },
        Date.now()
      );
      await this.messenger.replyCard(
        message.messageId,
        confirmationCard({
          id: shortId,
          action: result.confirmation.action,
          risk: result.confirmation.risk,
          params: result.confirmation.params
        })
      );
      return;
    }
    await this.messenger.replyText(message.messageId, result.summary);
  }

  private async confirmAction(message: InboundMessage, id: string): Promise<void> {
    const result = await this.performConfirmedAction(id);
    await this.messenger.replyText(message.messageId, result.summary);
  }

  private async performConfirmedAction(
    id: string
  ): Promise<{ success: boolean; summary: string }> {
    if (!this.actions) {
      return { success: false, summary: "飞书扩展动作当前已禁用。" };
    }
    const pending = this.store.getPendingAction(id);
    if (!pending) {
      return { success: false, summary: "没有找到待确认操作，可能已经处理。" };
    }
    try {
      const action = larkActionSchema.parse(JSON.parse(pending.actionJson));
      this.store.finishAction(id, "approved", Date.now());
      const result = await this.actions.execute(action, pending.idempotencyKey, true);
      const success = result.status === "completed";
      this.store.finishAction(id, success ? "completed" : "failed", Date.now());
      return { success, summary: result.summary };
    } catch (error) {
      this.store.finishAction(id, "failed", Date.now());
      return { success: false, summary: `确认执行失败：${errorMessage(error)}` };
    }
  }
}
