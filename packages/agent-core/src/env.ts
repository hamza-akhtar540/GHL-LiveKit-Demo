/**
 * Fail loudly at startup rather than with a confusing 401 six calls deep.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in (see docs/GHL_SETUP.md).`,
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
  calendarId: string;
  timezone: string;
  apiVersion: string;
}

/** Only the vars needed to talk to GHL. Called lazily so unrelated code doesn't blow up. */
export function ghlEnv(): GhlEnv {
  return {
    pit: req("GHL_PIT"),
    locationId: req("GHL_LOCATION_ID"),
    calendarId: req("GHL_CALENDAR_ID"),
    timezone: opt("GHL_TIMEZONE", "America/Chicago"),
    apiVersion: opt("GHL_API_VERSION", "2021-07-28"),
  };
}
