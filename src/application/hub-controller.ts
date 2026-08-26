import type { HubConfig } from "../contracts/config.js";
import type {
  InboundBotMenuAction,
  InboundCardAction,
  InboundMessage
} from "../contracts/events.js";
import { AccessPolicy } from "../domain/access-policy.js";
import { commandForBotMenu } from "../domain/bot-menu.js";
import {
  commandText,
  isCommandId
} from "../domain/command-registry.js";
import { conversationScope, operatorScope } from "../domain/scope.js";
import type { TurnControl } from "../domain/turn-queue.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { ActionBroker } from "../ports/action-broker.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { WorkspaceResolver } from "../ports/workspace-resolver.js";
import { CommandRouter, type CommandContext } from "./command-router.js";
import type { ControlCenterService } from "./control-center-service.js";
import type { DeliveryWorker } from "./delivery-worker.js";
import {
  LarkActionService,
  parseActionCommand
} from "./lark-action-service.js";
import { presentation, resultPresentation } from "./presentation-factory.js";
import type { ReactionProgressService } from "./reaction-progress.js";
import type { SessionCatalogService } from "./session-catalog-service.js";

export class HubController {
  private readonly accessPolicy: AccessPolicy;
  private readonly commands: CommandRouter;
  private readonly larkActions: LarkActionService;

  public constructor(
    config: HubConfig,
    agent: CodingAgent,
    actions: ActionBroker | undefined,
    private readonly store: StateRepository,
    reactions: ReactionProgressService,
    private readonly deliveries: DeliveryWorker,
    private readonly turns: TurnControl,
    sessions: SessionCatalogService,
    workspaces: WorkspaceResolver,
    controlCenter: ControlCenterService,
    logger: Logger
  ) {
    this.accessPolicy = new AccessPolicy(config.feishu);
    this.larkActions = new LarkActionService(
      actions,
      store,
      reactions,
      deliveries,
      logger
    );
    this.commands = new CommandRouter(
      config,
      agent,
      store,
      sessions,
      turns,
      workspaces,
      controlCenter,
      (id, context) => this.larkActions.confirm(id, context),
      (id, context) => this.larkActions.reject(id, context)
    );
  }

  public async handle(message: InboundMessage): Promise<void> {
    const access = this.accessPolicy.decide(message);
    if (!access.allowed) {
      if (access.reason !== "群聊中需要先提及机器人。") {
        this.deliveries.enqueueReply(
          message.messageId,
          presentation(access.reason ?? "访问被拒绝。", {
            title: "访问被拒绝",
            tone: "error",
            status: "无权限"
          }),
          { idempotencyKey: `${message.eventId}:access-denied` }
        );
      }
      return;
    }

    const scopeKey = conversationScope(message);
    if (message.chatKind === "p2p") {
      this.store.rememberP2pScope(
        message.senderOpenId,
        scopeKey,
        message.receivedAt
      );
    }
    const context: CommandContext = {
      scopeKey,
      operatorOpenId: message.senderOpenId,
      chatId: message.chatId,
      message,
      reply: async (replyText, options) => {
        this.deliveries.enqueueReply(
          message.messageId,
          presentation(replyText, options),
          { idempotencyKey: `${message.eventId}:reply:${replyText.slice(0, 32)}` }
        );
      }
    };
    const text = message.text.trim();
    if (await this.commands.handle(context, text)) {
      return;
    }

    try {
      const action = parseActionCommand(text);
      if (action) {
        await this.larkActions.execute(message, scopeKey, action);
        return;
      }
    } catch (error) {
      this.deliveries.enqueueReply(
        message.messageId,
        presentation(`飞书动作参数无效：${errorMessage(error)}`, {
          title: "参数无效",
          tone: "error",
          status: "无法执行"
        }),
        { idempotencyKey: `${message.eventId}:invalid-action` }
      );
      return;
    }
    if (this.turns.shouldSteerReply(message, scopeKey)) {
      const steered = await this.turns.steer(scopeKey, text, message);
      if (steered) {
        return;
      }
    }
    await this.turns.enqueue(message, scopeKey, text);
  }

  public async handleBotMenu(action: InboundBotMenuAction): Promise<void> {
    if (!this.accessPolicy.decideOperator(action.operatorOpenId).allowed) {
      return;
    }
    const command = commandForBotMenu(action.eventKey);
    if (!command) {
      this.deliveries.enqueueSend(
        { type: "open_id", id: action.operatorOpenId },
        presentation("这个快捷菜单事件无效，请按项目文档重新配置机器人菜单。", {
          title: "快捷菜单需要刷新",
          tone: "warning",
          status: "菜单无效"
        }),
        { idempotencyKey: `${action.eventId}:unknown-menu` }
      );
      return;
    }
    const scopeKey = this.store.resolveP2pScope(action.operatorOpenId);
    if (!scopeKey && command !== "/help") {
      this.deliveries.enqueueSend(
        { type: "open_id", id: action.operatorOpenId },
        presentation("请先给机器人发送一条消息，再使用快捷菜单。", {
          title: "尚未建立会话",
          tone: "warning",
          status: "需要消息上下文"
        }),
        { idempotencyKey: `${action.eventId}:missing-scope` }
      );
      return;
    }
    await this.commands.handle(
      {
        scopeKey: scopeKey ?? `p2p:${action.operatorOpenId}`,
        operatorOpenId: action.operatorOpenId,
        chatId: scopeKey?.split(":", 1)[0] ?? "",
        reply: async (replyText, options) => {
          this.deliveries.enqueueSend(
            { type: "open_id", id: action.operatorOpenId },
            presentation(replyText, options),
            { idempotencyKey: `${action.eventId}:menu:${command}` }
          );
        }
      },
      command
    );
  }

  public async handleCardAction(action: InboundCardAction): Promise<void> {
    const access = this.accessPolicy.decideOperator(
      action.operatorOpenId,
      action.chatId
    );
    if (!access.allowed) {
      this.deliveries.enqueueSend(
        { type: "open_id", id: action.operatorOpenId },
        resultPresentation("操作被拒绝", "当前用户没有权限执行该操作。", false),
        { idempotencyKey: `${action.actionId}:denied` }
      );
      return;
    }
    const value =
      action.value && typeof action.value === "object"
        ? (action.value as Record<string, unknown>)
        : undefined;
    const command = typeof value?.command === "string" ? value.command : undefined;
    const id = typeof value?.id === "string" ? value.id : undefined;
    const args = typeof value?.args === "string" ? value.args : "";
    const page = typeof value?.page === "number" && Number.isSafeInteger(value.page)
      ? value.page
      : undefined;
    const scopeKey = operatorScope(action.chatId, action.operatorOpenId);
    const legacyCommand = command === "resume_session" && id
      ? commandText("resume", id)
      : command === "new_session"
        ? commandText("new")
        : command === "cancel_turns"
          ? commandText("cancel")
          : command === "sessions_page" && page && page > 0
            ? commandText("sessions", String(page))
            : undefined;
    if (command === "registered_command" || legacyCommand) {
      let routed = legacyCommand;
      if (!routed) {
        if (!isCommandId(id)) {
          this.deliveries.enqueueUpdate(
            action.messageId,
            resultPresentation("无效操作", "卡片命令已经失效，请重新打开控制中心。", false),
            { idempotencyKey: `${action.actionId}:invalid-command` }
          );
          return;
        }
        routed = commandText(id, args);
      }
      await this.commands.handle(
        {
          scopeKey,
          operatorOpenId: action.operatorOpenId,
          chatId: action.chatId,
          reply: async (replyText, options) => {
            this.deliveries.enqueueUpdate(
              action.messageId,
              presentation(replyText, options),
              { idempotencyKey: `${action.actionId}:command:${id}` }
            );
          }
        },
        routed
      );
      return;
    }
    if (!id || (command !== "confirm" && command !== "reject")) {
      this.deliveries.enqueueUpdate(
        action.messageId,
        resultPresentation("无效操作", "卡片动作参数不完整。", false),
        { idempotencyKey: `${action.actionId}:invalid` }
      );
      return;
    }
    if (command === "reject") {
      const rejected = this.larkActions.reject(id, {
        operatorOpenId: action.operatorOpenId,
        chatId: action.chatId,
        scopeKey
      });
      this.deliveries.enqueueUpdate(
        action.messageId,
        rejected
          ? presentation(`操作 \`${id}\` 已被拒绝。`, {
              title: "已拒绝",
              kind: "action",
              tone: "neutral",
              status: "操作结束"
            })
          : resultPresentation(
              "操作已失效",
              "没有找到待确认操作，可能已经处理。",
              false
            ),
        { idempotencyKey: `${action.actionId}:rejected` }
      );
      return;
    }
    const result = await this.larkActions.confirm(id, {
      operatorOpenId: action.operatorOpenId,
      chatId: action.chatId,
      scopeKey
    });
    this.deliveries.enqueueUpdate(
      action.messageId,
      resultPresentation(
        result.success ? "操作完成" : "操作失败",
        result.summary,
        result.success
      ),
      { idempotencyKey: `${action.actionId}:result` }
    );
  }

}
