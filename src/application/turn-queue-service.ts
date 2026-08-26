import { randomUUID } from "node:crypto";
import type { InboundMessage } from "../contracts/events.js";
import type { ReactionTarget, TurnJobRecord } from "../contracts/jobs.js";
import type {
  TurnCancelResult,
  TurnControl,
  TurnQueueSnapshot
} from "../domain/turn-queue.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { CodexRunService } from "./codex-run-service.js";
import type {
  ReactionProgressService,
  ReactionTracker
} from "./reaction-progress.js";

interface ActiveBatch {
  laneKey: string;
  scopeKey: string;
  jobs: TurnJobRecord[];
  steeringReactions: ReactionTracker[];
}

function mergedPrompt(jobs: readonly TurnJobRecord[]): string {
  if (jobs.length === 1) {
    return jobs[0]!.prompt;
  }
  return jobs
    .map((job, index) => `【连续消息 ${index + 1}/${jobs.length}】\n${job.prompt}`)
    .join("\n\n");
}

export class TurnQueueService implements TurnControl {
  private readonly holder = randomUUID();
  private readonly activeLanes = new Map<string, ActiveBatch>();
  private readonly activeScopes = new Map<string, ActiveBatch>();
  private readonly activeTasks = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private stopping = false;

  public constructor(
    private readonly store: StateRepository,
    private readonly runs: CodexRunService,
    private readonly agent: CodingAgent,
    private readonly reactions: ReactionProgressService,
    private readonly coalesceMs: number,
    private readonly maxConcurrentTurns: number,
    private readonly logger: Logger
  ) {}

  public start(): void {
    if (this.timer) {
      return;
    }
    this.stopping = false;
    this.timer = setInterval(() => this.kick(), 200);
    this.timer.unref();
    this.kick();
  }

  public async stopAndDrain(): Promise<void> {
    this.stopClaiming();
    await Promise.all([...this.activeTasks]);
  }

  public stopClaiming(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async enqueue(
    message: InboundMessage,
    scopeKey: string,
    prompt: string
  ): Promise<number> {
    const active = this.activeScopes.get(scopeKey);
    const link = this.store.getConversation(scopeKey);
    const laneKey =
      active?.laneKey ??
      (link?.sessionId ? `session:${link.sessionId}` : `scope:${scopeKey}`);
    const record: TurnJobRecord = {
      id: randomUUID(),
      eventId: message.eventId,
      scopeKey,
      laneKey,
      message,
      prompt,
      state: "pending",
      createdAt: Date.now()
    };
    const inserted = this.store.enqueueTurnJob(record);
    if (!inserted) {
      return this.store.countPendingTurns(scopeKey);
    }
    await this.reactions.track(record.id, message.messageId).thinking();
    this.kick();
    return this.store.countPendingTurns(scopeKey);
  }

  public async retry(scopeKey: string, id?: string): Promise<number> {
    if (this.activeScopes.has(scopeKey) || this.store.countPendingTurns(scopeKey) > 0) {
      throw new Error("当前还有任务正在执行或排队，请等待完成后再重试。");
    }
    const source = this.store.getRetryableTurn(scopeKey, id);
    if (!source) {
      throw new Error("没有找到可重试的会话占用任务，可能已经重试过或任务已失效。");
    }
    const link = this.store.getConversation(scopeKey);
    const eventId = `${source.eventId}:retry:${source.id}`;
    const record: TurnJobRecord = {
      id: randomUUID(),
      eventId,
      scopeKey,
      laneKey: link?.sessionId ? `session:${link.sessionId}` : `scope:${scopeKey}`,
      message: {
        ...source.message,
        eventId,
        receivedAt: Date.now()
      },
      prompt: source.prompt,
      state: "pending",
      createdAt: Date.now()
    };
    if (!this.store.enqueueTurnJob(record)) {
      throw new Error("这条任务已经重新进入过队列，请使用最新的失败卡片继续重试。");
    }
    await this.reactions.track(record.id, record.message.messageId).thinking();
    this.kick();
    return this.store.countPendingTurns(scopeKey);
  }

  public async cancel(scopeKey: string): Promise<TurnCancelResult> {
    const pending = this.store.cancelPendingTurns(scopeKey, Date.now());
    await Promise.all(
      pending.map((job) =>
        this.reactions.track(job.id, job.message.messageId).finish("cancelled")
      )
    );
    return {
      interrupted: this.agent.cancel(scopeKey),
      cancelledPending: pending.length
    };
  }

  public async steer(
    scopeKey: string,
    prompt: string,
    message?: InboundMessage
  ): Promise<boolean> {
    const active = this.activeScopes.get(scopeKey);
    if (!active || !this.agent.steer) {
      return false;
    }
    const steered = await this.agent.steer(scopeKey, prompt);
    if (!steered || !message) {
      return steered;
    }
    const tracker = this.reactions.track(`steer:${message.eventId}`, message.messageId);
    await tracker.working();
    active.steeringReactions.push(tracker);
    return true;
  }

  public shouldSteerReply(message: InboundMessage, scopeKey: string): boolean {
    const active = this.activeScopes.get(scopeKey);
    if (!active) {
      return false;
    }
    const references = new Set(
      [message.parentMessageId, message.rootMessageId].filter(
        (value): value is string => Boolean(value)
      )
    );
    if (references.size === 0) {
      return false;
    }
    if (active.jobs.some((job) => references.has(job.message.messageId))) {
      return true;
    }
    const liveCard = this.runs.activeCardMessageId(active.jobs[0]!.id);
    return Boolean(liveCard && references.has(liveCard));
  }

  public snapshot(scopeKey: string): TurnQueueSnapshot {
    const items = this.store.listPendingTurns(scopeKey, 10);
    return {
      active: this.activeScopes.has(scopeKey),
      pending: this.store.countPendingTurns(scopeKey),
      items
    };
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
      const available = this.maxConcurrentTurns - this.activeTasks.size;
      if (available <= 0) {
        return;
      }
      const lanes = this.store.listReadyTurnLanes(
        Date.now() - this.coalesceMs,
        available
      );
      for (const lane of lanes) {
        if (
          this.stopping ||
          this.activeTasks.size >= this.maxConcurrentTurns ||
          this.activeLanes.has(lane.laneKey) ||
          this.activeScopes.has(lane.scopeKey)
        ) {
          continue;
        }
        const jobs = this.store.claimTurnBatch(
          lane.laneKey,
          lane.scopeKey,
          this.holder,
          Date.now(),
          this.coalesceMs
        );
        if (jobs.length === 0) {
          continue;
        }
        const active: ActiveBatch = {
          laneKey: lane.laneKey,
          scopeKey: lane.scopeKey,
          jobs,
          steeringReactions: []
        };
        this.activeLanes.set(lane.laneKey, active);
        this.activeScopes.set(lane.scopeKey, active);
        const task = this.process(active)
          .catch((error) => {
            this.logger.error("持久化 Codex 队列任务失败", {
              scopeKey: lane.scopeKey,
              error: errorMessage(error)
            });
          })
          .finally(() => {
            this.activeLanes.delete(lane.laneKey);
            this.activeScopes.delete(lane.scopeKey);
            this.activeTasks.delete(task);
            this.kick();
          });
        this.activeTasks.add(task);
      }
    } finally {
      this.draining = false;
    }
  }

  private async process(active: ActiveBatch): Promise<void> {
    const primary = active.jobs[0]!;
    const reactionTargets: ReactionTarget[] = active.jobs.map((job) => ({
      trackerId: job.id,
      messageId: job.message.messageId
    }));
    const outcome = await this.runs.run(
      primary.message,
      primary.scopeKey,
      mergedPrompt(active.jobs),
      { runId: primary.id, reactionTargets }
    );
    const ids = active.jobs.map((job) => job.id);
    const finishedAt = Date.now();
    if (outcome.state === "completed") {
      this.store.finishTurnJobs(ids, "completed", finishedAt);
    } else if (outcome.state === "cancelled") {
      this.store.finishTurnJobs(ids, "cancelled", finishedAt);
    } else {
      this.store.finishTurnJobs(
        ids,
        "failed",
        finishedAt,
        outcome.error ?? (outcome.state === "busy" ? "会话正忙" : undefined)
      );
    }
    const terminal =
      outcome.state === "completed"
        ? "success"
        : outcome.state === "cancelled"
          ? "cancelled"
          : "error";
    if (!outcome.terminalDeliveryQueued) {
      await Promise.all(
        reactionTargets.map((target) =>
          this.reactions
            .track(target.trackerId, target.messageId)
            .finish(terminal)
        )
      );
    }
    await Promise.all(
      active.steeringReactions.map((tracker) => tracker.finish(terminal))
    );
  }
}
