import type {
  AgentHealth,
  AgentThreadDetails,
  AgentThreadListRequest,
  AgentThreadPage,
  AgentThreadSummary,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult
} from "../../contracts/events.js";
import {
  ExecutionTimeoutError,
  SessionBusyError,
  isNativeSessionBusyMessage
} from "../../domain/execution-errors.js";
import type { Logger } from "../../observability/logger.js";
import { errorMessage } from "../../observability/logger.js";
import type { CodingAgent } from "../../ports/coding-agent.js";
import { AppServerRpcClient } from "./app-server-rpc-client.js";
import {
  lastAgentMessage,
  record,
  stableThreadConfig,
  stringValue,
  threadIdFrom,
  toThreadDetails,
  toThreadSummary,
  type JsonRecord,
  type RpcInboundMessage,
  type StableThreadForkParams,
  type StableThreadResumeParams,
  type StableThreadStartParams
} from "./app-server-protocol.js";

interface ActiveTurn {
  scopeKey: string;
  threadId: string;
  turnId?: string;
  startedAt: number;
  finalText: string;
  cancelled: boolean;
  settled: boolean;
  eventQueue: Promise<void>;
  onEvent(event: ExecutionEvent): Promise<void>;
  resolve(result: ExecutionResult): void;
  reject(error: Error): void;
  timeout?: NodeJS.Timeout;
}

interface InitializeResult {
  userAgent?: string;
}

function textInput(text: string): JsonRecord {
  return { type: "text", text, text_elements: [] };
}

function statusType(value: unknown): string | undefined {
  return stringValue(record(value)?.status) ?? stringValue(value);
}

function compactDetail(value: unknown, limit = 120): string | undefined {
  const text = stringValue(value)?.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, limit) : undefined;
}

function fileChangeDetail(item: JsonRecord): string | undefined {
  if (!Array.isArray(item.changes)) {
    return undefined;
  }
  const paths = item.changes
    .map((change) => compactDetail(record(change)?.path, 80))
    .filter((path): path is string => Boolean(path));
  if (!paths.length) {
    return undefined;
  }
  return `${paths.slice(0, 3).join("、")}${paths.length > 3 ? ` 等 ${paths.length} 个文件` : ""}`;
}

function progressLabel(itemValue: unknown, completed = false): string {
  const item = record(itemValue);
  const type = stringValue(item?.type);
  const status = stringValue(item?.status);
  const failed = status === "failed" || status === "declined";
  const phase = completed ? (failed ? "失败" : "完成") : "正在执行";
  if (type === "commandExecution") {
    const command = compactDetail(item?.command);
    return `${phase === "正在执行" ? "正在运行命令" : `命令执行${phase}`}${command ? `：${command}` : ""}`;
  }
  if (type === "fileChange") {
    const files = fileChangeDetail(item ?? {});
    return `${completed ? `文件修改${phase}` : "正在修改文件"}${files ? `：${files}` : ""}`;
  }
  if (type === "mcpToolCall") {
    const tool = [compactDetail(item?.server, 60), compactDetail(item?.tool, 60)]
      .filter(Boolean)
      .join("/");
    return `${completed ? `工具调用${phase}` : "正在调用工具"}${tool ? `：${tool}` : ""}`;
  }
  if (type === "dynamicToolCall") {
    const tool = [compactDetail(item?.namespace, 60), compactDetail(item?.tool, 60)]
      .filter(Boolean)
      .join("/");
    return `${completed ? `工具调用${phase}` : "正在调用工具"}${tool ? `：${tool}` : ""}`;
  }
  if (type === "agentMessage") {
    return "正在组织回复";
  }
  return "正在处理";
}

export class CodexAppServerAgent implements CodingAgent {
  private readonly client: AppServerRpcClient;
  private readonly active = new Map<string, ActiveTurn>();
  private readonly activeThreads = new Map<string, string>();
  private readonly loadedThreads = new Set<string>();
  private readonly loadingThreads = new Map<string, Promise<void>>();
  private readyPromise: Promise<InitializeResult> | undefined;
  private recyclePromise: Promise<void> | undefined;
  private recycleNeeded = false;
  private userAgent: string | undefined;
  private closing = false;
  private operations = 0;

  public constructor(
    command: string,
    private readonly logger: Logger,
    prefixArgs: readonly string[] = []
  ) {
    this.client = new AppServerRpcClient(command, prefixArgs, logger);
    this.client.onMessage((message) => this.handleNotification(message));
    this.client.onClose((error) => this.handleServerClose(error));
  }

  public activeScopes(): readonly string[] {
    return [...this.active.keys()];
  }

  public cancel(scopeKey: string): boolean {
    const active = this.active.get(scopeKey);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    if (active.turnId) {
      void this.client
        .request("turn/interrupt", {
          threadId: active.threadId,
          turnId: active.turnId
        })
        .catch((error) => {
          this.logger.warn("取消 App Server 任务失败", {
            scopeKey,
            error: errorMessage(error)
          });
        });
    }
    return true;
  }

  public async steer(scopeKey: string, prompt: string): Promise<boolean> {
    const active = this.active.get(scopeKey);
    if (!active?.turnId) {
      return false;
    }
    try {
      await this.client.request("turn/steer", {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        input: [textInput(prompt)]
      });
      return true;
    } catch (error) {
      this.logger.warn("向当前 Codex 任务追加指令失败", {
        scopeKey,
        error: errorMessage(error)
      });
      return false;
    }
  }

  public async health(): Promise<AgentHealth> {
    return this.withOperation(async () => {
      try {
        await this.ensureReady();
        await this.client.request("thread/list", {
          limit: 1,
          useStateDbOnly: true
        });
        return {
          backend: "app-server" as const,
          ready: true,
          ...(this.userAgent ? { version: this.userAgent } : {}),
          detail: "App Server 已初始化，thread/list 可用"
        };
      } catch (error) {
        return {
          backend: "app-server" as const,
          ready: false,
          detail: errorMessage(error)
        };
      }
    });
  }

  public async listThreads(request: AgentThreadListRequest): Promise<AgentThreadPage> {
    return this.withOperation(async () => {
      await this.ensureReady();
      const result = await this.client.request<unknown>("thread/list", {
        limit: request.limit,
        ...(request.cursor ? { cursor: request.cursor } : {}),
        sourceKinds: request.sourceKinds,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        useStateDbOnly: request.useStateDbOnly ?? false
      });
      const root = record(result);
      const values = root?.data;
      const nextCursor = stringValue(root?.nextCursor);
      return {
        threads: Array.isArray(values) ? values.map(toThreadSummary) : [],
        ...(nextCursor ? { nextCursor } : {})
      };
    });
  }

  public async readThread(
    threadId: string,
    includeTurns: boolean
  ): Promise<AgentThreadDetails> {
    return this.withOperation(async () => {
      await this.ensureReady();
      const result = await this.client.request<unknown>("thread/read", {
        threadId,
        includeTurns
      });
      const thread = record(result)?.thread;
      return toThreadDetails(thread);
    });
  }

  public async forkThread(threadId: string): Promise<AgentThreadSummary> {
    return this.withOperation(async () => {
      await this.ensureReady();
      const params = { threadId } satisfies StableThreadForkParams;
      const result = await this.client.request<unknown>("thread/fork", params);
      const thread = record(result)?.thread;
      const forked = toThreadSummary(thread);
      this.loadedThreads.add(forked.id);
      return forked;
    });
  }

  public async shutdown(graceMs: number): Promise<void> {
    this.closing = true;
    for (const scopeKey of this.active.keys()) {
      this.cancel(scopeKey);
    }
    const deadline = Date.now() + graceMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    for (const active of [...this.active.values()]) {
      if (!this.beginSettle(active)) {
        continue;
      }
      active.reject(new Error("Codex App Server 关闭时任务尚未结束，已强制中断。"));
      this.cleanup(active);
    }
    await this.client.close(Math.max(1_000, Math.min(graceMs, 5_000)));
    this.resetConnectionState();
  }

  public run(
    request: ExecutionRequest,
    onEvent: (event: ExecutionEvent) => Promise<void>
  ): Promise<ExecutionResult> {
    return this.withOperation(() => this.runTurn(request, onEvent));
  }

  private async runTurn(
    request: ExecutionRequest,
    onEvent: (event: ExecutionEvent) => Promise<void>
  ): Promise<ExecutionResult> {
    if (this.closing) {
      throw new Error("Codex App Server 正在关闭，暂不接受新任务。");
    }
    if (this.active.has(request.scopeKey)) {
      throw new Error("该会话已有 Codex 任务正在执行。");
    }
    await this.ensureReady();
    const startedAt = Date.now();
    let threadId: string;
    try {
      threadId = request.sessionId
        ? await this.resumeThread(request)
        : await this.startThread(request);
    } catch (error) {
      throw this.mapError(error);
    }
    const occupiedBy = this.activeThreads.get(threadId);
    if (occupiedBy && occupiedBy !== request.scopeKey) {
      throw new SessionBusyError();
    }

    let resolveCompletion!: (result: ExecutionResult) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<ExecutionResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const active: ActiveTurn = {
      scopeKey: request.scopeKey,
      threadId,
      startedAt,
      finalText: "",
      cancelled: false,
      settled: false,
      eventQueue: Promise.resolve(),
      onEvent,
      resolve: resolveCompletion,
      reject: rejectCompletion
    };
    this.active.set(request.scopeKey, active);
    this.activeThreads.set(threadId, request.scopeKey);
    active.timeout = setTimeout(() => {
      void this.timeoutTurn(active);
    }, request.timeoutMs);
    active.timeout.unref();

    await this.emit(active, { type: "session", sessionId: threadId });
    let response: unknown;
    try {
      response = await this.client.request<unknown>("turn/start", {
        threadId,
        input: [textInput(request.prompt)],
        cwd: request.cwd,
        approvalPolicy: "never",
        ...(request.model ? { model: request.model } : {})
      });
    } catch (error) {
      if (this.beginSettle(active)) {
        this.cleanup(active);
      }
      await this.releaseAfterTurn(threadId);
      throw this.mapError(error);
    }
    const turn = record(record(response)?.turn);
    const turnId = stringValue(turn?.id);
    if (turnId) {
      active.turnId = turnId;
    }
    return completion;
  }

  private async ensureReady(): Promise<InitializeResult> {
    if (this.recyclePromise) {
      await this.recyclePromise;
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = (async () => {
      const result = await this.client.request<InitializeResult>("initialize", {
        clientInfo: {
          name: "lark_codex_hub",
          title: "Lark Codex Hub",
          version: "1.3.0"
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false
        }
      });
      this.client.notify("initialized");
      this.userAgent = result.userAgent;
      return result;
    })().catch((error) => {
      this.readyPromise = undefined;
      throw error;
    });
    return this.readyPromise;
  }

  private async startThread(request: ExecutionRequest): Promise<string> {
    const params = {
      ...stableThreadConfig(request),
      serviceName: "Lark Codex Hub"
    } satisfies StableThreadStartParams;
    const result = await this.client.request<unknown>("thread/start", params);
    const threadId = threadIdFrom(result);
    if (!threadId) {
      throw new Error("App Server 创建会话后没有返回 thread id。");
    }
    this.loadedThreads.add(threadId);
    return threadId;
  }

  private async resumeThread(request: ExecutionRequest): Promise<string> {
    const threadId = request.sessionId!;
    if (this.loadedThreads.has(threadId)) {
      return threadId;
    }
    const existing = this.loadingThreads.get(threadId);
    if (existing) {
      await existing;
      return threadId;
    }
    const params = {
      ...stableThreadConfig(request),
      threadId
    } satisfies StableThreadResumeParams;
    const loading = this.client
      .request("thread/resume", params)
      .then(() => {
        this.loadedThreads.add(threadId);
      })
      .finally(() => {
        this.loadingThreads.delete(threadId);
      });
    this.loadingThreads.set(threadId, loading);
    await loading;
    return threadId;
  }

  private handleNotification(message: RpcInboundMessage): void {
    const params = record(message.params);
    const threadId = stringValue(params?.threadId);
    if (message.method === "thread/closed" && threadId) {
      this.loadedThreads.delete(threadId);
      return;
    }
    const scopeKey = threadId ? this.activeThreads.get(threadId) : undefined;
    const active = scopeKey ? this.active.get(scopeKey) : undefined;
    if (!active || active.settled) {
      return;
    }
    const turnId = stringValue(params?.turnId) ?? stringValue(record(params?.turn)?.id);
    if (turnId) {
      active.turnId ??= turnId;
    }
    if (active.turnId && turnId && active.turnId !== turnId) {
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const delta = stringValue(params?.delta) ?? "";
      active.finalText += delta;
      void this.emit(active, {
        type: "message-delta",
        delta,
        text: active.finalText
      });
      return;
    }
    if (message.method === "item/reasoning/summaryTextDelta") {
      void this.emit(active, { type: "reasoning", label: "正在整理思路" });
      return;
    }
    if (message.method === "item/started") {
      const item = params?.item;
      void this.emit(active, { type: "progress", label: progressLabel(item) });
      return;
    }
    if (message.method === "item/completed") {
      const item = record(params?.item);
      if (item?.type === "agentMessage") {
        const text = stringValue(item.text);
        if (text) {
          active.finalText = text;
          void this.emit(active, { type: "message", text });
        }
      } else if (item) {
        void this.emit(active, {
          type: "progress",
          label: progressLabel(item, true)
        });
      }
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      const last = record(record(params?.tokenUsage)?.last);
      const inputTokens = last?.inputTokens;
      const outputTokens = last?.outputTokens;
      if (typeof inputTokens === "number" && typeof outputTokens === "number") {
        void this.emit(active, { type: "usage", inputTokens, outputTokens });
      }
      return;
    }
    if (message.method === "error") {
      const detail =
        stringValue(record(params?.error)?.message) ??
        stringValue(params?.message) ??
        "Codex App Server 返回错误。";
      void this.emit(active, { type: "error", message: detail });
      return;
    }
    if (message.method === "turn/completed") {
      void this.completeTurn(active, params?.turn);
    }
  }

  private async completeTurn(active: ActiveTurn, turnValue: unknown): Promise<void> {
    if (!this.beginSettle(active)) {
      return;
    }
    const turn = record(turnValue);
    const status = statusType(turn?.status) ?? "completed";
    const completedText = lastAgentMessage(turn);
    if (completedText) {
      active.finalText = completedText;
    }
    const failure = stringValue(record(turn?.error)?.message);
    if (failure) {
      await this.emit(active, { type: "error", message: failure });
    }
    await active.eventQueue;
    if (status === "failed") {
      this.cleanup(active);
      await this.releaseAfterTurn(active.threadId);
      active.reject(this.mapError(new Error(failure ?? "Codex 任务执行失败。")));
      return;
    }
    const result: ExecutionResult = {
      sessionId: active.threadId,
      finalText: active.cancelled || status === "interrupted"
        ? "任务已取消。"
        : active.finalText,
      exitCode: status === "completed" ? 0 : 1,
      durationMs: Date.now() - active.startedAt,
      cancelled: active.cancelled || status === "interrupted"
    };
    this.cleanup(active);
    await this.releaseAfterTurn(active.threadId);
    active.resolve(result);
  }

  private emit(active: ActiveTurn, event: ExecutionEvent): Promise<void> {
    active.eventQueue = active.eventQueue
      .then(() => active.onEvent(event))
      .catch((error) => {
        this.logger.warn("处理 App Server 流式事件失败", {
          scopeKey: active.scopeKey,
          event: event.type,
          error: errorMessage(error)
        });
      });
    return active.eventQueue;
  }

  private cleanup(active: ActiveTurn): void {
    if (active.timeout) {
      clearTimeout(active.timeout);
    }
    if (this.active.get(active.scopeKey) === active) {
      this.active.delete(active.scopeKey);
    }
    if (this.activeThreads.get(active.threadId) === active.scopeKey) {
      this.activeThreads.delete(active.threadId);
    }
  }

  private async timeoutTurn(active: ActiveTurn): Promise<void> {
    if (
      this.active.get(active.scopeKey) !== active ||
      !this.beginSettle(active)
    ) {
      return;
    }
    active.cancelled = true;
    this.cancel(active.scopeKey);
    this.cleanup(active);
    await this.releaseAfterTurn(active.threadId);
    active.reject(new ExecutionTimeoutError());
  }

  private handleServerClose(error: Error): void {
    this.resetConnectionState();
    for (const active of [...this.active.values()]) {
      if (!this.beginSettle(active)) {
        continue;
      }
      active.reject(error);
      this.cleanup(active);
    }
  }

  private resetConnectionState(): void {
    this.readyPromise = undefined;
    this.userAgent = undefined;
    this.loadedThreads.clear();
    this.loadingThreads.clear();
    this.recycleNeeded = false;
  }

  private async releaseThread(threadId: string): Promise<void> {
    this.loadedThreads.delete(threadId);
    this.recycleNeeded = true;
    if (!this.client.isRunning()) {
      this.resetConnectionState();
      return;
    }
    if (this.active.size > 0) {
      try {
        await this.client.request("thread/unsubscribe", { threadId });
      } catch (error) {
        this.logger.debug("App Server 会话取消订阅失败", {
          threadId,
          error: errorMessage(error)
        });
      }
      return;
    }
    await this.recycleWhenIdle();
  }

  private async recycleWhenIdle(): Promise<void> {
    if (this.active.size > 0 || this.operations > 0 || !this.recycleNeeded) {
      return;
    }
    if (!this.recyclePromise) {
      this.recyclePromise = (async () => {
        this.logger.debug("回收空闲 Codex App Server，释放跨客户端会话 writer");
        await this.client.close(5_000);
        this.resetConnectionState();
      })().finally(() => {
        this.recyclePromise = undefined;
      });
    }
    await this.recyclePromise;
  }

  private beginSettle(active: ActiveTurn): boolean {
    if (active.settled) {
      return false;
    }
    active.settled = true;
    return true;
  }

  private async releaseAfterTurn(threadId: string): Promise<void> {
    try {
      await this.releaseThread(threadId);
    } catch (error) {
      this.logger.warn("释放 App Server 会话 writer 失败", {
        threadId,
        error: errorMessage(error)
      });
    }
  }

  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.recyclePromise) {
      await this.recyclePromise;
    }
    this.operations += 1;
    try {
      return await operation();
    } finally {
      this.operations -= 1;
      await this.recycleWhenIdle();
    }
  }

  private mapError(error: unknown): Error {
    const detail = errorMessage(error);
    return isNativeSessionBusyMessage(detail) ? new SessionBusyError() : error instanceof Error ? error : new Error(detail);
  }
}
