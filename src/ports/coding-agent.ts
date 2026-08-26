import type {
  AgentHealth,
  AgentThreadDetails,
  AgentThreadListRequest,
  AgentThreadPage,
  AgentThreadSummary,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult
} from "../contracts/events.js";

export interface CodingAgent {
  run(
    request: ExecutionRequest,
    onEvent: (event: ExecutionEvent) => Promise<void>
  ): Promise<ExecutionResult>;
  cancel(scopeKey: string): boolean;
  steer?(scopeKey: string, prompt: string): Promise<boolean>;
  health?(): Promise<AgentHealth>;
  listThreads?(request: AgentThreadListRequest): Promise<AgentThreadPage>;
  readThread?(threadId: string, includeTurns: boolean): Promise<AgentThreadDetails>;
  forkThread?(threadId: string): Promise<AgentThreadSummary>;
  activeScopes(): readonly string[];
  shutdown(graceMs: number): Promise<void>;
}
