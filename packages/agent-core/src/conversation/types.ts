/**
 * A conversation has to outlive the live session, or every follow-up email is a
 * generic template and the whole "we reference what you actually said" pitch is
 * gone. This is the store the worker writes turns into and the email composer
 * reads back from.
 *
 * Same shape of decision as BookingStore: an interface with a swappable
 * implementation. A JSON-file store is enough to build and demo against; a
 * client with real volume gets a Postgres/Drizzle implementation behind the
 * exact same interface, no caller changes.
 */

export type Channel = "voice" | "chat" | "email";

/**
 * Who produced a turn.
 *
 * `admin` is a human operator replying from the console, and it is a distinct
 * third speaker rather than a flavour of `agent`: the transcript exists so a
 * colleague can work out what actually happened, and showing a staff member's
 * words as the AI's — or, worse, as the customer's — makes it misleading rather
 * than merely imprecise. Anything rendering or summarising a transcript must
 * handle all three; see `speakerLabel` in `crm/sync.ts` and `roleClass` in the
 * dashboard.
 *
 * The database column is a free-form string, so widening this needed no
 * migration.
 */
export type Role = "caller" | "agent" | "admin";

export interface Message {
  role: Role;
  text: string;
  /** ISO 8601. Passed in, never generated here — see the store note. */
  at: string;
}

export type ConversationOutcome =
  | "booked"
  | "abandoned"
  | "enquiry_only"
  | "no_show"
  | "handed_off";

export interface Conversation {
  /** Stable id for the whole exchange, across channels and sessions. */
  id: string;
  industry: string;
  channel: Channel;
  /** GHL contact id once we know it; absent for an anonymous web visitor. */
  contactId?: string;
  /** Whatever we learned — name, phone, the qualification answers. */
  contact: Record<string, string>;
  messages: Message[];
  outcome?: ConversationOutcome;
  /** Booking reference, when one was made. */
  bookingCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationStore {
  readonly kind: "file" | "memory" | "db";
  /** Create or return the conversation for this id. */
  open(id: string, seed: Pick<Conversation, "industry" | "channel">): Promise<Conversation>;
  append(id: string, message: Message): Promise<void>;
  /** Merge in anything learned: contact fields, outcome, booking code, contactId. */
  update(id: string, patch: Partial<Omit<Conversation, "id" | "messages">>): Promise<void>;
  get(id: string): Promise<Conversation | null>;
  /** Most-recent-first, for building follow-up batches. */
  recent(limit?: number): Promise<Conversation[]>;
}
