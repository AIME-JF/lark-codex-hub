import { randomUUID } from "node:crypto";
import type {
  InboundBotMenuAction,
  InboundCardAction,
  InboundMessage
} from "../contracts/events.js";
import type {
  InboundJobPayload,
  InboundJobRecord
} from "../contracts/jobs.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { StateRepository } from "../ports/state-repository.js";

export interface InboundHandlers {
  message(value: InboundMessage): Promise<void>;
  cardAction(value: InboundCardAction): Promise<void>;
  botMenu(value: InboundBotMenuAction): Promise<void>;
}

export class InboundWorker {
  private readonly holder = randomUUID();
  private readonly active = new Map<number, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private stopping = false;

  public constructor(
    private readonly store: StateRepository,
    private readonly handlers: InboundHandlers,
    private readonly leaseMs: number,
    private readonly logger: Logger,
    private readonly concurrency = 4
  ) {}

  public start(): void {
    if (this.timer) {
      return;
    }
    this.stopping = false;
    this.timer = setInterval(() => this.kick(), 250);
    this.timer.unref();
    this.kick();
  }

  public submitMessage(value: InboundMessage): void {
    this.submit(value.eventId, value.messageId, { kind: "message", value });
  }

  public submitCardAction(value: InboundCardAction): void {
    this.submit(value.actionId, value.actionId, { kind: "card_action", value });
  }

  public submitBotMenu(value: InboundBotMenuAction): void {
    this.submit(value.eventId, value.eventId, { kind: "bot_menu", value });
  }

  public async stopAndDrain(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await Promise.all([...this.active.values()]);
  }

  private submit(
    eventId: string,
    messageId: string,
    payload: InboundJobPayload
  ): void {
    const inserted = this.store.enqueueInbound(
      eventId,
      messageId,
      payload,
      Date.now()
    );
    if (!inserted) {
      this.logger.debug("忽略重复飞书事件", { eventId });
      return;
    }
    this.kick();
  }

  private kick(): void {
    if (this.stopping || this.draining) {
      return;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.stopping && this.active.size < this.concurrency) {
        const job = this.store.claimInbound(this.holder, Date.now(), this.leaseMs);
        if (!job) {
          break;
        }
        const running = this.process(job).finally(() => {
          this.active.delete(job.id);
          this.kick();
        });
        this.active.set(job.id, running);
      }
    } finally {
      this.draining = false;
    }
  }

  private async process(job: InboundJobRecord): Promise<void> {
    const heartbeat = setInterval(() => {
      this.store.heartbeatInbound(job.id, this.holder, Date.now(), this.leaseMs);
    }, Math.max(10_000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    try {
      if (job.payload.kind === "message") {
        await this.handlers.message(job.payload.value);
      } else if (job.payload.kind === "card_action") {
        await this.handlers.cardAction(job.payload.value);
      } else {
        await this.handlers.botMenu(job.payload.value);
      }
      this.store.completeInbound(job.id, this.holder, Date.now());
    } catch (error) {
      const detail = errorMessage(error);
      this.store.failInbound(job.id, this.holder, Date.now(), detail);
      this.logger.error("持久化飞书事件处理失败", {
        inboundJobId: job.id,
        eventId: job.eventId,
        error: detail
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
