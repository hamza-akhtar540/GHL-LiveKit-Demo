import { pgTable, text, timestamp, jsonb, integer, boolean, index } from "drizzle-orm/pg-core";

/**
 * Three tables, each answering a different question:
 *
 *   lead_events     — have I already processed this submission?
 *   lead_identities — is this the same human as before, and which contact?
 *   lead_emails     — what did we compose, and has it actually been sent?
 */

/**
 * One row per submission. Ledger, audit trail and retry queue in one.
 *
 * `raw` is the most valuable column here: no real Meta or GHL payload has ever
 * been captured against this account, so every parser works from an assumed
 * shape. Keeping the original makes a wrong parser a fix-and-replay rather than
 * a lost lead.
 */
export const leadEvents = pgTable(
  "lead_events",
  {
    /** The submission id — `source:externalId`, or `source:c:<hash>`. */
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id"),
    identityKey: text("identity_key"),
    contactId: text("contact_id"),
    conversationId: text("conversation_id"),
    /** received | created | merged | duplicate | rejected | failed */
    status: text("status").notNull(),
    reason: text("reason"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    lead: jsonb("lead").$type<Record<string, unknown>>().notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    /** not_needed | pending | done | failed — Meta leads need a Graph fetch. */
    enrichment: text("enrichment").notNull().default("not_needed"),
    // Per-side-effect guards, so a retry resumes rather than repeating.
    tagsSynced: boolean("tags_synced").notNull().default(false),
    noteAdded: boolean("note_added").notNull().default(false),
    opportunityId: text("opportunity_id"),
    attempts: integer("attempts").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** How many times this exact submission was redelivered. */
    seenCount: integer("seen_count").notNull().default(1),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    byIdentity: index("lead_events_identity_idx").on(t.identityKey),
    byContact: index("lead_events_contact_idx").on(t.contactId),
    // The sweeper's query: unfinished rows not yet retried to death.
    byStatus: index("lead_events_status_idx").on(t.status, t.attempts),
    byReceived: index("lead_events_received_idx").on(t.receivedAt),
  }),
);

/**
 * Normalised identity → contact. A single lead usually writes TWO rows (email and
 * phone) pointing at the same contact, which is what lets someone who gave only a
 * phone this time merge with the record they created by email last week.
 */
export const leadIdentities = pgTable(
  "lead_identities",
  {
    /** `email:someone@example.com` or `phone:15125550177`. */
    key: text("key").primaryKey(),
    contactId: text("contact_id").notNull(),
    firstSource: text("first_source").notNull(),
    /** Every source this human has arrived through. Union, never replaced. */
    sources: jsonb("sources").$type<string[]>().notNull().default([]),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    conversationId: text("conversation_id"),
    lastLeadId: text("last_lead_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byContact: index("lead_identities_contact_idx").on(t.contactId),
  }),
);

/**
 * The composed follow-up, stored whether or not it was sent. This is what makes
 * the unverified-sending-domain situation survivable: everything is written and
 * reviewable, and sending is a separate decision.
 *
 * The primary key is the "one email per submission per trigger" guarantee. The
 * `contactId` index is the "never two first-touch sequences to one human" one.
 */
export const leadEmails = pgTable(
  "lead_emails",
  {
    /** `${leadId}:${trigger}` */
    id: text("id").primaryKey(),
    leadId: text("lead_id").notNull(),
    contactId: text("contact_id"),
    conversationId: text("conversation_id"),
    trigger: text("trigger").notNull(),
    recipient: text("recipient"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** composed | send_disabled | skipped_already_contacted | sent | failed */
    status: text("status").notNull(),
    reason: text("reason"),
    sendError: text("send_error"),
    ghlMessageId: text("ghl_message_id"),
    attempts: integer("attempts").notNull().default(0),
    composedAt: timestamp("composed_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => ({
    byContact: index("lead_emails_contact_idx").on(t.contactId),
    byStatus: index("lead_emails_status_idx").on(t.status),
  }),
);
