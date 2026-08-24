import type {
  ReactionEmoji,
  TerminalReaction
} from "../contracts/presentation.js";
import type { Logger } from "../observability/logger.js";
import { errorMessage } from "../observability/logger.js";
import type { Messenger } from "../ports/messenger.js";
import type {
  ActiveReactionRecord,
  StateRepository
} from "../ports/state-repository.js";

const terminalEmoji: Record<TerminalReaction, ReactionEmoji> = {
  success: "DONE",
  error: "ERROR",
  cancelled: "CrossMark",
  waiting: "OneSecond"
};

export interface ReactionTracker {
  thinking(): Promise<void>;
  working(): Promise<void>;
  typing(): Promise<void>;
  finish(result: TerminalReaction): Promise<void>;
  abandon(): Promise<void>;
}

class MessageReactionTracker implements ReactionTracker {
  private current: ActiveReactionRecord | undefined;

  public constructor(
    private readonly trackerId: string,
    private readonly messageId: string,
    private readonly enabled: boolean,
    private readonly keepTerminalReaction: boolean,
    private readonly messenger: Messenger,
    private readonly store: StateRepository,
    private readonly logger: Logger
  ) {
    this.current = store.getActiveReaction(trackerId);
  }

  public async thinking(): Promise<void> {
    await this.transition("THINKING");
  }

  public async working(): Promise<void> {
    await this.transition("OnIt");
  }

  public async typing(): Promise<void> {
    await this.transition("Typing");
  }

  public async finish(result: TerminalReaction): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.removeCurrent();
    if (!this.keepTerminalReaction) {
      return;
    }
    try {
      await this.messenger.addReaction(this.messageId, terminalEmoji[result]!);
    } catch (error) {
      this.logger.warn("添加飞书终态表情失败", {
        trackerId: this.trackerId,
        result,
        error: errorMessage(error)
      });
    }
  }

  public async abandon(): Promise<void> {
    if (this.enabled) {
      await this.removeCurrent();
    }
  }

  private async transition(emoji: ReactionEmoji): Promise<void> {
    if (!this.enabled || this.current?.emoji === emoji) {
      return;
    }
    if (!(await this.removeCurrent())) {
      return;
    }
    try {
      const reactionId = await this.messenger.addReaction(this.messageId, emoji);
      this.current = {
        trackerId: this.trackerId,
        messageId: this.messageId,
        reactionId,
        emoji,
        updatedAt: Date.now()
      };
      this.store.saveActiveReaction(this.current);
    } catch (error) {
      this.logger.warn("添加飞书进度表情失败", {
        trackerId: this.trackerId,
        emoji,
        error: errorMessage(error)
      });
    }
  }

  private async removeCurrent(): Promise<boolean> {
    if (!this.current) {
      return true;
    }
    const current = this.current;
    try {
      await this.messenger.removeReaction(current.messageId, current.reactionId);
      this.store.clearActiveReaction(this.trackerId);
      this.current = undefined;
      return true;
    } catch (error) {
      this.logger.warn("清理飞书进度表情失败", {
        trackerId: this.trackerId,
        emoji: current.emoji,
        error: errorMessage(error)
      });
      return false;
    }
  }
}

export class ReactionProgressService {
  public constructor(
    private readonly messenger: Messenger,
    private readonly store: StateRepository,
    private readonly enabled: boolean,
    private readonly keepTerminalReaction: boolean,
    private readonly logger: Logger
  ) {}

  public track(trackerId: string, messageId: string): ReactionTracker {
    return new MessageReactionTracker(
      trackerId,
      messageId,
      this.enabled,
      this.keepTerminalReaction,
      this.messenger,
      this.store,
      this.logger
    );
  }

  public async recoverStale(): Promise<void> {
    for (const reaction of this.store.listActiveReactions()) {
      if (!this.enabled) {
        this.store.clearActiveReaction(reaction.trackerId);
        continue;
      }
      try {
        await this.messenger.removeReaction(reaction.messageId, reaction.reactionId);
        this.store.clearActiveReaction(reaction.trackerId);
      } catch (error) {
        this.logger.warn("恢复时清理遗留飞书表情失败", {
          trackerId: reaction.trackerId,
          emoji: reaction.emoji,
          error: errorMessage(error)
        });
      }
    }
  }
}
