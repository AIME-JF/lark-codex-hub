import type { Messenger } from "../ports/messenger.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";

export class OutboxWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(
    private readonly store: StateRepository,
    private readonly messenger: Messenger,
    private readonly maxAttempts: number,
    private readonly logger: Logger
  ) {}

  public start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.flush(), 2_000);
    this.timer.unref();
    void this.flush();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async flush(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (const item of this.store.nextOutbox(Date.now(), 10)) {
        try {
          await this.messenger.sendText(
            { type: item.targetType, id: item.targetId },
            item.text
          );
          this.store.completeOutbox(item.id);
        } catch (error) {
          const attempts = item.attempts + 1;
          const detail = errorMessage(error);
          if (attempts >= this.maxAttempts) {
            this.store.failOutbox(item.id, attempts, detail);
            this.logger.error("主动通知已达到最大重试次数", {
              outboxId: item.id,
              error: detail
            });
          } else {
            const delay = Math.min(300_000, 2_000 * 2 ** (attempts - 1));
            this.store.retryOutbox(item.id, attempts, Date.now() + delay, detail);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
