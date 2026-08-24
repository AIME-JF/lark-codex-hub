import type { InboundCardAction, InboundMessage } from "../contracts/events.js";

export interface Messenger {
  connect(
    messageHandler: (message: InboundMessage) => Promise<void>,
    cardActionHandler?: (action: InboundCardAction) => Promise<void>
  ): Promise<void>;
  close(): Promise<void>;
  replyText(messageId: string, text: string): Promise<string | undefined>;
  sendText(target: { type: "open_id" | "chat_id"; id: string }, text: string): Promise<string | undefined>;
  replyCard(messageId: string, card: object): Promise<string | undefined>;
  updateCard(messageId: string, card: object): Promise<void>;
}
