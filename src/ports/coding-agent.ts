import type { ExecutionEvent, ExecutionRequest, ExecutionResult } from "../contracts/events.js";

export interface CodingAgent {
  run(
    request: ExecutionRequest,
    onEvent: (event: ExecutionEvent) => Promise<void>
  ): Promise<ExecutionResult>;
  cancel(scopeKey: string): boolean;
  activeScopes(): readonly string[];
}
