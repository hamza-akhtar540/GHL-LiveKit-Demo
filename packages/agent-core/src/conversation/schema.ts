import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Drizzle schema for conversation persistence. One row per conversation; the
 * turns live in a jsonb column rather than a child table, because we always
 * read and write the whole transcript at once (compose an email from all of
 * it) and never query inside it. A messages table would buy joins we never do.
 *
 * `id` is our own conversation id (room name, contact id), not a serial — the
 * worker knows it before the row exists.
 */
/**
 * Maps the short reference we read aloud ("QY3VD2") to the provider's own
 * appointment id, plus enough detail to talk about the booking without a second
 * API call.
 *
 * This exists because GoHighLevel has no "find an appointment by arbitrary
 * reference" endpoint. Without this table the agent can take a booking but can
 * never answer "what have I got booked?" or cancel it — which is half of what
 * people actually phone a hotel about.
 *
 * Also indexed by email and phone: "I don't have the reference on me" is the
 * common case, not the exception.
 */
export const bookings = pgTable(
  "bookings",
  {
    /** The reference given to the caller. Uppercase, unambiguous characters. */
    code: text("code").primaryKey(),
    /** GHL appointment id — what we actually cancel. */
    externalId: text("external_id"),
    resourceId: text("resource_id").notNull(),
    industry: text("industry").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("confirmed"),
    contactId: text("contact_id"),
    email: text("email"),
    phone: text("phone"),
    fullName: text("full_name"),
    details: jsonb("details").$type<Record<string, string>>().notNull().default({}),
    /** Set when a reschedule supersedes this booking, so history stays intact. */
    replacedByCode: text("replaced_by_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byEmail: index("bookings_email_idx").on(t.email),
    byPhone: index("bookings_phone_idx").on(t.phone),
    byStart: index("bookings_starts_idx").on(t.startsAt),
    /**
     * The Contact 360 join. Email and phone are the *caller's* lookup keys ("I
     * don't have my reference"); contact_id is the CRM's, and it is the only one
     * that is unambiguous — three live rows share a phone number and have no
     * email at all, and two people can share an address.
     */
    byContact: index("bookings_contact_idx").on(t.contactId),
  }),
);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    industry: text("industry").notNull(),
    channel: text("channel").notNull(),
    contactId: text("contact_id"),
    contact: jsonb("contact").$type<Record<string, string>>().notNull().default({}),
    messages: jsonb("messages")
      .$type<{ role: string; text: string; at: string }[]>()
      .notNull()
      .default([]),
    outcome: text("outcome"),
    bookingCode: text("booking_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    // recent() sorts by this; the index keeps follow-up batches cheap.
    byUpdated: index("conversations_updated_idx").on(t.updatedAt),
    byContact: index("conversations_contact_idx").on(t.contactId),
  }),
);
