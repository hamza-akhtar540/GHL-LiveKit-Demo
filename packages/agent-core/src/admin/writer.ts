import { GhlClient } from "../ghl/client.js";
import { paths } from "../ghl/endpoints.js";
import type { Booking, BookingStore } from "../booking/types.js";
import type { LeadEmailRow, LeadStore } from "../leads/store.js";
import { allowlisted } from "../leads/follow-up.js";
import { sendEmail } from "../email/send.js";
import { sendMessage, smsAvailability, type SendableChannel } from "../conversation/send.js";
import { SocialClient } from "../social/client.js";
import type { ConversationStore } from "../conversation/types.js";

/**
 * Every write the admin console can perform.
 *
 * This is the exact mirror of `AdminData`, which asserts in its own doc-comment
 * that no method on it ever issues a GHL POST/PUT/DELETE. That assertion is
 * load-bearing documentation — it is grep-verifiable — and this class is what
 * makes the other half checkable too: every mutation the dashboard can trigger
 * passes through `mutate()` here.
 *
 * ── Why a separate class rather than methods on AdminData ──
 * `apps/web/src/admin/http.ts` already established the pattern for
 * `SocialPublisher`: a separate writer object built once beside the reader, in
 * preference to reaching into the reader's private stores. This generalises it.
 *
 * ── Why this THROWS, when CrmSync deliberately does not ──
 * `CrmSync` promises never to throw at its caller (`crm/sync.ts:17-19`) and
 * swallows every failure into a boolean. That is right for a live phone call: an
 * agent mid-sentence must not crash because a tag write 429'd. It is exactly
 * wrong for a form. A swallowed 422 becomes a green "Saved" toast, the operator
 * walks away believing a customer's record was corrected, and nothing was
 * written. So every method here throws, and the HTTP layer turns that into a
 * real error with a reason attached.
 *
 * ── What this is NOT ──
 * Not a reimplementation of the domain logic. The genuinely hard multi-step
 * mechanics stay where they already are and are already correct — above all
 * `GhlBookingStore.reschedule`, which secures the new slot before releasing the
 * old one so a guest moving a reservation can never end up with neither. That
 * ordering is the most safety-critical logic in the repo and must exist once.
 * This class delegates to it.
 *
 * The honest consequence: a grep of this file shows every write the DASHBOARD can
 * trigger, not every write the codebase can perform — the agent still writes
 * through `CrmSync` and `GhlBookingStore` outside it.
 */

/** How bad is it if this goes wrong, and what must the UI do first. */
export interface WriteRisk {
  /** Can the operator undo this from the console? */
  reversible: boolean;
  /** What the UI must do before calling. */
  gate: "none" | "confirm" | "confirm-typed";
  /** Shown in the confirm dialog. Written for an operator, not a developer. */
  warning?: string;
}

/**
 * The confirm posture for every write, in one place, served to the browser at
 * `GET /admin/api/write-policy` so it cannot drift between eleven page modules.
 *
 * Default-deny is the point: `mutate()` throws for any op missing from this
 * table rather than falling through to `gate: "none"`. A table that centralises
 * safety and can silently lose an entry is worse than no table.
 */
export const WRITE_RISK: Record<string, WriteRisk> = {
  // --- social ---
  "social.draft": { reversible: true, gate: "none" },
  "social.schedule": {
    reversible: true,
    gate: "confirm",
    warning: "These will post automatically at the scheduled time. You can still cancel them in GoHighLevel → Social Planner before then.",
  },
  "social.publish": {
    reversible: false,
    gate: "confirm-typed",
    warning: "This posts to real accounts immediately. It cannot be recalled from the feed of anyone who has already seen it.",
  },
  "social.edit": { reversible: true, gate: "none" },
  "social.delete": {
    reversible: false,
    gate: "confirm",
    warning: "Deletes the post from GoHighLevel. If it was already published, this may not remove it from the platform itself.",
  },

  // --- bookings ---
  "booking.create": {
    reversible: true,
    gate: "confirm",
    warning: "This books a real appointment in GoHighLevel and the guest's calendar. You can cancel it afterwards.",
  },
  "booking.cancel": {
    reversible: false,
    gate: "confirm",
    warning:
      "This releases the slot in GoHighLevel immediately. It cannot be undone from here — you would have to book the guest in again, and the slot may be gone by then.",
  },
  "booking.reschedule": {
    reversible: false,
    gate: "confirm",
    warning:
      "Moving a booking issues the guest a NEW reference and retires the old one. If they call quoting the old code it will no longer be found, so tell them the new one.",
  },

  // --- contacts ---
  "contact.update": { reversible: false, gate: "none" },
  "contact.tag-add": { reversible: true, gate: "none" },
  "contact.tag-remove": {
    reversible: true,
    gate: "confirm",
    warning: "Tags drive GoHighLevel automations, so removing one can change which workflows this person is in.",
  },
  "contact.note": { reversible: false, gate: "none" },

  // --- leads ---
  "lead.retry": {
    reversible: false,
    gate: "confirm",
    warning:
      "This re-runs the CRM work for this submission. Contact and tag writes resume safely, but GoHighLevel notes have no duplicate protection, so a note may be added twice.",
  },

  // --- conversations ---
  "conversation.reply": {
    reversible: false,
    gate: "confirm",
    warning:
      "This sends a real message to a real person and cannot be recalled. On email, note the sending domain on this account is still unverified, so GoHighLevel may report success for mail that never arrives.",
  },

  // --- opportunities ---
  "opportunity.update": { reversible: false, gate: "none" },
  "opportunity.status": {
    reversible: false,
    gate: "confirm",
    warning:
      "Changing a deal's status fires GoHighLevel's status-changed automations, and setting it back afterwards does NOT un-fire them.",
  },
  "opportunity.create": { reversible: false, gate: "confirm", warning: "This creates a real deal in the pipeline." },

  // --- the email queue ---
  "email.send": {
    reversible: false,
    gate: "confirm",
    warning:
      "This sends a real email to a real person and cannot be recalled. Note the sending domain on this account is still unverified, so GoHighLevel may report success for mail that never actually arrives.",
  },
  "email.discard": {
    reversible: false,
    gate: "confirm",
    warning:
      "The draft is kept for the record but marked discarded, and the agent will not compose another first-touch email for this person.",
  },
};

/**
 * The fields an operator may edit on a contact.
 *
 * `tags` is deliberately ABSENT and must stay absent. GHL's `tags` field on this
 * endpoint replaces the whole set rather than merging, so including it here —
 * even optionally — would let a form round-trip the tag list it rendered and
 * silently drop every tag added since the page loaded. Those tags drive
 * automations, so the blast radius is workflow membership, not a label. Leaving
 * it out of the type means the compiler will not let the bug be written.
 *
 * `null` clears a field; `undefined` leaves it untouched.
 */
export interface ContactPatch {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  website?: string | null;
  timezone?: string | null;
  source?: string | null;
}

/**
 * The four real opportunity statuses.
 *
 * GHL's own enum also lists `all`, which is a SEARCH filter that leaked into the
 * write schema — and `AdminData.opportunities()` defaults to it, so it is one
 * careless round-trip away from reaching a PUT body. Whitelisted here so it
 * cannot.
 */
export const OPPORTUNITY_STATUSES = ["open", "won", "lost", "abandoned"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * Editable fields on a deal.
 *
 * `contactId` is absent because the update endpoint has no such field — a
 * contact picker would appear to work and change nothing. `assignedTo` is absent
 * because there is no users endpoint on this account to populate it from, and
 * `lostReasonId` because the endpoint cannot write it. All three are shown
 * read-only in the UI with the reason, rather than offered and quietly ignored.
 *
 * `pipelineStageId` may only be set together with `pipelineId`.
 */
export interface OpportunityPatch {
  name?: string;
  monetaryValue?: number;
  status?: OpportunityStatus;
  pipelineStageId?: string;
  pipelineId?: string;
}

/** Lowercase, trimmed, de-duplicated. GHL stores tags lowercased anyway. */
function normaliseTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

/** A write that could not be performed, with a reason fit to show an operator. */
export class AdminWriteError extends Error {
  constructor(
    message: string,
    readonly op: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AdminWriteError";
  }
}

export interface AdminWriterDeps {
  client?: GhlClient;
  /**
   * The booking store, injected rather than constructed here.
   *
   * Deliberately the SAME implementation the voice agent uses. Its `reschedule`
   * secures the new slot before releasing the old one, so a guest moving a
   * reservation can never end up with neither — that ordering is the most
   * safety-critical logic in the repo and must not be reimplemented for the
   * console's benefit.
   */
  booking?: BookingStore;
  /** The lead store, for the composed-email queue. Shares the caller's db handle. */
  leads?: LeadStore;
  /**
   * Re-runs the CRM work for a claimed-but-unfinished lead. This is
   * `LeadIngestor.process`, NOT `ingest` — the latter starts with the
   * idempotency claim and so returns `duplicate` without doing anything.
   */
  reprocessLead?: (id: string, lead: unknown) => Promise<{ status: string }>;
  /**
   * Our own transcripts. A reply is appended here as an `admin` turn so the
   * conversation page stays coherent — otherwise it shows the customer's
   * messages and not the operator's answer.
   */
  conversations?: ConversationStore;
  /**
   * Who is doing this. The session cookie deliberately carries no user data
   * (`auth.ts` — "no user data in the cookie, nothing to leak"), so the only
   * identity available is the configured admin address. Threaded into the log so
   * a write is attributable to a person rather than to "the system".
   */
  operator?: string;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
}

export class AdminWriter {
  private readonly client: GhlClient;

  constructor(private readonly deps: AdminWriterDeps = {}) {
    this.client = deps.client ?? new GhlClient();
  }

  /** The declared risk for an op, or undefined if it was never declared. */
  static riskFor(op: string): WriteRisk | undefined {
    return WRITE_RISK[op];
  }

  /**
   * The single funnel every mutation passes through.
   *
   * Logs intent BEFORE the call, not just the outcome after — if the process dies
   * mid-write, the log still says what was attempted, which is the difference
   * between a diagnosable incident and a mystery. Then re-throws, so nothing can
   * fail quietly.
   */
  protected async mutate<T>(
    op: string,
    target: Record<string, unknown>,
    work: () => Promise<T>,
  ): Promise<T> {
    const risk = WRITE_RISK[op];
    if (!risk) {
      // Default-deny. An op that nobody classified is an op whose confirm
      // posture the UI cannot know, so it must not be reachable.
      throw new AdminWriteError(
        `Refusing "${op}": it is not declared in WRITE_RISK, so no confirm posture is defined for it.`,
        op,
        500,
      );
    }

    const { onLog = () => {}, operator } = this.deps;
    onLog("admin write starting", { op, ...target, operator, reversible: risk.reversible });

    try {
      const result = await work();
      onLog("admin write ok", { op, ...target, operator });
      return result;
    } catch (err) {
      onLog("admin write failed", { op, ...target, operator, err: String(err).slice(0, 300) });
      throw err;
    }
  }

  /** Exposed so subsystem writers can share the one authenticated client. */
  protected get ghl(): GhlClient {
    return this.client;
  }

  // ======================================================================
  // Bookings
  //
  // Every method here converts `GhlBookingStore`'s `null` into a thrown
  // AdminWriteError. That store returns null when there is no index row, which
  // is right for the agent — the tool layer tells the caller plainly. Over HTTP
  // the same null becomes a 200 with no effect: the operator clicks Cancel, sees
  // success, and the appointment is still there. Converting it once here covers
  // all three booking writes.
  // ======================================================================

  private get bookingStore(): BookingStore {
    const store = this.deps.booking;
    if (!store) {
      throw new AdminWriteError(
        "Booking actions need DATABASE_URL and GHL calendar configuration.",
        "booking",
        503,
      );
    }
    return store;
  }

  async createBooking(input: {
    resourceId: string;
    start: string;
    contact: Record<string, string>;
    details?: Record<string, string>;
  }): Promise<Booking> {
    return this.mutate("booking.create", { resourceId: input.resourceId, start: input.start }, async () => {
      if (!input.contact.full_name?.trim() && !input.contact.email?.trim() && !input.contact.phone?.trim()) {
        throw new AdminWriteError(
          "A booking needs at least a name, email or phone — otherwise nobody can be contacted about it.",
          "booking.create",
        );
      }
      return this.bookingStore.create({
        resourceId: input.resourceId,
        start: input.start,
        contact: input.contact,
        details: input.details ?? {},
      });
    });
  }

  async cancelBooking(code: string): Promise<Booking> {
    return this.mutate("booking.cancel", { code }, async () => {
      const result = await this.bookingStore.cancel(code);
      if (!result) {
        // Distinguish the two reasons, because they need different actions:
        // already-cancelled is fine, unknown-reference means the appointment
        // exists only in GHL and must be cancelled there.
        const existing = await this.bookingStore.find(code).catch(() => null);
        throw new AdminWriteError(
          existing
            ? `Booking ${code} is already cancelled.`
            : `No booking with reference ${code} on our side. If it exists only in GoHighLevel, cancel it there — we have no reference to act on.`,
          "booking.cancel",
          404,
        );
      }
      return result;
    });
  }

  // ======================================================================
  // Contacts
  // ======================================================================

  /**
   * Partial update of one contact.
   *
   * Three things this gets right that the obvious implementation does not:
   *
   * 1. **PUT /contacts/{id}, never upsert.** Upsert has no contactId parameter
   *    at all — it resolves identity by email/phone. So editing a typo'd email
   *    through upsert would match a DIFFERENT contact that already owns the
   *    corrected address, or create a third record; never the one the operator
   *    opened. That is a correctness difference, not a preference.
   *
   * 2. **Only changed fields are sent.** The endpoint preserves anything you
   *    omit, so a form that submits everything it rendered turns every
   *    untouched-but-empty input into a deliberate erasure. The caller passes a
   *    diff (see `form().dirty()` in the UI), and empty strings are dropped
   *    rather than transmitted, because "" is ambiguous between clear-this and
   *    never-filled-in.
   *
   * 3. **`tags` is absent from the type.** GHL's own schema warns that the
   *    `tags` field on this endpoint REPLACES the entire set — so sending it
   *    from an edit form would silently wipe `lead-hot`, `ai-qualified`,
   *    `needs-human` and anything else added since the page loaded, and those
   *    tags drive automations. Keeping it out of `ContactPatch` means the
   *    compiler refuses to represent the bug. Use `addTags`/`removeTags`.
   */
  async updateContact(id: string, patch: ContactPatch): Promise<void> {
    return this.mutate("contact.update", { id, fields: Object.keys(patch) }, async () => {
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        // null is a deliberate "clear this field"; "" is not, and is dropped.
        if (value === null) body[key] = null;
        else if (String(value).trim() !== "") body[key] = String(value).trim();
      }

      if (!Object.keys(body).length) {
        throw new AdminWriteError("Nothing was changed.", "contact.update", 400);
      }
      if ("tags" in body) {
        throw new AdminWriteError(
          "Tags cannot be set this way — the field replaces every tag on the contact. Use add/remove tag instead.",
          "contact.update",
          400,
        );
      }

      await this.client.request(paths.getContact(id), { method: "PUT", body });
    });
  }

  async addContactTags(id: string, tags: string[]): Promise<string[]> {
    return this.mutate("contact.tag-add", { id, tags }, async () => {
      const clean = normaliseTags(tags);
      if (!clean.length) throw new AdminWriteError("No tags given.", "contact.tag-add", 400);
      const res = await this.client.request<{ tags?: string[] }>(paths.addTags(id), {
        method: "POST",
        body: { tags: clean },
      });
      return res.tags ?? clean;
    });
  }

  /**
   * Remove tags. DELETE **with a request body**, on the same path as add.
   *
   * Verified live before being relied on, because it is the repo's first
   * DELETE carrying a body and there was a real chance the client or GHL's
   * gateway would strip it: GHL replies `{"tags":[],"tagsRemoved":[...]}`.
   */
  async removeContactTags(id: string, tags: string[]): Promise<string[]> {
    return this.mutate("contact.tag-remove", { id, tags }, async () => {
      const clean = normaliseTags(tags);
      if (!clean.length) throw new AdminWriteError("No tags given.", "contact.tag-remove", 400);
      const res = await this.client.request<{ tags?: string[] }>(paths.addTags(id), {
        method: "DELETE",
        body: { tags: clean },
      });
      return res.tags ?? [];
    });
  }

  async addContactNote(id: string, body: string): Promise<void> {
    return this.mutate("contact.note", { id }, async () => {
      const text = body.trim();
      if (!text) throw new AdminWriteError("An empty note is not worth writing.", "contact.note", 400);
      // Attributed, because a note that just appears is worse than no note when
      // a colleague is trying to work out who said what.
      const signed = this.deps.operator ? `${text}\n\n— added by ${this.deps.operator} from the console` : text;
      await this.client.request(paths.addNote(id), { method: "POST", body: { body: signed } });
    });
  }

  // ======================================================================
  // Leads
  // ======================================================================

  /**
   * Re-run the CRM work for a lead that did not finish.
   *
   * `lead_events` has carried `attempts`, `lockedAt` and an index the schema
   * itself calls "the sweeper's query" since it was written — but no sweeper and
   * no retry path was ever built, so a failed lead was simply a dead row. This is
   * the manual half: an operator can push one through and see what happens.
   *
   * Safe to repeat because every side effect is individually guarded — the
   * contact upsert matches on email/phone, tags are additive, and `tagsSynced` /
   * `noteAdded` / `opportunityId` record what already happened. Re-running
   * resumes rather than duplicating.
   *
   * `lockedAt` is claimed before the work so a future sweeper and an impatient
   * operator cannot process the same row at once.
   */
  async retryLead(id: string): Promise<{ status: string; attempts: number }> {
    return this.mutate("lead.retry", { id }, async () => {
      const store = this.leadStore;
      const reprocess = this.deps.reprocessLead;
      if (!reprocess) {
        throw new AdminWriteError("Lead retry needs the ingestion pipeline, which is not configured.", "lead.retry", 503);
      }

      const claimed = await store.claimForRetry(id);
      if (!claimed) {
        throw new AdminWriteError(
          "That lead is either already finished, being processed right now, or has already been retried the maximum number of times.",
          "lead.retry",
          409,
        );
      }

      try {
        const result = await reprocess(claimed.id, claimed.lead);
        return { status: result.status, attempts: claimed.attempts };
      } finally {
        // Always released, even on failure — otherwise one bad run would lock
        // the row out of every future retry until the staleness window expired.
        await store.releaseRetryLock(id).catch(() => {});
      }
    });
  }

  // ======================================================================
  // Opportunities
  // ======================================================================

  /**
   * Partial update of a deal. Four traps, each of which bites silently.
   *
   * 1. **Always send `pipelineId` with `pipelineStageId`.** Both are
   *    independently optional, so a stage-only PUT naming a stage from another
   *    pipeline leaves the record pointing at pipeline A with a stage from B.
   *    Only one pipeline exists here today, which is precisely why this would
   *    ship unnoticed and break later.
   * 2. **`monetaryValue` is checked with `!== undefined`, not truthiness.**
   *    `crm/sync.ts` uses `opts.monetaryValue ? ... : {}`, which means 0 can
   *    never be written — and every live deal is currently 0.
   * 3. **Only the four real statuses.** GHL's enum includes `all`, which is a
   *    search filter that leaked into the write schema; `AdminData.opportunities`
   *    even defaults to it. It must not be able to reach a PUT body.
   * 4. **Empty strings are dropped**, not sent, so an untouched field cannot
   *    blank the deal's name.
   */
  async updateOpportunity(id: string, patch: OpportunityPatch): Promise<void> {
    return this.mutate("opportunity.update", { id, fields: Object.keys(patch) }, async () => {
      const body: Record<string, unknown> = {};

      if (patch.name !== undefined && patch.name.trim()) body.name = patch.name.trim();
      if (patch.monetaryValue !== undefined) body.monetaryValue = patch.monetaryValue;

      if (patch.status !== undefined) {
        if (!OPPORTUNITY_STATUSES.includes(patch.status)) {
          throw new AdminWriteError(`"${patch.status}" is not a real opportunity status.`, "opportunity.update", 400);
        }
        body.status = patch.status;
      }

      if (patch.pipelineStageId !== undefined) {
        if (!patch.pipelineId) {
          throw new AdminWriteError(
            "Refusing to move a stage without its pipeline id — that can leave the deal pointing at one pipeline with a stage from another.",
            "opportunity.update",
            400,
          );
        }
        body.pipelineStageId = patch.pipelineStageId;
        body.pipelineId = patch.pipelineId;
      }

      if (!Object.keys(body).length) {
        throw new AdminWriteError("Nothing was changed.", "opportunity.update", 400);
      }

      await this.client.request(paths.opportunity(id), { method: "PUT", body });
    });
  }

  async createOpportunity(input: {
    name: string;
    contactId: string;
    pipelineId: string;
    pipelineStageId: string;
    monetaryValue?: number;
  }): Promise<{ id?: string }> {
    return this.mutate("opportunity.create", { name: input.name, contactId: input.contactId }, async () => {
      if (!input.name.trim()) throw new AdminWriteError("A deal needs a name.", "opportunity.create", 400);
      if (!input.contactId) throw new AdminWriteError("A deal needs a contact.", "opportunity.create", 400);

      const res = await this.client.request<{ opportunity?: { id?: string }; id?: string }>(
        paths.createOpportunity(),
        {
          method: "POST",
          body: {
            locationId: this.client.env.locationId,
            name: input.name.trim(),
            contactId: input.contactId,
            pipelineId: input.pipelineId,
            pipelineStageId: input.pipelineStageId,
            status: "open",
            ...(input.monetaryValue !== undefined ? { monetaryValue: input.monetaryValue } : {}),
          },
          // Create is not idempotent and there is no key to make it so. A
          // retried 502 that actually succeeded would produce two deals.
          maxAttempts: 1,
        },
      );
      return { id: res.opportunity?.id ?? res.id };
    });
  }

  // ======================================================================
  // Social posts
  // ======================================================================

  async editSocialPost(
    postId: string,
    changes: { summary?: string; scheduleDate?: string; status?: string },
  ): Promise<void> {
    return this.mutate("social.edit", { postId }, async () => {
      // Read-modify-write happens inside the client, because GHL's edit is not a
      // patch: a bare {type, summary} PUT 422s on missing accountIds.
      await this.social.editPost(postId, changes);
    });
  }

  async deleteSocialPost(postId: string): Promise<void> {
    return this.mutate("social.delete", { postId }, async () => {
      try {
        await this.social.deletePost(postId);
      } catch (err) {
        // A post someone already removed in the GHL UI is in the desired state.
        // Reporting that as a failure would send the operator hunting for a
        // problem that does not exist.
        if (!String(err).includes("404")) throw err;
      }
    });
  }

  /**
   * Delete several posts in one operation.
   *
   * Sequential, not parallel: GHL rate-limits, and a burst of deletes that
   * half-succeeds is worse than a slower one that reports precisely which rows
   * went. Each result is returned individually so the UI can say "3 of 4
   * deleted, this one failed because…" rather than a single opaque outcome.
   */
  async deleteSocialPosts(postIds: string[]): Promise<{ id: string; ok: boolean; error?: string }[]> {
    return this.mutate("social.delete", { count: postIds.length }, async () => {
      const out: { id: string; ok: boolean; error?: string }[] = [];
      for (const id of postIds.slice(0, 50)) {
        try {
          await this.social.deletePost(id);
          out.push({ id, ok: true });
        } catch (err) {
          // A post someone already removed in the GHL UI is in the desired state.
          if (String(err).includes("404")) out.push({ id, ok: true });
          else out.push({ id, ok: false, error: String(err).slice(0, 160) });
        }
      }
      return out;
    });
  }

  private get social(): SocialClient {
    return (this._social ??= new SocialClient(this.client));
  }
  private _social?: SocialClient;

  // ======================================================================
  // Conversation replies — the highest-risk write in the console.
  // ======================================================================

  /**
   * Reply to a conversation, on a channel that can actually reach the person.
   *
   * Sends through GHL, then appends the same text to OUR transcript as an
   * `admin` turn. Both halves matter: without the send nothing reaches the
   * customer, and without the append the detail page would show the customer's
   * messages and not the operator's own reply — which reads as a broken page and
   * loses the record of what was said.
   *
   * The append is best-effort and deliberately after the send. If it fails, a
   * real message has already gone out and the operator must be told it was sent;
   * throwing here would invite them to send it a second time.
   */
  async replyToConversation(input: {
    conversationId: string;
    contactId: string;
    channel: SendableChannel;
    message: string;
    subject?: string;
  }): Promise<{ messageId?: string; appended: boolean }> {
    return this.mutate(
      "conversation.reply",
      { conversationId: input.conversationId, channel: input.channel },
      async () => {
        const text = input.message.trim();
        if (!text) throw new AdminWriteError("Nothing to send.", "conversation.reply", 400);
        if (text.length > 5000) {
          throw new AdminWriteError("That message is too long to send.", "conversation.reply", 400);
        }
        if (!input.contactId) {
          throw new AdminWriteError(
            "This conversation has no CRM contact. GoHighLevel threads messages by contact, so there is no way to reach this person — they were an anonymous web visitor.",
            "conversation.reply",
            422,
          );
        }
        if (input.channel === "SMS") {
          const sms = smsAvailability();
          if (!sms.available) throw new AdminWriteError(sms.reason!, "conversation.reply", 503);
        }

        const convos = this.deps.conversations;

        /**
         * Duplicate guard. GHL's send endpoint offers no idempotency key, so a
         * double-click, a browser retry or an impatient second click after a slow
         * response sends the customer the same message twice. The UI disables the
         * button for the round trip; this is the half that survives a reload.
         */
        if (convos) {
          const existing = await convos.get(input.conversationId).catch(() => null);
          const recent = existing?.messages.slice(-4) ?? [];
          const dupe = recent.find(
            (m) =>
              m.role === "admin" &&
              m.text === text &&
              Date.now() - new Date(m.at).getTime() < 5 * 60_000,
          );
          if (dupe) {
            throw new AdminWriteError(
              "That exact message was already sent to this person in the last few minutes. Sending it again would be a duplicate.",
              "conversation.reply",
              409,
            );
          }
        }

        const result = await sendMessage(
          {
            channel: input.channel,
            contactId: input.contactId,
            message: text,
            subject: input.channel === "Email" ? (input.subject?.trim() || "Following up") : undefined,
          },
          this.client,
        );

        let appended = false;
        if (convos) {
          appended = await convos
            .append(input.conversationId, { role: "admin", text, at: new Date().toISOString() })
            .then(() => true)
            .catch(() => false);
        }

        return { messageId: result.messageId, appended };
      },
    );
  }

  // ======================================================================
  // The email queue
  //
  // With LEAD_AUTOSEND defaulting to `dry_run`, the agent composes a follow-up
  // for every lead and never sends it. That is the system's NORMAL state, not an
  // error path — so these rows pile up, and until now there was no way to read
  // one, let alone send it.
  //
  // Note what does NOT gate a manual send: `LEAD_AUTOSEND` itself. That flag
  // governs UNATTENDED sending, and an operator reading a message and pressing
  // Send is precisely the human approval `dry_run` exists to require. Gating on
  // it would make the queue unusable in exactly the mode that creates it. The
  // allowlist DOES still apply, because it answers a different question — which
  // real addresses may be written to while the sending domain is unverified.
  // ======================================================================

  private get leadStore(): LeadStore {
    const store = this.deps.leads;
    if (!store) throw new AdminWriteError("The email queue needs DATABASE_URL.", "email", 503);
    return store;
  }

  async sendQueuedEmail(id: string): Promise<{ email: LeadEmailRow; messageId?: string }> {
    return this.mutate("email.send", { id }, async () => {
      const store = this.leadStore;
      const row = await store.getEmail(id);
      if (!row) throw new AdminWriteError(`No composed email with id ${id}.`, "email.send", 404);

      if (row.status === "sent") {
        throw new AdminWriteError(
          `That email was already sent${row.sentAt ? ` on ${new Date(row.sentAt).toLocaleString()}` : ""}. Sending again would be a duplicate.`,
          "email.send",
          409,
        );
      }
      if (!row.contactId) {
        throw new AdminWriteError(
          "This email has no CRM contact attached, and GoHighLevel threads outbound mail by contact — there is nowhere to send it from.",
          "email.send",
          422,
        );
      }
      if (!row.recipient) {
        throw new AdminWriteError("No recipient address was recorded for this email.", "email.send", 422);
      }
      if (!allowlisted(row.recipient)) {
        throw new AdminWriteError(
          `${row.recipient} is not in LEAD_AUTOSEND_ALLOWLIST, so sending to it is blocked. Add it there, or clear the allowlist to permit any recipient.`,
          "email.send",
          403,
        );
      }

      try {
        const result = await sendEmail(
          { contactId: row.contactId, email: { subject: row.subject, body: row.body } },
          this.client,
        );
        await store.markEmailSent(id, result.messageId);
        return { email: { ...row, status: "sent" }, messageId: result.messageId };
      } catch (err) {
        // Recorded, not just thrown: a failed send must be visible on the row
        // afterwards, or the operator has no idea why nothing happened.
        await store.markEmailFailed(id, String(err)).catch(() => {});
        throw err;
      }
    });
  }

  async discardQueuedEmail(id: string): Promise<LeadEmailRow> {
    return this.mutate("email.discard", { id }, async () => {
      const store = this.leadStore;
      const row = await store.getEmail(id);
      if (!row) throw new AdminWriteError(`No composed email with id ${id}.`, "email.discard", 404);
      if (row.status === "sent") {
        throw new AdminWriteError("That email has already gone out — it cannot be discarded.", "email.discard", 409);
      }
      await store.markEmailDiscarded(id);
      return { ...row, status: "discarded" };
    });
  }

  async rescheduleBooking(code: string, newStart: string): Promise<Booking> {
    return this.mutate("booking.reschedule", { code, newStart }, async () => {
      const store = this.bookingStore;
      if (!store.reschedule) {
        throw new AdminWriteError("This booking backend cannot reschedule.", "booking.reschedule", 501);
      }
      const result = await store.reschedule(code, newStart);
      if (!result) {
        throw new AdminWriteError(
          `Couldn't move ${code} — it is either already cancelled or not a reference we hold.`,
          "booking.reschedule",
          404,
        );
      }
      return result;
    });
  }
}
