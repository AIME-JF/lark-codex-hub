import type { PresentationCard } from "../contracts/presentation.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { Messenger } from "../ports/messenger.js";
import type {
  LiveCardRecord,
  StateRepository
} from "../ports/state-repository.js";

interface LiveState {
  record: LiveCardRecord;
  lastUpdateAt: number;
  pending: PresentationCard | undefined;
  timer: NodeJS.Timeout | undefined;
  updating: Promise<void> | undefined;
}

const updateIntervalMs = 1_000;

export class LiveCardService {
  private readonly states = new Map<string, LiveState>();

  public constructor(
    private readonly messenger: Messenger,
    private readonly store: StateRepository,
    private readonly enabled: boolean,
    private readonly logger: Logger
  ) {}

  public async ensure(
    runId: string,
    scopeKey: string,
    sourceMessageId: string,
    card: PresentationCard
  ): Promise<string | undefined> {
    const existing = this.state(runId);
    if (existing) {
      await this.update(runId, card);
      return existing.record.cardMessageId;
    }
    if (!this.enabled || !this.messenger.replyLiveCard) {
      return undefined;
    }
    try {
      const cardMessageId = await this.messenger.replyLiveCard(
        sourceMessageId,
        card,
        `${runId}:live`
      );
      if (!cardMessageId) {
        return undefined;
      }
      const record: LiveCardRecord = {
        runId,
        scopeKey,
        sourceMessageId,
        cardMessageId,
        cardJson: JSON.stringify(card),
        state: "active",
        updatedAt: Date.now()
      };
      this.store.saveLiveCard(record);
      this.states.set(runId, {
        record,
        lastUpdateAt: record.updatedAt,
        pending: undefined,
        timer: undefined,
        updating: undefined
      });
      return cardMessageId;
    } catch (error) {
      this.logger.warn("创建飞书实时进度卡片失败，将使用最终可靠回复", {
        runId,
        error: errorMessage(error)
      });
      return undefined;
    }
  }

  public async update(
    runId: string,
    card: PresentationCard,
    immediate = false
  ): Promise<void> {
    const state = this.state(runId);
    if (!state || state.record.state !== "active") {
      return;
    }
    state.pending = card;
    const elapsed = Date.now() - state.lastUpdateAt;
    if (immediate || elapsed >= updateIntervalMs) {
      await this.flush(state);
      return;
    }
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void this.flush(state);
      }, updateIntervalMs - elapsed);
      state.timer.unref();
    }
  }

  public async finish(
    runId: string,
    finalCard: PresentationCard,
    beforeComplete?: (
      messageId: string,
      card: PresentationCard
    ) => void | Promise<void>
  ): Promise<string | undefined> {
    const state = this.state(runId);
    if (!state) {
      return undefined;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    state.pending = undefined;
    await state.updating;
    await beforeComplete?.(state.record.cardMessageId, finalCard);
    state.record = {
      ...state.record,
      cardJson: JSON.stringify(finalCard),
      state: "completed",
      updatedAt: Date.now()
    };
    this.store.saveLiveCard(state.record);
    const cardMessageId = state.record.cardMessageId;
    this.states.delete(runId);
    return cardMessageId;
  }

  public activeMessageId(runId: string): string | undefined {
    const state = this.state(runId);
    return state?.record.state === "active"
      ? state.record.cardMessageId
      : undefined;
  }

  public close(): void {
    for (const state of this.states.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.states.clear();
  }

  private state(runId: string): LiveState | undefined {
    const cached = this.states.get(runId);
    if (cached) {
      return cached;
    }
    const record = this.store.getLiveCard(runId);
    if (!record) {
      return undefined;
    }
    const state: LiveState = {
      record,
      lastUpdateAt: record.updatedAt,
      pending: undefined,
      timer: undefined,
      updating: undefined
    };
    this.states.set(runId, state);
    return state;
  }

  private async flush(state: LiveState): Promise<void> {
    if (state.updating) {
      await state.updating;
    }
    const card = state.pending;
    if (!card || state.record.state !== "active") {
      return;
    }
    state.pending = undefined;
    state.updating = this.messenger
      .updateCard(state.record.cardMessageId, card)
      .then(() => {
        state.lastUpdateAt = Date.now();
        state.record = {
          ...state.record,
          cardJson: JSON.stringify(card),
          updatedAt: state.lastUpdateAt
        };
        this.store.saveLiveCard(state.record);
      })
      .catch((error) => {
        this.logger.warn("更新飞书实时进度卡片失败", {
          runId: state.record.runId,
          error: errorMessage(error)
        });
      })
      .finally(() => {
        state.updating = undefined;
      });
    await state.updating;
    if (state.pending && Date.now() - state.lastUpdateAt >= updateIntervalMs) {
      await this.flush(state);
    }
  }
}
