import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Logger } from "../../observability/logger.js";
import { errorMessage } from "../../observability/logger.js";
import type { JsonRecord, RpcInboundMessage } from "./app-server-protocol.js";
import { record, stringValue } from "./app-server-protocol.js";

interface PendingRequest {
  method: string;
  generation: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class AppServerRpcError extends Error {
  public constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

export class AppServerRpcClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private startPromise: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private messageHandler: ((message: RpcInboundMessage) => void) | undefined;
  private closeHandler: ((error: Error) => void) | undefined;
  private closing = false;
  private generation = 0;

  public constructor(
    private readonly command: string,
    private readonly prefixArgs: readonly string[],
    private readonly logger: Logger
  ) {}

  public onMessage(handler: (message: RpcInboundMessage) => void): void {
    this.messageHandler = handler;
  }

  public onClose(handler: (error: Error) => void): void {
    this.closeHandler = handler;
  }

  public isRunning(): boolean {
    return Boolean(
      this.child && this.child.exitCode === null && this.child.signalCode === null
    );
  }

  public async start(): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.spawnServer().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  public async request<T>(
    method: string,
    params: JsonRecord | undefined,
    timeoutMs = 30_000
  ): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error("Codex App Server 连接不可用。");
    }
    const id = this.nextId++;
    const generation = this.generation;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server 请求超时：${method}`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, {
        method,
        generation,
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
      child.stdin.write(
        `${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`,
        "utf8",
        (error) => {
          if (!error) {
            return;
          }
          const pending = this.pending.get(id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pending.delete(id);
            pending.reject(error);
          }
        }
      );
    });
  }

  public notify(method: string, params?: JsonRecord): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error("Codex App Server 连接不可用。");
    }
    child.stdin.write(
      `${JSON.stringify({ method, ...(params ? { params } : {}) })}\n`,
      "utf8"
    );
  }

  public async close(graceMs: number): Promise<void> {
    this.closing = true;
    const child = this.child;
    const generation = this.generation;
    if (!child) {
      return;
    }
    let finished = false;
    const closed = new Promise<void>((resolve) => child.once("close", () => {
      finished = true;
      resolve();
    }));
    child.kill("SIGTERM");
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, graceMs);
        timeout.unref();
      })
    ]);
    if (!finished && child.pid !== undefined) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const killer = spawn(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { stdio: "ignore", windowsHide: true }
          );
          killer.once("error", () => resolve());
          killer.once("close", () => resolve());
        });
      } else {
        child.kill("SIGKILL");
      }
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 2_000);
          timeout.unref();
        })
      ]);
    }
    if (this.child === child && this.generation === generation) {
      this.handleClose(child, generation, new Error("Codex App Server 已关闭。"));
    }
  }

  private spawnServer(): Promise<void> {
    this.closing = false;
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.command,
        [...this.prefixArgs, "app-server", "--listen", "stdio://"],
        {
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }
      );
      const generation = this.generation + 1;
      this.generation = generation;
      this.child = child;
      let settled = false;
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.handleClose(child, generation, error);
      });
      child.once("close", (code, signal) => {
        const detail = `Codex App Server 已退出（code=${String(code)}, signal=${String(signal)}）。`;
        if (!settled) {
          settled = true;
          reject(new Error(detail));
        }
        this.handleClose(child, generation, new Error(detail));
      });

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.lines = lines;
      lines.on("line", (line) => this.handleLine(child, generation, line));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (part: string) => {
        const detail = part.trim();
        if (detail) {
          this.logger.debug("Codex App Server 日志", { detail: detail.slice(-4_000) });
        }
      });
    });
  }

  private handleLine(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    line: string
  ): void {
    if (this.child !== child || this.generation !== generation) {
      return;
    }
    let message: RpcInboundMessage;
    try {
      message = JSON.parse(line) as RpcInboundMessage;
    } catch (error) {
      this.logger.warn("忽略无法解析的 App Server 消息", {
        error: errorMessage(error),
        line: line.slice(0, 1_000)
      });
      return;
    }
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending || pending.generation !== generation) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        const data = message.error.data;
        const dataText = data === undefined
          ? ""
          : `：${typeof data === "string" ? data : JSON.stringify(data)}`;
        pending.reject(
          new AppServerRpcError(
            `${message.error.message ?? `App Server 请求失败：${pending.method}`}${dataText}`.slice(0, 8_000),
            message.error.code,
            data
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      this.handleServerRequest(child, message);
      return;
    }
    if (message.method) {
      this.messageHandler?.(message);
    }
  }

  private handleServerRequest(
    child: ChildProcessWithoutNullStreams,
    message: RpcInboundMessage
  ): void {
    const method = message.method ?? "";
    let result: unknown;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "applyPatchApproval" ||
      method === "execCommandApproval"
    ) {
      result = { decision: "decline" };
    } else if (method === "item/tool/requestUserInput") {
      result = { answers: {} };
    } else if (method === "mcpServer/elicitation/request") {
      result = { action: "decline", content: null, _meta: null };
    } else if (method === "currentTime/read") {
      result = { currentTimeAt: Math.floor(Date.now() / 1_000) };
    }
    if (this.child !== child || child.stdin.destroyed) {
      return;
    }
    const response =
      result === undefined
        ? {
            id: message.id,
            error: {
              code: -32601,
              message: `Lark Codex Hub 不处理 App Server 请求：${method}`
            }
          }
        : { id: message.id, result };
    child.stdin.write(`${JSON.stringify(response)}\n`, "utf8");
    this.logger.warn("App Server 发起了未预期的交互请求，已安全拒绝", {
      method,
      threadId: stringValue(record(message.params)?.threadId)
    });
  }

  private handleClose(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    error: Error
  ): void {
    if (this.child !== child || this.generation !== generation) {
      return;
    }
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) {
        continue;
      }
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (!this.closing) {
      this.closeHandler?.(error);
    }
  }
}
