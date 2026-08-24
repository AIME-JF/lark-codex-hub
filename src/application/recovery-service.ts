import type { Logger } from "../observability/logger.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { DeliveryWorker } from "./delivery-worker.js";
import { presentation } from "./presentation-factory.js";
import type { ReactionProgressService } from "./reaction-progress.js";

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
    const runs = this.store.interruptRunningRuns(now);
    const actions = this.store.interruptExecutingActions(now);
    await this.reactions.recoverStale();

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
    if (inbound.interruptedMessages.length || inbound.requeued || runs || actions) {
      this.logger.warn("启动恢复已处理遗留状态", {
        interruptedMessages: inbound.interruptedMessages.length,
        requeuedEvents: inbound.requeued,
        interruptedRuns: runs,
        interruptedActions: actions
      });
    }
  }
}
