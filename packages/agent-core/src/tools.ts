import { z } from "zod";
import type { IndustryConfig } from "./industries/types.js";
import type { BookingStore } from "./booking/types.js";

/**
 * Transport-agnostic tool definitions. `apps/agent` wraps these for LiveKit;
 * the email channel will call `execute` directly. The brain does not import a
 * realtime framework — that framework is the wrong shape for correspondence
 * that happens days apart, and this is the boundary that keeps it out.
 */
export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: S;
  execute(args: z.infer<S>): Promise<string>;
}

/**
 * Hooks so a caller can observe what the tools did without the tools knowing
 * who's listening. The worker uses this to record the booking and the contact
 * details onto the conversation, which is what makes a follow-up email specific
 * rather than generic.
 */
export interface ToolEvents {
  onBooked?(info: { code: string; resourceId: string; start: string; contact: Record<string, string> }): void;
  onHandoff?(info: { reason: string; summary: string }): void;
  /**
   * Something a human has to quote or coordinate — multiple rooms, an event, a
   * large party. Not a booking, but a lead worth more than most bookings, so it
   * has to land in the CRM as a real opportunity with the details attached.
   */
  onEnquiry?(info: {
    kind: string;
    summary: string;
    details: Record<string, string>;
    contact: Record<string, string>;
  }): void;
}

/** Tool results are read aloud, so they return prose the agent can speak. */
export function createTools(
  cfg: IndustryConfig,
  store: BookingStore,
  events: ToolEvents = {},
): ToolDef[] {
  const resourceIds = cfg.resources.map((r) => r.id);
  const resourceList = cfg.resources.map((r) => `${r.id} (${r.label})`).join(", ");

  const checkAvailability: ToolDef = {
    name: "checkAvailability",
    description:
      `Find open times. Call this before offering any time — never guess. Resources: ${resourceList}.`,
    parameters: z.object({
      resourceId: z.string().describe(`One of: ${resourceIds.join(", ")}`),
      date: z.string().describe("Target date as YYYY-MM-DD, resolved from what the caller said"),
      partOfDay: z
        .enum(["morning", "afternoon", "evening"])
        .optional()
        .describe("Only when the caller expressed a preference"),
      partySize: z.number().optional().describe("Number of people, where it applies"),
    }),
    async execute({ resourceId, date, partOfDay, partySize }) {
      const slots = await store.findSlots({ resourceId, date, partOfDay, partySize });
      if (!slots.length) {
        return `Nothing open for ${resourceId} on ${date}${partOfDay ? ` in the ${partOfDay}` : ""}. Offer a different day or time of day.`;
      }
      return [
        `Open times on ${date}:`,
        ...slots.map((s) => `- ${s.label} (start=${s.start})`),
        "Offer these. Pass the exact start value to createBooking.",
      ].join("\n");
    },
  };

  const createBooking: ToolDef = {
    name: "createBooking",
    description:
      "Reserve a specific time. Only call once you hold every required contact detail. " +
      "Do not tell the caller it is confirmed until this returns success.",
    parameters: z.object({
      resourceId: z.string().describe(`One of: ${resourceIds.join(", ")}`),
      start: z.string().describe("Exact start value returned by checkAvailability"),
      contact: z
        .record(z.string())
        .describe(`Keys: ${cfg.contact.map((c) => c.key).join(", ")}`),
      details: z.record(z.string()).optional().describe("Everything else collected"),
    }),
    async execute({ resourceId, start, contact, details }) {
      const missing = cfg.contact
        .filter((f) => f.required && !contact[f.key]?.trim())
        .map((f) => f.key);
      if (missing.length) {
        return `Not booked — still missing: ${missing.join(", ")}. Ask for those first.`;
      }
      try {
        const booking = await store.create({ resourceId, start, contact, details: details ?? {} });
        // `booking.contact`, not the input `contact` — the store enriches it
        // with the CRM's contactId, and everything downstream (tagging,
        // scoring, the transcript note) is keyed on that id.
        events.onBooked?.({
          code: booking.code,
          resourceId,
          start,
          contact: { ...booking.contact, ...(details ?? {}) },
        });
        return `Confirmed. Reference ${booking.code}, ${new Date(booking.start).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}. Give the caller the reference.`;
      } catch (err) {
        return `Not booked — ${err instanceof Error ? err.message : "failed"}. Apologise briefly and offer another time from checkAvailability.`;
      }
    },
  };

  const speak = (iso: string) =>
    new Date(iso).toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  const lookupBooking: ToolDef = {
    name: "lookupBooking",
    description:
      "Find an existing reservation. Use the confirmation reference if they have it; " +
      "otherwise look it up by their email or phone — most people don't have the " +
      "reference to hand.",
    parameters: z.object({
      code: z.string().optional().describe("Confirmation reference, if they have it"),
      email: z.string().optional().describe("Their email, if no reference"),
      phone: z.string().optional().describe("Their phone, if no reference"),
    }),
    async execute({ code, email, phone }) {
      if (code) {
        const booking = await store.find(code);
        if (booking) {
          return `Found ${booking.code}: ${booking.resourceId}, ${speak(booking.start)}, under ${booking.contact.full_name ?? "unknown"} (${booking.status}). Read the details back before changing anything.`;
        }
        // A mistyped or misheard code is common — fall through to contact lookup
        // rather than dead-ending the caller.
        if (!email && !phone) {
          return `Nothing under ${code}. Ask them to re-read it, or ask for the email or phone it was booked with.`;
        }
      }

      if (!email && !phone) {
        return "Need a reference, an email, or a phone number to look anything up. Ask for one.";
      }

      const byContact = store.findByContact
        ? await store.findByContact({ email, phone })
        : [];
      if (!byContact.length) {
        return "No upcoming reservations found for those details. Offer to check a different email or phone, or hand to a human.";
      }
      return [
        `Found ${byContact.length} upcoming:`,
        ...byContact.map((b) => `- ${b.code}: ${b.resourceId}, ${speak(b.start)}`),
        "Confirm which one they mean before changing anything.",
      ].join("\n");
    },
  };

  const rescheduleBooking: ToolDef = {
    name: "rescheduleBooking",
    description:
      "Move an existing reservation to a new time. Check the new time is free with " +
      "checkAvailability first, and confirm the change back to them before calling this.",
    parameters: z.object({
      code: z.string().describe("Confirmation reference of the booking being moved"),
      start: z.string().describe("New start, exactly as returned by checkAvailability"),
    }),
    async execute({ code, start }) {
      if (!store.reschedule) {
        return "Rescheduling isn't available here — cancel and rebook instead, or hand to a human.";
      }
      try {
        const moved = await store.reschedule(code, start);
        if (!moved) return `Couldn't find an active booking under ${code}. Look it up first.`;
        return `Moved. New reference ${moved.code}, now ${speak(moved.start)}. Give them the new reference — the old one no longer applies.`;
      } catch (err) {
        return `Not moved — ${err instanceof Error ? err.message : "failed"}. Their original booking is still intact; offer another time.`;
      }
    },
  };

  const cancelBooking: ToolDef = {
    name: "cancelBooking",
    description:
      "Cancel a reservation. Look it up and read the details back first — this cannot " +
      "be undone, and cancelling the wrong booking is much worse than asking twice.",
    parameters: z.object({
      code: z.string().describe("Confirmation reference"),
      confirmed: z
        .boolean()
        .describe("True only once the caller has explicitly confirmed THIS booking"),
    }),
    async execute({ code, confirmed }) {
      if (!confirmed) {
        return "Not cancelled. Read the booking back and get an explicit yes first.";
      }
      try {
        const booking = await store.cancel(code);
        if (!booking) return `No active reservation under ${code}. Nothing cancelled.`;
        return `Cancelled ${code}. Say so plainly and offer to rebook.`;
      } catch (err) {
        return `Not cancelled — ${err instanceof Error ? err.message : "failed"}. Their booking still stands; tell them a human will sort it.`;
      }
    },
  };

  /**
   * The honest version of "I've flagged this for our team."
   *
   * Some requests can't be self-served: several rooms at once, an event, a party
   * too large for the normal calendar. The agent can't book those and shouldn't
   * pretend to — but abandoning the caller with "someone will call you" and no
   * record is worse than not answering the phone. These are usually the most
   * valuable leads that come in.
   *
   * So it records a real opportunity with every detail collected, and only then
   * tells the caller it's been passed on.
   */
  const recordEnquiry: ToolDef = {
    name: "recordEnquiry",
    description:
      "Log a request that needs a human to quote or arrange — multiple rooms, an event, " +
      "a large party, anything you cannot book yourself. Collect the dates, the numbers " +
      "and their contact details FIRST, then call this. Only after it succeeds may you " +
      "tell them it has been passed to the team.",
    parameters: z.object({
      kind: z
        .string()
        .describe("Short label: 'multiple rooms', 'wedding', 'corporate event', 'large party'"),
      summary: z
        .string()
        .describe("One or two sentences a colleague could act on without listening to the call"),
      details: z
        .record(z.string())
        .describe(
          "Everything concrete: dates, number of rooms, headcount, occasion, budget, " +
            "special requests. Use the caller's own numbers, not approximations.",
        ),
      contact: z
        .record(z.string())
        .describe(`Keys: ${cfg.contact.map((c) => c.key).join(", ")}`),
    }),
    async execute({ kind, summary, details, contact }) {
      // Same requirement as a booking: an enquiry nobody can reply to is not a
      // lead. This is also what stops the agent "logging" an anonymous request.
      const missing = cfg.contact
        .filter((f) => f.required && !contact[f.key]?.trim())
        .map((f) => f.key);
      if (missing.length) {
        return `Not logged — still missing: ${missing.join(", ")}. Ask for those before telling them it's been passed on.`;
      }

      events.onEnquiry?.({ kind, summary, details, contact });
      return (
        `Logged as a ${kind} enquiry for the team, with the details. ` +
        `Now you may tell them someone will be in touch — say roughly when, and confirm ` +
        `the number you have.`
      );
    },
  };

  const handoffToHuman: ToolDef = {
    name: "handoffToHuman",
    description:
      "Hand to a person. Call this the moment someone asks for a human, is upset, or " +
      "wants something you have no grounded answer for. Never argue first.",
    parameters: z.object({
      reason: z.string().describe("Why, in one line — this goes to the team"),
      summary: z.string().describe("What the caller needs, so nobody makes them repeat it"),
    }),
    async execute({ reason, summary }) {
      events.onHandoff?.({ reason, summary });
      // Day 8 tags the CRM contact and notifies the team. Logged until then so
      // the handoff is at least observable in a demo.
      console.log(`[handoff] ${reason} :: ${summary}`);
      return `Flagged for a callback on ${cfg.business.phone}. Tell them someone will call shortly, and confirm the number to use.`;
    },
  };

  return [
    checkAvailability,
    createBooking,
    lookupBooking,
    rescheduleBooking,
    cancelBooking,
    recordEnquiry,
    handoffToHuman,
  ];
}
