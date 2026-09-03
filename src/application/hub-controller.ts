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
  isCommandId,
  registeredCommandAction,
  sessionConflictActions
} from "../domain/command-registry.js";
import { conversationScope, operatorScope } from "../domain/scope.js";
import type { TurnControl } from "../domain/turn-queue.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { ActionBroker } from "../ports/action-broker.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { StateRepository } from "../ports/state-repository.js";
import { CommandRouter, type CommandContext } from "./command-router.js";
import type { ControlCenterService } from "./control-center-service.js";
import type { DeliveryWorker } from "./delivery-worker.js";
import {
  LarkActionService,
  parseActionCommand
} from "./lark-action-service.js";
import { presentation, resultPresentation } from "./presentation-factory.js";
import type { ReactionProgressService } from "./reaction-progress.js";
import type { ProjectNavigationService } from "./project-navigation-service.js";
import type { SessionCatalogService } from "./session-catalog-service.js";

export class HubController {
  private readonly accessPolicy: AccessPolicy;
  private readonly commands: CommandRouter;
  private readonly larkActions: LarkActionService;
  private readonly pendingPromptTtlMs: number;

  public constructor(
    config: HubConfig,
    agent: CodingAgent,
    actions: ActionBroker | undefined,
    private readonly store: StateRepository,
    private readonly reactions: ReactionProgressService,
    private readonly deliveries: DeliveryWorker,
    private readonly turns: TurnControl,
    private readonly sessions: SessionCatalogService,
    private readonly navigation: ProjectNavigationService,
    controlCenter: ControlCenterService,
    logger: Logger
  ) {
    this.accessPolicy = new AccessPolicy(config.feishu);
    this.pendingPromptTtlMs = config.projects.pendingPromptMinutes * 60_000;
    this.larkActions = new LarkActionService(
      actions,
      store,
      reactions,
      deliveries,
      logger
    );
    this.commands = new CommandRouter(
      agent,
      store,
      sessions,
      turns,
      navigation,
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
    const openConflict = this.store.getOpenSessionConflict(scopeKey);
    if (openConflict) {
      // Persist messages received while the A/B card is pending. The queue
      // freezes their target to the conflict record, so they will follow the
      // same decision instead of being silently dropped or routed elsewhere.
      const pending = await this.turns.enqueue(message, scopeKey, text);
      this.deliveries.enqueueReply(
        message.messageId,
        presentation(
          `当前会话正在等待占用选择，本条消息已暂存（队列 ${pending} 条）。处理 A/B 后会继续执行。`,
          {
            title: "消息已暂存",
            tone: "warning",
            status: "等待占用选择",
            fields: [
              { label: "工作目录", value: openConflict.target.cwd },
              { label: "目标会话", value: openConflict.target.sessionId }
            ],
            actions: sessionConflictActions(openConflict)
          }
        ),
        { idempotencyKey: `${message.eventId}:conflict-deferred` }
      );
      return;
    }
    if (this.turns.shouldSteerReply(message, scopeKey)) {
      const steered = await this.turns.steer(scopeKey, text, message);
      if (steered) {
        return;
      }
    }
    let project;
    try {
      project = await this.sessions.selectedProject(scopeKey);
    } catch (error) {
      this.deliveries.enqueueReply(
        message.messageId,
        presentation(`暂时无法读取 Codex 项目索引：${errorMessage(error)}`, {
          title: "项目索引暂不可用",
          tone: "warning",
          status: "请稍后重试",
          actions: [registeredCommandAction("刷新项目", "projects", "", "primary")]
        }),
        { idempotencyKey: `${message.eventId}:project-index-error` }
      );
      return;
    }
    if (!project) {
      this.store.savePendingPrompt({
        scopeKey,
        message,
        prompt: text,
        createdAt: message.receivedAt,
        expiresAt: message.receivedAt + this.pendingPromptTtlMs
      });
      await this.commands.handle(context, "/projects");
      return;
    }
    if (
      !this.store.getConversation(scopeKey) &&
      !this.store.getNewSessionIntent(scopeKey)
    ) {
      this.store.savePendingPrompt({
        scopeKey,
        message,
        prompt: text,
        createdAt: message.receivedAt,
        expiresAt: message.receivedAt + this.pendingPromptTtlMs
      });
      const view = await this.navigation.projectSessions(scopeKey, project.key);
      await context.reply(view.content, view.options);
      return;
    }
    // 用户在已经选定项目后发送了新消息，视为主动放弃此前暂存内容。
    this.store.clearPendingPrompt(scopeKey);
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
    // 会话占用卡片的分流选项使用独立动作，避免把一次性选择
    // 暗编码成普通文本命令。冲突记录会冻结目标和原始任务，回调只
    // 能消费一次，避免旧卡片把消息误投到当前绑定的其他会话。
    if (command === "session_conflict") {
      const choice = typeof value?.choice === "string" ? value.choice : undefined;
      const conflictId = typeof value?.conflictId === "string" ? value.conflictId : undefined;
      const token = typeof value?.token === "string" ? value.token : undefined;
      if (
        !conflictId ||
        !token ||
        (choice !== "wait" && choice !== "branch" && choice !== "cancel")
      ) {
        this.deliveries.enqueueUpdate(
          action.messageId,
          resultPresentation("无效操作", "会话占用选择已失效，请重新发送消息。", false),
          { idempotencyKey: `${action.actionId}:invalid-conflict` }
        );
        return;
      }
      const claimed = this.store.claimSessionConflict(
        conflictId,
        token,
        action.operatorOpenId,
        action.chatId,
        scopeKey,
        choice,
        Date.now(),
        action.messageId
      );
      if (!claimed) {
        this.deliveries.enqueueUpdate(
          action.messageId,
          resultPresentation("操作已失效", "这张占用卡片已经处理过或已过期，请查看最新状态。", false),
          { idempotencyKey: `${action.actionId}:conflict-stale` }
        );
        return;
      }
      if (choice === "cancel") {
        const cancelledAt = Date.now();
        this.store.finishTurnJobs(
          claimed.jobIds,
          "cancelled",
          cancelledAt,
          "用户取消了会话占用请求。"
        );
        await Promise.all(
          claimed.jobIds
            .map((jobId) => this.store.getTurnJob(jobId))
            .filter((job): job is NonNullable<ReturnType<StateRepository["getTurnJob"]>> => Boolean(job))
            .map((job) =>
              this.reactions.track(job.id, job.message.messageId).finish("cancelled")
            )
        );
        this.deliveries.enqueueUpdate(
          action.messageId,
          presentation("本次请求已取消，原会话绑定保持不变。", {
            title: "已取消",
            kind: "action",
            tone: "neutral",
            status: "请求结束"
          }),
          { idempotencyKey: `${action.actionId}:conflict-cancel` }
        );
        return;
      }
      try {
        const pending = await this.turns.resolveConflict(conflictId, choice);
        this.deliveries.enqueueUpdate(
          action.messageId,
          presentation(
            choice === "wait"
              ? "原始会话目标已冻结，消息已进入等待释放队列。释放 Desktop/VS Code 会话后将按原会话重试。"
              : "已切换到同项目的独立新会话，原始消息将在那里执行。",
            {
              title: choice === "wait" ? "等待原会话释放" : "已选择独立会话",
              kind: "status",
              tone: "info",
              status: choice === "wait" ? "等待交接" : "准备新会话",
              fields: [
                { label: "工作目录", value: claimed.target.cwd },
                {
                  label: "目标",
                  value: choice === "wait"
                    ? claimed.target.sessionId
                    : "同项目新会话（创建后回传 ID）"
                },
                { label: "当前等待", value: `${pending} 条` }
              ],
              actions: [registeredCommandAction("查看队列", "queue", "", "primary")]
            }
          ),
          { idempotencyKey: `${action.actionId}:conflict:${choice}` }
        );
      } catch (error) {
        const detail = errorMessage(error);
        const failedAt = Date.now();
        const current = this.store.getSessionConflict(conflictId);
        let recoverable = false;
        if (
          current &&
          current.expiresAt > failedAt &&
          (current.state === "waiting" || current.state === "branching")
        ) {
          // The decision was claimed, but a transient SQLite/requeue error
          // happened before a retry batch was committed. Re-open the same
          // card instead of permanently losing the user's A/B choice.
          recoverable = this.store.updateSessionConflict(
            conflictId,
            {
              state: "pending",
              choice: null,
              nextAttemptAt: null,
              cardMessageId: action.messageId,
              lastError: `上次选择暂时未处理：${detail}`,
              resolvedAt: null
            },
            failedAt,
            [current.state]
          );
        } else if (current?.state === "pending") {
          recoverable = this.store.updateSessionConflict(
            conflictId,
            {
              cardMessageId: action.messageId,
              lastError: `上次选择暂时未处理：${detail}`
            },
            failedAt,
            ["pending"]
          );
        } else if (current?.state === "retrying") {
          // Another queue worker may have committed the retry while this
          // callback was finishing. Keep that durable work alive.
          this.store.updateSessionConflict(
            conflictId,
            { cardMessageId: action.messageId },
            failedAt,
            ["retrying"]
          );
          recoverable = true;
        }
        if (!recoverable && current &&
          (current.state === "waiting" || current.state === "branching" || current.state === "retrying")) {
          this.store.updateSessionConflict(
            conflictId,
            {
              state: "failed",
              lastError: `处理会话占用选择失败：${detail}`,
              resolvedAt: failedAt,
              nextAttemptAt: null
            },
            failedAt,
            [current.state]
          );
        }
        const latest = this.store.getSessionConflict(conflictId);
        const errorCard = latest?.state === "pending"
          ? presentation(
              `上次选择暂时没有成功：${detail}。请再次选择 A/B，或取消本次请求。`,
              {
                title: "占用选择可重试",
                tone: "warning",
                status: "等待重新选择",
                actions: sessionConflictActions(latest)
              }
            )
          : latest?.state === "retrying"
            ? presentation("选择已接收，队列正在继续处理，请稍候查看结果。", {
                title: "正在继续处理",
                tone: "info",
                status: "处理中",
                actions: [registeredCommandAction("查看队列", "queue", "", "primary")]
              })
            : resultPresentation("无法处理占用选择", detail, false);
        this.deliveries.enqueueUpdate(
          action.messageId,
          errorCard,
          { idempotencyKey: `${action.actionId}:conflict-error` }
        );
      }
      return;
    }
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
