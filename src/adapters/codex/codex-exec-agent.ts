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

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
}

export class CodexExecAgent implements CodingAgent {
  private readonly active = new Map<string, ActiveRun>();

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
    run.cancelled = true;
    run.child.kill("SIGTERM");
    return true;
  }

  public async run(
    request: ExecutionRequest,
    onEvent: (event: ExecutionEvent) => Promise<void>
  ): Promise<ExecutionResult> {
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
    const active: ActiveRun = { child, cancelled: false };
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
      child.kill("SIGTERM");
    }, request.timeoutMs);
    timeout.unref();

    child.stdin.end(request.prompt, "utf8");

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      await eventQueue;
      if (exitCode !== 0 && !active.cancelled) {
        const detail = stderr.trim() || "Codex 未返回错误详情。";
        throw new Error(`Codex 退出码 ${exitCode}：${detail}`);
      }
      return {
        ...(sessionId ? { sessionId } : {}),
        finalText: active.cancelled ? "任务已取消。" : finalText,
        exitCode,
        durationMs: Date.now() - startedAt
      };
    } finally {
      clearTimeout(timeout);
      lines.close();
      this.active.delete(request.scopeKey);
    }
  }

  private arguments(request: ExecutionRequest): string[] {
    const common = ["--json", "--color", "never", "-c", 'approval_policy="never"'];
    if (request.model) {
      common.push("--model", request.model);
    }
    if (request.sessionId) {
      return ["exec", "resume", ...common, request.sessionId, "-"];
    }
    return [
      "exec",
      ...common,
      "--sandbox",
      request.sandbox,
      "--cd",
      request.cwd,
      "-"
    ];
  }
}
