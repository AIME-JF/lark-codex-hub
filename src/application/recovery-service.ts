import type { PresentationCard } from "../contracts/presentation.js";
import type { Logger } from "../observability/logger.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { DeliveryWorker } from "./delivery-worker.js";
import { presentation } from "./presentation-factory.js";
import type { ReactionProgressService } from "./reaction-progress.js";

function interruptedProcessCard(serialized: string): PresentationCard {
  try {
    const current = JSON.parse(serialized) as PresentationCard;
    if (typeof current.content !== "string") {
      throw new Error("过程卡片缺少内容");
    }
    return presentation(
      `${current.content}\n\n- 服务重启，当前执行已中断`,
      {
        title: "Codex 执行过程",
        kind: "status",
        tone: "neutral",
        status: "已中断",
        ...(current.subtitle ? { subtitle: current.subtitle } : {}),
        ...(current.fields ? { fields: current.fields } : {})
      }
    );
  } catch {
    return presentation("- 服务重启，当前执行已中断", {
      title: "Codex 执行过程",
      kind: "status",
      tone: "neutral",
      status: "已中断"
    });
  }
}

export class RecoveryService {
  public constructor(
    private readonly store: StateRepository,
    private readonly deliveries: DeliveryWorker,
    private readonly reactions: ReactionProgressService,
    private readonly ownerOpenId: string,
    private readonly logger: Logger
  ) {}

  public async recover(): Promise<void> {
    const now = Date.now();
    const inbound = this.store.recoverInbound(now);
    const turns = this.store.recoverTurnJobs(now);
    const runs = this.store.interruptRunningRuns(now);
    const actions = this.store.interruptExecutingActions(now);
    const activeCards = this.store.listActiveLiveCards();
    await this.reactions.recoverStale();

    for (const card of activeCards) {
      this.deliveries.enqueueUpdate(
        card.cardMessageId,
        interruptedProcessCard(card.cardJson),
        { idempotencyKey: `recovery:live-card-process:${card.runId}` }
      );
      this.deliveries.enqueueReply(
        card.sourceMessageId,
        presentation(
          "服务在任务执行期间重新启动。为避免重复修改文件，这次执行已标记为中断；排队中但尚未开始的消息会继续处理。",
          {
            title: "Codex 任务已中断",
            kind: "answer",
            tone: "warning",
            status: "服务已恢复"
          }
        ),
        {
          idempotencyKey: `recovery:live-card-result:${card.runId}`,
          terminalReaction: "cancelled",
          reactionTargets: [
            { trackerId: card.runId, messageId: card.sourceMessageId }
          ]
        }
      );
      this.store.finishLiveCard(card.runId, now);
    }

    const cardRunIds = new Set(activeCards.map((card) => card.runId));
    for (const job of turns) {
      if (cardRunIds.has(job.id)) {
        continue;
      }
      this.deliveries.enqueueReply(
        job.message.messageId,
        presentation(
          "服务在任务执行期间重新启动。这次任务已标记为中断，不会自动重跑；你可以检查项目后继续发送消息。",
          {
            title: "任务已中断",
            kind: "answer",
            tone: "warning",
            status: "需要确认"
          }
        ),
        {
          idempotencyKey: `recovery:turn:${job.id}`,
          terminalReaction: "cancelled",
          reactionTargets: [
            { trackerId: job.id, messageId: job.message.messageId }
          ]
        }
      );
    }

    for (const job of inbound.interruptedMessages) {
      if (job.payload.kind !== "message") {
        continue;
      }
      this.deliveries.enqueueReply(
        job.payload.value.messageId,
        presentation(
          "服务在任务执行期间被关闭。为避免重复修改文件，本次任务不会自动重跑；Codex 会话记录仍会保留，你可以检查项目后继续发送消息。",
          {
            title: "任务已中断",
            kind: "answer",
            tone: "warning",
            status: "需要确认"
          }
        ),
        { idempotencyKey: `recovery:${job.eventId}` }
      );
    }
    if (actions > 0) {
      this.deliveries.enqueueSend(
        { type: "open_id", id: this.ownerOpenId },
        presentation(
          `${actions} 个飞书高风险操作在服务关闭时处于执行中，已标记为中断，不会自动重试。`,
          {
            title: "飞书操作已中断",
            kind: "notification",
            tone: "warning",
            status: "需要检查"
          }
        ),
        { idempotencyKey: `recovery:actions:${now}` }
      );
    }
    if (
      inbound.interruptedMessages.length ||
      inbound.requeued ||
      turns.length ||
      activeCards.length ||
      runs ||
      actions
    ) {
      this.logger.warn("启动恢复已处理遗留状态", {
        interruptedMessages: inbound.interruptedMessages.length,
        requeuedEvents: inbound.requeued,
        interruptedTurns: turns.length,
        recoveredLiveCards: activeCards.length,
        interruptedRuns: runs,
        interruptedActions: actions
      });
    }
  }
}
