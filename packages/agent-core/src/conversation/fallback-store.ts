import type { Conversation, ConversationStore, Message } from "./types.js";

/**
 * Writes to a primary store, and to a backup whenever the primary fails.
 *
 * Built after watching it matter: Docker stopped mid-session, Postgres went
 * away, and seven turns of a real conversation were dropped. The recorder
 * swallowed the errors so the call carried on — correct — but the transcript was
 * gone, and with it any chance of a follow-up. For a lead-capture system that's
 * the worst possible failure: the customer had the conversation and we lost it.
 *
 * Reads prefer the primary and fall back, so a conversation that landed in the
 * backup during an outage is still visible afterwards.
 */
export class FallbackConversationStore implements ConversationStore {
  readonly kind = "db" as const;

  constructor(
    private readonly primary: ConversationStore,
    private readonly backup: ConversationStore,
    private readonly onFallback: (err: unknown) => void = () => {},
  ) {}

  private async both<T>(
    primaryOp: (s: ConversationStore) => Promise<T>,
    backupOp: (s: ConversationStore) => Promise<T>,
  ): Promise<T> {
    try {
      return await primaryOp(this.primary);
    } catch (err) {
      this.onFallback(err);
      return backupOp(this.backup);
    }
  }

  async open(id: string, seed: Pick<Conversation, "industry" | "channel">): Promise<Conversation> {
    return this.both(
      (s) => s.open(id, seed),
      (s) => s.open(id, seed),
    );
  }

  async append(id: string, message: Message): Promise<void> {
    return this.both(
      (s) => s.append(id, message),
      async (s) => {
        // The backup may never have seen this conversation, so open it first —
        // append() on an unknown id throws in both implementations.
        await s.open(id, { industry: "unknown", channel: "chat" }).catch(() => {});
        await s.append(id, message);
      },
    );
  }

  async update(id: string, patch: Partial<Omit<Conversation, "id" | "messages">>): Promise<void> {
    return this.both(
      (s) => s.update(id, patch),
      async (s) => {
        await s.open(id, { industry: "unknown", channel: "chat" }).catch(() => {});
        await s.update(id, patch);
      },
    );
  }

  async get(id: string): Promise<Conversation | null> {
    try {
      return (await this.primary.get(id)) ?? (await this.backup.get(id));
    } catch (err) {
      this.onFallback(err);
      return this.backup.get(id);
    }
  }

  async recent(limit = 50): Promise<Conversation[]> {
    try {
      return await this.primary.recent(limit);
    } catch (err) {
      this.onFallback(err);
      return this.backup.recent(limit);
    }
  }
}
