#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { FileConfigStore } from "../adapters/config/file-config.js";
import { createSecretVault } from "../adapters/secrets/create-vault.js";
import { openDatabase } from "../adapters/sqlite/database.js";
import { SqliteStateStore } from "../adapters/sqlite/state-store.js";
import {
  installScheduledTask,
  removeScheduledTask,
  scheduledTaskStatus,
  startScheduledTask
} from "../adapters/windows/scheduled-task.js";
import {
  createDefaultConfig,
  defaultHome
} from "../contracts/config.js";
import { startRuntime } from "../composition/runtime.js";
import { runDoctor } from "./doctor.js";
import { errorMessage } from "../observability/logger.js";
import { isPathInside } from "../domain/scope.js";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

async function stdinText(): Promise<string> {
  const values: Buffer[] = [];
  for await (const chunk of process.stdin) {
    values.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(values).toString("utf8");
}

async function setup(home: string): Promise<void> {
  let appId: string | undefined;
  let appSecret: string | undefined;
  let ownerOpenId: string | undefined;
  let workspace: string | undefined;
  let allowedRoots: string[] | undefined;

  if (hasFlag("--from-env")) {
    appId = process.env.LARK_APP_ID;
    appSecret = process.env.LARK_APP_SECRET;
    ownerOpenId = flag("--owner");
    workspace = flag("--workspace");
    const allowRoot = flag("--allow-root");
    allowedRoots = allowRoot ? [allowRoot] : undefined;
  } else if (hasFlag("--from-stdin")) {
    const input = JSON.parse(await stdinText()) as Record<string, unknown>;
    appId = typeof input.appId === "string" ? input.appId : undefined;
    appSecret = typeof input.appSecret === "string" ? input.appSecret : undefined;
    ownerOpenId = typeof input.ownerOpenId === "string" ? input.ownerOpenId : undefined;
    workspace = typeof input.workspace === "string" ? input.workspace : undefined;
    allowedRoots = Array.isArray(input.allowedRoots)
      ? input.allowedRoots.filter((item): item is string => typeof item === "string")
      : undefined;
  } else {
    throw new Error("setup 需要 --from-env 或 --from-stdin，避免在命令行中暴露密钥。");
  }

  if (!appId || !appSecret || !ownerOpenId || !workspace) {
    throw new Error("缺少 App ID、App Secret、ownerOpenId 或 workspace。");
  }
  const workspacePath = resolve(workspace);
  const config = createDefaultConfig(ownerOpenId, workspacePath);
  if (allowedRoots && allowedRoots.length > 0) {
    config.workspace.allowedRoots = allowedRoots.map((item) => resolve(item));
    const containsDefault = config.workspace.allowedRoots.some((root) =>
      isPathInside(workspacePath, root)
    );
    if (!containsDefault) {
      throw new Error("默认工作目录必须位于 --allow-root 范围内。");
    }
  }
  const vault = createSecretVault(home);
  if (process.env.LARK_APP_ID && process.env.LARK_APP_SECRET) {
    const savedAppId = process.env.LARK_APP_ID;
    const savedAppSecret = process.env.LARK_APP_SECRET;
    delete process.env.LARK_APP_ID;
    delete process.env.LARK_APP_SECRET;
    const persistentVault = createSecretVault(home);
    await persistentVault.set("feishu.app_id", savedAppId);
    await persistentVault.set("feishu.app_secret", savedAppSecret);
  } else {
    await vault.set("feishu.app_id", appId);
    await vault.set("feishu.app_secret", appSecret);
  }
  await new FileConfigStore(home).save(config);
  process.stdout.write(`配置完成。状态目录：${home}\n`);
}

async function start(home: string): Promise<void> {
  const runtime = await startRuntime(home);
  await new Promise<void>((resolveShutdown) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      void runtime.close().finally(resolveShutdown);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function doctor(home: string): Promise<void> {
  const checks = await runDoctor(home);
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}：${check.detail}\n`);
  }
  if (checks.some((check) => !check.ok && check.name !== "静默启动")) {
    process.exitCode = 1;
  }
}

async function status(home: string): Promise<void> {
  const config = await new FileConfigStore(home).load();
  const task = process.platform === "win32" ? await scheduledTaskStatus() : { installed: false };
  const database = openDatabase(join(home, "hub.sqlite"));
  const store = new SqliteStateStore(database);
  store.migrate();
  const health = store.health();
  store.close();
  process.stdout.write(
    `${JSON.stringify(
      {
        ownerOpenId: config.feishu.ownerOpenId,
        defaultWorkspace: config.workspace.defaultRoot,
        scheduledTask: task,
        database: health
      },
      null,
      2
    )}\n`
  );
}

async function service(home: string): Promise<void> {
  const action = args[1];
  if (action === "install") {
    const cliFile = fileURLToPath(import.meta.url);
    const installRoot = resolve(dirname(cliFile), "..", "..");
    await installScheduledTask({
      home,
      cliFile,
      installRoot,
      nodeExecutable: process.execPath
    });
    process.stdout.write("静默启动计划任务已安装，尚未启动。\n");
    return;
  }
  if (action === "remove") {
    await removeScheduledTask();
    process.stdout.write("静默启动计划任务已删除。\n");
    return;
  }
  if (action === "start") {
    await startScheduledTask();
    process.stdout.write("已请求启动计划任务。\n");
    return;
  }
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(await scheduledTaskStatus(), null, 2)}\n`);
    return;
  }
  throw new Error("用法：service install|remove|start|status");
}

async function notify(home: string): Promise<void> {
  const text = args.slice(1).join(" ").trim();
  if (!text) {
    throw new Error("notify 需要消息正文。");
  }
  const config = await new FileConfigStore(home).load();
  const store = new SqliteStateStore(openDatabase(join(home, "hub.sqlite")));
  store.migrate();
  store.enqueueOutbox(
    {
      idempotencyKey: randomUUID(),
      targetType: "open_id",
      targetId: config.feishu.ownerOpenId,
      text
    },
    Date.now()
  );
  store.close();
  process.stdout.write("主动通知已进入发送队列。\n");
}

function usage(): void {
  process.stdout.write(`Lark Codex Hub

用法：
  lark-codex-hub setup --from-env --owner <open_id> --workspace <目录> [--allow-root <根目录>]
  lark-codex-hub setup --from-stdin
  lark-codex-hub start
  lark-codex-hub doctor
  lark-codex-hub status
  lark-codex-hub notify <消息>
  lark-codex-hub service install|remove|start|status
`);
}

async function main(): Promise<void> {
  const command = args[0] ?? "help";
  const home = defaultHome();
  if (command === "setup") {
    await setup(home);
  } else if (command === "start") {
    await start(home);
  } else if (command === "doctor") {
    await doctor(home);
  } else if (command === "status") {
    await status(home);
  } else if (command === "service") {
    await service(home);
  } else if (command === "notify") {
    await notify(home);
  } else if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else {
    throw new Error(`未知命令：${command}`);
  }
}

void main().catch((error) => {
  process.stderr.write(`错误：${errorMessage(error)}\n`);
  process.exitCode = 1;
});
