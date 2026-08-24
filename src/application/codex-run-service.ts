import { randomUUID } from "node:crypto";
import type { HubConfig } from "../contracts/config.js";
import type { ExecutionEvent, InboundMessage } from "../contracts/events.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { CodingAgent } from "../ports/coding-agent.js";
import type { StateRepository } from "../ports/state-repository.js";
import type { WorkspaceResolver } from "../ports/workspace-resolver.js";
import type { DeliveryWorker } from "./delivery-worker.js";
import { durationText, presentation } from "./presentation-factory.js";
import type { ReactionProgressService } from "./reaction-progress.js";

export class CodexRunService {
  public constructor(
    private readonly config: HubConfig,
    private readonly agent: CodingAgent,
    private readonly store: StateRepository,
    private readonly reactions: ReactionProgressService,
    private readonly deliveries: DeliveryWorker,
    private readonly workspaces: WorkspaceResolver,
    private readonly logger: Logger
  ) {}

  public async run(
    message: InboundMessage,
    scopeKey: string,
    prompt: string
  ): Promise<void> {
    const runId = randomUUID();
    const now = Date.now();
    const leaseMs = this.config.runtime.leaseSeconds * 1_000;
    const link = this.store.getConversation(scopeKey);
    const requestedCwd =
      this.store.getWorkspace(scopeKey) ??
      link?.cwd ??
      this.config.workspace.defaultRoot;
    let cwd: string;
    try {
      cwd = await this.workspaces.resolveAllowed(
        requestedCwd,
        requestedCwd,
        this.config.workspace.allowedRoots
      );
    } catch (error) {
      this.deliveries.enqueueReply(
        message.messageId,
        presentation(errorMessage(error), {
          title: "工作目录不可用",
          tone: "error",
          status: "无法执行"
        }),
        { idempotencyKey: `${message.eventId}:workspace-error` }
      );
      return;
    }

    const leaseResource = link?.sessionId
      ? `session:${link.sessionId}`
      : `scope:${scopeKey}`;
    if (!this.store.acquireLease(leaseResource, runId, now, leaseMs)) {
      this.deliveries.enqueueReply(
        message.messageId,
        presentation("当前 Codex 会话已有任务占用，请等待完成后再试。", {
          title: "当前会话正忙",
          tone: "warning",
          status: "任务执行中"
        }),
        { idempotencyKey: `${message.eventId}:busy` }
      );
      return;
    }

    this.store.createRun({
      id: runId,
      scopeKey,
      ...(link?.sessionId ? { sessionId: link.sessionId } : {}),
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

    const progress = this.reactions.track(runId, message.messageId);
    await progress.thinking();
    let currentSessionId = link?.sessionId;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    const onEvent = async (event: ExecutionEvent): Promise<void> => {
      if (event.type === "session") {
        currentSessionId = event.sessionId;
        this.store.bindConversation({
          scopeKey,
          sessionId: event.sessionId,
          cwd,
          updatedAt: Date.now()
        });
      } else if (event.type === "progress") {
        this.logger.debug("Codex 执行进度", { scopeKey, label: event.label });
        await progress.working();
      } else if (event.type === "message") {
        await progress.typing();
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
      const result = await this.agent.run(
        {
          scopeKey,
          prompt,
          cwd,
          ...(link?.sessionId ? { sessionId: link.sessionId } : {}),
          ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
          sandbox: this.config.codex.sandbox,
          timeoutMs: this.config.codex.timeoutMinutes * 60_000
        },
        onEvent
      );
      if (result.sessionId && result.sessionId !== currentSessionId) {
        this.store.bindConversation({
          scopeKey,
          sessionId: result.sessionId,
          cwd,
          updatedAt: Date.now()
        });
      }
      this.store.finishRun(
        runId,
        result.cancelled ? "cancelled" : "completed",
        Date.now()
      );
      this.deliveries.enqueueReply(
        message.messageId,
        presentation(result.finalText || "Codex 已完成，但没有返回文本结果。", {
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
        }),
        {
          idempotencyKey: `${message.eventId}:codex-result`,
          trackerId: runId,
          terminalReaction: result.cancelled ? "cancelled" : "success"
        }
      );
      deliveryQueued = true;
    } catch (error) {
      const detail = errorMessage(error);
      this.store.finishRun(runId, "failed", Date.now(), detail);
      this.logger.error("Codex 任务失败", { runId, scopeKey, error: detail });
      try {
        this.deliveries.enqueueReply(
          message.messageId,
          presentation(`执行失败：${detail}`, {
            title: "Codex 执行失败",
            kind: "answer",
            tone: "error",
            status: "失败",
            fields: [{ label: "工作目录", value: cwd }]
          }),
          {
            idempotencyKey: `${message.eventId}:codex-error`,
            trackerId: runId,
            terminalReaction: "error"
          }
        );
        deliveryQueued = true;
      } catch (deliveryError) {
        this.logger.error("Codex 结果无法进入投递队列", {
          runId,
          error: errorMessage(deliveryError)
        });
      }
    } finally {
      if (!deliveryQueued) {
        await progress.abandon();
      }
      clearInterval(heartbeat);
      this.store.releaseLease(leaseResource, runId);
    }
  }
}
