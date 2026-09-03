import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type {
  LifecycleEventRecord,
  LifecycleNotificationMode,
  LifecycleStopReason,
  WindowsPowerEvent
} from "../contracts/lifecycle.js";
import type { PresentationCard } from "../contracts/presentation.js";
import type { Logger } from "../observability/logger.js";
import type { StateRepository } from "../ports/state-repository.js";
import { durationText, presentation } from "./presentation-factory.js";
import type { DeliveryWorker } from "./delivery-worker.js";

type LifecycleNotificationKind =
  | "startup"
  | "stopping"
  | "abnormal"
  | "connection"
  | "windows_power";

function localTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function reasonText(reason: LifecycleStopReason): string {
  if (reason === "service_stop") {
    return "用户请求停止后台服务";
  }
  if (reason === "sigint") {
    return "收到终端中断信号（SIGINT）";
  }
  if (reason === "sigterm") {
    return "收到系统终止信号（SIGTERM）";
  }
  return "运行时正在正常关闭";
}

function parseWindowsPowerEvent(detailsJson: string): WindowsPowerEvent | undefined {
  try {
    const value: unknown = JSON.parse(detailsJson);
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.key !== "string" ||
      (record.kind !== "system_shutdown" && record.kind !== "system_restart") ||
      typeof record.occurredAt !== "number" ||
      !Number.isFinite(record.occurredAt) ||
      typeof record.message !== "string"
    ) {
      return undefined;
    }
    return {
      key: record.key,
      kind: record.kind,
      occurredAt: record.occurredAt,
      message: record.message
    };
  } catch {
    return undefined;
  }
}

export function lifecycleNotificationEnabled(
  mode: LifecycleNotificationMode,
  kind: LifecycleNotificationKind
): boolean {
  if (mode === "off") {
    return false;
  }
  if (mode === "minimal") {
    return kind === "abnormal";
  }
  if (mode === "smart") {
    return kind === "abnormal" || kind === "connection" || kind === "windows_power";
  }
  return true;
}

export function windowsPowerPresentation(event: WindowsPowerEvent): PresentationCard {
  const restarting = event.kind === "system_restart";
  return presentation(
    restarting
      ? "Windows 已发出重新启动请求。Hub 会暂时离线，并在用户登录后自动恢复。"
      : "Windows 已发出关机请求。Hub 即将离线，并会在下次登录后自动恢复。",
    {
      title: restarting ? "Windows 正在重新启动" : "Windows 正在关机",
      kind: "notification",
      tone: "warning",
      status: "即将离线",
      subtitle: hostname(),
      fields: [
        { label: "设备", value: hostname() },
        { label: "时间", value: localTime(event.occurredAt) }
      ]
    }
  );
}

export class LifecycleNotificationService {
  private readonly instanceId = randomUUID();
  private readonly machine = hostname();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private startedAt = 0;
  private notificationsReady = false;
  private readonly pendingNotifications: Array<{
    card: PresentationCard;
    idempotencyKey: string;
  }> = [];

  public constructor(
    private readonly store: StateRepository,
    private readonly deliveries: DeliveryWorker,
    private readonly ownerOpenId: string,
    private readonly mode: LifecycleNotificationMode,
    private readonly heartbeatSeconds: number,
    private readonly logger: Logger
  ) {}

  public begin(bootId: string, observedPowerEvent?: WindowsPowerEvent): void {
    const now = Date.now();
    this.startedAt = now;
    if (observedPowerEvent) {
      this.store.recordLifecycleEvent({
        key: observedPowerEvent.key,
        kind: observedPowerEvent.kind,
        occurredAt: observedPowerEvent.occurredAt,
        detailsJson: JSON.stringify(observedPowerEvent)
      });
    }
    const previous = this.store.beginLifecycleInstance({
      instanceId: this.instanceId,
      bootId,
      startedAt: now,
      heartbeatAt: now,
      clean: false
    });

    if (previous && !previous.clean) {
      if (previous.bootId === bootId) {
        this.enqueue(
          "abnormal",
          presentation(
            "检测到上一个 Hub 进程未正常结束，Windows 计划任务已经自动拉起新实例。此前正在处理的任务会由恢复机制单独说明。",
            {
              title: "Hub 已从异常中恢复",
              kind: "notification",
              tone: "warning",
              status: "自动重启",
              subtitle: this.machine,
              fields: [
                { label: "上次心跳", value: localTime(previous.heartbeatAt) },
                { label: "恢复时间", value: localTime(now) }
              ]
            }
          ),
          `lifecycle:crash:${previous.instanceId}`
        );
      } else {
        const powerEvent = this.store.getLatestLifecycleEvent(
          previous.heartbeatAt - 120_000
        );
        if (powerEvent) {
          if (!powerEvent.deliveredAt) {
            const parsed = parseWindowsPowerEvent(powerEvent.detailsJson);
            if (parsed) {
              this.enqueue(
                "windows_power",
                windowsPowerPresentation(parsed),
                `lifecycle:windows:${powerEvent.key}`
              );
            } else {
              this.logger.warn("生命周期关机事件记录格式无效，跳过该事件提醒", {
                eventKey: powerEvent.key
              });
            }
          }
        } else {
          this.enqueue(
            "abnormal",
            presentation(
              "上次心跳后没有发现正常关机或重启事件，推测设备曾突然断电、强制关机或系统异常退出。本次启动后 Hub 已恢复在线。",
              {
                title: "检测到非正常断电",
                kind: "notification",
                tone: "error",
                status: "已恢复",
                subtitle: this.machine,
                fields: [
                  { label: "最后心跳", value: localTime(previous.heartbeatAt) },
                  { label: "恢复时间", value: localTime(now) }
                ]
              }
            ),
            `lifecycle:power-loss:${previous.instanceId}`
          );
        }
      }
    }

    this.enqueue(
      "startup",
      presentation("飞书远程控制已恢复在线，可以继续发送消息和操作 Codex 会话。", {
        title: "Lark Codex Hub 已启动",
        kind: "notification",
        tone: "success",
        status: "运行中",
        subtitle: this.machine,
        fields: [
          { label: "设备", value: this.machine },
          { label: "启动时间", value: localTime(now) },
          { label: "进程", value: String(process.pid) }
        ]
      }),
      `lifecycle:start:${this.instanceId}`
    );

    this.heartbeatTimer = setInterval(() => {
      try {
        if (!this.store.heartbeatLifecycle(this.instanceId, Date.now())) {
          this.logger.warn("生命周期心跳未写入，当前实例记录可能已被替换", {
            instanceId: this.instanceId
          });
        }
      } catch (error) {
        this.logger.warn("生命周期心跳写入失败", { error: String(error) });
      }
    }, this.heartbeatSeconds * 1_000);
    this.heartbeatTimer.unref();
  }

  public notifyConnectionRecovered(durationMs?: number): void {
    const now = Date.now();
    this.enqueue(
      "connection",
      presentation(
        durationMs === undefined
          ? "飞书长连接已重新建立，机器人消息收发已经恢复。"
          : `飞书长连接已重新建立，机器人消息收发已经恢复。离线约 ${durationText(durationMs)}。`,
        {
          title: "飞书连接已恢复",
          kind: "notification",
          tone: "success",
          status: "在线",
          subtitle: this.machine,
          fields: [{ label: "恢复时间", value: localTime(now) }]
        }
      ),
      `lifecycle:connection:${this.instanceId}:${String(now)}`
    );
  }

  public ready(): void {
    if (this.notificationsReady) {
      return;
    }
    this.notificationsReady = true;
    for (const item of this.pendingNotifications.splice(0)) {
      this.deliver(item.card, item.idempotencyKey);
    }
  }

  public notifyStopping(reason: LifecycleStopReason): void {
    const now = Date.now();
    this.enqueue(
      "stopping",
      presentation("Hub 正在完成队列收尾并关闭飞书连接。服务停止后将暂时无法接收远程消息。", {
        title: "Lark Codex Hub 正在停止",
        kind: "notification",
        tone: "warning",
        status: "即将离线",
        subtitle: this.machine,
        fields: [
          { label: "原因", value: reasonText(reason) },
          { label: "运行时长", value: durationText(now - this.startedAt) },
          { label: "时间", value: localTime(now) }
        ]
      }),
      `lifecycle:stop:${this.instanceId}`
    );
  }

  public finish(reason: LifecycleStopReason): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.store.finishLifecycle(this.instanceId, reason, Date.now());
  }

  private enqueue(
    kind: LifecycleNotificationKind,
    card: PresentationCard,
    idempotencyKey: string
  ): void {
    if (!lifecycleNotificationEnabled(this.mode, kind)) {
      return;
    }
    if (!this.notificationsReady) {
      this.pendingNotifications.push({ card, idempotencyKey });
      return;
    }
    this.deliver(card, idempotencyKey);
  }

  private deliver(card: PresentationCard, idempotencyKey: string): void {
    this.deliveries.enqueueSend(
      { type: "open_id", id: this.ownerOpenId },
      card,
      { idempotencyKey }
    );
  }
}
