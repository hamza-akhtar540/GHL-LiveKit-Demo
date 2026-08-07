/**
 * Every GHL path and query-param name lives here. Nowhere else.
 *
 * The public docs are client-rendered and don't reliably expose exact param
 * names, so anything marked VERIFY is our best read of the v2 surface and gets
 * confirmed against the live API by `pnpm ghl:smoke` on day 1. When a name is
 * wrong, it is wrong in exactly one place.
 */

export const GHL_BASE = "https://services.leadconnectorhq.com";

/**
 * v2 resources. Note: GHL is rolling v3 out per-resource (Users, Opportunities
 * have v3 pages as of mid-2026). Calendars and Contacts are still v2 under the
 * 2021-07-28 Version header. Revisit if we start using Opportunities heavily.
 */
export const paths = {
  freeSlots: (calendarId: string) => `/calendars/${calendarId}/free-slots`,
  upsertContact: () => `/contacts/upsert`,
  /**
   * A single contact, and the ONLY safe source for an edit form.
   *
   * VERIFIED live, and it is a silent data-loss trap: this endpoint returns
   * `firstName: "Hina"` correctly cased, while the `listContacts` collection
   * below returns the SAME person as `firstName: "hina"`, lowercased, with the
   * true casing tucked away in `firstNameRaw`/`lastNameRaw`. Prefill a form from
   * a list row and PUT it back and you permanently downcase a real customer's
   * name — with no error, even if the operator only meant to fix a postcode.
   *
   * Also the endpoint to PUT to for a partial update: it preserves every field
   * you omit. `upsertContact` cannot do this job — it has no contactId
   * parameter at all and resolves identity by email/phone, so editing a typo'd
   * email there edits a different contact or creates a third one.
   */
  getContact: (contactId: string) => `/contacts/${contactId}`,
  bookAppointment: () => `/calendars/events/appointments`,
  getAppointment: (id: string) => `/calendars/events/appointments/${id}`,
  sendMessage: () => `/conversations/messages`,
  addNote: (contactId: string) => `/contacts/${contactId}/notes`,
  listCalendars: () => `/calendars/`,
  /**
   * POST adds tags; **DELETE on this same path removes them**, with the tags to
   * remove in the request body. There is no separate remove-tags path.
   *
   * Never write tags through `getContact`'s PUT instead: its `tags` field
   * REPLACES the whole set, so it would silently drop `lead-hot`, `ai-qualified`,
   * `needs-human` and anything else added since the page loaded — and those tags
   * drive GHL automations, so the blast radius is workflow membership, not just a
   * label. GHL's own schema says to use add/remove for this reason.
   */
  addTags: (contactId: string) => `/contacts/${contactId}/tags`,
  createOpportunity: () => `/opportunities/`,
  /** One opportunity: GET to read, PUT to partially update. */
  opportunity: (id: string) => `/opportunities/${id}`,
  /** Alias of `opportunity`, kept so existing write call sites still read clearly. */
  updateOpportunity: (id: string) => `/opportunities/${id}`,
  /**
   * The reliable way to confirm an appointment exists. Do NOT use
   * `getAppointment` for that — it keeps returning `confirmed` for an
   * appointment that has genuinely been deleted, which reads exactly like a
   * failed cancellation. Needs startTime/endTime as epoch-millisecond *strings*.
   *
   * VERIFIED live: also requires `locationId`, and one of `calendarId`, `userId`
   * or `groupId`. The published schema mentions neither `locationId` nor that
   * requirement, so implementing from the schema alone yields a guaranteed
   * 400 `{"message":"Location ID is required"}`.
   *
   * Prefer fanning out per `calendarId` over the single `userId` shortcut: userId
   * filters on the appointment's assigned user, so a round-robin calendar with
   * two team members would silently return only half its appointments.
   */
  calendarEvents: () => `/calendars/events`,

  // --- Admin dashboard reads. All GET, all live — nothing here is cached by
  // us except where a store explicitly snapshots it (see social/schema.ts). ---
  listContacts: () => `/contacts/`,
  /**
   * Tasks on a contact — "call them back on Tuesday" as a first-class record
   * rather than prose buried in a note. Envelope is `{tasks: [...]}`.
   */
  contactTasks: (contactId: string) => `/contacts/${contactId}/tasks`,
  searchOpportunities: () => `/opportunities/search`,
  pipelines: () => `/opportunities/pipelines`,
  searchConversations: () => `/conversations/search`,
  conversationMessages: (conversationId: string) => `/conversations/${conversationId}/messages`,
} as const;

/**
 * Query-param names for free-slots.
 * VERIFY: startDate/endDate are epoch milliseconds as strings on v2 (not ISO).
 * The smoke test prints the raw response so we confirm this immediately.
 */
export const freeSlotsParams = {
  startDate: "startDate",
  endDate: "endDate",
  timezone: "timezone",
  userId: "userId",
} as const;

/**
 * The free-slots response is an availability map keyed by YYYY-MM-DD, with a
 * `slots` array of ISO strings per day, plus non-date keys we must ignore:
 *
 *   { "2026-07-21": { "slots": ["2026-07-21T09:00:00-05:00", ...] },
 *     "traceId": "..." }
 *
 * VERIFY the exact envelope on first run — `traceId` sitting alongside date
 * keys is the kind of thing that silently breaks a naive Object.entries walk.
 */
export const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
