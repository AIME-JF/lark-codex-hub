import type {
  InboundBotMenuAction,
  InboundCardAction,
  InboundMessage
} from "../contracts/events.js";
import type {
  PresentationCard,
  ReactionEmoji
} from "../contracts/presentation.js";

export interface Messenger {
  connect(
    messageHandler: (message: InboundMessage) => Promise<void>,
    cardActionHandler?: (action: InboundCardAction) => Promise<void>,
    botMenuHandler?: (action: InboundBotMenuAction) => Promise<void>
  ): Promise<void>;
  close(): Promise<void>;
  replyCard(
    messageId: string,
    card: PresentationCard,
    idempotencyKey?: string
  ): Promise<string | undefined>;
  sendCard(
    target: { type: "open_id" | "chat_id"; id: string },
    card: PresentationCard,
    idempotencyKey?: string
  ): Promise<string | undefined>;
  updateCard(messageId: string, card: PresentationCard): Promise<void>;
  addReaction(messageId: string, emoji: ReactionEmoji): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}
