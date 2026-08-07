import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, desc, eq, gte, or } from "drizzle-orm";
import postgres from "postgres";
import { bookings } from "../conversation/schema.js";
import type { Booking } from "./types.js";

/**
 * Our own index of bookings, keyed by the reference we read aloud.
 *
 * Needed because GoHighLevel has no "look up an appointment by arbitrary
 * reference" endpoint — it can create appointments and fetch them by its own id,
 * but a caller on the phone has our six-character code, not a GHL uuid. Without
 * this table the agent can take a booking and then never speak about it again,
 * which rules out "what have I got booked?", "cancel it", and "move it to
 * Saturday" — a large share of why people ring a hotel at all.
 *
 * Lookup by email or phone is here too, because "I don't have the reference on
 * me" is the normal case rather than the exception.
 */
export interface IndexedBooking {
  code: string;
  externalId?: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  contactId?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  details: Record<string, string>;
  replacedByCode?: string;
}

export class BookingIndex {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly db: PostgresJsDatabase;

  constructor(url = process.env.DATABASE_URL) {
    if (!url) throw new Error("DATABASE_URL not set — needed for BookingIndex");
    this.sql = postgres(url);
    this.db = drizzle(this.sql);
  }

  async record(
    booking: Booking,
    industry: string,
    now = new Date().toISOString(),
  ): Promise<void> {
    await this.db
      .insert(bookings)
      .values({
        code: booking.code,
        externalId: booking.externalId,
        resourceId: booking.resourceId,
        industry,
        startsAt: new Date(booking.start),
        endsAt: new Date(booking.end),
        status: booking.status,
        contactId: booking.contact.contactId,
        fullName: booking.contact.full_name,
        // Normalised so a caller who says their email differently still matches.
        email: booking.contact.email?.trim().toLowerCase(),
        phone: booking.contact.phone ? digits(booking.contact.phone) : undefined,
        details: booking.details,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .onConflictDoNothing();
  }

  async byCode(code: string): Promise<IndexedBooking | null> {
    const [row] = await this.db
      .select()
      .from(bookings)
      .where(eq(bookings.code, normaliseCode(code)))
      .limit(1);
    return row ? toIndexed(row) : null;
  }

  /**
   * Upcoming bookings for whoever this is. Past bookings are excluded — nobody
   * rings to cancel last month's dinner, and offering it would be confusing.
   */
  async byContact(
    contact: { email?: string; phone?: string },
    from = new Date(),
  ): Promise<IndexedBooking[]> {
    const clauses = [];
    if (contact.email?.trim()) clauses.push(eq(bookings.email, contact.email.trim().toLowerCase()));
    if (contact.phone?.trim()) clauses.push(eq(bookings.phone, digits(contact.phone)));
    if (!clauses.length) return [];

    const rows = await this.db
      .select()
      .from(bookings)
      .where(and(or(...clauses), gte(bookings.startsAt, from), eq(bookings.status, "confirmed")))
      .orderBy(desc(bookings.startsAt));
    return rows.map(toIndexed);
  }

  async markCancelled(code: string, now = new Date()): Promise<void> {
    await this.db
      .update(bookings)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(bookings.code, normaliseCode(code)));
  }

  /** Links the old booking to its replacement so the history stays readable. */
  async markReplaced(oldCode: string, newCode: string, now = new Date()): Promise<void> {
    await this.db
      .update(bookings)
      .set({ status: "cancelled", replacedByCode: newCode, updatedAt: now })
      .where(eq(bookings.code, normaliseCode(oldCode)));
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

/**
 * Codes get read aloud and typed back, so accept them loosely: any case, and
 * with the spaces or dashes people naturally add ("QY3 VD2").
 */
function normaliseCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/** Compare phone numbers by digits only — +1, dashes and spacing all vary. */
function digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

function toIndexed(row: typeof bookings.$inferSelect): IndexedBooking {
  return {
    code: row.code,
    externalId: row.externalId ?? undefined,
    resourceId: row.resourceId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    contactId: row.contactId ?? undefined,
    fullName: row.fullName ?? undefined,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    details: row.details,
    replacedByCode: row.replacedByCode ?? undefined,
  };
}
