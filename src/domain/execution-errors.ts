export type SessionBusyOwner = "desktop_or_external" | "hub" | "unknown";

export class SessionBusyError extends Error {
  public readonly code = "session_busy";

  public constructor(
    message = "该 Codex 会话正在被另一个入口使用，请等待当前任务结束后重试。",
    public readonly owner: SessionBusyOwner = "unknown"
  ) {
    super(message);
    this.name = "SessionBusyError";
  }
}

export class ExecutionTimeoutError extends Error {
  public constructor(message = "Codex 执行超时，进程已终止。") {
    super(message);
    this.name = "ExecutionTimeoutError";
  }
}

export function isNativeSessionBusyMessage(value: string): boolean {
  return /already has an active writer|active writer|(session|thread).{0,80}(lock|locked|busy|another process)|write lock|会话.{0,20}(锁|占用)/iu.test(
    value
  );
}
