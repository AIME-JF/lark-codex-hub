import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult
} from "../../contracts/events.js";
import type { CodingAgent } from "../../ports/coding-agent.js";
import type { Logger } from "../../observability/logger.js";
import { parseCodexLine } from "./jsonl-parser.js";
import {
  ExecutionTimeoutError,
  SessionBusyError,
  isNativeSessionBusyMessage
} from "../../domain/execution-errors.js";

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  stopReason?: "cancelled" | "timeout" | "shutdown";
  exited: boolean;
}

export class CodexExecAgent implements CodingAgent {
  private readonly active = new Map<string, ActiveRun>();
  private closing = false;

  public constructor(
    private readonly command: string,
    private readonly logger: Logger,
    private readonly prefixArgs: readonly string[] = []
  ) {}

  public activeScopes(): readonly string[] {
    return [...this.active.keys()];
  }

  public cancel(scopeKey: string): boolean {
    const run = this.active.get(scopeKey);
    if (!run) {
      return false;
    }
    this.terminate(run, "cancelled");
    return true;
  }

  public async shutdown(graceMs: number): Promise<void> {
    this.closing = true;
    for (const run of this.active.values()) {
      this.terminate(run, "shutdown");
    }
    const deadline = Date.now() + graceMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    for (const run of this.active.values()) {
      this.forceTerminate(run);
    }
  }

  public async run(
    request: ExecutionRequest,
    onEvent: (event: ExecutionEvent) => Promise<void>
  ): Promise<ExecutionResult> {
    if (this.closing) {
      throw new Error("Codex 运行器正在关闭，暂不接受新任务。");
    }
    if (this.active.has(request.scopeKey)) {
      throw new Error("该会话已有 Codex 任务正在执行。");
    }
    const args = this.arguments(request);
    const startedAt = Date.now();
    const child = spawn(this.command, [...this.prefixArgs, ...args], {
      cwd: request.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const active: ActiveRun = { child, exited: false };
    this.active.set(request.scopeKey, active);
    let stderr = "";
    let sessionId = request.sessionId;
    let finalText = "";
    let eventQueue = Promise.resolve();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part: string) => {
      stderr = `${stderr}${part}`.slice(-16_000);
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      for (const event of parseCodexLine(line)) {
        if (event.type === "session") {
          sessionId = event.sessionId;
        } else if (event.type === "message") {
          finalText = event.text;
        }
        eventQueue = eventQueue.then(() => onEvent(event));
      }
    });

    const timeout = setTimeout(() => {
      this.logger.warn("Codex 执行超时，正在终止", { scopeKey: request.scopeKey });
      this.terminate(active, "timeout");
    }, request.timeoutMs);
    timeout.unref();

    child.stdin.end(request.prompt, "utf8");

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          active.exited = true;
          resolve(code ?? 1);
        });
      });
      await eventQueue;
      if (active.stopReason === "timeout") {
        throw new ExecutionTimeoutError();
      }
      if (exitCode !== 0 && !active.stopReason) {
        const detail = stderr.trim() || "Codex 未返回错误详情。";
        if (isNativeSessionBusyMessage(detail)) {
          throw new SessionBusyError();
        }
        throw new Error(`Codex 退出码 ${exitCode}：${detail}`);
      }
      const cancelled = Boolean(active.stopReason);
      return {
        ...(sessionId ? { sessionId } : {}),
        finalText: cancelled ? "任务已取消。" : finalText,
        exitCode,
        durationMs: Date.now() - startedAt,
        cancelled
      };
    } finally {
      clearTimeout(timeout);
      lines.close();
      this.active.delete(request.scopeKey);
    }
  }

  private terminate(
    run: ActiveRun,
    reason: "cancelled" | "timeout" | "shutdown"
  ): void {
    run.stopReason ??= reason;
    run.child.kill("SIGTERM");
    const force = setTimeout(() => this.forceTerminate(run), 2_000);
    force.unref();
  }

  private forceTerminate(run: ActiveRun): void {
    if (run.exited || run.child.pid === undefined) {
      return;
    }
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(run.child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true }
      );
      killer.once("error", () => undefined);
      return;
    }
    run.child.kill("SIGKILL");
  }

  private arguments(request: ExecutionRequest): string[] {
    const execOptions = [
      "--json",
      "-c",
      'approval_policy="never"',
      "--sandbox",
      request.sandbox,
      "--cd",
      request.cwd
    ];
    if (request.model) {
      execOptions.push("--model", request.model);
    }
    if (request.sessionId) {
      return ["exec", ...execOptions, "resume", request.sessionId, "-"];
    }
    return ["exec", ...execOptions, "-"];
  }
}
