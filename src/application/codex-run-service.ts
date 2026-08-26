import { randomUUID } from "node:crypto";
import type { HubConfig } from "../contracts/config.js";
import type { ExecutionEvent, InboundMessage } from "../contracts/events.js";
import type { ReactionTarget } from "../contracts/jobs.js";
import type { PresentationCard } from "../contracts/presentation.js";
import { ProgressTranscript } from "../domain/progress-transcript.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { WorkspaceResolver } from "../ports/workspace-resolver.js";
import { SessionBusyError } from "../domain/execution-errors.js";
import { registeredCommandAction } from "../domain/command-registry.js";
import type { DeliveryWorker } from "./delivery-worker.js";
import type { LiveCardService } from "./live-card-service.js";
import { durationText, presentation } from "./presentation-factory.js";
import type {
  ReactionProgressService,
  ReactionTracker
} from "./reaction-progress.js";

export interface CodexRunOptions {
  runId?: string;
  reactionTargets?: ReactionTarget[];
}

export interface CodexRunOutcome {
  state: "completed" | "failed" | "cancelled" | "busy";
  terminalDeliveryQueued: boolean;
  error?: string;
}

function progressCard(
  transcript: ProgressTranscript,
  status: string,
  cwd: string,
  completed = false
): PresentationCard {
  return presentation(transcript.markdown(), {
    title: "Codex 执行过程",
    kind: completed ? "status" : "progress",
    tone: "neutral",
    status,
    subtitle: new Date(transcript.startedAt).toLocaleString("zh-CN"),
    fields: [{ label: "工作目录", value: cwd }]
  });
}

export class CodexRunService {
  public constructor(
    private readonly config: HubConfig,
    private readonly agent: CodingAgent,
    private readonly store: StateRepository,
    private readonly reactions: ReactionProgressService,
    private readonly deliveries: DeliveryWorker,
    private readonly workspaces: WorkspaceResolver,
    private readonly logger: Logger,
    private readonly liveCards?: LiveCardService
  ) {}

  public activeCardMessageId(runId: string): string | undefined {
    return this.liveCards?.activeMessageId(runId);
  }

  public async run(
    message: InboundMessage,
    scopeKey: string,
    prompt: string,
    options: CodexRunOptions = {}
  ): Promise<CodexRunOutcome> {
    const runId = options.runId ?? randomUUID();
    const now = Date.now();
    const leaseMs = this.config.runtime.leaseSeconds * 1_000;
    const link = this.store.getConversation(scopeKey);
    const newSessionIntent = this.store.getNewSessionIntent(scopeKey);
    const requestedCwd = link?.cwd ?? newSessionIntent?.cwd ?? this.store.getProject(scopeKey);
    if (!requestedCwd) {
      const detail = "尚未选择项目，消息没有执行。";
      this.deliveries.enqueueReply(
        message.messageId,
        presentation("请先从项目中心选择项目和会话。", {
          title: "需要选择项目",
          tone: "warning",
          status: "未执行"
        }),
        { idempotencyKey: `${message.eventId}:missing-project` }
      );
      return { state: "failed", terminalDeliveryQueued: false, error: detail };
    }
    if (!link && !newSessionIntent) {
      const detail = "已选择项目，但尚未选择继续已有会话还是新建会话。";
      this.deliveries.enqueueReply(
        message.messageId,
        presentation("请选择一个历史会话，或者明确点击“新建会话”。本条消息没有执行。", {
          title: "需要选择会话",
          tone: "warning",
          status: "未执行",
          actions: [
            registeredCommandAction("选择历史会话", "sessions", "", "primary"),
            registeredCommandAction("新建会话", "new")
          ]
        }),
        { idempotencyKey: `${message.eventId}:missing-session-target` }
      );
      return { state: "failed", terminalDeliveryQueued: false, error: detail };
    }
    let cwd: string;
    try {
      cwd = await this.workspaces.resolveProject(requestedCwd);
    } catch (error) {
      const detail = errorMessage(error);
      this.deliveries.enqueueReply(
        message.messageId,
        presentation(detail, {
          title: "工作目录不可用",
          tone: "error",
          status: "无法执行"
        }),
        { idempotencyKey: `${message.eventId}:workspace-error` }
      );
      return { state: "failed", terminalDeliveryQueued: false, error: detail };
    }

    const leaseResource = link?.sessionId
      ? `session:${link.sessionId}`
      : `scope:${scopeKey}`;
    if (!this.store.acquireLease(leaseResource, runId, now, leaseMs)) {
      this.deliveries.enqueueReply(
        message.messageId,
        presentation("当前 Codex 会话已有任务占用，请等待完成后再试。", {
          title: "当前会话正忙",
          tone: "warning",
          status: "任务执行中"
        }),
        { idempotencyKey: `${message.eventId}:busy` }
      );
      return { state: "busy", terminalDeliveryQueued: false };
    }

    this.store.createRun({
      id: runId,
      scopeKey,
      ...(link?.sessionId ? { sessionId: link.sessionId } : {}),
      state: "running",
      startedAt: now
    });
    const heartbeat = setInterval(() => {
      const renewed = this.store.heartbeatLease(
        leaseResource,
        runId,
        Date.now(),
        leaseMs
      );
      if (!renewed) {
        this.logger.error("Codex Session 租约续期失败", { runId, leaseResource });
        this.agent.cancel(scopeKey);
      }
    }, Math.max(10_000, Math.floor(leaseMs / 3)));
    heartbeat.unref();

    const reactionTargets = options.reactionTargets ?? [
      { trackerId: runId, messageId: message.messageId }
    ];
    const progress = reactionTargets.map((target) =>
      this.reactions.track(target.trackerId, target.messageId)
    );
    await Promise.all(progress.map((tracker) => tracker.thinking()));
    let currentSessionId = link?.sessionId;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let streamedText = "";
    const transcript = new ProgressTranscript(now);

    const transition = async (
      action: (tracker: ReactionTracker) => Promise<void>
    ): Promise<void> => {
      await Promise.all(progress.map(action));
    };
    const showLive = async (status: string): Promise<void> => {
      if (!this.liveCards) {
        return;
      }
      const card = progressCard(transcript, status, cwd);
      const existing = this.liveCards.activeMessageId(runId);
      if (existing) {
        await this.liveCards.update(runId, card);
      } else {
        await this.liveCards.ensure(runId, scopeKey, message.messageId, card);
      }
    };
    const onEvent = async (event: ExecutionEvent): Promise<void> => {
      if (event.type === "session") {
        currentSessionId = event.sessionId;
        transcript.record(`已连接 Codex 会话：${event.sessionId}`);
        this.store.bindConversation({
          scopeKey,
          sessionId: event.sessionId,
          cwd,
          updatedAt: Date.now()
        });
        await showLive("会话已连接");
      } else if (event.type === "progress") {
        this.logger.debug("Codex 执行进度", { scopeKey, label: event.label });
        transcript.record(event.label);
        await transition((tracker) => tracker.working());
        await showLive(event.label);
      } else if (event.type === "reasoning") {
        transcript.record(event.label);
        await transition((tracker) => tracker.working());
        await showLive(event.label);
      } else if (event.type === "message-delta") {
        streamedText = event.text;
        transcript.record("正在生成回复");
        transcript.setPreview(streamedText);
        await transition((tracker) => tracker.typing());
        await showLive("正在生成回复");
      } else if (event.type === "message") {
        streamedText = event.text;
        transcript.record("回复生成完成");
        transcript.setPreview(streamedText);
        await transition((tracker) => tracker.typing());
        await showLive("正在完成回复");
      } else if (event.type === "usage") {
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens
        };
      } else if (event.type === "error") {
        this.logger.warn("Codex 返回错误事件", {
          scopeKey,
          error: event.message
        });
      }
    };

    let deliveryQueued = false;
    try {
      await showLive("正在启动 Codex");
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
      const runState = result.cancelled ? "cancelled" : "completed";
      this.store.finishRun(runId, runState, Date.now());
      const finalText = result.finalText || "Codex 已完成，但没有返回文本结果。";
      const finalCard = presentation(finalText, {
        title: result.cancelled ? "Codex 任务已取消" : "Codex 回复",
        kind: "answer",
        tone: result.cancelled ? "neutral" : "success",
        status: result.cancelled ? "已取消" : "已完成",
        subtitle: new Date().toLocaleString("zh-CN"),
        fields: [
          { label: "耗时", value: durationText(result.durationMs) },
          { label: "工作目录", value: cwd },
          {
            label: "Codex 会话",
            value: result.sessionId ?? currentSessionId ?? "尚未创建"
          },
          ...(usage
            ? [
                {
                  label: "Token",
                  value: `${usage.inputTokens} 输入 / ${usage.outputTokens} 输出`
                }
              ]
            : [])
        ]
      });
      const terminalReaction = result.cancelled ? "cancelled" : "success";
      transcript.record(result.cancelled ? "任务已取消" : "任务执行完成");
      transcript.setPreview(streamedText || finalText);
      const frozenCard = progressCard(
        transcript,
        result.cancelled ? "已取消" : "已完成",
        cwd,
        true
      );
      await this.liveCards?.finish(runId, frozenCard, (liveMessageId, card) => {
        this.deliveries.enqueueUpdate(liveMessageId, card, {
          idempotencyKey: `${message.eventId}:codex-process-complete`
        });
      });
      this.deliveries.enqueueReply(message.messageId, finalCard, {
        idempotencyKey: `${message.eventId}:codex-result`,
        terminalReaction,
        reactionTargets
      });
      deliveryQueued = true;
      return {
        state: result.cancelled ? "cancelled" : "completed",
        terminalDeliveryQueued: true
      };
    } catch (error) {
      const detail = errorMessage(error);
      this.store.finishRun(runId, "failed", Date.now(), detail);
      this.logger.error("Codex 任务失败", { runId, scopeKey, error: detail });
      if (error instanceof SessionBusyError) {
        const guidance = error.owner === "hub"
            ? "Hub 内已有任务占用这个会话。请等待当前队列完成后重新执行。"
            : "这个会话已被 Codex Desktop、VS Code 或另一个 Codex CLI 进程持有。请先让本地入口释放该会话，再点击“重新执行”。";
        const busyCard = presentation(guidance, {
          title: "会话正在其他入口使用",
          kind: "answer",
          tone: "warning",
          status: "等待交接",
          fields: [
            { label: "工作目录", value: cwd },
            { label: "会话", value: link?.sessionId ?? currentSessionId ?? "尚未创建" },
            { label: "占用来源", value: error.owner === "hub" ? "Lark Codex Hub" : "Codex 本地入口" }
          ],
          actions: [
            registeredCommandAction("重新执行", "retry", runId, "primary"),
            registeredCommandAction("新建会话", "new"),
            registeredCommandAction("查看状态", "status")
          ]
        });
        try {
          transcript.record("会话正在其他入口使用，等待交接");
          const frozenCard = progressCard(transcript, "等待交接", cwd, true);
          await this.liveCards?.finish(runId, frozenCard, (liveMessageId, card) => {
            this.deliveries.enqueueUpdate(liveMessageId, card, {
              idempotencyKey: `${message.eventId}:codex-process-busy`
            });
          });
          this.deliveries.enqueueReply(message.messageId, busyCard, {
            idempotencyKey: `${message.eventId}:session-busy`,
            terminalReaction: "waiting",
            reactionTargets
          });
          deliveryQueued = true;
        } catch (deliveryError) {
          this.logger.error("会话占用提示无法进入投递队列", {
            runId,
            error: errorMessage(deliveryError)
          });
        }
        return {
          state: "busy",
          terminalDeliveryQueued: deliveryQueued,
          error: `session_busy:${error.owner}:${detail}`
        };
      }
      const errorCard = presentation(`执行失败：${detail}`, {
        title: "Codex 执行失败",
        kind: "answer",
        tone: "error",
        status: "失败",
        fields: [{ label: "工作目录", value: cwd }]
      });
      try {
        transcript.record("任务执行失败");
        const frozenCard = progressCard(transcript, "执行失败", cwd, true);
        await this.liveCards?.finish(runId, frozenCard, (liveMessageId, card) => {
          this.deliveries.enqueueUpdate(liveMessageId, card, {
            idempotencyKey: `${message.eventId}:codex-process-failed`
          });
        });
        this.deliveries.enqueueReply(message.messageId, errorCard, {
          idempotencyKey: `${message.eventId}:codex-error`,
          terminalReaction: "error",
          reactionTargets
        });
        deliveryQueued = true;
      } catch (deliveryError) {
        this.logger.error("Codex 结果无法进入投递队列", {
          runId,
          error: errorMessage(deliveryError)
        });
      }
      return {
        state: "failed",
        terminalDeliveryQueued: deliveryQueued,
        error: detail
      };
    } finally {
      if (!deliveryQueued) {
        await Promise.all(progress.map((tracker) => tracker.abandon()));
      }
      clearInterval(heartbeat);
      this.store.releaseLease(leaseResource, runId);
    }
  }
}
