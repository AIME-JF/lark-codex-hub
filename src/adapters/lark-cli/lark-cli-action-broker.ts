import { spawn } from "node:child_process";
import type { ActionResult, LarkAction } from "../../contracts/actions.js";
import type { ActionBroker } from "../../ports/action-broker.js";

interface CliEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: { message?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface Invocation {
  args: string[];
  stdin?: string;
}

function invocation(action: LarkAction, idempotencyKey: string): Invocation {
  if (action.kind === "send_message") {
    return {
      args: [
        "im",
        "+messages-send",
        "--as",
        action.identity,
        action.receiveIdType === "chat_id" ? "--chat-id" : "--user-id",
        action.receiveId,
        "--text",
        action.text,
        "--idempotency-key",
        idempotencyKey.slice(0, 50),
        "--json"
      ]
    };
  }
  if (action.kind === "create_task") {
    return {
      args: [
        "task",
        "+create",
        "--as",
        "user",
        "--summary",
        action.summary,
        "--description",
        action.description,
        "--idempotency-key",
        idempotencyKey,
        "--json"
      ]
    };
  }
  return {
    args: [
      "docs",
      "+create",
      "--as",
      "user",
      "--doc-format",
      "markdown",
      "--title",
      action.title,
      "--content",
      "-",
      "--json"
    ],
    stdin: action.markdown
  };
}

function findConfirmation(value: unknown, depth = 0): unknown {
  if (depth > 5 || !value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["confirmation", "_confirmation", "confirm", "_confirm"]) {
    if (record[key] && typeof record[key] === "object") {
      return record[key];
    }
  }
  for (const item of Object.values(record)) {
    const found = findConfirmation(item, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function confirmationFields(value: unknown): NonNullable<ActionResult["confirmation"]> {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    action: typeof record.action === "string" ? record.action : "飞书高风险操作",
    risk: typeof record.risk === "string" ? record.risk : "该操作需要用户明确确认",
    params: record.params ?? record.parameters ?? record
  };
}

function successSummary(action: LarkAction, envelope: CliEnvelope): string {
  if (action.kind === "send_message") {
    return "飞书消息已发送。";
  }
  if (action.kind === "create_task") {
    return "飞书任务已创建。";
  }
  const data = envelope.data as { document?: { url?: unknown } } | undefined;
  const url = data?.document?.url;
  return typeof url === "string" ? `飞书文档已创建：${url}` : "飞书文档已创建。";
}

export class LarkCliActionBroker implements ActionBroker {
  public constructor(
    private readonly command: string,
    private readonly prefixArgs: readonly string[] = []
  ) {}

  public async execute(
    action: LarkAction,
    idempotencyKey: string,
    confirmed = false
  ): Promise<ActionResult> {
    const spec = invocation(action, idempotencyKey);
    if (confirmed) {
      spec.args.push("--yes");
    }
    const result = await this.invoke(spec);
    let envelope: CliEnvelope;
    try {
      envelope = JSON.parse(result.stdout) as CliEnvelope;
    } catch {
      envelope = {};
    }

    if (result.code === 10) {
      const found = findConfirmation(envelope);
      return {
        status: "confirmation_required",
        summary: "飞书要求确认高风险操作。",
        confirmation: confirmationFields(found),
        raw: envelope
      };
    }
    if (envelope.ok === true) {
      return {
        status: "completed",
        summary: successSummary(action, envelope),
        raw: envelope.data
      };
    }
    const detail = envelope.error?.message ?? result.stderr.trim() ?? `exit ${result.code}`;
    return {
      status: "failed",
      summary: `飞书操作失败：${detail}`,
      raw: envelope
    };
  }

  private async invoke(spec: Invocation): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.prefixArgs, ...spec.args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (part: string) => {
        stdout += part;
      });
      child.stderr.on("data", (part: string) => {
        stderr += part;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(spec.stdin ?? "", "utf8");
    });
  }
}
