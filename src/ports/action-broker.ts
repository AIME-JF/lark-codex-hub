import type { ActionResult, LarkAction } from "../contracts/actions.js";

export interface ActionBroker {
  execute(action: LarkAction, idempotencyKey: string, confirmed?: boolean): Promise<ActionResult>;
}
