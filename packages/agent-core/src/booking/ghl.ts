import { GhlClient } from "../ghl/client.js";
import { DATE_KEY, paths } from "../ghl/endpoints.js";
import { calendarIdFor } from "../env.js";
import { normalizePhone, splitName } from "../crm/contacts.js";
import type { BookingIndex } from "./index-store.js";
import type { Resource } from "../industries/types.js";
import type {
  AvailabilityQuery,
  Booking,
  BookingRequest,
  BookingStore,
  Slot,
} from "./types.js";

/**
 * The real store. Same interface as MemoryBookingStore, so swapping it in is a
 * one-line change in the worker and the agent's prompt and tools don't move.
 *
 * Everything the free-slots response does that a naive reader would get wrong
 * is handled here rather than at the call site:
 *
 *  - `startDate`/`endDate` are epoch **milliseconds**, not ISO. Confirmed live.
 *  - The response is keyed by date, but `traceId` sits alongside those keys, so
 *    an `Object.entries` walk without the date filter treats it as a day and
 *    crashes on `.slots`.
 *  - Slot strings carry the calendar's own offset (`+05:00`, `-05:00`). Never
 *    re-parse them into another zone — pass them back exactly as received.
 */

const PART_OF_DAY: Record<string, [number, number]> = {
  morning: [0, 12],
  afternoon: [12, 17],
  evening: [17, 24],
};

/** Read aloud over the phone, so no characters that sound alike. */
const CODE_ALPHABET = "23456789ACDEFGHJKMNPQRTUVWXYZ";

export class GhlBookingStore implements BookingStore {
  readonly kind = "ghl" as const;

  private readonly resources: Map<string, Resource>;

  constructor(
    resources: Resource[],
    private readonly client: GhlClient = new GhlClient(),
    /**
     * Our own reference → appointment index. Optional: without it bookings still
     * work, but the agent can't look one up or cancel it, because GHL has no
     * lookup-by-our-reference endpoint.
     */
    private readonly index?: BookingIndex,
    private readonly industry = "unknown",
  ) {
    this.resources = new Map(resources.map((r) => [r.id, r]));
  }

  async findSlots(query: AvailabilityQuery): Promise<Slot[]> {
    const resource = this.resources.get(query.resourceId);
    if (!resource) return [];

    // A whole local day, in epoch millis. Widened by a day either side so a
    // caller near midnight, or a calendar in a different zone to ours, doesn't
    // fall off the end of the window.
    const day = new Date(`${query.date}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) return [];
    const startDate = day.getTime() - 24 * 3600_000;
    const endDate = day.getTime() + 48 * 3600_000;

    const res = await this.client.request<Record<string, unknown>>(
      paths.freeSlots(calendarIdFor(query.resourceId)),
      { query: { startDate: String(startDate), endDate: String(endDate) } },
    );

    const [fromH, toH] = query.partOfDay ? (PART_OF_DAY[query.partOfDay] ?? [0, 24]) : [0, 24];
    const slots: Slot[] = [];

    for (const [key, value] of Object.entries(res)) {
      // `traceId` and friends live here too — only date-shaped keys are days.
      if (!DATE_KEY.test(key) || key !== query.date) continue;
      const raw = (value as { slots?: unknown }).slots;
      if (!Array.isArray(raw)) continue;

      for (const start of raw) {
        if (typeof start !== "string") continue;
        // Hour as the calendar reports it, read off the string rather than via
        // Date, which would shift it into this process's timezone.
        const hour = Number(start.slice(11, 13));
        if (Number.isNaN(hour) || hour < fromH || hour >= toH) continue;

        slots.push({
          start,
          end: new Date(new Date(start).getTime() + resource.durationMin * 60_000).toISOString(),
          label: this.speak(start),
        });
      }
    }

    // Two or three options is a conversation. Ten read aloud is unbearable — so
    // the default stays 3 for the voice agent, and the admin slot picker asks
    // for more explicitly.
    return slots.slice(0, query.limit ?? 3);
  }

  async create(request: BookingRequest): Promise<Booking> {
    const resource = this.resources.get(request.resourceId);
    if (!resource) throw new Error(`Unknown resource ${request.resourceId}`);

    const contact = await this.upsertContact(request);
    const end = new Date(new Date(request.start).getTime() + resource.durationMin * 60_000);

    const appt = await this.client.request<{ id?: string; appointmentId?: string }>(
      paths.bookAppointment(),
      {
        method: "POST",
        body: {
          calendarId: calendarIdFor(request.resourceId),
          locationId: this.client.env.locationId,
          contactId: contact.id,
          startTime: request.start,
          endTime: end.toISOString(),
          title: `${resource.label} — ${request.contact.full_name ?? "guest"}`,
          appointmentStatus: "confirmed",
        },
      },
    );

    const code = this.codeFrom(appt.id ?? appt.appointmentId ?? request.start);

    // The reference the caller is given has to survive a lookup later, and GHL
    // won't store our short code — so it goes in a note against the contact,
    // which is also where a human will look for it.
    await this.client
      .request(paths.addNote(contact.id), {
        method: "POST",
        body: {
          body:
            `Booking ${code} — ${resource.label} at ${this.speak(request.start)}.\n` +
            Object.entries(request.details)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n"),
        },
      })
      .catch(() => {
        /* the appointment is what matters; a missing note must not fail it */
      });

    const booking: Booking = {
      ...request,
      // Carry the GHL contact id forward. Everything downstream — tagging,
      // scoring, the transcript note — needs it, and re-looking-it-up by email
      // is both slower and ambiguous when two people share an address.
      contact: { ...request.contact, contactId: contact.id },
      code,
      status: "confirmed",
      end: end.toISOString(),
      externalId: appt.id ?? appt.appointmentId,
    };

    // Indexed so it can be found and cancelled later. Non-fatal if it fails:
    // the appointment is real and in the CRM either way, and refusing a booking
    // because our index hiccuped would be the wrong trade.
    await this.index?.record(booking, this.industry).catch(() => {});

    return booking;
  }

  async find(code: string): Promise<Booking | null> {
    if (!this.index) return null;
    const found = await this.index.byCode(code);
    return found ? this.toBooking(found) : null;
  }

  /** Bookings someone can be reminded of when they don't have their reference. */
  async findByContact(contact: { email?: string; phone?: string }): Promise<Booking[]> {
    if (!this.index) return [];
    return (await this.index.byContact(contact)).map((b) => this.toBooking(b));
  }

  async cancel(code: string): Promise<Booking | null> {
    if (!this.index) return null;
    const found = await this.index.byCode(code);
    if (!found || found.status === "cancelled") return null;

    // Free the slot in GHL first. If that fails we must NOT mark it cancelled
    // locally — telling a guest their table is released while it still holds the
    // slot is the worse of the two failures.
    //
    // Verifying a deletion: do NOT trust `GET /calendars/events/appointments/{id}`.
    // It keeps returning `appointmentStatus: "confirmed"` for an appointment that
    // is genuinely gone, which reads exactly like a failed cancel. Query the
    // calendar's event list instead — that reflects reality.
    if (found.externalId) {
      await this.client.request(paths.getAppointment(found.externalId), { method: "DELETE" });
    }
    await this.index.markCancelled(code);

    return { ...this.toBooking(found), status: "cancelled" };
  }

  /**
   * Cancel and rebook in one step. Books the new slot *before* releasing the old
   * one, so a guest moving a reservation can never end up with neither — if the
   * new time turns out to be gone, they still have the original.
   */
  async reschedule(code: string, newStart: string): Promise<Booking | null> {
    if (!this.index) return null;
    const existing = await this.index.byCode(code);
    if (!existing || existing.status === "cancelled") return null;

    const replacement = await this.create({
      resourceId: existing.resourceId,
      start: newStart,
      contact: {
        full_name: existing.fullName ?? "",
        email: existing.email ?? "",
        phone: existing.phone ?? "",
        ...(existing.contactId ? { contactId: existing.contactId } : {}),
      },
      details: existing.details,
    });

    if (existing.externalId) {
      await this.client
        .request(paths.getAppointment(existing.externalId), { method: "DELETE" })
        .catch(() => {
          /* new booking already holds; a stale old one is a cleanup problem */
        });
    }
    await this.index.markReplaced(code, replacement.code);

    return replacement;
  }

  private toBooking(b: {
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
  }): Booking {
    return {
      code: b.code,
      externalId: b.externalId,
      resourceId: b.resourceId,
      start: b.startsAt,
      end: b.endsAt,
      // NOTE: this collapses GHL's real vocabulary. GHL also has `showed`,
      // `noshow` and `invalid` — one live appointment is `showed` right now — and
      // they all arrive here as "confirmed". Callers that need the true status
      // must read it off the live calendar event, not off a `Booking`.
      status: b.status === "cancelled" ? "cancelled" : "confirmed",
      contact: {
        // Carried so a booking read back from the index can be rescheduled or
        // re-booked without re-upserting the contact from name fragments — see
        // the short-circuit in `upsertContact`.
        ...(b.contactId ? { contactId: b.contactId } : {}),
        ...(b.fullName ? { full_name: b.fullName } : {}),
        ...(b.email ? { email: b.email } : {}),
        ...(b.phone ? { phone: b.phone } : {}),
      },
      details: b.details,
    };
  }

  /**
   * Resolve the contact to book against.
   *
   * Two things here exist to prevent the same data-loss bug, from two directions.
   *
   * 1. **The short-circuit.** When the caller already knows the contact id we do
   *    NOT write at all. GHL's upsert matches on email/phone and has no
   *    `contactId` parameter, so re-upserting a known contact from whatever
   *    fragments we happen to hold can only ever degrade the record it matches.
   *    `reschedule` hits this path with a name read back from our index
   *    (`existing.fullName ?? ""`), which is nullable — so without the
   *    short-circuit, rescheduling a booking whose row has no name would send
   *    `firstName: "Guest"` and rename a real customer. An admin console makes
   *    that one click away.
   *
   * 2. **The shared `splitName`.** This used to hand-roll the name split and
   *    hardcode `firstName || "Guest"`, which is exactly the copy that
   *    `crm/contacts.ts:5-7` warns about ("a copy that drifts is a bug that comes
   *    back") — it never received the `defaultFirstName` fix written for it.
   *    "Guest" is genuinely right *here*, for a real anonymous walk-up booking,
   *    which is why it is passed explicitly rather than defaulted.
   *
   * Not routed through `CrmSync.upsertContact` despite sharing the helper:
   * `CrmSync` promises never to throw (`crm/sync.ts:17-19`) and returns `null` on
   * failure, which would turn a real 422 here into the generic "returned no
   * contact id" below and lose the reason. Consolidating needs a throwing variant
   * of that method; that belongs with the admin writer work, not here.
   */
  private async upsertContact(request: BookingRequest): Promise<{ id: string }> {
    const { full_name, phone, email, contactId } = request.contact;
    if (contactId) return { id: contactId };

    const res = await this.client.request<{ contact?: { id?: string }; id?: string }>(
      paths.upsertContact(),
      {
        method: "POST",
        body: {
          locationId: this.client.env.locationId,
          ...splitName(full_name, "Guest"),
          phone: normalizePhone(phone),
          email: email || undefined,
          // NOTE: this location has ZERO custom fields defined, so these writes
          // currently go nowhere — the same silent no-op `crm/sync.ts:94-99`
          // documents for lead_score. The booking details a caller gave us
          // deserve to land on the appointment note instead; tracked separately.
          customFields: Object.entries(request.details)
            .filter(([, v]) => v != null && v !== "")
            .map(([key, value]) => ({ key, field_value: value })),
        },
      },
    );

    const id = res.contact?.id ?? res.id;
    if (!id) throw new Error("GHL upsert returned no contact id");
    return { id };
  }

  /** Stable per appointment, so the same booking always reads the same aloud. */
  private codeFrom(seed: string): string {
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    let out = "";
    for (let i = 0; i < 6; i++) {
      out += CODE_ALPHABET[h % CODE_ALPHABET.length];
      h = Math.floor(h / CODE_ALPHABET.length) + 7919 * (i + 1);
    }
    return out;
  }

  private speak(iso: string): string {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
}
