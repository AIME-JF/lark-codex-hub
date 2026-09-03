import { randomUUID } from "node:crypto";
import type { InboundMessage } from "../contracts/events.js";
import type { ReactionTarget, TurnJobRecord } from "../contracts/jobs.js";
import type { TurnTarget } from "../contracts/session-routing.js";
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

function laneForTarget(scopeKey: string, target: TurnTarget): string {
  return target.mode === "session"
    ? `session:${target.sessionId}`
    : `scope:${scopeKey}`;
}

function sameCwd(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function belongsToConflict(
  job: TurnJobRecord,
  conflict: NonNullable<ReturnType<StateRepository["getSessionConflict"]>>
): boolean {
  if (job.target?.conflictId === conflict.id) {
    return true;
  }
  if (job.target?.conflictId) {
    return false;
  }
  if (job.laneKey !== `session:${conflict.target.sessionId}`) {
    return false;
  }
  if (!job.target) {
    // Rows written by versions before target snapshots are still safe to
    // include when they are in the frozen session lane.
    return true;
  }
  return job.target.mode === "session" &&
    job.target.sessionId === conflict.target.sessionId &&
    sameCwd(job.target.cwd, conflict.target.cwd);
}

const OPEN_CONFLICT_STATES = [
  "pending",
  "waiting",
  "branching",
  "retrying"
] as const;

export class TurnQueueService implements TurnControl {
  private readonly holder = randomUUID();
  private readonly activeLanes = new Map<string, ActiveBatch>();
  private readonly activeScopes = new Map<string, ActiveBatch>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly conflictTimers = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | undefined;
  /**
   * Startup recovery must finish before a normal queue drain can claim work.
   * Otherwise a pending message could race the conflict requeue and change
   * the scope/session binding that the recovery logic is meant to preserve.
   */
  private recoveryPromise: Promise<void> | undefined;
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
    const recovery = this.recoverConflicts().catch((error) => {
      this.logger.error("恢复会话占用状态失败", { error: errorMessage(error) });
    });
    this.recoveryPromise = recovery;
    void recovery.then(() => {
      if (this.recoveryPromise !== recovery) {
        return;
      }
      this.recoveryPromise = undefined;
      this.kick();
    });
  }

  public async stopAndDrain(): Promise<void> {
    this.stopClaiming();
    const recovery = this.recoveryPromise;
    if (recovery) {
      await recovery;
    }
    await Promise.all([...this.activeTasks]);
  }

  public stopClaiming(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const timer of this.conflictTimers.values()) {
      clearTimeout(timer);
    }
    this.conflictTimers.clear();
  }

  public async enqueue(
    message: InboundMessage,
    scopeKey: string,
    prompt: string
  ): Promise<number> {
    const active = this.activeScopes.get(scopeKey);
    const openConflict = this.store.getOpenSessionConflict(scopeKey);
    const link = this.store.getConversation(scopeKey);
    const intent = this.store.getNewSessionIntent(scopeKey);
    // Once an external-writer conflict is open, freeze every subsequently
    // received message to that conflict. This closes the race between the
    // controller's UI guard and the queue insert, and lets the A/B decision
    // carry all messages that arrived while the card was waiting.
    const conflictTarget: TurnTarget | undefined = openConflict
      ? (openConflict.state === "branching" || openConflict.state === "retrying") &&
        openConflict.choice === "branch"
        ? { mode: "new", cwd: openConflict.target.cwd, conflictId: openConflict.id }
        : { ...openConflict.target, conflictId: openConflict.id }
      : undefined;
    const target: TurnTarget | undefined = conflictTarget ??
      active?.jobs[0]?.target ??
        (link
          ? { mode: "session", sessionId: link.sessionId, cwd: link.cwd }
          : intent
            ? { mode: "new", cwd: intent.cwd }
            : undefined);
    const laneKey = active?.laneKey ??
      (target ? laneForTarget(scopeKey, target) : `scope:${scopeKey}`);
    const record: TurnJobRecord = {
      id: randomUUID(),
      eventId: message.eventId,
      scopeKey,
      laneKey,
      ...(target ? { target } : {}),
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
    const intent = this.store.getNewSessionIntent(scopeKey);
    const capturedTarget: TurnTarget | undefined = source.target ??
      (link
        ? { mode: "session", sessionId: link.sessionId, cwd: link.cwd }
        : intent
          ? { mode: "new", cwd: intent.cwd }
          : undefined);
    const target = capturedTarget ? this.stripTerminalConflict(capturedTarget) : undefined;
    if (!target) {
      throw new Error("原任务没有可恢复的项目或会话目标，请重新选择项目。 ");
    }
    const eventId = `${source.eventId}:retry:${source.id}`;
    const record: TurnJobRecord = {
      id: randomUUID(),
      eventId,
      scopeKey,
      laneKey: laneForTarget(scopeKey, target),
      message: {
        ...source.message,
        eventId,
        receivedAt: Date.now()
      },
      prompt: source.prompt,
      target,
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

  /**
   * Requeue every job represented by a conflict card using the card's frozen
   * target. This deliberately bypasses the normal "no pending work" guard so
   * an A/B callback cannot be redirected by a newer conversation binding.
   */
  public async resolveConflict(
    conflictId: string,
    choice: "wait" | "branch"
  ): Promise<number> {
    const existingTimer = this.conflictTimers.get(conflictId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.conflictTimers.delete(conflictId);
    }
    const conflict = this.store.getSessionConflict(conflictId);
    if (!conflict) {
      throw new Error("会话占用选择已经失效，请重新发送消息。 ");
    }
    if (conflict.expiresAt <= Date.now()) {
      this.store.updateSessionConflict(
        conflictId,
        { state: "expired", lastError: "会话占用选择已过期。", resolvedAt: Date.now() },
        Date.now(),
        OPEN_CONFLICT_STATES
      );
      throw new Error("会话占用选择已过期，请重新发送消息。 ");
    }
    if (choice === "wait") {
      const delayMs = 5_000;
      const now = Date.now();
      const updated = this.store.updateSessionConflict(
        conflictId,
        {
          state: "waiting",
          attempts: conflict.attempts + 1,
          nextAttemptAt: now + delayMs,
          lastError: null
        },
        now,
        ["waiting"]
      );
      if (!updated) {
        throw new Error("会话占用选择已被其他操作处理，请刷新状态。 ");
      }
      this.scheduleConflictRetry(conflictId, delayMs);
      return this.store.countPendingTurns(conflict.scopeKey);
    }
    return this.requeueConflict(conflict, choice);
  }

  /** Restore conflict work that was claimed just before a process restart. */
  private async recoverConflicts(): Promise<void> {
    const conflicts = this.store.listSessionConflicts([
      "waiting",
      "branching",
      "retrying"
    ]);
    for (const conflict of conflicts) {
      if (this.stopping) {
        return;
      }
      const now = Date.now();
      if (conflict.state !== "retrying" && conflict.expiresAt <= now) {
        this.store.updateSessionConflict(
          conflict.id,
          { state: "expired", lastError: "会话占用等待已过期。", resolvedAt: now },
          now,
          [conflict.state]
        );
        continue;
      }
      if (conflict.state === "waiting") {
        const delay = Math.max(0, (conflict.nextAttemptAt ?? now) - now);
        this.scheduleConflictRetry(conflict.id, delay);
        continue;
      }
      if (conflict.state === "branching") {
        try {
          await this.requeueConflict(conflict, "branch");
        } catch (error) {
          this.logger.warn("恢复会话占用分支失败", {
            conflictId: conflict.id,
            error: errorMessage(error)
          });
          const failedAt = Date.now();
          this.store.updateSessionConflict(
            conflict.id,
            {
              state: "failed",
              lastError: `服务重启时无法恢复独立分支：${errorMessage(error)}`,
              resolvedAt: failedAt,
              nextAttemptAt: null
            },
            failedAt,
            ["branching"]
          );
        }
        continue;
      }
      // A retrying conflict normally has pending/running child jobs and will
      // be picked up by the regular queue. If the child disappeared during a
      // crash, release the scope instead of leaving every future message
      // blocked behind a stale card.
      const childJobs = this.store.listTurnJobsByConflict(
        conflict.scopeKey,
        conflict.id
      );
      if (childJobs.some((job) => job.state === "pending" || job.state === "running")) {
        continue;
      }
      const terminal = childJobs.length > 0 && childJobs.every(
        (job) => job.state === "completed" || job.state === "cancelled"
      );
      this.store.updateSessionConflict(
        conflict.id,
        {
          state: terminal ? "resolved" : "failed",
          lastError: terminal
            ? null
            : "服务重启时发现冲突重试任务已中断，未自动重跑；请使用 /retry 并先检查文件变更。",
          resolvedAt: now,
          nextAttemptAt: null
        },
        now,
        ["retrying"]
      );
    }
  }

  /** Requeue the complete conflict batch with a deterministic attempt key. */
  private async requeueConflict(
    conflict: NonNullable<ReturnType<StateRepository["getSessionConflict"]>>,
    choice: "wait" | "branch"
  ): Promise<number> {
    const target: TurnTarget = choice === "branch"
      ? { mode: "new", cwd: conflict.target.cwd, conflictId: conflict.id }
      : { ...conflict.target, conflictId: conflict.id };
    const expectedState = choice === "branch" ? "branching" : "waiting";
    if (conflict.expiresAt <= Date.now()) {
      const expiredAt = Date.now();
      this.store.updateSessionConflict(
        conflict.id,
        {
          state: "expired",
          lastError: "会话占用选择已过期。",
          resolvedAt: expiredAt,
          nextAttemptAt: null
        },
        expiredAt,
        [expectedState]
      );
      throw new Error("会话占用选择已过期，请重新发送消息。 ");
    }
    const conflictChildren = this.store.listTurnJobsByConflict(
      conflict.scopeKey,
      conflict.id
    );
    const sourceIds = new Set(conflict.jobIds);
    const sourceRecords = conflict.jobIds
      .map((jobId) => this.store.getTurnJob(jobId))
      .filter((job): job is TurnJobRecord => Boolean(job));
    const runningSources = sourceRecords.filter((job) => job.state === "running");
    const sourceJobs = [
      ...sourceRecords,
      ...conflictChildren
    ].filter(
      (job, index, all): job is TurnJobRecord =>
        Boolean(
          job &&
          (job.state === "pending" ||
            job.state === "failed" ||
            job.state === "interrupted") &&
          all.findIndex((candidate) => candidate?.id === job.id) === index
        )
    );
    const pendingJobs = this.store
      .listPendingTurns(conflict.scopeKey, Number.MAX_SAFE_INTEGER)
      .filter((job) => belongsToConflict(job, conflict) && !sourceIds.has(job.id));
    const activeChildren = conflictChildren.some(
      (job) => job.state === "pending" || job.state === "running"
    );
    if (runningSources.length > 0) {
      // The busy card can reach Feishu before TurnQueue has marked its
      // original running job as failed. Keep the claimed choice intact and
      // retry shortly instead of falsely closing the conflict as failed.
      this.scheduleConflictRetry(conflict.id, 250, choice);
      return this.store.countPendingTurns(conflict.scopeKey);
    }
    if (sourceJobs.length === 0 && pendingJobs.length === 0 && !activeChildren) {
      const now = Date.now();
      const terminalChildren = conflictChildren.length > 0 && conflictChildren.every(
        (job) => job.state === "completed" || job.state === "cancelled"
      );
      this.store.updateSessionConflict(
        conflict.id,
        {
          state: terminalChildren ? "resolved" : "failed",
          lastError: terminalChildren ? null : "原始任务已经不存在或已被处理。",
          resolvedAt: now,
          nextAttemptAt: null
        },
        now,
        [expectedState]
      );
      throw new Error(
        terminalChildren
          ? "这批冲突任务已经处理完成，请刷新状态。"
          : "原始任务已经不存在或已被处理。"
      );
    }
    const now = Date.now();
    const attempt = conflict.attempts + 1;
    const childRecords: TurnJobRecord[] = [];
    const sourceIdsToSupersede: string[] = [];

    for (const source of sourceJobs) {
      const eventId = `${source.eventId}:conflict:${conflict.id}:${choice}:${attempt}`;
      const record: TurnJobRecord = {
        id: randomUUID(),
        eventId,
        scopeKey: conflict.scopeKey,
        laneKey: laneForTarget(conflict.scopeKey, target),
        target,
        message: {
          ...source.message,
          eventId,
          receivedAt: now
        },
        prompt: source.prompt,
        state: "pending",
        createdAt: now
      };
      childRecords.push(record);
      sourceIdsToSupersede.push(source.id);
    }

    // Messages received while the card was open are already pending. Keep
    // their event/message identity, but move them to the selected target so
    // they are executed exactly once along with the original request. The
    // repository commits this retargeting together with the conflict CAS and
    // child inserts, so a crash cannot leave a half-transferred batch.
    const commit = this.store.commitSessionConflictRetry(
      conflict.id,
      expectedState,
      target,
      laneForTarget(conflict.scopeKey, target),
      attempt,
      childRecords,
      pendingJobs.map((job) => job.id),
      sourceIdsToSupersede,
      `已由会话占用${choice === "branch" ? "独立分支" : "等待重试"}接管。`,
      now
    );
    if (!commit.updated) {
      throw new Error("会话占用选择已被其他操作处理，请刷新状态。 ");
    }
    if (commit.retargeted !== pendingJobs.length) {
      this.logger.warn("部分冲突等待消息未能重新绑定目标", {
        conflictId: conflict.id,
        expected: pendingJobs.length,
        actual: commit.retargeted
      });
    }

    if (commit.inserted === 0 && commit.retargeted === 0 && !activeChildren) {
      const failedAt = Date.now();
      this.store.updateSessionConflict(
        conflict.id,
        {
          state: "failed",
          lastError: "冲突任务没有成功重新入队。",
          resolvedAt: failedAt,
          nextAttemptAt: null
        },
        failedAt,
        ["retrying"]
      );
      throw new Error("这批任务没有成功重新进入队列，请刷新状态后重试。 ");
    }

    // Persist the retrying state before yielding to the network-backed
    // reaction updates. The queue timer can therefore never claim a child
    // while its parent conflict is still in the branching/waiting state.
    const reactionResults = await Promise.allSettled(
      childRecords.map((record) =>
        this.reactions.track(record.id, record.message.messageId).thinking()
      )
    );
    for (const result of reactionResults) {
      if (result.status === "rejected") {
        this.logger.warn("冲突重试任务的进度表情写入失败", {
          conflictId: conflict.id,
          error: errorMessage(result.reason)
        });
      }
    }
    this.kick();
    return this.store.countPendingTurns(conflict.scopeKey);
  }

  private scheduleConflictRetry(
    conflictId: string,
    delayMs: number,
    choice?: "wait" | "branch"
  ): void {
    const previous = this.conflictTimers.get(conflictId);
    if (previous) {
      clearTimeout(previous);
    }
    const timer = setTimeout(() => {
      this.conflictTimers.delete(conflictId);
      void this.enqueueScheduledConflict(conflictId, choice).catch((error) => {
        this.logger.warn("会话占用等待重试失败", {
          conflictId,
          error: errorMessage(error)
        });
      });
    }, delayMs);
    timer.unref();
    this.conflictTimers.set(conflictId, timer);
  }

  private async enqueueScheduledConflict(
    conflictId: string,
    requestedChoice?: "wait" | "branch"
  ): Promise<void> {
    if (this.stopping) {
      return;
    }
    const conflict = this.store.getSessionConflict(conflictId);
    if (!conflict || (conflict.state !== "waiting" && conflict.state !== "branching")) {
      return;
    }
    const choice = conflict.state === "branching"
      ? "branch"
      : requestedChoice ?? "wait";
    const now = Date.now();
    if (conflict.expiresAt <= now) {
      this.store.updateSessionConflict(
        conflictId,
        { state: "expired", lastError: "会话占用等待已过期。", resolvedAt: now },
        now,
        [conflict.state]
      );
      return;
    }
    try {
      await this.requeueConflict(conflict, choice);
    } catch (error) {
      this.logger.warn("会话占用等待任务无法重新入队", {
        conflictId,
        error: errorMessage(error)
      });
      const current = this.store.getSessionConflict(conflictId);
      if (
        (current?.state === "waiting" || current?.state === "branching") &&
        current.expiresAt > Date.now()
      ) {
        // A transient store/reaction failure must not leave a waiting card
        // stranded forever. Re-attempt with a bounded delay; permanent
        // source-job errors transition the conflict to failed in
        // requeueConflict and therefore are not rescheduled here.
        this.scheduleConflictRetry(conflictId, 5_000, choice);
      }
    }
  }

  public async cancel(scopeKey: string): Promise<TurnCancelResult> {
    const conflict = this.store.getOpenSessionConflict(scopeKey);
    if (conflict) {
      const timer = this.conflictTimers.get(conflict.id);
      if (timer) {
        clearTimeout(timer);
        this.conflictTimers.delete(conflict.id);
      }
      const now = Date.now();
      const updated = this.store.updateSessionConflict(
        conflict.id,
        {
          state: "cancelled",
          choice: "cancel",
          nextAttemptAt: null,
          lastError: "用户取消了会话占用请求。",
          resolvedAt: now
        },
        now,
        OPEN_CONFLICT_STATES
      );
      if (updated) {
        this.store.finishTurnJobs(
          conflict.jobIds,
          "cancelled",
          now,
          "用户取消了会话占用请求。"
        );
        await Promise.all(
          conflict.jobIds
            .map((jobId) => this.store.getTurnJob(jobId))
            .filter((job): job is NonNullable<ReturnType<StateRepository["getTurnJob"]>> => Boolean(job))
            .map((job) =>
              this.reactions.track(job.id, job.message.messageId).finish("cancelled")
            )
        );
      }
    }
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
    if (this.stopping || this.draining || this.recoveryPromise) {
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
        if (this.laneBlockedByConflict(lane.scopeKey, lane.laneKey)) {
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

  /**
   * Keep deferred conflict jobs behind their decision card. Terminal cards
   * are handled explicitly so a stale child can never execute against a
   * newly selected conversation.
   */
  private laneBlockedByConflict(scopeKey: string, laneKey: string): boolean {
    const open = this.store.getOpenSessionConflict(scopeKey);
    if (open && open.state !== "retrying") {
      return true;
    }
    const laneJobs = this.store
      .listPendingTurns(scopeKey, Number.MAX_SAFE_INTEGER)
      .filter((job) => job.laneKey === laneKey);
    if (open?.state === "retrying" && !laneJobs.some(
      (job) => job.target?.conflictId === open.id
    )) {
      // A conflict retry owns the whole conversation scope until its child
      // batch settles. Do not let an unrelated lane overtake it.
      return true;
    }
    const jobs = laneJobs.filter((job) => job.target?.conflictId);
    let blocked = false;
    for (const job of jobs) {
      const conflict = job.target?.conflictId
        ? this.store.getSessionConflict(job.target.conflictId)
        : undefined;
      if (conflict && (conflict.state === "retrying" || conflict.state === "resolved")) {
        continue;
      }
      blocked = true;
      const now = Date.now();
      if (
        conflict &&
        conflict.state !== "retrying" &&
        conflict.expiresAt <= now &&
        OPEN_CONFLICT_STATES.includes(conflict.state as (typeof OPEN_CONFLICT_STATES)[number])
      ) {
        this.store.updateSessionConflict(
          conflict.id,
          {
            state: "expired",
            lastError: "会话占用选择已过期。",
            resolvedAt: now,
            nextAttemptAt: null
          },
          now,
          [conflict.state]
        );
      }
      const terminalState = conflict?.state === "cancelled" || conflict?.state === "expired"
        ? "cancelled"
        : "failed";
      this.store.finishTurnJobs(
        [job.id],
        terminalState,
        now,
        conflict?.state === "cancelled"
          ? "会话占用请求已取消。"
          : "会话占用选择已失效，请重新发送消息。"
      );
      void this.reactions
        .track(job.id, job.message.messageId)
        .finish(terminalState === "cancelled" ? "cancelled" : "error")
        .catch((error) => {
          this.logger.warn("清理失效冲突任务的进度表情失败", {
            jobId: job.id,
            error: errorMessage(error)
          });
        });
    }
    return blocked;
  }

  private async process(active: ActiveBatch): Promise<void> {
    const primary = active.jobs[0]!;
    const target = this.inheritCreatedSession(primary);
    const reactionTargets: ReactionTarget[] = active.jobs.map((job) => ({
      trackerId: job.id,
      messageId: job.message.messageId
    }));
    const outcome = await this.runs.run(
      primary.message,
      primary.scopeKey,
      mergedPrompt(active.jobs),
      {
        runId: primary.id,
        reactionTargets,
        target: target ?? null,
        jobIds: active.jobs.map((job) => job.id)
      }
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

  /**
   * A normal `/new` intent is a placeholder until the first thread is
   * created. Messages queued behind that first turn should continue the
   * created session; an A/B branch is explicitly independent and must never
   * inherit it.
   */
  private inheritCreatedSession(job: TurnJobRecord): TurnTarget | undefined {
    const target = job.target ?? this.legacyTarget(job);
    if (!target) {
      return undefined;
    }
    if (target.mode === "new" && target.conflictId) {
      // Normally B-branch jobs are retargeted as soon as the branch emits its
      // session id. This fallback covers a late event or an older persisted
      // row: once the conflict is resolved, continue the same newly bound
      // session instead of creating another blank session.
      const conflict = this.store.getSessionConflict(target.conflictId);
      const link = this.store.getConversation(job.scopeKey);
      const sameCwd = link && (process.platform === "win32"
        ? link.cwd.toLowerCase() === target.cwd.toLowerCase()
        : link.cwd === target.cwd);
      const linkFresh = conflict?.state === "retrying"
        ? Boolean(link && link.updatedAt >= conflict.updatedAt)
        : Boolean(link && conflict && link.updatedAt >= conflict.createdAt);
      if (
        conflict?.choice === "branch" &&
        (conflict.state === "resolved" || conflict.state === "retrying") &&
        link &&
        linkFresh &&
        sameCwd
      ) {
        return { mode: "session", sessionId: link.sessionId, cwd: link.cwd };
      }
      return target;
    }
    if (target.mode !== "new") {
      return target;
    }
    const link = this.store.getConversation(job.scopeKey);
    if (!link || link.updatedAt < job.createdAt) {
      return target;
    }
    const sameCwd = process.platform === "win32"
      ? link.cwd.toLowerCase() === target.cwd.toLowerCase()
      : link.cwd === target.cwd;
    return sameCwd
      ? { mode: "session", sessionId: link.sessionId, cwd: link.cwd }
      : target;
  }

  /** A manual retry starts a fresh attempt once its conflict is terminal. */
  private stripTerminalConflict(target: TurnTarget): TurnTarget {
    if (!target.conflictId) {
      return target;
    }
    const conflict = this.store.getSessionConflict(target.conflictId);
    if (
      conflict &&
      (conflict.state === "pending" ||
        conflict.state === "waiting" ||
        conflict.state === "branching" ||
        conflict.state === "retrying")
    ) {
      return target;
    }
    if (target.mode === "session") {
      return { mode: "session", sessionId: target.sessionId, cwd: target.cwd };
    }
    return { mode: "new", cwd: target.cwd };
  }

  /** Infer a safe target for rows written before target snapshots existed. */
  private legacyTarget(job: TurnJobRecord): TurnTarget | undefined {
    const link = this.store.getConversation(job.scopeKey);
    const sessionPrefix = "session:";
    if (job.laneKey.startsWith(sessionPrefix)) {
      const sessionId = job.laneKey.slice(sessionPrefix.length);
      if (link?.sessionId === sessionId) {
        return { mode: "session", sessionId, cwd: link.cwd };
      }
      return undefined;
    }
    if (job.laneKey === `scope:${job.scopeKey}`) {
      const intent = this.store.getNewSessionIntent(job.scopeKey);
      if (intent && intent.updatedAt <= job.createdAt) {
        return { mode: "new", cwd: intent.cwd };
      }
      if (link && link.updatedAt >= job.createdAt) {
        return { mode: "session", sessionId: link.sessionId, cwd: link.cwd };
      }
    }
    return undefined;
  }
}
