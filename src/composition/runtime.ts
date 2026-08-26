import { join } from "node:path";
import { FileConfigStore } from "../adapters/config/file-config.js";
import { CodexExecAgent } from "../adapters/codex/codex-exec-agent.js";
import { CodexAppServerAgent } from "../adapters/codex/codex-app-server-agent.js";
import { CodexProjectMetadataStore } from "../adapters/codex/codex-project-metadata.js";
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
import { CodexRunService } from "../application/codex-run-service.js";
import { ControlCenterService } from "../application/control-center-service.js";
import { LiveCardService } from "../application/live-card-service.js";
import { ProjectCatalogService } from "../application/project-catalog-service.js";
import { ProjectNavigationService } from "../application/project-navigation-service.js";
import { SessionCatalogService } from "../application/session-catalog-service.js";
import { TurnQueueService } from "../application/turn-queue-service.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { presentation } from "../application/presentation-factory.js";
import type { CodingAgent } from "../ports/coding-agent.js";

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
  const agent: CodingAgent = config.codex.backend === "exec"
    ? new CodexExecAgent(
        codexCommand.executable,
        logger,
        codexCommand.prefixArgs
      )
    : new CodexAppServerAgent(
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
  const liveCards = new LiveCardService(
    messenger,
    store,
    config.presentation.cardsEnabled,
    logger
  );
  const workspaces = new NodeWorkspaceResolver();
  const projectCatalog = new ProjectCatalogService(
    agent,
    workspaces,
    new CodexProjectMetadataStore(),
    config.projects.cacheSeconds * 1_000
  );
  const sessions = new SessionCatalogService(
    agent,
    store,
    projectCatalog
  );
  const navigation = new ProjectNavigationService(sessions, store);
  const codexRuns = new CodexRunService(
    config,
    agent,
    store,
    reactions,
    deliveries,
    workspaces,
    logger,
    liveCards
  );
  const turns = new TurnQueueService(
    store,
    codexRuns,
    agent,
    reactions,
    config.runtime.queueCoalesceMilliseconds,
    config.runtime.maxConcurrentTurns,
    logger
  );
  const controlCenter = new ControlCenterService(
    store,
    turns,
    sessions
  );
  const controller = new HubController(
    config,
    agent,
    actionBroker,
    store,
    reactions,
    deliveries,
    turns,
    sessions,
    navigation,
    controlCenter,
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
    logger,
    1
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
  turns.start();
  inbound.start();
  logger.info("Lark Codex Hub 已启动", {
    owner: config.feishu.ownerOpenId,
    codexBackend: config.codex.backend
  });

  let closed = false;
  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await inbound.stopAndDrain();
      turns.stopClaiming();
      await agent.shutdown(config.runtime.shutdownGraceSeconds * 1_000);
      await turns.stopAndDrain();
      await deliveries.stopAndDrain();
      liveCards.close();
      await messenger.close();
      logger.info("Lark Codex Hub 已停止");
      store.close();
    }
  };
}

export function runtimeLogger(home: string): Logger {
  return createLogger("info", join(home, "logs", "cli.log"));
}
