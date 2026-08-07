import type { Conversation, ConversationStore, Role } from "./types.js";

/**
 * Records a live conversation as it happens, so it outlives the session and can
 * be followed up on later. Without this, every follow-up email is a template
 * and the whole "we reference what you actually said" pitch is gone.
 *
 * Transport-agnostic on purpose — the LiveKit worker feeds it turns from session
 * events, the email channel feeds it turns from webhook payloads. It knows
 * nothing about either.
 *
 * Writes are fire-and-forget and never throw at the caller. A failed transcript
 * write must not interrupt a live call; losing a follow-up email is bad, dropping
 * the customer mid-sentence is worse.
 */
export class ConversationRecorder {
  private opened = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: ConversationStore,
    private readonly id: string,
    private readonly seed: Pick<Conversation, "industry" | "channel">,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /**
   * Serialised through a promise chain rather than awaited by the caller. Turns
   * arrive faster than Postgres round-trips during a fast exchange, and
   * append() is read-modify-write — concurrent calls would lose messages.
   */
  private enqueue(work: () => Promise<unknown>): void {
    this.queue = this.queue.then(work).catch((err) => this.onError(err));
  }

  private async ensureOpen(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    await this.store.open(this.id, this.seed);
  }

  /** A turn from either side. Empty text is ignored — interim STT produces plenty. */
  record(role: Role, text: string, at = new Date().toISOString()): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.enqueue(async () => {
      await this.ensureOpen();
      await this.store.append(this.id, { role, text: trimmed, at });
    });
  }

  /** Anything learned mid-conversation: contact details, booking code, outcome. */
  patch(patch: Partial<Omit<Conversation, "id" | "messages">>): void {
    this.enqueue(async () => {
      await this.ensureOpen();
      await this.store.update(this.id, { ...patch, updatedAt: new Date().toISOString() });
    });
  }

  /**
   * Called at the end. If nothing set an outcome, infer one — a conversation with
   * no booking is exactly the abandoned lead the follow-up sequence exists for,
   * and it must not be left null or nothing will ever chase it.
   */
  async finish(): Promise<void> {
    this.enqueue(async () => {
      await this.ensureOpen();
      const convo = await this.store.get(this.id);
      if (!convo || convo.outcome) return;
      await this.store.update(this.id, {
        outcome: convo.bookingCode
          ? "booked"
          : convo.messages.some((m) => m.role === "caller")
            ? "abandoned"
            : "enquiry_only",
        updatedAt: new Date().toISOString(),
      });
    });
    // Only here do we wait — the session is closing and the queue must drain.
    await this.queue;
  }
}
