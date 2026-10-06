/**
 * Fail loudly at startup rather than with a confusing 401 six calls deep.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

export interface GhlEnv {
  pit: string;
  locationId: string;
  /**
   * Legacy single-calendar id. Optional now that each bookable resource has its
   * own — see `calendarIdFor`. Kept as the fallback for single-resource
   * verticals like roofing, where one calendar is the whole story.
   */
  calendarId?: string;
  timezone: string;
  apiVersion: string;
}

/**
 * A GHL calendar per bookable resource.
 *
 * A hotel books rooms AND restaurant tables — different durations, different
 * opening hours, different people looking at them. They cannot share one
 * calendar, so each resource id maps to its own:
 *
 *   room  -> GHL_CALENDAR_ROOM
 *   table -> GHL_CALENDAR_TABLE
 *
 * Single-resource verticals (roofing has only `inspection`) can keep using the
 * plain GHL_CALENDAR_ID, which is the fallback.
 */
export function calendarIdFor(resourceId: string): string {
  const specific = process.env[`GHL_CALENDAR_${resourceId.toUpperCase()}`];
  if (specific?.trim()) return specific.trim();

  const fallback = process.env.GHL_CALENDAR_ID;
  if (fallback?.trim()) return fallback.trim();

  throw new Error(
    `No calendar configured for resource "${resourceId}". Set GHL_CALENDAR_${resourceId.toUpperCase()} ` +
      `in .env..`,
  );
}

/** Only the vars needed to talk to GHL. Called lazily so unrelated code doesn't blow up. */
export function ghlEnv(): GhlEnv {
  return {
    pit: req("GHL_PIT"),
    locationId: req("GHL_LOCATION_ID"),
    calendarId: process.env.GHL_CALENDAR_ID?.trim() || undefined,
    timezone: opt("GHL_TIMEZONE", "America/Chicago"),
    apiVersion: opt("GHL_API_VERSION", "2021-07-28"),
  };
}
