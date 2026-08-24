import { join } from "node:path";
import { FileConfigStore } from "../adapters/config/file-config.js";
import { CodexExecAgent } from "../adapters/codex/codex-exec-agent.js";
import { FeishuMessenger } from "../adapters/feishu/feishu-messenger.js";
import { LarkCliActionBroker } from "../adapters/lark-cli/lark-cli-action-broker.js";
import { resolveCommand } from "../adapters/process/command-resolver.js";
import { createSecretVault } from "../adapters/secrets/create-vault.js";
import { openDatabase } from "../adapters/sqlite/database.js";
import { SqliteStateStore } from "../adapters/sqlite/state-store.js";
import { HubController } from "../application/hub-controller.js";
import { OutboxWorker } from "../application/outbox-worker.js";
import { createLogger, type Logger } from "../observability/logger.js";

export interface HubRuntime {
  close(): Promise<void>;
}

export async function startRuntime(home: string): Promise<HubRuntime> {
  const config = await new FileConfigStore(home).load();
  const vault = createSecretVault(home);
  const appId = await vault.get("feishu.app_id");
  const appSecret = await vault.get("feishu.app_secret");
  if (!appId || !appSecret) {
    throw new Error("未找到飞书 App ID/App Secret，请先执行 setup。");
  }

  const logger = createLogger(config.runtime.logLevel, join(home, "logs", "hub.log"));
  const database = openDatabase(join(home, "hub.sqlite"));
  const store = new SqliteStateStore(database);
  store.migrate();
  store.pruneInbox(Date.now() - 7 * 24 * 60 * 60 * 1_000);

  const messenger = new FeishuMessenger(
    appId,
    appSecret,
    config.feishu.domain,
    logger
  );
  const codexCommand = await resolveCommand(config.codex.command);
  const agent = new CodexExecAgent(
    codexCommand.executable,
    logger,
    codexCommand.prefixArgs
  );
  const larkCommand = config.larkCli.enabled
    ? await resolveCommand(config.larkCli.command)
    : undefined;
  const actionBroker = larkCommand
    ? new LarkCliActionBroker(larkCommand.executable, larkCommand.prefixArgs)
    : undefined;
  const controller = new HubController(
    config,
    messenger,
    agent,
    actionBroker,
    store,
    logger
  );
  const outbox = new OutboxWorker(
    store,
    messenger,
    config.notifications.maxAttempts,
    logger
  );

  await messenger.connect(
    (message) => controller.handle(message),
    (action) => controller.handleCardAction(action)
  );
  outbox.start();
  logger.info("Lark Codex Hub 已启动", {
    owner: config.feishu.ownerOpenId,
    workspace: config.workspace.defaultRoot
  });

  let closed = false;
  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      outbox.stop();
      await messenger.close();
      store.close();
      logger.info("Lark Codex Hub 已停止");
    }
  };
}

export function runtimeLogger(home: string): Logger {
  return createLogger("info", join(home, "logs", "cli.log"));
}
