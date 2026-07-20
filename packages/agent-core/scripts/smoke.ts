/**
 * T1.3 — Credential + endpoint-shape smoke test.
 *
 *   pnpm ghl:smoke
 *
 * Proves three things before we write a single line of agent code:
 *   1. The Private Integration Token authenticates.
 *   2. The location and calendar ids are real.
 *   3. free-slots returns the shape endpoints.ts assumes (it prints the raw
 *      response so we correct DATE_KEY / param names against reality, not docs).
 *
 * This is deliberately read-only. It creates nothing in the account.
 */
import "dotenv/config";
import { GhlClient, GhlError } from "../src/ghl/client.js";
import { paths, freeSlotsParams, DATE_KEY } from "../src/ghl/endpoints.js";
import { ghlEnv } from "../src/env.js";

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m: string) => console.log(`    \x1b[90m${m}\x1b[0m`);

async function main() {
  console.log("\nGHL smoke test\n");

  // ---- 1. env -------------------------------------------------------------
  let env;
  try {
    env = ghlEnv();
    ok("env vars present");
    info(`location ${env.locationId}  calendar ${env.calendarId}  tz ${env.timezone}`);
  } catch (e) {
    bad((e as Error).message);
    process.exit(1);
  }

  const ghl = new GhlClient(env);

  // ---- 2. auth ------------------------------------------------------------
  console.log("\nauth + location");
  let calendars: any;
  try {
    calendars = await ghl.get(paths.listCalendars(), { locationId: env.locationId });
    ok("PIT authenticated, location resolved");
  } catch (e) {
    if (e instanceof GhlError && e.status === 401) {
      bad("401 — token rejected. Regenerate the PIT and check it has calendars + contacts scopes.");
    } else if (e instanceof GhlError && e.status === 403) {
      bad("403 — token is valid but lacks scopes. Edit the Private Integration and enable them.");
    } else {
      bad(`${(e as Error).message}`);
    }
    process.exit(1);
  }

  const list: any[] = calendars?.calendars ?? [];
  info(`${list.length} calendar(s) on this location`);
  const match = list.find((c) => c.id === env.calendarId);
  if (match) {
    ok(`GHL_CALENDAR_ID matches "${match.name}"`);
  } else {
    bad("GHL_CALENDAR_ID not found on this location. Available:");
    for (const c of list) info(`${c.id}  ${c.name}`);
    process.exit(1);
  }

  // ---- 3. free-slots shape -----------------------------------------------
  console.log("\nfree-slots");
  const now = Date.now();
  const in7d = now + 7 * 24 * 60 * 60 * 1000;

  let slots: any;
  try {
    slots = await ghl.get(paths.freeSlots(env.calendarId), {
      [freeSlotsParams.startDate]: now,
      [freeSlotsParams.endDate]: in7d,
      [freeSlotsParams.timezone]: env.timezone,
    });
    ok("free-slots responded");
  } catch (e) {
    bad(`${(e as Error).message}`);
    info("If this is a 422/400, startDate/endDate are probably not epoch ms —");
    info("try ISO strings and update freeSlotsParams usage in endpoints.ts.");
    process.exit(1);
  }

  console.log("\n  raw response (first 600 chars) — confirm the envelope:");
  info(JSON.stringify(slots).slice(0, 600));

  const keys = Object.keys(slots ?? {});
  const dateKeys = keys.filter((k) => DATE_KEY.test(k));
  const otherKeys = keys.filter((k) => !DATE_KEY.test(k));

  if (dateKeys.length > 0) {
    ok(`${dateKeys.length} date-keyed day(s); DATE_KEY assumption holds`);
    const first = dateKeys[0]!;
    const day = (slots as any)[first];
    const arr = day?.slots;
    if (Array.isArray(arr)) {
      ok(`day objects carry a "slots" array (${arr.length} on ${first})`);
      info(`first slot: ${arr[0]}`);
    } else {
      bad(`day object has no "slots" array — shape is: ${JSON.stringify(day).slice(0, 200)}`);
    }
  } else {
    bad("no date-keyed entries. Either the calendar has zero availability in the");
    info("next 7 days (check business hours), or the envelope differs from our assumption.");
  }

  if (otherKeys.length > 0) {
    info(`non-date keys to ignore when walking the map: ${otherKeys.join(", ")}`);
  }

  console.log("\n\x1b[32mSmoke test passed.\x1b[0m Ready for T2.1.\n");
}

main().catch((e) => {
  console.error("\nUnexpected failure:", e);
  process.exit(1);
});
