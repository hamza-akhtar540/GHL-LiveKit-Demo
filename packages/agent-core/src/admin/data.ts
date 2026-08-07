import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { asc, desc, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { GhlClient } from "../ghl/client.js";
import { paths } from "../ghl/endpoints.js";
import { conversations as conversationsTable } from "../conversation/schema.js";
import { bookings as bookingsTable } from "../conversation/schema.js";
import { leadEvents, leadEmails } from "../leads/schema.js";
import { socialPosts } from "../social/schema.js";
import { SocialClient } from "../social/client.js";
import { SocialStore } from "../social/store.js";
import { calendarIdFor } from "../env.js";
import type { IndustryConfig } from "../industries/types.js";

/** GHL's calendar wire shape, mapped immediately. */
interface RawCalendar {
  id?: string;
  name?: string;
  isActive?: boolean;
  calendarType?: string;
  slotDuration?: number;
  appointmentPerSlot?: number | string;
  allowReschedule?: boolean;
  allowCancellation?: boolean;
}

/** GHL's calendar-event wire shape. */
interface RawEvent {
  id?: string;
  calendarId?: string;
  contactId?: string;
  title?: string;
  appointmentStatus?: string;
  /** GHL really does ship this misspelling alongside the correct one. */
  appoinmentStatus?: string;
  startTime?: string;
  endTime?: string;
  dateAdded?: string;
  dateUpdated?: string;
  deleted?: boolean;
}

/** Someone waiting on a human, from either side of the system. */
export interface NeedsHumanEntry {
  source: "conversation" | "crm-tag";
  conversationId: string | null;
  contactId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  channel: string;
  lastMessage: string | null;
  at: string;
  tags: string[];
}

export type AdminCalendar = {
  id: string;
  name: string;
  isActive: boolean;
  calendarType?: string;
  slotDuration?: number;
  appointmentPerSlot: number;
  allowReschedule: boolean;
  allowCancellation: boolean;
  resourceId?: string;
};

/**
 * GHL titles appointments "a table at Halcyon — Ayesha Khan". For a GHL-only row
 * that is the only name we have, so take the part after the em dash. Returns null
 * rather than a misleading fragment when the format differs.
 */
function titleName(title?: string): string | null {
  if (!title) return null;
  const parts = title.split("—");
  return parts.length > 1 ? parts.slice(1).join("—").trim() || null : null;
}

/**
 * Everything the admin dashboard reads, in one place.
 *
 * Two different sources, and the split is deliberate: our own Postgres tables
 * are the record of what the AGENT did (transcripts, bookings we made, leads we
 * captured). GHL is asked live for CONTACTS and OPPORTUNITIES because those are
 * shared with whatever else touches the CRM — a human editing a contact in the
 * GHL UI must show up here without us needing to sync anything.
 *
 * Nothing here writes. This is read-only by construction — there is no method
 * on this class that calls a GHL POST/PUT/DELETE.
 */
export class AdminData {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly db: PostgresJsDatabase;
  private readonly ghl: GhlClient;
  private readonly socialClient: SocialClient;
  private readonly socialStore: SocialStore;

  /** Pipeline stage id -> name, fetched once and reused across requests. */
  private stageNames: Map<string, string> | undefined;
  private stageNamesAt = 0;

  /** Calendars change rarely; the bookings page would otherwise refetch per view. */
  private calendarCache: AdminCalendar[] | undefined;
  private calendarCacheAt = 0;

  private pipelineCache: { id: string; name: string; stages: { id: string; name: string }[] }[] | undefined;
  private pipelineCacheAt = 0;

  constructor(databaseUrl = process.env.DATABASE_URL, ghl?: GhlClient) {
    if (!databaseUrl) throw new Error("DATABASE_URL not set — needed for AdminData");
    this.sql = postgres(databaseUrl);
    this.db = drizzle(this.sql);
    this.ghl = ghl ?? new GhlClient();
    this.socialClient = new SocialClient(this.ghl);
    this.socialStore = new SocialStore(this.db);
  }

  // ---------------------------------------------------------------------
  // Overview — one number per thing, for the landing page.
  // ---------------------------------------------------------------------

  /**
   * The landing page.
   *
   * Two of these numbers used to overstate reality, which on a management
   * console is worse than showing nothing: `bookings` counted every row
   * including cancelled ones (9 where 5 were live), and `socialPosts` counted
   * every mirror row including `failed` ones that never reached GHL at all
   * (15 where 7 existed). Both now count only what is real, and the totals a
   * `count(*)` would have given are kept alongside so the difference is visible
   * rather than quietly dropped.
   *
   * The second block is the operator's actual work queue rather than vanity
   * numbers — "what needs me right now". `draftsAwaitingSend` is the one that
   * matters most: with LEAD_AUTOSEND defaulting to dry_run, the agent composes a
   * follow-up for every lead and never sends it, so this number is normally
   * non-zero and nothing else in the product mentions it.
   */
  async overview() {
    const countOf = async (n: Promise<{ n: number }[]>) => (await n)[0]?.n ?? 0;
    const in48h = new Date(Date.now() + 48 * 3600_000);

    const [
      convoCount,
      bookingsLive,
      bookingsAll,
      leadCount,
      emailsSent,
      draftsAwaitingSend,
      postsManageable,
      postsAll,
      failedLeads,
      bookingsSoon,
      handoffConversations,
    ] = await Promise.all([
      countOf(this.db.select({ n: sql<number>`count(*)::int` }).from(conversationsTable)),
      countOf(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(bookingsTable)
          .where(sql`${bookingsTable.status} = 'confirmed'`),
      ),
      countOf(this.db.select({ n: sql<number>`count(*)::int` }).from(bookingsTable)),
      countOf(this.db.select({ n: sql<number>`count(*)::int` }).from(leadEvents)),
      countOf(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(leadEmails)
          .where(sql`${leadEmails.status} = 'sent'`),
      ),
      // Composed but never sent. `send_disabled` is what dry_run writes;
      // `composed` is the pre-send state. Both are waiting on a human.
      countOf(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(leadEmails)
          .where(sql`${leadEmails.status} in ('send_disabled', 'composed')`),
      ),
      // `failed` rows never reached GHL, so they are not manageable posts —
      // there is nothing in GHL to edit or delete.
      countOf(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(socialPosts)
          .where(sql`${socialPosts.status} <> 'failed'`),
      ),
      countOf(this.db.select({ n: sql<number>`count(*)::int` }).from(socialPosts)),
      /**
       * Leads genuinely STUCK, not merely un-created.
       *
       * `rejected` is excluded: a submission with no email and no phone is
       * correctly rejected and will never succeed, so counting it here would
       * show a number an operator can do nothing about. This counts what the
       * sweeper would actually pick up.
       */
      countOf(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(leadEvents)
          .where(
            sql`${leadEvents.status} in ('received', 'failed')
                and ${leadEvents.attempts} < 6
                and ${leadEvents.processedAt} is null`,
          ),
      ),
      countOf(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(bookingsTable)
          .where(
            // The bound value needs an explicit ::timestamptz — postgres.js
            // sends a bare Date as an untyped parameter and the comparison
            // against a timestamptz column then fails to plan.
            sql`${bookingsTable.status} = 'confirmed'
                and ${bookingsTable.startsAt} >= now()
                and ${bookingsTable.startsAt} <= ${in48h.toISOString()}::timestamptz`,
          ),
      ),
      countOf(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(conversationsTable)
          .where(sql`${conversationsTable.outcome} = 'handed_off'`),
      ),
    ]);

    // Best-effort: a GHL outage shouldn't blank the whole overview, just the
    // two numbers that come from it.
    const [opportunities, contacts] = await Promise.all([
      this.opportunities({ limit: 1 }).catch(() => ({ total: undefined as number | undefined, items: [] })),
      this.contacts({ limit: 1 }).catch(() => ({ total: undefined as number | undefined, items: [] })),
    ]);

    return {
      conversations: convoCount,
      bookings: bookingsLive,
      bookingsIncludingCancelled: bookingsAll,
      leads: leadCount,
      emailsSent,
      socialPosts: postsManageable,
      socialPostsIncludingFailed: postsAll,
      opportunities: opportunities.total,
      contacts: contacts.total,

      /** What needs a human, right now. */
      queues: {
        draftsAwaitingSend,
        stuckLeads: failedLeads,
        bookingsNext48h: bookingsSoon,
        handoffConversations,
      },

      generatedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // Our own data — conversations, bookings, leads, emails, social.
  // ---------------------------------------------------------------------

  async conversations(limit = 30) {
    const rows = await this.db
      .select()
      .from(conversationsTable)
      .orderBy(desc(conversationsTable.updatedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      industry: r.industry,
      channel: r.channel,
      contactId: r.contactId,
      contact: r.contact,
      outcome: r.outcome,
      bookingCode: r.bookingCode,
      messageCount: r.messages.length,
      lastMessage: r.messages.at(-1)?.text?.slice(0, 140),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** The full transcript for one conversation — polled by the UI for a live view. */
  async conversation(id: string) {
    const [row] = await this.db
      .select()
      .from(conversationsTable)
      .where(sql`${conversationsTable.id} = ${id}`)
      .limit(1);
    return row ?? null;
  }

  /**
   * GoHighLevel's own message thread for a contact.
   *
   * Rendered BESIDE our transcript, never merged into it. The two hold different
   * things: our transcript is the actual voice/chat dialogue, which exists only
   * in Postgres because nothing in `conversation/*.ts` ever calls GHL; GHL's
   * thread is outbound mail plus activity records generated by our own booking
   * and CRM writes. Merging them is also unsafe — our `Message` has no id, so a
   * combined view could not dedupe an operator's reply against GHL's echo of it.
   *
   * Two shape traps, both verified rather than assumed:
   *  - the response is DOUBLE-nested: `{messages: {messages: [...]}}`, so the
   *    usual `(res.x ?? []).map(...)` idiom throws here.
   *  - activity rows are identified by the STRING `messageType`
   *    (`TYPE_ACTIVITY_*`), not the numeric `type`. Real data also contains
   *    values absent from the documented enum, so never switch exhaustively.
   */
  async ghlThread(contactId: string, limit = 30) {
    const search = await this.ghl.get<{ conversations?: Record<string, unknown>[] }>(
      paths.searchConversations(),
      { locationId: this.ghl.env.locationId, contactId, limit: 5 },
    );

    const convo = (search.conversations ?? [])[0];
    if (!convo?.id) return { conversationId: null, messages: [], activity: [] };

    const res = await this.ghl.get<{ messages?: { messages?: Record<string, unknown>[] } }>(
      paths.conversationMessages(String(convo.id)),
      { limit },
    );

    const all = (res.messages?.messages ?? []).map((m) => ({
      id: String(m.id ?? ""),
      type: String(m.messageType ?? ""),
      direction: String(m.direction ?? ""),
      body: (m.body as string) ?? "",
      at: (m.dateAdded as string) ?? null,
    }));

    // Split rather than filter: the activity trail is genuinely useful ("we
    // created an appointment"), just not interleaved with what people said.
    return {
      conversationId: String(convo.id),
      messages: all.filter((m) => !m.type.startsWith("TYPE_ACTIVITY_")),
      activity: all.filter((m) => m.type.startsWith("TYPE_ACTIVITY_")),
    };
  }

  /**
   * Our own booking index. `externalId`, `contactId`, `details` and `updatedAt`
   * are all projected because the console needs them: `externalId` to act on the
   * appointment in GHL and to join against the live calendar, `contactId` to link
   * to the contact, `details` to show what the guest actually asked for.
   */
  async bookings(limit = 30) {
    const rows = await this.db
      .select()
      .from(bookingsTable)
      .orderBy(desc(bookingsTable.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      code: r.code,
      externalId: r.externalId,
      resourceId: r.resourceId,
      industry: r.industry,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      status: r.status,
      contactId: r.contactId,
      fullName: r.fullName,
      email: r.email,
      phone: r.phone,
      details: r.details,
      replacedByCode: r.replacedByCode,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Every calendar on the location, with the resource it is wired to.
   *
   * The `resourceId` mapping is derived by asking `calendarIdFor` for each
   * configured resource, i.e. by reading the same env vars the booking path uses,
   * so the console can never offer a calendar the agent cannot actually book.
   * A calendar with no resource is returned with `resourceId: undefined` and must
   * be shown read-only rather than as a bookable option.
   */
  async calendars(cfg: IndustryConfig) {
    if (this.calendarCache && Date.now() - this.calendarCacheAt < 5 * 60_000) {
      return this.calendarCache;
    }

    const res = await this.ghl.get<{ calendars?: RawCalendar[] }>(paths.listCalendars(), {
      locationId: this.ghl.env.locationId,
    });

    const resourceByCalendarId = new Map<string, string>();
    for (const r of cfg.resources) {
      try {
        resourceByCalendarId.set(calendarIdFor(r.id), r.id);
      } catch {
        // No calendar configured for this resource. Not fatal here — the booking
        // form reports it per-resource instead of failing the whole page.
      }
    }

    this.calendarCache = (res.calendars ?? []).map((c) => ({
      id: c.id!,
      // GHL's own calendar names carry trailing tabs on this location.
      name: (c.name ?? "").trim(),
      isActive: c.isActive !== false,
      calendarType: c.calendarType,
      slotDuration: c.slotDuration,
      /**
       * How many appointments GHL allows in ONE slot. Every calendar here is
       * `class_booking` with this between 6 and 20, which means a slot reported
       * as "free" may already hold other bookings — three appointments currently
       * share one table slot. An admin reading "available" as "empty" will
       * double-book, so the picker must show occupancy against this number.
       */
      appointmentPerSlot: Number(c.appointmentPerSlot ?? 1),
      allowReschedule: c.allowReschedule !== false,
      allowCancellation: c.allowCancellation !== false,
      resourceId: resourceByCalendarId.get(c.id!),
    }));
    this.calendarCacheAt = Date.now();
    return this.calendarCache;
  }

  /**
   * Appointments as GoHighLevel actually has them.
   *
   * This is the authority on status and wall-clock time. Our index cannot be:
   * it stores `timestamptz`, which preserves the instant and DESTROYS the
   * original offset, and it never learns about a change a human makes in the GHL
   * UI. Right now one appointment is `showed` in GHL while our row still says
   * `confirmed`, and three appointments have no row at all.
   *
   * Fanned out per calendar rather than using the single-`userId` shortcut:
   * `userId` filters on the appointment's assigned user, so a round-robin
   * calendar with two team members would silently return half its appointments.
   */
  private async eventsFor(calendarId: string, from: Date, to: Date): Promise<RawEvent[]> {
    return this.ghl
      .get<{ events?: RawEvent[] }>(paths.calendarEvents(), {
        // Required, and absent from the published schema — without it this is a
        // guaranteed 400 "Location ID is required".
        locationId: this.ghl.env.locationId,
        calendarId,
        startTime: String(from.getTime()),
        endTime: String(to.getTime()),
      })
      .then((r) => r.events ?? [])
      .catch(() => [] as RawEvent[]);
  }

  async liveAppointments(
    cfg: IndustryConfig,
    /**
     * `calendarId` narrows the fan-out to one calendar. Worth having: the slot
     * picker only ever cares about the calendar being booked, and querying all
     * four then filtering meant five concurrent GHL calls per slot lookup — which
     * is what started failing with `fetch failed` under a page that was already
     * making four of its own.
     */
    opts: { from?: Date; to?: Date; contactId?: string; calendarId?: string } = {},
  ) {
    const from = opts.from ?? new Date(Date.now() - 180 * 864e5);
    const to = opts.to ?? new Date(Date.now() + 180 * 864e5);

    const all = await this.calendars(cfg);
    const cals = opts.calendarId ? all.filter((c) => c.id === opts.calendarId) : all;
    const byResource = new Map(all.map((c) => [c.id, c]));

    const perCalendar = await Promise.all(
      cals.map((c) => this.eventsFor(c.id, from, to)),
    );

    return perCalendar
      .flat()
      .filter((e) => e.id && !e.deleted)
      .filter((e) => !opts.contactId || e.contactId === opts.contactId)
      .map((e) => ({
        externalId: e.id!,
        calendarId: e.calendarId,
        resourceId: e.calendarId ? byResource.get(e.calendarId)?.resourceId : undefined,
        contactId: e.contactId,
        title: e.title,
        /**
         * GHL ships this field under BOTH spellings, including a typo'd
         * `appoinmentStatus`. Read the correct one and fall back, because we do
         * not control which one a future response drops.
         */
        status: e.appointmentStatus ?? e.appoinmentStatus ?? "unknown",
        /** Raw, offset-bearing. Never re-parse into another zone. */
        startTime: e.startTime,
        endTime: e.endTime,
        dateAdded: e.dateAdded,
        dateUpdated: e.dateUpdated,
      }))
      .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));
  }

  /**
   * The bookings page: live GHL appointments UNIONed with our own index.
   *
   * Joined on `external_id ↔ GHL event id`. Which side wins is decided per field
   * rather than per row, because each side genuinely knows something the other
   * does not:
   *
   *   GHL owns  — status (`showed`/`noshow` exist there and cannot be
   *               represented in our `Booking` type at all) and the wall-clock
   *               time with its original offset.
   *   we own    — the six-character reference the guest was given, the resource,
   *               the collected details, and the reschedule lineage.
   *
   * `source` says which sides a row appeared on, so the UI can hide actions that
   * cannot work: cancel and reschedule are keyed on our reference, so a
   * `ghl-only` row has nothing to act on.
   */
  async bookingsMerged(cfg: IndustryConfig, limit = 50) {
    const [ours, live] = await Promise.all([
      this.bookings(200),
      this.liveAppointments(cfg).catch(() => [] as Awaited<ReturnType<AdminData["liveAppointments"]>>),
    ]);

    const liveByExternalId = new Map(live.map((e) => [e.externalId, e]));
    const claimed = new Set<string>();

    const merged = ours.map((b) => {
      const ghl = b.externalId ? liveByExternalId.get(b.externalId) : undefined;
      if (ghl) claimed.add(ghl.externalId);

      return {
        ...b,
        source: ghl ? ("both" as const) : ("index-only" as const),
        // GHL's status wins when we have it — ours is a two-value collapse.
        status: ghl?.status ?? b.status,
        indexStatus: b.status,
        startTimeRaw: ghl?.startTime ?? b.startsAt,
        ghlUpdatedAt: ghl?.dateUpdated,
        canCancel: b.status !== "cancelled",
        canReschedule: b.status !== "cancelled",
      };
    });

    // Appointments GHL knows about that we have no row for — booked by a human
    // in the GHL UI, or predating our index. Surfaced explicitly; dropping them
    // is what made this page quietly wrong.
    const ghlOnly = live
      .filter((e) => !claimed.has(e.externalId))
      .map((e) => ({
        code: null,
        externalId: e.externalId,
        resourceId: e.resourceId ?? null,
        industry: null,
        startsAt: e.startTime,
        endsAt: e.endTime,
        status: e.status,
        indexStatus: null,
        contactId: e.contactId ?? null,
        fullName: titleName(e.title),
        email: null,
        phone: null,
        details: {},
        replacedByCode: null,
        createdAt: e.dateAdded,
        updatedAt: e.dateUpdated,
        source: "ghl-only" as const,
        startTimeRaw: e.startTime,
        ghlUpdatedAt: e.dateUpdated,
        // No reference on our side, so there is nothing for cancel/reschedule to
        // key on. Better to hide the buttons than to offer a silent no-op.
        canCancel: false,
        canReschedule: false,
      }));

    const all = [...merged, ...ghlOnly].sort((a, b) =>
      String(b.startTimeRaw ?? "").localeCompare(String(a.startTimeRaw ?? "")),
    );

    return {
      items: all.slice(0, limit),
      counts: {
        total: all.length,
        both: merged.filter((m) => m.source === "both").length,
        indexOnly: merged.filter((m) => m.source === "index-only").length,
        ghlOnly: ghlOnly.length,
      },
      /** So the UI can render every time in the business's own zone. */
      timezone: this.ghl.env.timezone,
    };
  }

  /**
   * Free slots for a day, annotated with how full each one already is.
   *
   * `free-slots` alone is not enough to book safely here: every calendar is
   * `class_booking` with `appointmentPerSlot` well above 1, so GHL reports a slot
   * as available while it already holds other appointments. The occupancy count
   * comes from a second read of that day's events, cross-tabulated by start time.
   */
  async slotsWithOccupancy(
    cfg: IndustryConfig,
    opts: { resourceId: string; date: string; limit?: number },
  ) {
    const calendarId = calendarIdFor(opts.resourceId);
    const day = new Date(`${opts.date}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) throw new Error(`Invalid date "${opts.date}"`);

    const cal = (await this.calendars(cfg)).find((c) => c.id === calendarId);

    const [slotRes, events] = await Promise.all([
      this.ghl.get<Record<string, unknown>>(paths.freeSlots(calendarId), {
        startDate: String(day.getTime() - 864e5),
        endDate: String(day.getTime() + 2 * 864e5),
      }),
      this.liveAppointments(cfg, {
        from: new Date(day.getTime() - 864e5),
        to: new Date(day.getTime() + 2 * 864e5),
        calendarId,
      }),
    ]);

    const takenByStart = new Map<string, number>();
    for (const e of events) {
      if (e.status === "cancelled") continue;
      const key = String(e.startTime);
      takenByStart.set(key, (takenByStart.get(key) ?? 0) + 1);
    }

    const capacity = cal?.appointmentPerSlot ?? 1;
    const raw = (slotRes[opts.date] as { slots?: unknown } | undefined)?.slots;
    const slots = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];

    return {
      date: opts.date,
      resourceId: opts.resourceId,
      capacity,
      calendarName: cal?.name,
      timezone: this.ghl.env.timezone,
      slots: slots.slice(0, opts.limit ?? 50).map((start) => ({
        start,
        taken: takenByStart.get(start) ?? 0,
        capacity,
        full: (takenByStart.get(start) ?? 0) >= capacity,
      })),
    };
  }

  /**
   * Lead submissions.
   *
   * The projection now carries WHO the lead was — name, email, phone, pulled out
   * of the stored `lead` payload. The page's entire job is "did this submission
   * land", and it previously showed five columns none of which identified the
   * person, so an operator could not tell one row from another without opening a
   * contact that might not exist.
   *
   * `retryable` is computed here rather than in the UI so the button and the
   * server agree on one definition of what can be retried.
   */
  async leads(opts: { limit?: number; offset?: number; status?: string; sort?: string; dir?: string } = {}) {
    const limit = opts.limit ?? 30;
    const where = opts.status ? sql`${leadEvents.status} = ${opts.status}` : undefined;

    /**
     * Sorting is server-side and whitelisted.
     *
     * Server-side because the list is paginated: sorting only the rows already
     * loaded would silently reorder one page and call it sorted, which is worse
     * than not offering it. Whitelisted because the column name goes into SQL —
     * a client-supplied string here would be an injection.
     */
    const columns: Record<string, PgColumn> = {
      receivedAt: leadEvents.receivedAt,
      status: leadEvents.status,
      source: leadEvents.source,
      attempts: leadEvents.attempts,
    };
    const column = columns[opts.sort ?? "receivedAt"] ?? leadEvents.receivedAt;
    const order = opts.dir === "asc" ? asc(column) : desc(column);

    const [rows, counted] = await Promise.all([
      this.db
        .select()
        .from(leadEvents)
        .where(where)
        .orderBy(order)
        .limit(limit)
        .offset(opts.offset ?? 0),
      this.db.select({ n: sql<number>`count(*)::int` }).from(leadEvents).where(where),
    ]);
    const total = counted[0]?.n ?? 0;

    const items = rows.map((r) => {
      const lead = (r.lead ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        source: r.source,
        externalId: r.externalId,
        status: r.status,
        reason: r.reason,
        contactId: r.contactId,
        conversationId: r.conversationId,
        opportunityId: r.opportunityId,
        identityKey: r.identityKey,
        tags: r.tags,
        seenCount: r.seenCount,
        attempts: r.attempts,
        enrichment: r.enrichment,
        tagsSynced: r.tagsSynced,
        noteAdded: r.noteAdded,
        lockedAt: r.lockedAt?.toISOString() ?? null,
        // Who it actually was.
        name: (lead.fullName as string) ?? (lead.full_name as string) ?? null,
        email: (lead.email as string) ?? null,
        phone: (lead.phone as string) ?? null,
        receivedAt: r.receivedAt.toISOString(),
        processedAt: r.processedAt?.toISOString() ?? null,
        /**
         * Unfinished and not yet retried to death. `duplicate` is excluded on
         * purpose: it is a correct terminal outcome, not a failure.
         */
        retryable: ["received", "failed"].includes(r.status) && r.attempts < 6,
      };
    });

    return { items, total };
  }

  /** One submission in full, including the original webhook payload. */
  async lead(id: string) {
    const [r] = await this.db.select().from(leadEvents).where(sql`${leadEvents.id} = ${id}`).limit(1);
    if (!r) return null;
    return {
      id: r.id,
      source: r.source,
      externalId: r.externalId,
      identityKey: r.identityKey,
      status: r.status,
      reason: r.reason,
      contactId: r.contactId,
      conversationId: r.conversationId,
      opportunityId: r.opportunityId,
      tags: r.tags,
      enrichment: r.enrichment,
      tagsSynced: r.tagsSynced,
      noteAdded: r.noteAdded,
      attempts: r.attempts,
      seenCount: r.seenCount,
      lockedAt: r.lockedAt?.toISOString() ?? null,
      /** The parsed lead as our own code understood it. */
      lead: r.lead,
      /**
       * The ORIGINAL payload, exactly as it arrived. Kept precisely so a parser
       * can be fixed and the submission replayed rather than lost — and it is the
       * single most useful thing to look at when a lead did not land as expected.
       */
      raw: r.raw,
      capturedAt: r.capturedAt.toISOString(),
      receivedAt: r.receivedAt.toISOString(),
      processedAt: r.processedAt?.toISOString() ?? null,
    };
  }

  /** Our own composed/sent emails. See `emailConversations` for GHL's side. */
  async emails(limit = 30) {
    const rows = await this.db
      .select()
      .from(leadEmails)
      .orderBy(desc(leadEmails.composedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      trigger: r.trigger,
      recipient: r.recipient,
      subject: r.subject,
      status: r.status,
      reason: r.reason,
      composedAt: r.composedAt.toISOString(),
      sentAt: r.sentAt?.toISOString(),
    }));
  }

  // ---------------------------------------------------------------------
  // Live from GHL — contacts, opportunities, email conversations.
  // ---------------------------------------------------------------------

  private async stageNameMap(): Promise<Map<string, string>> {
    // Cached for 5 minutes. Pipeline stages change rarely; re-fetching them on
    // every opportunities request would just be latency for no benefit.
    if (this.stageNames && Date.now() - this.stageNamesAt < 5 * 60_000) return this.stageNames;

    const map = new Map<string, string>();
    try {
      const res = await this.ghl.get<{ pipelines?: { stages?: { id: string; name: string }[] }[] }>(
        paths.pipelines(),
        { locationId: this.ghl.env.locationId },
      );
      for (const p of res.pipelines ?? []) {
        for (const s of p.stages ?? []) map.set(s.id, s.name);
      }
    } catch {
      /* stage NAMES are a nicety; ids alone still render */
    }
    this.stageNames = map;
    this.stageNamesAt = Date.now();
    return map;
  }

  /**
   * Pipelines with their stages, ordered, for the stage dropdown.
   *
   * Deliberately NOT reusing `stageNameMap()`: that flattens every pipeline into
   * `Map<stageId, name>`, discarding the pipelineId, the pipeline name and the
   * stage order. A dropdown built from it would be unordered and — worse —
   * unable to send the pipelineId alongside the stage, which is the pairing that
   * keeps a record internally consistent. Same fetch, same 5-minute cache, richer
   * shape; the flattened map is now derived from this.
   */
  async pipelines() {
    if (this.pipelineCache && Date.now() - this.pipelineCacheAt < 5 * 60_000) {
      return this.pipelineCache;
    }

    const res = await this.ghl.get<{
      pipelines?: {
        id?: string;
        name?: string;
        stages?: { id?: string; name?: string; position?: number }[];
      }[];
    }>(paths.pipelines(), { locationId: this.ghl.env.locationId });

    this.pipelineCache = (res.pipelines ?? []).map((p) => ({
      id: String(p.id ?? ""),
      name: String(p.name ?? ""),
      stages: (p.stages ?? [])
        .slice()
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((s) => ({ id: String(s.id ?? ""), name: String(s.name ?? "") })),
    }));
    this.pipelineCacheAt = Date.now();
    return this.pipelineCache;
  }

  async opportunities(opts: { limit?: number; status?: string; contactId?: string } = {}) {
    const [res, stageNames] = await Promise.all([
      this.ghl.get<{ opportunities?: unknown[]; meta?: { total?: number } }>(
        paths.searchOpportunities(),
        {
          location_id: this.ghl.env.locationId,
          limit: opts.limit ?? 25,
          status: opts.status ?? "all",
          // snake_case here, unlike `locationId` elsewhere — this endpoint's
          // convention genuinely differs. Native filter, so no new path builder.
          ...(opts.contactId ? { contact_id: opts.contactId } : {}),
        },
      ),
      this.stageNameMap(),
    ]);

    const items = (res.opportunities ?? []).map((o) => {
      const op = o as Record<string, unknown>;
      return {
        id: op.id,
        name: op.name,
        status: op.status,
        stageId: op.pipelineStageId,
        stageName: stageNames.get(String(op.pipelineStageId)) ?? "—",
        /**
         * Carried because a stage-only update can leave the record pointing at
         * one pipeline with a stage belonging to another. Only one pipeline
         * exists today, which is exactly why that would ship unnoticed.
         */
        pipelineId: op.pipelineId,
        contactId: op.contactId,
        monetaryValue: op.monetaryValue,
        createdAt: op.createdAt,
        updatedAt: op.updatedAt,
      };
    });

    return { items, total: res.meta?.total ?? items.length };
  }

  /**
   * Contacts, page by page.
   *
   * GoHighLevel pages this endpoint with a CURSOR, not an offset: you hand back
   * the last row's `dateAdded` and `id` as `startAfter`/`startAfterId`. That is
   * more awkward than a page number but it is stable under concurrent edits,
   * where an offset silently skips or repeats rows as the list shifts under you.
   *
   * Note this endpoint is deprecated in GHL's own docs in favour of a search
   * endpoint — which is also the only one that can filter by tag, so the
   * needs-human queue will want that migration before it can scale past a page.
   */
  async contacts(opts: { limit?: number; query?: string; startAfter?: string; startAfterId?: string } = {}) {
    const res = await this.ghl.get<{
      contacts?: unknown[];
      meta?: { total?: number; startAfter?: number; startAfterId?: string; nextPageUrl?: string };
    }>(paths.listContacts(), {
      locationId: this.ghl.env.locationId,
      limit: opts.limit ?? 25,
      query: opts.query,
      ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
      ...(opts.startAfterId ? { startAfterId: opts.startAfterId } : {}),
    });

    const items = (res.contacts ?? []).map((c) => {
      const contact = c as Record<string, unknown>;
      return {
        id: contact.id,
        /**
         * `firstNameRaw` FIRST. This endpoint returns `firstName` LOWERCASED —
         * verified live, and not an edge case: all 17 contacts on this location
         * diverge ("hina" vs "Hina"). The true casing is only in the `…Raw`
         * fields here; `GET /contacts/{id}` returns it correctly cased and has no
         * `…Raw` at all.
         *
         * Reading the lowercased one made the console display every customer's
         * name in lower case. Far worse, an edit form prefilled from this row and
         * PUT back would have written the lowercase version into the CRM
         * permanently — silently, even if the operator only fixed a postcode.
         * The edit form loads from `contactDetail` for exactly that reason.
         */
        firstName: contact.firstNameRaw ?? contact.firstName,
        lastName: contact.lastNameRaw ?? contact.lastName,
        email: contact.email,
        phone: contact.phone,
        tags: contact.tags,
        /** Compliance-relevant and previously fetched then thrown away. */
        dnd: contact.dnd === true,
        companyName: contact.companyName,
        city: contact.city,
        source: contact.source,
        dateAdded: contact.dateAdded,
      };
    });

    // The cursor for the NEXT page, taken from the last row we actually got —
    // GHL echoes its own `meta` cursor but the row values are what it expects
    // back, and they cannot disagree with what the operator just saw.
    const last = items.at(-1) as { id?: unknown; dateAdded?: unknown } | undefined;
    const nextCursor =
      items.length === (opts.limit ?? 25) && last?.id && last?.dateAdded
        ? { startAfter: String(new Date(String(last.dateAdded)).getTime()), startAfterId: String(last.id) }
        : null;

    return { items, total: res.meta?.total ?? items.length, nextCursor };
  }

  /**
   * ONE contact, correctly cased — the only safe source for an edit form.
   *
   * See the casing note in `contacts()`. This endpoint is the authority: it
   * returns `firstName: "Hina"` where the list returns `"hina"`.
   */
  async contactDetail(id: string) {
    const res = await this.ghl.get<{ contact?: Record<string, unknown> }>(paths.getContact(id));
    const c = res.contact;
    if (!c) return null;
    return {
      id: String(c.id ?? id),
      firstName: (c.firstName as string) ?? null,
      lastName: (c.lastName as string) ?? null,
      name: (c.contactName as string) ?? (c.name as string) ?? null,
      email: (c.email as string) ?? null,
      phone: (c.phone as string) ?? null,
      companyName: (c.companyName as string) ?? null,
      address1: (c.address1 as string) ?? null,
      city: (c.city as string) ?? null,
      state: (c.state as string) ?? null,
      postalCode: (c.postalCode as string) ?? null,
      country: (c.country as string) ?? null,
      website: (c.website as string) ?? null,
      timezone: (c.timezone as string) ?? null,
      source: (c.source as string) ?? null,
      dnd: c.dnd === true,
      tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
      assignedTo: (c.assignedTo as string) ?? null,
      dateAdded: (c.dateAdded as string) ?? null,
      dateUpdated: (c.dateUpdated as string) ?? null,
    };
  }

  /**
   * Notes on a contact — where the agent's own reasoning surfaces.
   *
   * `saveTranscript`, `writeScore`'s reason and `flagForHuman` all land here, so
   * this is the only place an operator can see WHY the agent did what it did.
   *
   * VERIFIED live (this endpoint had never once been called): the envelope is
   * `{notes: [...]}` and the timestamp field is **`dateAdded`**, not `createdAt`.
   */
  async contactNotes(id: string, limit = 25) {
    const res = await this.ghl.get<{ notes?: Record<string, unknown>[] }>(paths.addNote(id));
    return (res.notes ?? [])
      .map((n) => ({
        id: String(n.id ?? ""),
        body: (n.body as string) ?? (n.bodyText as string) ?? "",
        pinned: n.pinned === true,
        at: (n.dateAdded as string) ?? null,
      }))
      .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
      .slice(0, limit);
  }

  /**
   * Open work items on a contact.
   *
   * Distinct from notes: a note records what happened, a task records what still
   * has to. "Call them back" belongs here rather than buried in prose, and the
   * agent's handoff currently writes it as a note because nothing read this.
   */
  async contactTasks(id: string) {
    const res = await this.ghl.get<{ tasks?: Record<string, unknown>[] }>(paths.contactTasks(id));
    return (res.tasks ?? []).map((t) => ({
      id: String(t.id ?? ""),
      title: (t.title as string) ?? "",
      body: (t.body as string) ?? (t.description as string) ?? "",
      dueDate: (t.dueDate as string) ?? null,
      completed: t.completed === true,
      assignedTo: (t.assignedTo as string) ?? null,
    }));
  }

  /**
   * Everything about one person, in a single round trip.
   *
   * One fan-out rather than five browser fetches: five would become five
   * sequential GHL round-trips through one Node process, five error surfaces and
   * five spinners. Each source is caught independently into `errors`, so a GHL
   * hiccup blanks one card instead of the page — the same posture the emails
   * route already takes.
   */
  async contact360(cfg: IndustryConfig, id: string) {
    const errors: Record<string, string> = {};
    const guard = async <T>(key: string, work: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await work;
      } catch (err) {
        errors[key] = String(err).slice(0, 200);
        return fallback;
      }
    };

    const [contact, notes, conversations, bookings, opportunities, liveAppointments, emails, tasks] = await Promise.all([
      guard("contact", this.contactDetail(id), null),
      guard("notes", this.contactNotes(id), [] as Awaited<ReturnType<AdminData["contactNotes"]>>),
      guard("conversations", this.conversationsForContact(id), [] as Awaited<ReturnType<AdminData["conversationsForContact"]>>),
      guard("bookings", this.bookingsForContact(id), [] as Awaited<ReturnType<AdminData["bookingsForContact"]>>),
      guard("opportunities", this.opportunities({ limit: 25, contactId: id }), { items: [], total: 0 }),
      guard("liveAppointments", this.liveAppointments(cfg, { contactId: id }), [] as Awaited<ReturnType<AdminData["liveAppointments"]>>),
      guard("emails", this.emailsForContact(id), [] as Awaited<ReturnType<AdminData["emailsForContact"]>>),
      guard("tasks", this.contactTasks(id), [] as Awaited<ReturnType<AdminData["contactTasks"]>>),
    ]);

    if (!contact && errors.contact) throw new Error(`Couldn't load contact ${id}: ${errors.contact}`);

    // Appointments GHL has for this person that our index never recorded.
    const known = new Set(bookings.map((b) => b.externalId).filter(Boolean));
    const unlinkedAppointments = liveAppointments.filter((a) => !known.has(a.externalId));

    return {
      contact,
      notes,
      conversations,
      bookings,
      unlinkedAppointments,
      opportunities: opportunities.items,
      emails,
      tasks,
      timezone: this.ghl.env.timezone,
      errors,
    };
  }

  /** Conversations for one contact. `conversations_contact_idx` already covers this. */
  async conversationsForContact(contactId: string, limit = 25) {
    const rows = await this.db
      .select()
      .from(conversationsTable)
      .where(sql`${conversationsTable.contactId} = ${contactId}`)
      .orderBy(desc(conversationsTable.updatedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      outcome: r.outcome,
      bookingCode: r.bookingCode,
      messageCount: r.messages.length,
      lastMessage: r.messages.at(-1)?.text?.slice(0, 160) ?? null,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Bookings for one contact — an exact join on the stored GHL contact id.
   *
   * Deliberately NOT `BookingIndex.byContact`, which matches on email/phone and
   * filters to upcoming-and-confirmed only. That is right for a caller saying "I
   * don't have my reference", and wrong for a history page: it would show an
   * empty list for a guest who has stayed twice and cancelled once. Past and
   * cancelled are both included here.
   */
  async bookingsForContact(contactId: string, limit = 50) {
    const rows = await this.db
      .select()
      .from(bookingsTable)
      .where(sql`${bookingsTable.contactId} = ${contactId}`)
      .orderBy(desc(bookingsTable.startsAt))
      .limit(limit);

    return rows.map((r) => ({
      code: r.code,
      externalId: r.externalId,
      resourceId: r.resourceId,
      startsAt: r.startsAt.toISOString(),
      status: r.status,
      replacedByCode: r.replacedByCode,
      details: r.details,
    }));
  }

  /** Composed follow-ups for one contact, so the 360 shows what we said to them. */
  async emailsForContact(contactId: string, limit = 25) {
    const rows = await this.db
      .select()
      .from(leadEmails)
      .where(sql`${leadEmails.contactId} = ${contactId}`)
      .orderBy(desc(leadEmails.composedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      status: r.status,
      recipient: r.recipient,
      composedAt: r.composedAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
    }));
  }

  /**
   * Real email threads from GHL — as distinct from `emails()`, which is only
   * what WE composed. This is what makes "emails being sent" complete: a human
   * replying manually in the GHL inbox shows up here too.
   */
  /**
   * One composed email, including the two fields the list view drops: `body`
   * (which is the entire point of reviewing it) and `sendError` (which is the
   * only explanation when a send failed).
   */
  async email(id: string) {
    const [row] = await this.db.select().from(leadEmails).where(sql`${leadEmails.id} = ${id}`).limit(1);
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
   * Everyone who asked to speak to a person, from both sides.
   *
   * Two sources because neither is complete on its own: our conversations table
   * knows the agent handed off and holds the transcript, while the GHL tag is
   * what a human operator working in the CRM would actually see. A contact can
   * appear in one and not the other.
   */
  async needsHuman(limit = 50) {
    const rows = await this.db
      .select()
      .from(conversationsTable)
      .where(sql`${conversationsTable.outcome} = 'handed_off'`)
      .orderBy(desc(conversationsTable.updatedAt))
      .limit(limit);

    const fromConversations: NeedsHumanEntry[] = rows.map((r) => ({
      source: "conversation",
      conversationId: r.id,
      contactId: r.contactId ?? null,
      name: r.contact?.full_name ?? null,
      email: r.contact?.email ?? null,
      phone: r.contact?.phone ?? null,
      channel: r.channel,
      lastMessage: r.messages.at(-1)?.text?.slice(0, 200) ?? null,
      at: r.updatedAt.toISOString(),
      tags: [],
    }));

    // GHL side: contacts carrying the tags `flagForHuman` writes. Filtered here
    // rather than by the API because `GET /contacts/` has no tag filter — it is
    // also deprecated in favour of a search endpoint, so this is the honest
    // interim and it is bounded by the page size.
    let fromCrm: NeedsHumanEntry[] = [];
    try {
      const { items } = await this.contacts({ limit: 100 });
      const seen = new Set(fromConversations.map((c) => c.contactId).filter(Boolean));
      fromCrm = (items as Record<string, unknown>[])
        .filter((c) => {
          const tags = Array.isArray(c.tags) ? (c.tags as string[]) : [];
          return tags.includes("needs-human") || tags.includes("ai-handoff");
        })
        .filter((c) => !seen.has(String(c.id)))
        .map((c) => ({
          source: "crm-tag",
          conversationId: null,
          contactId: String(c.id),
          name: [c.firstName, c.lastName].filter(Boolean).join(" ") || null,
          email: (c.email as string) ?? null,
          phone: (c.phone as string) ?? null,
          channel: "crm",
          lastMessage: null,
          at: (c.dateAdded as string) ?? new Date().toISOString(),
          tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
        }));
    } catch {
      // A GHL hiccup must not blank the queue we can answer from Postgres.
    }

    return {
      items: [...fromConversations, ...fromCrm].sort((a, b) => String(b.at).localeCompare(String(a.at))),
      counts: { fromConversations: fromConversations.length, fromCrm: fromCrm.length },
    };
  }

  async emailConversations(limit = 25) {
    const res = await this.ghl.get<{ conversations?: unknown[] }>(paths.searchConversations(), {
      locationId: this.ghl.env.locationId,
      limit,
      // `lastMessageType`, NOT `query_lastMessageType`. The `query_` prefix is an
      // artifact of how the GHL MCP tooling names its inputs, not a real API
      // parameter — and GHL silently IGNORES unknown query params rather than
      // erroring, so the mistake looked like it worked. It returned every
      // conversation of every type (16) while claiming to return only email (1).
      // Note the two params above are correctly unprefixed, which is what made
      // the odd one out easy to miss.
      lastMessageType: "TYPE_EMAIL",
    });

    return (res.conversations ?? []).map((c) => {
      const convo = c as Record<string, unknown>;
      return {
        id: convo.id,
        contactId: convo.contactId,
        contactName: convo.fullName ?? convo.contactName,
        lastMessageBody: (convo.lastMessageBody as string | undefined)?.slice(0, 180),
        lastMessageDate: convo.lastMessageDate,
        lastMessageType: convo.lastMessageType,
        unreadCount: convo.unreadCount,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Social
  // ---------------------------------------------------------------------

  /**
   * Accounts, posts and timing insight.
   *
   * `posts` is now GoHighLevel's authoritative list, enriched from our Postgres
   * mirror rather than replaced by it. Each side knows something the other does
   * not: GHL alone knows whether a post still exists and what its real status
   * is; our mirror alone holds the `topic` and `askedBy` provenance — which
   * caller's question prompted the post — that GHL has no field for.
   *
   * Rows are marked `manageable` only when GHL has them. The mirror contains
   * `failed-*` rows that never reached GHL and `local-*` rows created while the
   * id-extraction bug was live, and offering Edit on either would be a button
   * that cannot work.
   */
  async social() {
    const now = Date.now();
    const [accounts, mirror, insights, live] = await Promise.all([
      this.socialClient.accounts(),
      this.socialStore.recentPosts(50),
      this.socialStore.weekdayInsights(),
      this.socialClient
        .listPosts({
          fromDate: new Date(now - 90 * 864e5).toISOString(),
          toDate: new Date(now + 120 * 864e5).toISOString(),
          limit: 100,
        })
        .catch(() => []),
    ]);

    // `post.platform` is unreliable until a post fires — drafts and scheduled
    // posts report "google" regardless of the account they belong to. Resolve it
    // from the account instead.
    const platformByAccountId = new Map(accounts.map((a) => [a.id, a.platform]));
    const mirrorById = new Map(mirror.map((p) => [p.id, p]));

    const posts = live
      .filter((p) => !p.deleted)
      .map((p) => {
        const ours = mirrorById.get(p.id);
        return {
          id: p.id,
          platform: p.accountIds.map((a) => platformByAccountId.get(a)).find(Boolean) ?? p.reportedPlatform ?? "unknown",
          status: p.status,
          summary: p.summary,
          scheduleDate: p.scheduleDate ?? null,
          publishedAt: p.publishedAt ?? null,
          createdAt: p.createdAt ?? null,
          topic: ours?.topic ?? null,
          askedBy: ours?.askedBy ?? null,
          manageable: true,
          // A published post's GHL record can be edited, but nothing verified
          // says GHL propagates that to the live Facebook/LinkedIn post.
          editable: p.status !== "published",
        };
      })
      .sort((a, b) =>
        String(b.scheduleDate ?? b.publishedAt ?? b.createdAt ?? "").localeCompare(
          String(a.scheduleDate ?? a.publishedAt ?? a.createdAt ?? ""),
        ),
      );

    const liveIds = new Set(live.map((p) => p.id));
    const unmanageable = mirror
      .filter((p) => !liveIds.has(p.id))
      .map((p) => ({
        id: p.id,
        platform: p.platform,
        status: p.status,
        topic: p.topic,
        error: p.error ?? null,
        postedAt: p.postedAt ?? null,
        manageable: false,
        reason: /^(local|failed)-/.test(p.id)
          ? "Recorded before we captured GoHighLevel's real id, so there is nothing to act on there."
          : "Not in GoHighLevel any more — deleted there, most likely.",
      }));

    /**
     * Repeated clicks of "schedule at best time" land on the same computed slot,
     * so duplicates fan out silently. Surfaced rather than deduped: which one to
     * keep is the operator's call.
     */
    const bySlot = new Map<string, number>();
    for (const p of posts) {
      if (p.status !== "scheduled" || !p.scheduleDate) continue;
      bySlot.set(p.scheduleDate, (bySlot.get(p.scheduleDate) ?? 0) + 1);
    }
    const duplicateSlots = [...bySlot.entries()].filter(([, n]) => n > 1).map(([at, n]) => ({ at, count: n }));

    return { accounts, posts, unmanageable, insights, duplicateSlots, timezone: this.ghl.env.timezone };
  }

  /**
   * Engagement for ONE connected account, over GHL's rolling 7 days.
   *
   * Per-account rather than aggregated: "how is the Facebook page doing" and
   * "how is LinkedIn doing" are different questions, and a combined number
   * answers neither. `dayRange` comes back as weekday names (Fri…Thu), so the
   * series is labelled with the days GHL actually measured rather than dates we
   * would have to guess at.
   *
   * `grouping` is always `"daily"` — there is no hour-of-day breakdown anywhere
   * in this API, which is why the timing analysis can only ever answer "best
   * day" and not "best hour".
   */
  async socialAnalytics(profileId: string, platform: string) {
    const stats = await this.socialClient.statistics([profileId], [platform as never]);
    if (!stats) return null;

    const raw = stats as unknown as {
      dayRange?: string[];
      totals?: Record<string, number>;
      platformTotals?: Record<string, Record<string, { total?: number; series?: number[] }>>;
      breakdowns?: Record<string, { total?: number; totalChange?: number | string }>;
    };

    const seriesFor = (metric: string): { total: number; series: number[] } => {
      const perPlatform = raw.platformTotals?.[metric] ?? {};
      const entry = perPlatform[platform] ?? Object.values(perPlatform)[0];
      return { total: Number(entry?.total ?? 0), series: entry?.series ?? [] };
    };

    const change = (metric: string): number | null => {
      const v = raw.breakdowns?.[metric]?.totalChange;
      return v === undefined || v === null || v === "" ? null : Number(v);
    };

    return {
      profileId,
      platform,
      days: raw.dayRange ?? [],
      grouping: "daily",
      totals: raw.totals ?? {},
      metrics: [
        { key: "impressions", label: "Impressions", slot: 1, ...seriesFor("impressions"), change: change("impressions") },
        { key: "followers", label: "Followers", slot: 2, ...seriesFor("followers"), change: null },
        { key: "likes", label: "Likes", slot: 3, ...seriesFor("likes"), change: null },
      ],
      posts: Number(raw.breakdowns?.posts?.total ?? raw.totals?.posts ?? 0),
      reach: Number(raw.breakdowns?.reach?.total ?? 0),
    };
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
