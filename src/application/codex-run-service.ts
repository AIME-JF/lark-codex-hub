import { randomUUID } from "node:crypto";
import type { HubConfig } from "../contracts/config.js";
import type { ExecutionEvent, InboundMessage } from "../contracts/events.js";
import type { ReactionTarget } from "../contracts/jobs.js";
import type { PresentationCard } from "../contracts/presentation.js";
import type {
  SessionConflictRecord,
  SessionConflictState,
  TurnTarget
} from "../contracts/session-routing.js";
import { ProgressTranscript } from "../domain/progress-transcript.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { WorkspaceResolver } from "../ports/workspace-resolver.js";
import { SessionBusyError } from "../domain/execution-errors.js";
import {
  registeredCommandAction,
  sessionConflictActions
} from "../domain/command-registry.js";
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
  /** Target captured by the durable queue; never re-read after enqueue. */
  target?: TurnTarget | null;
  /** All coalesced jobs represented by this run. */
  jobIds?: string[];
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

const OPEN_CONFLICT_STATES: readonly SessionConflictState[] = [
  "pending",
  "waiting",
  "branching",
  "retrying"
];

function isOpenConflictState(state: SessionConflictState): boolean {
  return OPEN_CONFLICT_STATES.includes(state);
}

function sameCwd(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
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
    private readonly liveCards?: LiveCardService,
    private readonly invalidateCatalog?: () => void
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
    const target: TurnTarget | undefined = options.target === null
      ? undefined
      : options.target ??
        (link
          ? { mode: "session", sessionId: link.sessionId, cwd: link.cwd }
          : newSessionIntent
            ? { mode: "new", cwd: newSessionIntent.cwd }
            : undefined);
    const requestedCwd = target?.cwd ?? this.store.getProject(scopeKey);
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
    if (!target) {
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
      this.failConflict(target, detail);
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

    const leaseResource = target.mode === "session"
      ? `session:${target.sessionId}`
      : `scope:${scopeKey}`;
    if (!this.store.acquireLease(leaseResource, runId, now, leaseMs)) {
      this.failConflict(target, "当前 Codex 会话已有任务占用，请等待完成后再试。");
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
      ...(target.mode === "session" ? { sessionId: target.sessionId } : {}),
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
    let currentSessionId = target.mode === "session" ? target.sessionId : undefined;
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
        this.bindSessionIfOwned(scopeKey, target, event.sessionId, cwd, now);
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
          ...(target.mode === "session" ? { sessionId: target.sessionId } : {}),
          ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
          sandbox: this.config.codex.sandbox,
          timeoutMs: this.config.codex.timeoutMinutes * 60_000
        },
        onEvent
      );
      if (result.sessionId) {
        this.bindSessionIfOwned(scopeKey, target, result.sessionId, cwd, now);
      }
      const completedSessionId = result.sessionId ?? currentSessionId;
      if (target.mode === "new" && target.conflictId && completedSessionId) {
        // A branch creates a new session. Messages that arrived while that
        // branch was running must follow the newly created session instead of
        // starting one fresh session per message after the conflict resolves.
        this.retargetConflictPendingJobs(
          scopeKey,
          target.conflictId,
          completedSessionId,
          cwd
        );
      }
      if (target.conflictId) {
        const conflictFinishedAt = Date.now();
        this.store.updateSessionConflict(
          target.conflictId,
          {
            state: result.cancelled ? "cancelled" : "resolved",
            nextAttemptAt: null,
            lastError: null,
            resolvedAt: conflictFinishedAt
          },
          conflictFinishedAt,
          OPEN_CONFLICT_STATES
        );
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
        const externalOwner = error.owner !== "hub";
        let conflict: SessionConflictRecord | undefined;
        const conflictNow = Date.now();
        const targetConflict = target.conflictId
          ? this.store.getSessionConflict(target.conflictId)
          : undefined;
        const existing = targetConflict ?? this.store.getOpenSessionConflict(scopeKey);
        let reusable = target.mode === "session" && existing &&
          isOpenConflictState(existing.state) &&
          (existing.state === "retrying" || existing.expiresAt > conflictNow) &&
          existing.target.sessionId === target.sessionId &&
          sameCwd(existing.target.cwd, target.cwd)
          ? existing
          : undefined;
        if (reusable && !reusable.cardMessageId) {
          // If the original card was never clicked there is no message id we
          // can update in place. Rotate the token before sending a replacement
          // so an older, orphaned card cannot authorize this new attempt.
          const nextToken = randomUUID();
          if (this.store.rotateSessionConflictToken(
            reusable.id,
            reusable.token,
            nextToken,
            conflictNow
          )) {
            reusable = { ...reusable, token: nextToken };
          } else {
            const current = this.store.getSessionConflict(reusable.id);
            reusable = current && isOpenConflictState(current.state)
              ? current
              : undefined;
          }
        }
        const canCreateConflict = externalOwner && target.mode === "session";
        if (canCreateConflict) {
          let nextConflict = reusable ?? {
            id: randomUUID(),
            token: randomUUID(),
            scopeKey,
            chatId: message.chatId,
            operatorOpenId: message.senderOpenId,
            runId,
            jobIds: options.jobIds?.length ? options.jobIds : [runId],
            target: {
              mode: "session",
              sessionId: target.sessionId,
              cwd: target.cwd
            },
            state: "pending",
            attempts: 0,
            expiresAt: conflictNow + this.config.projects.pendingPromptMinutes * 60_000,
            createdAt: conflictNow,
            updatedAt: conflictNow
          };
          if (reusable) {
            const { choice: _previousChoice, ...withoutChoice } = reusable;
            nextConflict = {
              ...withoutChoice,
              state: "pending",
              jobIds: [
                ...new Set([
                  ...reusable.jobIds,
                  ...(options.jobIds ?? [])
                ])
              ],
              // A fresh busy observation gets a fresh decision window. The
              // previous card may already be close to (or past) its expiry,
              // especially after a wait/retry cycle.
              expiresAt: conflictNow + this.config.projects.pendingPromptMinutes * 60_000,
              lastError: detail,
              updatedAt: conflictNow
            };
          }
          conflict = nextConflict;
          this.store.saveSessionConflict(nextConflict);
          this.store.updateSessionConflict(
            nextConflict.id,
            {
              state: "pending",
              attempts: nextConflict.attempts + 1,
              nextAttemptAt: conflictNow,
              lastError: detail
            },
            conflictNow
          );
        } else if (target.conflictId) {
          this.failConflict(target, detail);
        }
        const guidance = externalOwner
          ? "这个会话正在被 Codex Desktop、VS Code 或其他 Codex 入口使用。请选择等待原会话释放，或立即切换到同项目的新会话。"
          : "Hub 内已有任务占用这个会话。请等待当前队列完成后重新执行。";
        const busyCard = presentation(guidance, {
          title: externalOwner ? "会话正在其他入口使用" : "当前会话正忙",
          kind: "answer",
          tone: "warning",
          status: "等待交接",
          fields: [
            { label: "工作目录", value: cwd },
            {
              label: "会话",
              value: target.mode === "session"
                ? target.sessionId
                : currentSessionId ?? "尚未创建"
            },
            { label: "占用来源", value: externalOwner ? "Codex 本地入口" : "Lark Codex Hub" },
            ...(conflict
              ? [{ label: "选择有效期", value: `${Math.max(1, Math.ceil((conflict.expiresAt - conflictNow) / 60_000))} 分钟` }]
              : [])
          ],
           actions: conflict
             ? [
                 ...sessionConflictActions(conflict),
                 registeredCommandAction("查看状态", "status")
               ]
            : [
                registeredCommandAction("重新执行", "retry", runId, "primary"),
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
          if (conflict?.cardMessageId && this.config.presentation.cardsEnabled) {
            // A wait/branch retry can observe the same external lock several
            // times. Update the card that the user already acted on instead
            // of creating a new reply on every 5-second retry. Its token is
            // intentionally preserved while the same conflict remains open.
            this.deliveries.enqueueUpdate(conflict.cardMessageId, busyCard, {
              idempotencyKey: `${message.eventId}:session-busy-update:${conflict.id}:${conflict.attempts}`,
              terminalReaction: "waiting",
              reactionTargets
            });
          } else {
            this.deliveries.enqueueReply(message.messageId, busyCard, {
              idempotencyKey: `${message.eventId}:session-busy`,
              terminalReaction: "waiting",
              reactionTargets
            });
          }
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
      this.failConflict(target, detail);
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

  private failConflict(target: TurnTarget | undefined, detail: string): void {
    if (!target?.conflictId) {
      return;
    }
    const now = Date.now();
    this.store.updateSessionConflict(
      target.conflictId,
      {
        state: "failed",
        nextAttemptAt: null,
        lastError: detail,
        resolvedAt: now
      },
      now,
      OPEN_CONFLICT_STATES
    );
  }

  /**
   * Transfer messages deferred behind a B-branch to the session that the
   * branch actually created. The conflict id is intentionally retained as an
   * audit marker; the queue releases it when the conflict reaches resolved.
   */
  private retargetConflictPendingJobs(
    scopeKey: string,
    conflictId: string,
    sessionId: string,
    cwd: string
  ): void {
    const pending = this.store
      .listTurnJobsByConflict(scopeKey, conflictId)
      .filter((job) => job.state === "pending");
    if (pending.length === 0) {
      return;
    }
    const target: TurnTarget = {
      mode: "session",
      sessionId,
      cwd,
      conflictId
    };
    const retargeted = this.store.retargetPendingTurnJobs(
      pending.map((job) => job.id),
      target,
      `session:${sessionId}`,
      Date.now()
    );
    if (retargeted !== pending.length) {
      this.logger.warn("独立分支完成后部分延迟消息未能继承新会话", {
        scopeKey,
        conflictId,
        expected: pending.length,
        actual: retargeted
      });
    }
  }

  /**
   * Bind a session only while this run still owns the conversation target.
   * A late event from an interrupted/branched run must never overwrite a
   * newer Desktop, VS Code, or Feishu selection.
   */
  private bindSessionIfOwned(
    scopeKey: string,
    target: TurnTarget,
    sessionId: string,
    cwd: string,
    runStartedAt: number
  ): boolean {
    const current = this.store.getConversation(scopeKey);
    const sameCurrent = Boolean(
      current &&
      current.sessionId === sessionId &&
      sameCwd(current.cwd, cwd)
    );
    if (current && current.updatedAt > runStartedAt && !sameCurrent) {
      this.logger.warn("忽略晚到的 Codex 会话绑定事件", {
        scopeKey,
        sessionId,
        currentSessionId: current.sessionId,
        runStartedAt,
        currentUpdatedAt: current.updatedAt
      });
      return false;
    }
    if (target.conflictId) {
      const conflict = this.store.getSessionConflict(target.conflictId);
      const open = Boolean(
        conflict &&
        isOpenConflictState(conflict.state) &&
        (conflict.state === "retrying" || conflict.expiresAt > Date.now())
      );
      if (!open) {
        if (sameCurrent) {
          return true;
        }
        this.logger.warn("忽略已结束会话占用任务的绑定事件", {
          scopeKey,
          sessionId,
          conflictId: target.conflictId,
          conflictState: conflict?.state ?? "missing"
        });
        return false;
      }
    }
    if (sameCurrent) {
      return true;
    }
    this.store.bindConversation({
      scopeKey,
      sessionId,
      cwd,
      updatedAt: Date.now()
    });
    if (target.mode === "new") {
      this.store.clearNewSessionIntent(scopeKey);
    }
    this.invalidateCatalog?.();
    return true;
  }
}
