#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
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
import { presentation } from "../application/presentation-factory.js";

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

  const sourceFromEnv = hasFlag("--from-env");
  if (sourceFromEnv) {
    appId = process.env.LARK_APP_ID;
    appSecret = process.env.LARK_APP_SECRET;
    ownerOpenId = flag("--owner");
  } else if (hasFlag("--from-stdin")) {
    const input = JSON.parse(await stdinText()) as Record<string, unknown>;
    appId = typeof input.appId === "string" ? input.appId : undefined;
    appSecret = typeof input.appSecret === "string" ? input.appSecret : undefined;
    ownerOpenId = typeof input.ownerOpenId === "string" ? input.ownerOpenId : undefined;
  } else {
    throw new Error("setup 需要 --from-env 或 --from-stdin，避免在命令行中暴露密钥。");
  }

  if (!appId || !appSecret || !ownerOpenId) {
    throw new Error("缺少 App ID、App Secret 或 ownerOpenId。");
  }
  const config = createDefaultConfig(ownerOpenId);
  delete process.env.LARK_APP_ID;
  delete process.env.LARK_APP_SECRET;
  const persistentVault = createSecretVault(home);
  await persistentVault.set("feishu.app_id", appId);
  await persistentVault.set("feishu.app_secret", appSecret);
  await new FileConfigStore(home).save(config);
  process.stdout.write(`配置完成。状态目录：${home}\n`);
}

async function start(home: string): Promise<void> {
  const runtime = await startRuntime(home);
  const stopRequest = join(home, "shutdown.request");
  await new Promise<void>((resolveShutdown) => {
    let stopping = false;
    let stopWatcher: NodeJS.Timeout;
    const shutdown = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      clearInterval(stopWatcher);
      void runtime.close().finally(resolveShutdown);
    };
    stopWatcher = setInterval(() => {
      void readFile(stopRequest, "utf8")
        .then(async () => {
          await rm(stopRequest, { force: true });
          shutdown();
        })
        .catch(() => undefined);
    }, 500);
    stopWatcher.unref();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function doctor(home: string): Promise<void> {
  const checks = await runDoctor(home);
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}：${check.detail}\n`);
  }
  if (checks.some((check) => !check.ok)) {
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
        configVersion: config.schemaVersion,
        projectSources: config.projects.sourceKinds,
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
    await stopService(home);
    await removeScheduledTask();
    process.stdout.write("静默启动计划任务已删除。\n");
    return;
  }
  if (action === "start") {
    await rm(join(home, "shutdown.request"), { force: true });
    await startScheduledTask();
    process.stdout.write("已请求启动计划任务。\n");
    return;
  }
  if (action === "stop") {
    await stopService(home);
    process.stdout.write("静默服务已停止。\n");
    return;
  }
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(await scheduledTaskStatus(), null, 2)}\n`);
    return;
  }
  throw new Error("用法：service install|remove|start|stop|status");
}

async function stopService(home: string): Promise<void> {
  const initial = await scheduledTaskStatus();
  if (!initial.installed || initial.state !== "Running") {
    await rm(join(home, "shutdown.request"), { force: true });
    return;
  }
  await writeFile(join(home, "shutdown.request"), `${Date.now()}\n`, "utf8");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
    const current = await scheduledTaskStatus();
    if (current.state !== "Running") {
      return;
    }
  }
  throw new Error("等待静默服务优雅停止超时，请检查 logs/hub.log。");
}

async function notify(home: string): Promise<void> {
  const text = args.slice(1).join(" ").trim();
  if (!text) {
    throw new Error("notify 需要消息正文。");
  }
  const config = await new FileConfigStore(home).load();
  if (!config.notifications.enabled) {
    throw new Error("主动通知已在配置中关闭。");
  }
  const store = new SqliteStateStore(openDatabase(join(home, "hub.sqlite")));
  store.migrate();
  store.enqueueDelivery(
    {
      idempotencyKey: randomUUID(),
      target: {
        kind: "send",
        type: "open_id",
        id: config.feishu.ownerOpenId
      },
      card: presentation(text, {
        title: "Codex 主动通知",
        kind: "notification",
        status: "新通知"
      })
    },
    Date.now()
  );
  store.close();
  process.stdout.write("主动通知已进入发送队列。\n");
}

function usage(): void {
  process.stdout.write(`Lark Codex Hub

用法：
  lark-codex-hub setup --from-env --owner <open_id>
  lark-codex-hub setup --from-stdin
  lark-codex-hub start
  lark-codex-hub doctor
  lark-codex-hub status
  lark-codex-hub notify <消息>
  lark-codex-hub service install|remove|start|stop|status
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
