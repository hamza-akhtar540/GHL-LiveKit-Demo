import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { desc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { conversations } from "./schema.js";
import type { Conversation, ConversationStore, Message } from "./types.js";

/**
 * Postgres-backed conversation store. Same interface as the file store, so the
 * worker and the email composer don't know which one they're talking to — the
 * choice is one line at construction.
 *
 * Timestamps are passed in by callers, same rule as the file store: the store
 * stays clock-free so tests are deterministic.
 */
export class PgConversationStore implements ConversationStore {
  readonly kind = "db" as const;

  private readonly sql: ReturnType<typeof postgres>;
  private readonly db: PostgresJsDatabase;

  constructor(url = process.env.DATABASE_URL) {
    if (!url) throw new Error("DATABASE_URL not set — needed for PgConversationStore");
    this.sql = postgres(url);
    this.db = drizzle(this.sql);
  }

  async open(
    id: string,
    seed: Pick<Conversation, "industry" | "channel">,
    now = new Date().toISOString(),
  ): Promise<Conversation> {
    const existing = await this.get(id);
    if (existing) return existing;

    // onConflictDoNothing so two racing opens don't error — either wins, the
    // row is identical.
    await this.db
      .insert(conversations)
      .values({
        id,
        industry: seed.industry,
        channel: seed.channel,
        contact: {},
        messages: [],
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .onConflictDoNothing();

    return (await this.get(id))!;
  }

  /**
   * Append one turn, atomically, in the database.
   *
   * This was read-modify-write: `get()` the row, spread the array, write the
   * whole thing back. Two concurrent appends both read the same array and the
   * second write silently discarded the first turn.
   *
   * `recorder.ts` works around that with a per-session promise chain, which
   * holds only while every append comes from one process. It stopped holding the
   * moment the admin console could reply to a conversation: that runs in the web
   * server, has no access to the recorder's chain, and can land mid-session
   * alongside the agent still recording turns.
   *
   * `messages = messages || $1::jsonb` pushes the concatenation into Postgres, so
   * the read and the write are one statement and concurrent appends serialise on
   * the row lock instead of racing. Strictly better for the agent too — it
   * removes a data-loss class the promise chain only narrowed.
   */
  async append(id: string, message: Message): Promise<void> {
    const [updated] = await this.db
      .update(conversations)
      .set({
        messages: sql`${conversations.messages} || ${JSON.stringify([message])}::jsonb`,
        // `greatest` so an out-of-order append cannot drag updatedAt backwards
        // and reshuffle the "most recent conversations" list.
        updatedAt: sql`greatest(${conversations.updatedAt}, ${new Date(message.at).toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, id))
      .returning({ id: conversations.id });

    // No row updated means no such conversation. Same contract as before, but
    // now established by the write itself rather than by a preceding read that
    // could go stale between the two statements.
    if (!updated) throw new Error(`No conversation ${id}; open() it first`);
  }

  async update(id: string, patch: Partial<Omit<Conversation, "id" | "messages">>): Promise<void> {
    const convo = await this.get(id);
    if (!convo) throw new Error(`No conversation ${id}; open() it first`);
    await this.db
      .update(conversations)
      .set({
        // Contact fields merge; later turns add without erasing earlier ones.
        contact: { ...convo.contact, ...(patch.contact ?? {}) },
        contactId: patch.contactId ?? convo.contactId,
        outcome: patch.outcome ?? convo.outcome,
        bookingCode: patch.bookingCode ?? convo.bookingCode,
        updatedAt: new Date(patch.updatedAt ?? new Date().toISOString()),
      })
      .where(eq(conversations.id, id));
  }

  async get(id: string): Promise<Conversation | null> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    return row ? this.toConversation(row) : null;
  }

  async recent(limit = 50): Promise<Conversation[]> {
    const rows = await this.db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(limit);
    return rows.map((r) => this.toConversation(r));
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  private toConversation(row: typeof conversations.$inferSelect): Conversation {
    return {
      id: row.id,
      industry: row.industry,
      channel: row.channel as Conversation["channel"],
      contactId: row.contactId ?? undefined,
      contact: row.contact,
      messages: row.messages as Message[],
      outcome: (row.outcome as Conversation["outcome"]) ?? undefined,
      bookingCode: row.bookingCode ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
