/**
 * The agent talks to this, never to GoHighLevel directly. Two implementations:
 * an in-memory one for demos and prompt tuning, and the GHL one once the
 * sub-account exists. Swapping them must not touch the prompt or the tools.
 */

export interface Slot {
  /** ISO 8601 with offset, in business-local time. */
  start: string;
  end: string;
  /** How the agent should say it: "Thursday at 2pm". */
  label: string;
}

export interface BookingRequest {
  resourceId: string;
  start: string;
  contact: Record<string, string>;
  /** Resource params plus whatever qualification collected. */
  details: Record<string, string>;
}

export interface Booking extends BookingRequest {
  /** Short, human-speakable. Read aloud over the phone, so no ambiguous chars. */
  code: string;
  status: "confirmed" | "cancelled";
  end: string;
  /** The provider's own id, when there is one. Absent for in-memory bookings. */
  externalId?: string;
}

export interface AvailabilityQuery {
  resourceId: string;
  /** ISO date (YYYY-MM-DD) in business-local time. */
  date: string;
  /** "morning" | "afternoon" | "evening", when the caller expressed one. */
  partOfDay?: string;
  /** Capacity needed, for resources where that matters. */
  partySize?: number;
  /**
   * How many slots to return. Defaults to 3 — deliberately tiny, because ten
   * times read aloud over the phone is unbearable. An admin picking a time out
   * of a day's availability needs the whole day, so the console passes a real
   * limit rather than the voice default.
   */
  limit?: number;
}

export interface BookingStore {
  /** Whether bookings land somewhere real. Surfaced at startup, not to callers. */
  readonly kind: "memory" | "ghl";
  findSlots(query: AvailabilityQuery): Promise<Slot[]>;
  create(request: BookingRequest): Promise<Booking>;
  find(code: string): Promise<Booking | null>;
  cancel(code: string): Promise<Booking | null>;

  /**
   * Optional because they need a lookup index, which not every backend has.
   * The tools check for them and tell the caller plainly when a capability is
   * missing, rather than pretending or failing silently.
   */

  /** For "I don't have my reference" — the common case, not the exception. */
  findByContact?(contact: { email?: string; phone?: string }): Promise<Booking[]>;
  /** Move a booking. Implementations must secure the new slot before releasing the old. */
  reschedule?(code: string, newStart: string): Promise<Booking | null>;
}
