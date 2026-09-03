import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const sandboxSchema = z.enum(["read-only", "workspace-write"]);

export const hubConfigSchema = z.object({
  schemaVersion: z.literal(6),
  feishu: z.object({
    domain: z.enum(["feishu", "lark"]).default("feishu"),
    ownerOpenId: z.string().min(1),
    allowedOpenIds: z.array(z.string().min(1)).default([]),
    allowedChatIds: z.array(z.string().min(1)).default([]),
    requireMentionInGroup: z.boolean().default(true)
  }),
  codex: z.object({
    command: z.string().min(1).default("codex"),
    backend: z.enum(["app-server", "exec"]).default("app-server"),
    sandbox: sandboxSchema.default("workspace-write"),
    model: z.string().min(1).optional(),
    timeoutMinutes: z.number().int().min(1).max(240).default(60)
  }),
  projects: z.object({
    cacheSeconds: z.number().int().min(5).max(300).default(30),
    pendingPromptMinutes: z.number().int().min(1).max(240).default(30)
  }),
  larkCli: z.object({
    enabled: z.boolean().default(true),
    command: z.string().min(1).default("lark-cli")
  }),
  notifications: z.object({
    enabled: z.boolean().default(true),
    maxAttempts: z.number().int().min(1).max(20).default(6),
    lifecycle: z
      .object({
        mode: z.enum(["off", "minimal", "smart", "all"]).default("all"),
        heartbeatSeconds: z.number().int().min(10).max(300).default(30)
      })
      .default({ mode: "all", heartbeatSeconds: 30 })
  }),
  presentation: z
    .object({
      cardsEnabled: z.boolean().default(true),
      reactionsEnabled: z.boolean().default(true),
      keepTerminalReaction: z.boolean().default(true)
    })
    .default({
      cardsEnabled: true,
      reactionsEnabled: true,
      keepTerminalReaction: true
    }),
  runtime: z.object({
    leaseSeconds: z.number().int().min(30).max(3600).default(180),
    shutdownGraceSeconds: z.number().int().min(5).max(300).default(30),
    logMaxMegabytes: z.number().int().min(1).max(100).default(10),
    logRetentionFiles: z.number().int().min(1).max(20).default(5),
    queueCoalesceMilliseconds: z.number().int().min(0).max(5_000).default(800),
    maxConcurrentTurns: z.number().int().min(1).max(8).default(1),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info")
  })
});

export type HubConfig = z.infer<typeof hubConfigSchema>;

export function defaultHome(): string {
  return process.env.LARK_CODEX_HUB_HOME
    ? resolve(process.env.LARK_CODEX_HUB_HOME)
    : resolve(homedir(), ".lark-codex-hub");
}

export function createDefaultConfig(
  ownerOpenId: string,
  _legacyWorkspaceRoot?: string
): HubConfig {
  return hubConfigSchema.parse({
    schemaVersion: 6,
    feishu: {
      domain: "feishu",
      ownerOpenId,
      allowedOpenIds: [],
      allowedChatIds: [],
      requireMentionInGroup: true
    },
    codex: {
      command: "codex",
      backend: "app-server",
      sandbox: "workspace-write",
      timeoutMinutes: 60
    },
    projects: {
      cacheSeconds: 30,
      pendingPromptMinutes: 30
    },
    larkCli: {
      enabled: true,
      command: "lark-cli"
    },
    notifications: {
      enabled: true,
      maxAttempts: 6,
      lifecycle: {
        mode: "all",
        heartbeatSeconds: 30
      }
    },
    presentation: {
      cardsEnabled: true,
      reactionsEnabled: true,
      keepTerminalReaction: true
    },
    runtime: {
      leaseSeconds: 180,
      shutdownGraceSeconds: 30,
      logMaxMegabytes: 10,
      logRetentionFiles: 5,
      queueCoalesceMilliseconds: 800,
      maxConcurrentTurns: 1,
      logLevel: "info"
    }
  });
}
