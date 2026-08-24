import { randomBytes, randomUUID } from "node:crypto";
import { larkActionSchema, type LarkAction } from "../contracts/actions.js";
import type { InboundMessage } from "../contracts/events.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { ActionBroker } from "../ports/action-broker.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { DeliveryWorker } from "./delivery-worker.js";
import { presentation, resultPresentation } from "./presentation-factory.js";
import type { ReactionProgressService } from "./reaction-progress.js";

export interface ActionApprovalContext {
  operatorOpenId: string;
  chatId: string;
  scopeKey: string;
}

export function parseActionCommand(text: string): LarkAction | undefined {
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
    return larkActionSchema.parse({
      kind: "create_document",
      identity: "user",
      title: (newline >= 0 ? body.slice(0, newline) : body).trim(),
      markdown: newline >= 0 ? body.slice(newline + 1) : ""
    });
  }
  return undefined;
}

export class LarkActionService {
  public constructor(
    private readonly broker: ActionBroker | undefined,
    private readonly store: StateRepository,
    private readonly reactions: ReactionProgressService,
    private readonly deliveries: DeliveryWorker,
    private readonly logger: Logger
  ) {}

  public async execute(
    message: InboundMessage,
    scopeKey: string,
    action: LarkAction
  ): Promise<void> {
    if (!this.broker) {
      this.deliveries.enqueueReply(
        message.messageId,
        presentation("飞书扩展动作当前已禁用。", {
          title: "扩展动作不可用",
          tone: "error",
          status: "已禁用"
        }),
        { idempotencyKey: `${message.eventId}:actions-disabled` }
      );
      return;
    }
    const idempotencyKey = randomUUID();
    const trackerId = `action:${idempotencyKey}`;
    const progress = this.reactions.track(trackerId, message.messageId);
    await progress.thinking();
    let deliveryQueued = false;
    try {
      const result = await this.broker.execute(action, idempotencyKey);
      if (result.status === "confirmation_required" && result.confirmation) {
        const confirmationId = randomBytes(12).toString("hex");
        this.store.savePendingAction(
          {
            id: confirmationId,
            idempotencyKey,
            actionJson: JSON.stringify(action),
            confirmationJson: JSON.stringify(result.confirmation),
            operatorOpenId: message.senderOpenId,
            chatId: message.chatId,
            scopeKey
          },
          Date.now()
        );
        this.deliveries.enqueueReply(
          message.messageId,
          {
            kind: "confirmation",
            title: "需要确认飞书操作",
            content: [
              `**动作**：${result.confirmation.action}`,
              `**风险**：${result.confirmation.risk}`,
              "**参数**",
              `\`\`\`\`json\n${JSON.stringify(result.confirmation.params, null, 2)}\n\`\`\`\``
            ].join("\n\n"),
            tone: "warning",
            status: "等待确认",
            fields: [{ label: "确认编号", value: confirmationId }],
            actions: [
              {
                label: "确认执行",
                style: "primary",
                value: { command: "confirm", id: confirmationId }
              },
              {
                label: "拒绝",
                style: "danger",
                value: { command: "reject", id: confirmationId }
              }
            ],
            summary: `需要确认飞书操作：${result.confirmation.action}`
          },
          {
            idempotencyKey: `${message.eventId}:confirmation`,
            trackerId,
            terminalReaction: "waiting"
          }
        );
        deliveryQueued = true;
        return;
      }
      const success = result.status === "completed";
      this.deliveries.enqueueReply(
        message.messageId,
        resultPresentation(
          success ? "飞书操作完成" : "飞书操作失败",
          result.summary,
          success
        ),
        {
          idempotencyKey: `${message.eventId}:action-result`,
          trackerId,
          terminalReaction: success ? "success" : "error"
        }
      );
      deliveryQueued = true;
    } catch (error) {
      try {
        this.deliveries.enqueueReply(
          message.messageId,
          resultPresentation("飞书操作失败", errorMessage(error), false),
          {
            idempotencyKey: `${message.eventId}:action-error`,
            trackerId,
            terminalReaction: "error"
          }
        );
        deliveryQueued = true;
      } catch (deliveryError) {
        this.logger.error("飞书动作结果无法进入投递队列", {
          error: errorMessage(deliveryError)
        });
      }
    } finally {
      if (!deliveryQueued) {
        await progress.abandon();
      }
    }
  }

  public reject(id: string, context: ActionApprovalContext): boolean {
    return this.store.rejectPendingAction(
      id,
      context.operatorOpenId,
      context.chatId,
      context.scopeKey,
      Date.now()
    );
  }

  public async confirm(
    id: string,
    context: ActionApprovalContext
  ): Promise<{ success: boolean; summary: string }> {
    if (!this.broker) {
      return { success: false, summary: "飞书扩展动作当前已禁用。" };
    }
    const pending = this.store.claimPendingAction(
      id,
      context.operatorOpenId,
      context.chatId,
      context.scopeKey,
      Date.now()
    );
    if (!pending) {
      return { success: false, summary: "没有找到待确认操作，可能已经处理。" };
    }
    try {
      const action = larkActionSchema.parse(JSON.parse(pending.actionJson));
      const result = await this.broker.execute(
        action,
        pending.idempotencyKey,
        true
      );
      const success = result.status === "completed";
      this.store.finishAction(id, success ? "completed" : "failed", Date.now());
      return { success, summary: result.summary };
    } catch (error) {
      this.store.finishAction(id, "failed", Date.now());
      return { success: false, summary: `确认执行失败：${errorMessage(error)}` };
    }
  }
}
