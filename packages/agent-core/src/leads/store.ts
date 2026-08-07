import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { leadEmails, leadEvents, leadIdentities } from "./schema.js";
import type { Lead } from "./types.js";

/**
 * Storage for lead ingestion, behind an interface so the whole pipeline is
 * testable without Postgres — same call as `BookingStore` and
 * `ConversationStore` elsewhere in this package.
 */

export interface ClaimResult {
  /** False when this exact submission has been handled before. */
  claimed: boolean;
  /** The existing row's state, when it wasn't claimed. */
  existing?: LeadEventRow;
}

export interface LeadEventRow {
  id: string;
  source: string;
  status: string;
  contactId?: string;
  conversationId?: string;
  identityKey?: string;
  tags: string[];
  tagsSynced: boolean;
  noteAdded: boolean;
  opportunityId?: string;
  enrichment: string;
  attempts: number;
}

export interface IdentityRow {
  key: string;
  contactId: string;
  sources: string[];
  tags: string[];
  createdAt: string;
}

export interface LeadStore {
  /**
   * Atomically take ownership of a submission. Returns `claimed: false` if
   * someone already has it — that is the idempotency barrier, and everything
   * after it is safe to retry.
   */
  claim(id: string, lead: Lead, raw?: Record<string, unknown>): Promise<ClaimResult>;
  update(id: string, patch: Partial<LeadEventRow> & { reason?: string; processed?: boolean }): Promise<void>;
  /** Identity rows for these keys, so a returning human is recognised. */
  findIdentities(keys: string[]): Promise<IdentityRow[]>;
  /** Upserts the identity, unioning sources and tags rather than replacing. */
  linkIdentity(
    key: string,
    contactId: string,
    source: string,
    tags: string[],
    leadId: string,
    conversationId?: string,
  ): Promise<void>;
  /** Has this human already had a first-touch email of this kind? */
  hasEmailForContact(contactId: string, trigger: string): Promise<boolean>;
  saveEmail(row: {
    id: string;
    leadId: string;
    contactId?: string;
    conversationId?: string;
    trigger: string;
    recipient?: string;
    subject: string;
    body: string;
    status: string;
    reason?: string;
  }): Promise<void>;
  markEmailSent(id: string, ghlMessageId?: string): Promise<void>;
  recent(limit?: number): Promise<LeadEventRow[]>;

  /**
   * Claim an unfinished lead for reprocessing, atomically.
   *
   * Returns null when the row is finished, already locked by someone else, or
   * has been retried to death. The lock is what stops a future sweeper and an
   * impatient operator working the same row at once — the same reason `claim()`
   * inserts-then-checks rather than reading first.
   */
  claimForRetry(id: string, staleAfterMs?: number): Promise<{ id: string; lead: Lead; attempts: number } | null>;
  releaseRetryLock(id: string): Promise<void>;
  /**
   * Ids the sweeper should attempt, oldest first. Reads only — each one is still
   * claimed individually, so two sweepers racing cannot double-process a row.
   */
  findRetryable(limit?: number): Promise<{ id: string; status: string; attempts: number; receivedAt: string }[]>;

  /**
   * The admin email queue. With autosend defaulting to `dry_run`, a follow-up is
   * composed for every lead and then never sent — so these rows are the normal
   * state of the system, not an error path, and an operator needs to read, send
   * and dismiss them by hand.
   */
  getEmail(id: string): Promise<LeadEmailRow | null>;
  markEmailFailed(id: string, error: string): Promise<void>;
  markEmailDiscarded(id: string, reason?: string): Promise<void>;
}

export interface LeadEmailRow {
  id: string;
  leadId: string;
  contactId: string | null;
  conversationId: string | null;
  trigger: string;
  recipient: string | null;
  subject: string;
  body: string;
  status: string;
  reason: string | null;
  sendError: string | null;
  ghlMessageId: string | null;
  attempts: number;
  composedAt: string;
  sentAt: string | null;
}

// ---------------------------------------------------------------------------

export class PgLeadStore implements LeadStore {
  private readonly sql?: ReturnType<typeof postgres>;
  private readonly db: PostgresJsDatabase;

  /**
   * Accepts an existing db handle so a process that already has one (the web
   * server holds pools for conversations and bookings too) doesn't open a third.
   */
  constructor(urlOrDb: string | PostgresJsDatabase | undefined = process.env.DATABASE_URL) {
    if (typeof urlOrDb === "string") {
      this.sql = postgres(urlOrDb);
      this.db = drizzle(this.sql);
    } else if (urlOrDb) {
      this.db = urlOrDb;
    } else {
      throw new Error("DATABASE_URL not set — needed for PgLeadStore");
    }
  }

  async claim(id: string, lead: Lead, raw?: Record<string, unknown>): Promise<ClaimResult> {
    const now = new Date();

    /**
     * Insert-then-check, NOT read-then-insert.
     *
     * Read-then-insert is what `pg-store.ts` does for conversations, and it's
     * correct there because the row is identical either way. Here it would be a
     * real bug: two simultaneous redeliveries would both read nothing, both
     * insert (one silently absorbed), and both go on to create a contact and
     * send an email. `returning()` coming back empty is an atomic "not mine".
     */
    const inserted = await this.db
      .insert(leadEvents)
      .values({
        id,
        source: lead.source,
        externalId: lead.externalId,
        status: "received",
        lead: lead as unknown as Record<string, unknown>,
        raw,
        enrichment: lead.source === "facebook_lead_ad" && !lead.email && !lead.phone
          ? "pending"
          : "not_needed",
        capturedAt: new Date(lead.capturedAt),
        receivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: leadEvents.id });

    if (inserted.length) return { claimed: true };

    // Someone else owns it. Count the redelivery so the volume is visible.
    await this.db
      .update(leadEvents)
      .set({ seenCount: sql`${leadEvents.seenCount} + 1` })
      .where(eq(leadEvents.id, id));

    const [existing] = await this.db.select().from(leadEvents).where(eq(leadEvents.id, id)).limit(1);
    return { claimed: false, existing: existing ? toEventRow(existing) : undefined };
  }

  async update(
    id: string,
    patch: Partial<LeadEventRow> & { reason?: string; processed?: boolean },
  ): Promise<void> {
    await this.db
      .update(leadEvents)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.contactId ? { contactId: patch.contactId } : {}),
        ...(patch.conversationId ? { conversationId: patch.conversationId } : {}),
        ...(patch.identityKey ? { identityKey: patch.identityKey } : {}),
        ...(patch.tags ? { tags: patch.tags } : {}),
        ...(patch.tagsSynced !== undefined ? { tagsSynced: patch.tagsSynced } : {}),
        ...(patch.noteAdded !== undefined ? { noteAdded: patch.noteAdded } : {}),
        ...(patch.opportunityId ? { opportunityId: patch.opportunityId } : {}),
        ...(patch.enrichment ? { enrichment: patch.enrichment } : {}),
        ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
        ...(patch.processed ? { processedAt: new Date() } : {}),
      })
      .where(eq(leadEvents.id, id));
  }

  async findIdentities(keys: string[]): Promise<IdentityRow[]> {
    if (!keys.length) return [];
    // `inArray`, not a hand-written `= ANY(...)` — the driver binds a JS array as
    // a scalar there, which fails with "op ANY/ALL requires array on right side".
    const rows = await this.db
      .select()
      .from(leadIdentities)
      .where(inArray(leadIdentities.key, keys));
    return rows.map((r) => ({
      key: r.key,
      contactId: r.contactId,
      sources: r.sources,
      tags: r.tags,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async linkIdentity(
    key: string,
    contactId: string,
    source: string,
    tags: string[],
    leadId: string,
    conversationId?: string,
  ): Promise<void> {
    const now = new Date();
    // Union on conflict, so a second source adds to the record instead of
    // overwriting the first one's attribution. Replay-safe by construction.
    await this.db
      .insert(leadIdentities)
      .values({
        key,
        contactId,
        firstSource: source,
        sources: [source],
        tags,
        conversationId,
        lastLeadId: leadId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: leadIdentities.key,
        set: {
          sources: sql`(
            select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
            from jsonb_array_elements_text(${leadIdentities.sources} || ${JSON.stringify([source])}::jsonb) as value
          )`,
          tags: sql`(
            select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
            from jsonb_array_elements_text(${leadIdentities.tags} || ${JSON.stringify(tags)}::jsonb) as value
          )`,
          lastLeadId: leadId,
          updatedAt: now,
        },
      });
  }

  async hasEmailForContact(contactId: string, trigger: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: leadEmails.id })
      .from(leadEmails)
      .where(
        and(
          eq(leadEmails.contactId, contactId),
          eq(leadEmails.trigger, trigger),
          eq(leadEmails.status, "sent"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async saveEmail(row: {
    id: string;
    leadId: string;
    contactId?: string;
    conversationId?: string;
    trigger: string;
    recipient?: string;
    subject: string;
    body: string;
    status: string;
    reason?: string;
  }): Promise<void> {
    await this.db
      .insert(leadEmails)
      .values({ ...row, composedAt: new Date() })
      .onConflictDoNothing();
  }

  async markEmailSent(id: string, ghlMessageId?: string): Promise<void> {
    await this.db
      .update(leadEmails)
      .set({ status: "sent", ghlMessageId, sentAt: new Date(), sendError: null })
      .where(eq(leadEmails.id, id));
  }

  async claimForRetry(
    id: string,
    staleAfterMs = 5 * 60_000,
  ): Promise<{ id: string; lead: Lead; attempts: number } | null> {
    const staleBefore = new Date(Date.now() - staleAfterMs);

    // One statement: the guard and the claim cannot drift apart, and two callers
    // racing for the same row serialise on it.
    const [claimed] = await this.db
      .update(leadEvents)
      .set({ lockedAt: new Date(), attempts: sql`${leadEvents.attempts} + 1` })
      .where(
        and(
          eq(leadEvents.id, id),
          inArray(leadEvents.status, ["received", "failed"]),
          sql`${leadEvents.attempts} < 6`,
          sql`(${leadEvents.lockedAt} is null or ${leadEvents.lockedAt} < ${staleBefore.toISOString()}::timestamptz)`,
        ),
      )
      .returning({ id: leadEvents.id, lead: leadEvents.lead, attempts: leadEvents.attempts });

    return claimed ? { id: claimed.id, lead: claimed.lead as unknown as Lead, attempts: claimed.attempts } : null;
  }

  async releaseRetryLock(id: string): Promise<void> {
    await this.db.update(leadEvents).set({ lockedAt: null }).where(eq(leadEvents.id, id));
  }

  /**
   * The query `lead_events_status_idx` was built for — the schema calls it
   * "the sweeper's query" and until now nothing ran it.
   *
   * `rejected` and `duplicate` are excluded deliberately: both are correct
   * terminal outcomes, not failures. Retrying a lead with no email or phone
   * would fail identically every time until it burned through its attempts.
   */
  async findRetryable(limit = 25): Promise<{ id: string; status: string; attempts: number; receivedAt: string }[]> {
    const rows = await this.db
      .select({
        id: leadEvents.id,
        status: leadEvents.status,
        attempts: leadEvents.attempts,
        receivedAt: leadEvents.receivedAt,
      })
      .from(leadEvents)
      .where(
        and(
          inArray(leadEvents.status, ["received", "failed"]),
          sql`${leadEvents.attempts} < 6`,
          sql`${leadEvents.processedAt} is null`,
        ),
      )
      .orderBy(leadEvents.receivedAt)
      .limit(limit);

    return rows.map((r) => ({ ...r, receivedAt: r.receivedAt.toISOString() }));
  }

  async getEmail(id: string): Promise<LeadEmailRow | null> {
    const [row] = await this.db.select().from(leadEmails).where(eq(leadEmails.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      leadId: row.leadId,
      contactId: row.contactId,
      conversationId: row.conversationId,
      trigger: row.trigger,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      status: row.status,
      reason: row.reason,
      sendError: row.sendError,
      ghlMessageId: row.ghlMessageId,
      attempts: row.attempts,
      composedAt: row.composedAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
    };
  }

  /**
   * `attempts` is incremented rather than overwritten so a repeatedly-failing
   * send is visible as such, instead of looking like a single fresh failure.
   */
  async markEmailFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(leadEmails)
      .set({ status: "failed", sendError: error.slice(0, 500), attempts: sql`${leadEmails.attempts} + 1` })
      .where(eq(leadEmails.id, id));
  }

  /**
   * Dismissed by a human. Kept rather than deleted: the composed copy is the
   * evidence of what the agent would have said, and `hasEmailForContact` needs
   * the row to stay put so a discarded first touch is not silently recomposed.
   */
  async markEmailDiscarded(id: string, reason?: string): Promise<void> {
    await this.db
      .update(leadEmails)
      .set({ status: "discarded", reason: reason ?? "discarded by an operator" })
      .where(eq(leadEmails.id, id));
  }

  async recent(limit = 25): Promise<LeadEventRow[]> {
    const rows = await this.db
      .select()
      .from(leadEvents)
      .orderBy(desc(leadEvents.receivedAt))
      .limit(limit);
    return rows.map(toEventRow);
  }

  async close(): Promise<void> {
    await this.sql?.end();
  }
}

function toEventRow(r: typeof leadEvents.$inferSelect): LeadEventRow {
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    contactId: r.contactId ?? undefined,
    conversationId: r.conversationId ?? undefined,
    identityKey: r.identityKey ?? undefined,
    tags: r.tags,
    tagsSynced: r.tagsSynced,
    noteAdded: r.noteAdded,
    opportunityId: r.opportunityId ?? undefined,
    enrichment: r.enrichment,
    attempts: r.attempts,
  };
}

// ---------------------------------------------------------------------------

/** In-memory equivalent, so the pipeline can be tested with nothing running. */
export class MemoryLeadStore implements LeadStore {
  private readonly events = new Map<string, LeadEventRow & { seenCount: number }>();
  /** The parsed lead, kept so `claimForRetry` can hand it back for reprocessing. */
  private readonly payloads = new Map<string, Lead>();
  private readonly identities = new Map<string, IdentityRow>();
  private readonly emails = new Map<string, LeadEmailRow>();

  async claim(id: string, lead: Lead): Promise<ClaimResult> {
    const existing = this.events.get(id);
    if (existing) {
      existing.seenCount += 1;
      return { claimed: false, existing };
    }
    this.events.set(id, {
      id,
      source: lead.source,
      status: "received",
      tags: [],
      tagsSynced: false,
      noteAdded: false,
      enrichment: "not_needed",
      attempts: 0,
      seenCount: 1,
    });
    this.payloads.set(id, lead);
    return { claimed: true };
  }

  async update(id: string, patch: Partial<LeadEventRow>): Promise<void> {
    const row = this.events.get(id);
    if (row) Object.assign(row, patch);
  }

  async findIdentities(keys: string[]): Promise<IdentityRow[]> {
    return keys.map((k) => this.identities.get(k)).filter((r): r is IdentityRow => !!r);
  }

  async linkIdentity(
    key: string,
    contactId: string,
    source: string,
    tags: string[],
  ): Promise<void> {
    const existing = this.identities.get(key);
    if (existing) {
      existing.sources = [...new Set([...existing.sources, source])];
      existing.tags = [...new Set([...existing.tags, ...tags])];
      return;
    }
    this.identities.set(key, {
      key,
      contactId,
      sources: [source],
      tags,
      createdAt: new Date().toISOString(),
    });
  }

  async hasEmailForContact(contactId: string, trigger: string): Promise<boolean> {
    return [...this.emails.values()].some(
      (e) => e.contactId === contactId && e.trigger === trigger && e.status === "sent",
    );
  }

  async saveEmail(row: {
    id: string;
    leadId?: string;
    contactId?: string;
    conversationId?: string;
    trigger: string;
    recipient?: string;
    subject?: string;
    body?: string;
    status: string;
    reason?: string;
  }): Promise<void> {
    if (this.emails.has(row.id)) return;
    this.emails.set(row.id, {
      id: row.id,
      leadId: row.leadId ?? "",
      contactId: row.contactId ?? null,
      conversationId: row.conversationId ?? null,
      trigger: row.trigger,
      recipient: row.recipient ?? null,
      subject: row.subject ?? "",
      body: row.body ?? "",
      status: row.status,
      reason: row.reason ?? null,
      sendError: null,
      ghlMessageId: null,
      attempts: 0,
      composedAt: new Date().toISOString(),
      sentAt: null,
    });
  }

  async markEmailSent(id: string, ghlMessageId?: string): Promise<void> {
    const e = this.emails.get(id);
    if (!e) return;
    e.status = "sent";
    e.ghlMessageId = ghlMessageId ?? null;
    e.sentAt = new Date().toISOString();
    e.sendError = null;
  }

  async claimForRetry(id: string): Promise<{ id: string; lead: Lead; attempts: number } | null> {
    const row = this.events.get(id);
    if (!row || !["received", "failed"].includes(row.status) || row.attempts >= 6) return null;
    row.attempts += 1;
    return { id, lead: this.payloads.get(id)!, attempts: row.attempts };
  }

  async releaseRetryLock(): Promise<void> {
    /* no lock to release in memory */
  }

  async findRetryable(limit = 25): Promise<{ id: string; status: string; attempts: number; receivedAt: string }[]> {
    return [...this.events.values()]
      .filter((e) => ["received", "failed"].includes(e.status) && e.attempts < 6)
      .slice(0, limit)
      .map((e) => ({ id: e.id, status: e.status, attempts: e.attempts, receivedAt: new Date().toISOString() }));
  }

  async getEmail(id: string): Promise<LeadEmailRow | null> {
    return this.emails.get(id) ?? null;
  }

  async markEmailFailed(id: string, error: string): Promise<void> {
    const e = this.emails.get(id);
    if (!e) return;
    e.status = "failed";
    e.sendError = error.slice(0, 500);
    e.attempts += 1;
  }

  async markEmailDiscarded(id: string, reason?: string): Promise<void> {
    const e = this.emails.get(id);
    if (!e) return;
    e.status = "discarded";
    e.reason = reason ?? "discarded by an operator";
  }

  async recent(limit = 25): Promise<LeadEventRow[]> {
    return [...this.events.values()].slice(-limit).reverse();
  }
}
