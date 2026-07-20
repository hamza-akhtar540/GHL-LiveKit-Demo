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
  getContact: (contactId: string) => `/contacts/${contactId}`,
  bookAppointment: () => `/calendars/events/appointments`,
  getAppointment: (id: string) => `/calendars/events/appointments/${id}`,
  sendMessage: () => `/conversations/messages`,
  addNote: (contactId: string) => `/contacts/${contactId}/notes`,
  listCalendars: () => `/calendars/`,
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
