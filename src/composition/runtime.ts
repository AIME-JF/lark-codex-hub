import { join } from "node:path";
import { FileConfigStore } from "../adapters/config/file-config.js";
import { CodexExecAgent } from "../adapters/codex/codex-exec-agent.js";
import { FeishuMessenger } from "../adapters/feishu/feishu-messenger.js";
import { LarkCliActionBroker } from "../adapters/lark-cli/lark-cli-action-broker.js";
import { NodeWorkspaceResolver } from "../adapters/fs/node-workspace-resolver.js";
import { resolveCommand } from "../adapters/process/command-resolver.js";
import { createSecretVault } from "../adapters/secrets/create-vault.js";
import { openDatabase } from "../adapters/sqlite/database.js";
import { SqliteStateStore } from "../adapters/sqlite/state-store.js";
import { HubController } from "../application/hub-controller.js";
import { DeliveryWorker } from "../application/delivery-worker.js";
import { InboundWorker } from "../application/inbound-worker.js";
import { RecoveryService } from "../application/recovery-service.js";
import { ReactionProgressService } from "../application/reaction-progress.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { presentation } from "../application/presentation-factory.js";

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

  const logger = createLogger(
    config.runtime.logLevel,
    join(home, "logs", "hub.log"),
    {
      console: process.env.LARK_CODEX_HUB_SERVICE !== "1",
      maxBytes: config.runtime.logMaxMegabytes * 1024 * 1024,
      retentionFiles: config.runtime.logRetentionFiles
    }
  );
  const database = openDatabase(join(home, "hub.sqlite"));
  const store = new SqliteStateStore(database);
  store.migrate();
  store.pruneInbox(Date.now() - 7 * 24 * 60 * 60 * 1_000);

  const messenger = new FeishuMessenger(
    appId,
    appSecret,
    config.feishu.domain,
    config.presentation.cardsEnabled,
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
  const reactions = new ReactionProgressService(
    messenger,
    store,
    config.presentation.reactionsEnabled,
    config.presentation.keepTerminalReaction,
    logger
  );
  const deliveries = new DeliveryWorker(
    store,
    messenger,
    reactions,
    config.notifications.maxAttempts,
    logger
  );
  const workspaces = new NodeWorkspaceResolver();
  await workspaces.resolveAllowed(
    config.workspace.defaultRoot,
    config.workspace.defaultRoot,
    config.workspace.allowedRoots
  );
  const controller = new HubController(
    config,
    agent,
    actionBroker,
    store,
    reactions,
    deliveries,
    workspaces,
    logger
  );
  const inbound = new InboundWorker(
    store,
    {
      message: (message) => controller.handle(message),
      cardAction: (action) => controller.handleCardAction(action),
      botMenu: (action) => controller.handleBotMenu(action)
    },
    config.runtime.leaseSeconds * 1_000,
    logger
  );

  await messenger.connect(
    async (message) => inbound.submitMessage(message),
    async (action) => inbound.submitCardAction(action),
    async (action) => inbound.submitBotMenu(action)
  );
  await new RecoveryService(
    store,
    deliveries,
    reactions,
    config.feishu.ownerOpenId,
    logger
  ).recover();
  for (const item of store.nextOutbox(Number.MAX_SAFE_INTEGER, 1_000)) {
    deliveries.enqueueSend(
      { type: item.targetType, id: item.targetId },
      presentation(item.text, {
        title: "Codex 主动通知",
        kind: "notification",
        status: "新通知"
      }),
      { idempotencyKey: `legacy:${item.idempotencyKey}` }
    );
    store.completeOutbox(item.id);
  }
  deliveries.start();
  inbound.start();
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
      await messenger.close();
      await Promise.all([
        agent.shutdown(config.runtime.shutdownGraceSeconds * 1_000),
        inbound.stopAndDrain()
      ]);
      await deliveries.stopAndDrain();
      logger.info("Lark Codex Hub 已停止");
      store.close();
    }
  };
}

export function runtimeLogger(home: string): Logger {
  return createLogger("info", join(home, "logs", "cli.log"));
}
