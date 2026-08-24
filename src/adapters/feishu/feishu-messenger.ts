import { createHash, randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  InboundCardAction,
  InboundMessage
} from "../../contracts/events.js";
import type { Messenger } from "../../ports/messenger.js";
import type { Logger } from "../../observability/logger.js";
import { errorMessage } from "../../observability/logger.js";

const textLimit = 18_000;

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

export class FeishuMessenger implements Messenger {
  private readonly channel: Lark.LarkChannel;
  private messageHandler: ((message: InboundMessage) => Promise<void>) | undefined;
  private cardActionHandler: ((action: InboundCardAction) => Promise<void>) | undefined;

  public constructor(
    appId: string,
    appSecret: string,
    domain: "feishu" | "lark",
    private readonly logger: Logger
  ) {
    const sdkLogger: Lark.Logger = {
      error: (...items: unknown[]) => this.logger.error("飞书 SDK 错误", { items }),
      warn: (...items: unknown[]) => this.logger.warn("飞书 SDK 警告", { items }),
      info: (...items: unknown[]) => this.logger.debug("飞书 SDK 信息", { items }),
      debug: (...items: unknown[]) => this.logger.debug("飞书 SDK 调试", { items }),
      trace: (...items: unknown[]) => this.logger.debug("飞书 SDK 跟踪", { items })
    };
    this.channel = Lark.createLarkChannel({
      appId,
      appSecret,
      domain: domain === "feishu" ? Lark.Domain.Feishu : Lark.Domain.Lark,
      transport: "websocket",
      logger: sdkLogger,
      source: "lark-codex-hub",
      includeRawEvent: true,
      handshakeTimeoutMs: 20_000,
      wsConfig: { pingTimeout: 10 },
      safety: {
        dedup: { ttl: 10 * 60_000, maxEntries: 20_000 },
        chatQueue: { enabled: true },
        staleMessageWindowMs: 10 * 60_000
      },
      policy: {
        dmMode: "open",
        requireMention: false,
        respondToMentionAll: false
      },
      outbound: {
        textChunkLimit: textLimit,
        retry: { maxAttempts: 3, baseDelayMs: 500 }
      }
    });
  }

  public async connect(
    messageHandler: (message: InboundMessage) => Promise<void>,
    cardActionHandler?: (action: InboundCardAction) => Promise<void>
  ): Promise<void> {
    this.messageHandler = messageHandler;
    this.cardActionHandler = cardActionHandler;
    this.channel.on("message", async (message) => {
      if (!this.messageHandler) {
        return;
      }
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
        receivedAt: Date.now()
      };
      try {
        await this.messageHandler(event);
      } catch (error) {
        this.logger.error("消息处理器发生未捕获错误", {
          eventId: event.eventId,
          error: errorMessage(error)
        });
      }
    });
    this.channel.on("cardAction", async (action) => {
      if (!this.cardActionHandler) {
        return;
      }
      await this.cardActionHandler({
        actionId: stableActionId(action),
        messageId: action.messageId,
        chatId: action.chatId,
        operatorOpenId: action.operator.openId,
        value: action.action.value,
        receivedAt: Date.now()
      });
    });
    this.channel.on("error", (error) => {
      this.logger.error("飞书通道错误", { error: error.message, code: error.code });
    });
    this.channel.on("reconnecting", () => this.logger.warn("飞书长连接正在重连"));
    this.channel.on("reconnected", () => this.logger.info("飞书长连接已恢复"));
    await this.channel.connect();
    this.logger.info("飞书长连接已就绪");
  }

  public async close(): Promise<void> {
    await this.channel.disconnect();
    this.messageHandler = undefined;
    this.cardActionHandler = undefined;
  }

  public async replyText(messageId: string, text: string): Promise<string | undefined> {
    let firstMessageId: string | undefined;
    for (const part of chunks(text || "（无文本结果）")) {
      const response = await this.channel.rawClient.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: part }),
          uuid: randomUUID()
        }
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`飞书回复失败：${response.msg ?? String(response.code)}`);
      }
      firstMessageId ??= response.data?.message_id;
    }
    return firstMessageId;
  }

  public async replyCard(messageId: string, card: object): Promise<string | undefined> {
    const response = await this.channel.rawClient.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        uuid: randomUUID()
      }
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`飞书卡片回复失败：${response.msg ?? String(response.code)}`);
    }
    return response.data?.message_id;
  }

  public async updateCard(messageId: string, card: object): Promise<void> {
    await this.channel.updateCard(messageId, card);
  }

  public async sendText(
    target: { type: "open_id" | "chat_id"; id: string },
    text: string
  ): Promise<string | undefined> {
    let firstMessageId: string | undefined;
    for (const part of chunks(text || "（无文本结果）")) {
      const response = await this.channel.rawClient.im.message.create({
        params: { receive_id_type: target.type },
        data: {
          receive_id: target.id,
          msg_type: "text",
          content: JSON.stringify({ text: part }),
          uuid: randomUUID()
        }
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`飞书发送失败：${response.msg ?? String(response.code)}`);
      }
      firstMessageId ??= response.data?.message_id;
    }
    return firstMessageId;
  }
}
