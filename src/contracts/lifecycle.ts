export type LifecycleStopReason =
  | "service_stop"
  | "sigint"
  | "sigterm"
  | "runtime_close";

export type LifecycleNotificationMode = "off" | "minimal" | "smart" | "all";

export type WindowsPowerEventKind = "system_shutdown" | "system_restart";

export interface LifecycleStateRecord {
  instanceId: string;
  bootId: string;
  startedAt: number;
  heartbeatAt: number;
  clean: boolean;
  stoppedAt?: number;
  stopReason?: LifecycleStopReason;
}

export interface LifecycleEventRecord {
  key: string;
  kind: WindowsPowerEventKind;
  occurredAt: number;
  detailsJson: string;
  deliveredAt?: number;
}

export interface WindowsPowerEvent {
  key: string;
  kind: WindowsPowerEventKind;
  occurredAt: number;
  message: string;
}

export interface ConnectionLifecycleEvent {
  type: "reconnecting" | "reconnected";
  at: number;
  disconnectedAt?: number;
  durationMs?: number;
}
