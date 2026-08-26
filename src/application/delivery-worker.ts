import { randomUUID } from "node:crypto";
import type {
  DeliveryRequest,
  DeliveryTarget,
  ReactionTarget
} from "../contracts/jobs.js";
import type {
  PresentationCard,
  TerminalReaction
} from "../contracts/presentation.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { Messenger } from "../ports/messenger.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { ReactionProgressService } from "./reaction-progress.js";

interface DeliveryOptions {
  idempotencyKey?: string;
  trackerId?: string;
  terminalReaction?: TerminalReaction;
  reactionTargets?: ReactionTarget[];
}

export class DeliveryWorker {
  private readonly holder = randomUUID();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;

  public constructor(
    private readonly store: StateRepository,
    private readonly messenger: Messenger,
    private readonly reactions: ReactionProgressService,
    private readonly maxAttempts: number,
    private readonly logger: Logger
  ) {}

  public start(): void {
    if (this.timer) {
      return;
    }
    this.stopping = false;
    this.timer = setInterval(() => void this.flush(), 1_000);
    this.timer.unref();
    void this.flush();
  }

  public async stopAndDrain(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  public enqueueReply(
    messageId: string,
    card: PresentationCard,
    options: DeliveryOptions = {}
  ): string {
    return this.enqueue(
      { kind: "reply", messageId },
      card,
      options
    );
  }

  public enqueueSend(
    target: { type: "open_id" | "chat_id"; id: string },
    card: PresentationCard,
    options: DeliveryOptions = {}
  ): string {
    return this.enqueue(
      { kind: "send", type: target.type, id: target.id },
      card,
      options
    );
  }

  public enqueueUpdate(
    messageId: string,
    card: PresentationCard,
    options: DeliveryOptions = {}
  ): string {
    return this.enqueue(
      { kind: "update", messageId },
      card,
      options
    );
  }

  private enqueue(
    target: DeliveryTarget,
    card: PresentationCard,
    options: DeliveryOptions
  ): string {
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    const request: DeliveryRequest = {
      idempotencyKey,
      target,
      card,
      ...(options.trackerId ? { trackerId: options.trackerId } : {}),
      ...(options.terminalReaction
        ? { terminalReaction: options.terminalReaction }
        : {}),
      ...(options.reactionTargets
        ? { reactionTargets: options.reactionTargets }
        : {})
    };
    this.store.enqueueDelivery(request, Date.now());
    if (!this.stopping) {
      void this.flush();
    }
    return idempotencyKey;
  }

  public flush(): Promise<void> {
    if (this.running) {
      return this.running;
    }
    this.running = this.doFlush().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async doFlush(): Promise<void> {
    for (;;) {
      const item = this.store.claimDelivery(this.holder, Date.now(), 60_000);
      if (!item) {
        return;
      }
      try {
        if (item.target.kind === "reply") {
          await this.messenger.replyCard(
            item.target.messageId,
            item.card,
            item.idempotencyKey
          );
        } else if (item.target.kind === "send") {
          await this.messenger.sendCard(
            { type: item.target.type, id: item.target.id },
            item.card,
            item.idempotencyKey
          );
        } else {
          await this.messenger.updateCard(item.target.messageId, item.card);
        }
        this.store.completeDelivery(item.id, this.holder, Date.now());
        await this.finishReaction(
          item.target,
          item.trackerId,
          item.terminalReaction,
          item.reactionTargets
        );
      } catch (error) {
        const detail = errorMessage(error);
        if (item.attempts >= this.maxAttempts) {
          this.store.failDelivery(
            item.id,
            this.holder,
            item.attempts,
            Date.now(),
            detail
          );
          this.logger.error("飞书投递达到最大重试次数", {
            deliveryId: item.id,
            error: detail
          });
          await this.finishReaction(
            item.target,
            item.trackerId,
            "error",
            item.reactionTargets
          );
        } else {
          const delay = Math.min(300_000, 2_000 * 2 ** (item.attempts - 1));
          this.store.retryDelivery(
            item.id,
            this.holder,
            item.attempts,
            Date.now() + delay,
            detail
          );
        }
      }
    }
  }

  private async finishReaction(
    target: DeliveryTarget,
    trackerId: string | undefined,
    result: TerminalReaction | undefined,
    reactionTargets: ReactionTarget[] | undefined
  ): Promise<void> {
    if (!result) {
      return;
    }
    const targets = reactionTargets ?? (
      trackerId && target.kind === "reply"
        ? [{ trackerId, messageId: target.messageId }]
        : []
    );
    await Promise.all(
      targets.map((item) =>
        this.reactions.track(item.trackerId, item.messageId).finish(result)
      )
    );
  }
}
