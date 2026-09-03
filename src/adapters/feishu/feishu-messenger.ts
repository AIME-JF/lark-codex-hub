import { createHash, randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  InboundBotMenuAction,
  InboundCardAction,
  InboundMessage
} from "../../contracts/events.js";
import type {
  PresentationCard,
  ReactionEmoji
} from "../../contracts/presentation.js";
import type { Messenger } from "../../ports/messenger.js";
import type { ConnectionLifecycleEvent } from "../../contracts/lifecycle.js";
import type { Logger } from "../../observability/logger.js";
import { errorMessage } from "../../observability/logger.js";
import { renderCardParts } from "./card-renderer.js";

const textLimit = 18_000;

type FeishuUuid = `${string}-${string}-${string}-${string}-${string}`;

function stableUuid(key: string, part: string): FeishuUuid {
  const hex = createHash("sha256").update(`${key}:${part}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as FeishuUuid;
}

function isUnhandledEventWarning(items: readonly unknown[]): boolean {
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") {
      return /(?:^|\s)no .+ handle(?:\s|$)/iu.test(item);
    }
    if (Array.isArray(item)) {
      return item.some(visit);
    }
    if (item && typeof item === "object") {
      return Object.values(item as Record<string, unknown>).some(visit);
    }
    return false;
  };
  return items.some(visit);
}

function chunks(text: string): string[] {
  if (text.length <= textLimit) {
    return [text];
  }
  const values: string[] = [];
  for (let start = 0; start < text.length; start += textLimit) {
    values.push(text.slice(start, start + textLimit));
  }
  return values;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function rawEventId(raw: unknown): string | undefined {
  const root = object(raw);
  const header = object(root?.header);
  const event = object(root?.event);
  for (const value of [root?.event_id, header?.event_id, event?.event_id]) {
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function rawMessageLinks(raw: unknown): {
  parentMessageId?: string;
  rootMessageId?: string;
} {
  const root = object(raw);
  const event = object(root?.event) ?? root;
  const message = object(event?.message);
  const parentMessageId = message?.parent_id;
  const rootMessageId = message?.root_id;
  return {
    ...(typeof parentMessageId === "string" && parentMessageId
      ? { parentMessageId }
      : {}),
    ...(typeof rootMessageId === "string" && rootMessageId
      ? { rootMessageId }
      : {})
  };
}

function stableActionId(action: Lark.CardActionEvent): string {
  const explicit = rawEventId(action.raw);
  if (explicit) {
    return `card:${explicit}`;
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        messageId: action.messageId,
        operator: action.operator.openId,
        value: action.action.value
      })
    )
    .digest("hex");
  return `card:${digest}`;
}

function normalizeBotMenuAction(raw: unknown): InboundBotMenuAction | undefined {
  const root = object(raw);
  const event = object(root?.event) ?? root;
  const operator = object(event?.operator);
  const operatorId = object(operator?.operator_id);
  const operatorOpenId = operatorId?.open_id;
  const eventKey = event?.event_key;
  if (typeof operatorOpenId !== "string" || typeof eventKey !== "string") {
    return undefined;
  }
  const eventId = rawEventId(raw) ?? `menu:${operatorOpenId}:${eventKey}:${String(event?.timestamp ?? "")}`;
  return {
    eventId,
    operatorOpenId,
    eventKey,
    receivedAt: Date.now()
  };
}

export class FeishuMessenger implements Messenger {
  private readonly client: Lark.Client;
  private readonly sdkLogger: Lark.Logger;
  private readonly domain: Lark.Domain;
  private wsClient: Lark.WSClient | undefined;
  private messageHandler: ((message: InboundMessage) => Promise<void>) | undefined;
  private cardActionHandler: ((action: InboundCardAction) => Promise<void>) | undefined;
  private botMenuHandler: ((action: InboundBotMenuAction) => Promise<void>) | undefined;
  private lifecycleHandler: ((event: ConnectionLifecycleEvent) => Promise<void>) | undefined;
  private reconnectingAt: number | undefined;

  public constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    domain: "feishu" | "lark",
    private readonly cardsEnabled: boolean,
    private readonly logger: Logger
  ) {
    this.sdkLogger = {
      error: (...items: unknown[]) => this.logger.error("飞书 SDK 错误", { items }),
      warn: (...items: unknown[]) =>
        isUnhandledEventWarning(items)
          ? this.logger.debug("飞书 SDK 忽略未订阅事件", { items })
          : this.logger.warn("飞书 SDK 警告", { items }),
      info: (...items: unknown[]) => this.logger.debug("飞书 SDK 信息", { items }),
      debug: (...items: unknown[]) => this.logger.debug("飞书 SDK 调试", { items }),
      trace: (...items: unknown[]) => this.logger.debug("飞书 SDK 跟踪", { items })
    };
    this.domain = domain === "feishu" ? Lark.Domain.Feishu : Lark.Domain.Lark;
    this.client = new Lark.Client({
      appId,
      appSecret,
      domain: this.domain,
      logger: this.sdkLogger,
      source: "lark-codex-hub"
    });
  }

  public async connect(
    messageHandler: (message: InboundMessage) => Promise<void>,
    cardActionHandler?: (action: InboundCardAction) => Promise<void>,
    botMenuHandler?: (action: InboundBotMenuAction) => Promise<void>,
    lifecycleHandler?: (event: ConnectionLifecycleEvent) => Promise<void>
  ): Promise<void> {
    this.messageHandler = messageHandler;
    this.cardActionHandler = cardActionHandler;
    this.botMenuHandler = botMenuHandler;
    this.lifecycleHandler = lifecycleHandler;

    const botResponse = await this.client.request({
      url: "/open-apis/bot/v3/info",
      method: "GET"
    });
    const bot = object(object(botResponse)?.bot);
    const botOpenId = bot?.open_id;
    if (typeof botOpenId !== "string") {
      throw new Error("无法读取飞书机器人 open_id。");
    }

    const dispatcher = new Lark.EventDispatcher({ logger: this.sdkLogger }).register({
      "im.message.receive_v1": async (raw) => {
        if (!this.messageHandler) {
          return;
        }
        try {
          const message = await Lark.normalize(raw as Lark.RawMessageEvent, {
            botIdentity: {
              openId: botOpenId,
              name: typeof bot?.app_name === "string" ? bot.app_name : "bot"
            },
            stripBotMentions: true,
            includeRaw: true
          });
          const event: InboundMessage = {
            eventId:
              rawEventId(message.raw) ??
              `message:${message.messageId}:${String(message.createTime)}`,
            messageId: message.messageId,
            chatId: message.chatId,
            chatKind: message.chatType,
            senderOpenId: message.senderId,
            text: message.content.trim(),
            mentioned: message.mentionedBot,
            ...rawMessageLinks(message.raw),
            receivedAt: Date.now()
          };
          await this.messageHandler(event);
        } catch (error) {
          this.logger.error("消息处理器发生未捕获错误", { error: errorMessage(error) });
        }
      },
      "card.action.trigger": async (raw: Lark.RawCardActionEvent) => {
        if (!this.cardActionHandler) {
          return;
        }
        const action = Lark.normalizeCardAction(raw, { includeRaw: true });
        if (!action) {
          return;
        }
        try {
          await this.cardActionHandler({
            actionId: stableActionId(action),
            messageId: action.messageId,
            chatId: action.chatId,
            operatorOpenId: action.operator.openId,
            value: action.action.value,
            receivedAt: Date.now()
          });
        } catch (error) {
          this.logger.error("卡片处理器发生未捕获错误", {
            actionId: stableActionId(action),
            error: errorMessage(error)
          });
        }
      },
      "application.bot.menu_v6": async (raw) => {
        if (!this.botMenuHandler) {
          return;
        }
        const action = normalizeBotMenuAction(raw);
        if (!action) {
          this.logger.warn("忽略字段不完整的机器人菜单事件");
          return;
        }
        try {
          await this.botMenuHandler(action);
        } catch (error) {
          this.logger.error("菜单处理器发生未捕获错误", {
            eventId: action.eventId,
            error: errorMessage(error)
          });
        }
      }
    });

    await new Promise<void>((resolveConnection, rejectConnection) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectConnection(new Error("飞书 WebSocket 握手超时。"));
        }
      }, 20_000);
      this.wsClient = new Lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain: this.domain,
        logger: this.sdkLogger,
        autoReconnect: true,
        source: "lark-codex-hub",
        wsConfig: { pingTimeout: 10 },
        handshakeTimeoutMs: 20_000,
        onReady: () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolveConnection();
          }
        },
        onError: (error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            rejectConnection(error);
          } else {
            this.logger.error("飞书通道错误", { error: error.message });
          }
        },
        onReconnecting: () => {
          this.reconnectingAt ??= Date.now();
          this.logger.warn("飞书长连接正在重连");
          void this.lifecycleHandler?.({
            type: "reconnecting",
            at: this.reconnectingAt
          })?.catch((error: unknown) => {
            this.logger.warn("飞书重连状态回调失败", { error: errorMessage(error) });
          });
        },
        onReconnected: () => {
          const at = Date.now();
          const disconnectedAt = this.reconnectingAt;
          this.reconnectingAt = undefined;
          this.logger.info("飞书长连接已恢复");
          void this.lifecycleHandler?.({
            type: "reconnected",
            at,
            ...(disconnectedAt
              ? { disconnectedAt, durationMs: at - disconnectedAt }
              : {})
          })?.catch((error: unknown) => {
            this.logger.warn("飞书恢复状态回调失败", { error: errorMessage(error) });
          });
        }
      });
      void this.wsClient.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          rejectConnection(error);
        } else {
          this.logger.error("飞书长连接异常结束", { error: errorMessage(error) });
        }
      });
    });
    this.logger.info("飞书长连接已就绪");
  }

  public async close(): Promise<void> {
    this.wsClient?.close({});
    this.wsClient = undefined;
    this.messageHandler = undefined;
    this.cardActionHandler = undefined;
    this.botMenuHandler = undefined;
    this.lifecycleHandler = undefined;
    this.reconnectingAt = undefined;
  }

  private async replyText(
    messageId: string,
    text: string,
    idempotencyKey = randomUUID()
  ): Promise<string | undefined> {
    let firstMessageId: string | undefined;
    for (const [index, part] of chunks(text || "（无文本结果）").entries()) {
      const response = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: part }),
          uuid: stableUuid(idempotencyKey, `text:${index}`)
        }
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`飞书回复失败：${response.msg ?? String(response.code)}`);
      }
      firstMessageId ??= response.data?.message_id;
    }
    return firstMessageId;
  }

  public async replyCard(
    messageId: string,
    presentation: PresentationCard,
    idempotencyKey = randomUUID()
  ): Promise<string | undefined> {
    let firstMessageId: string | undefined;
    for (const [index, part] of renderCardParts(presentation).entries()) {
      if (!this.cardsEnabled) {
        const fallbackMessageId = await this.replyText(
          messageId,
          part.fallbackText,
          stableUuid(idempotencyKey, `fallback:${index}`)
        );
        firstMessageId ??= fallbackMessageId;
        continue;
      }
      try {
        const response = await this.client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "interactive",
            content: JSON.stringify(part.card),
            uuid: stableUuid(idempotencyKey, `card:${index}`)
          }
        });
        if (response.code !== undefined && response.code !== 0) {
          throw new Error(`飞书卡片回复失败：${response.msg ?? String(response.code)}`);
        }
        firstMessageId ??= response.data?.message_id;
      } catch (error) {
        this.logger.warn("飞书卡片回复失败，降级为文本", { error: errorMessage(error) });
        const fallbackMessageId = await this.replyText(
          messageId,
          part.fallbackText,
          stableUuid(idempotencyKey, `fallback:${index}`)
        );
        firstMessageId ??= fallbackMessageId;
      }
    }
    return firstMessageId;
  }

  public async replyLiveCard(
    messageId: string,
    presentation: PresentationCard,
    idempotencyKey: string
  ): Promise<string | undefined> {
    if (!this.cardsEnabled) {
      return undefined;
    }
    const part = renderCardParts(presentation)[0];
    if (!part) {
      return undefined;
    }
    const response = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(part.card),
        uuid: stableUuid(idempotencyKey, "live-card")
      }
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`飞书实时卡片回复失败：${response.msg ?? String(response.code)}`);
    }
    return response.data?.message_id;
  }

  public async updateCard(messageId: string, presentation: PresentationCard): Promise<void> {
    const part = renderCardParts(presentation)[0];
    if (!part) {
      throw new Error("飞书卡片更新失败：没有可渲染内容");
    }
    const response = await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(part.card) }
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`飞书卡片更新失败：${response.msg ?? String(response.code)}`);
    }
  }

  private async sendText(
    target: { type: "open_id" | "chat_id"; id: string },
    text: string,
    idempotencyKey = randomUUID()
  ): Promise<string | undefined> {
    let firstMessageId: string | undefined;
    for (const [index, part] of chunks(text || "（无文本结果）").entries()) {
      const response = await this.client.im.message.create({
        params: { receive_id_type: target.type },
        data: {
          receive_id: target.id,
          msg_type: "text",
          content: JSON.stringify({ text: part }),
          uuid: stableUuid(idempotencyKey, `text:${index}`)
        }
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`飞书发送失败：${response.msg ?? String(response.code)}`);
      }
      firstMessageId ??= response.data?.message_id;
    }
    return firstMessageId;
  }

  public async sendCard(
    target: { type: "open_id" | "chat_id"; id: string },
    presentation: PresentationCard,
    idempotencyKey: string = randomUUID()
  ): Promise<string | undefined> {
    let firstMessageId: string | undefined;
    for (const [index, part] of renderCardParts(presentation).entries()) {
      if (!this.cardsEnabled) {
        const fallbackMessageId = await this.sendText(
          target,
          part.fallbackText,
          stableUuid(idempotencyKey, `fallback:${index}`)
        );
        firstMessageId ??= fallbackMessageId;
        continue;
      }
      try {
        const response = await this.client.im.message.create({
          params: { receive_id_type: target.type },
          data: {
            receive_id: target.id,
            msg_type: "interactive",
            content: JSON.stringify(part.card),
            uuid: stableUuid(idempotencyKey, `card:${index}`)
          }
        });
        if (response.code !== undefined && response.code !== 0) {
          throw new Error(`飞书卡片发送失败：${response.msg ?? String(response.code)}`);
        }
        firstMessageId ??= response.data?.message_id;
      } catch (error) {
        this.logger.warn("飞书卡片发送失败，降级为文本", { error: errorMessage(error) });
        const fallbackMessageId = await this.sendText(
          target,
          part.fallbackText,
          stableUuid(idempotencyKey, `fallback:${index}`)
        );
        firstMessageId ??= fallbackMessageId;
      }
    }
    return firstMessageId;
  }

  public async addReaction(messageId: string, emoji: ReactionEmoji): Promise<string> {
    const response = await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } }
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`飞书表情添加失败：${response.msg ?? String(response.code)}`);
    }
    const reactionId = response.data?.reaction_id;
    if (!reactionId) {
      throw new Error("飞书表情添加失败：响应中缺少 reaction_id");
    }
    return reactionId;
  }

  public async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const response = await this.client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId }
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`飞书表情删除失败：${response.msg ?? String(response.code)}`);
    }
  }
}
