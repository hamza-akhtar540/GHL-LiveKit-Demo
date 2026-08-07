/**
 * One-off backfill: fill in `bookings.contact_id` where it is NULL.
 *
 *   pnpm --filter @ghl-lk/agent-core backfill:booking-contacts          # dry run
 *   pnpm --filter @ghl-lk/agent-core backfill:booking-contacts --write
 *
 * The four oldest booking rows predate the code that started carrying the GHL
 * contact id forward, so they have `contact_id IS NULL`. That is a historical
 * gap, not a live defect — every row the current path writes has one.
 *
 * It matters because Contact 360 joins bookings on `contact_id`, so without this
 * those four bookings are invisible on their own customer's page: the page would
 * look broken for precisely the oldest, most-likely-to-be-clicked records.
 *
 * The fix is lossless because the link already exists in the other direction:
 * each row stores `external_id` (the GHL appointment id), and GHL's calendar
 * event for that id carries the contactId.
 *
 * Deliberately NOT matched on email or phone. Three live rows share the phone
 * 03216032104 and have NULL email, and email matching would collide any two
 * people sharing an address — which is the whole reason `booking/ghl.ts:148-150`
 * carries contactId forward rather than re-deriving it.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { GhlClient } = await import("../src/ghl/client.js");
const { paths } = await import("../src/ghl/endpoints.js");

const write = process.argv.includes("--write");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const postgres = (await import("postgres")).default;
const sql = postgres(url);

const client = new GhlClient();

interface CalendarEvent {
  id?: string;
  contactId?: string;
  calendarId?: string;
  appointmentStatus?: string;
  startTime?: string;
  title?: string;
}

try {
  const orphans = await sql<{ code: string; external_id: string | null }[]>`
    select code, external_id from bookings where contact_id is null order by created_at
  `;

  console.log(`\n${orphans.length} booking row(s) with no contact_id`);
  if (!orphans.length) {
    console.log("nothing to do\n");
    process.exit(0);
  }

  const withExternal = orphans.filter((o) => o.external_id);
  const withoutExternal = orphans.filter((o) => !o.external_id);
  for (const o of withoutExternal) {
    console.log(`  ${o.code}  — no external_id either, unrecoverable from GHL`);
  }
  if (!withExternal.length) {
    console.log("\nnone are recoverable\n");
    process.exit(0);
  }

  // Fan out per calendar rather than using the single-userId shortcut: userId
  // filters on the appointment's assigned user, so a round-robin calendar with
  // two members would silently return half its events.
  const cal = await client.get<{ calendars?: { id?: string; name?: string }[] }>(
    paths.listCalendars(),
    { locationId: client.env.locationId },
  );
  const calendars = (cal.calendars ?? []).filter((c) => c.id);
  console.log(`\nscanning ${calendars.length} calendar(s)`);

  // Wide window — these are old rows and we do not know how old.
  const startTime = String(Date.now() - 365 * 864e5);
  const endTime = String(Date.now() + 365 * 864e5);

  const byExternalId = new Map<string, CalendarEvent>();
  for (const c of calendars) {
    const res = await client.get<{ events?: CalendarEvent[] }>(paths.calendarEvents(), {
      locationId: client.env.locationId,
      calendarId: c.id!,
      startTime,
      endTime,
    });
    for (const ev of res.events ?? []) {
      if (ev.id) byExternalId.set(ev.id, ev);
    }
  }
  console.log(`found ${byExternalId.size} live GHL appointment(s)\n`);

  let matched = 0;
  let updated = 0;

  for (const o of withExternal) {
    const ev = byExternalId.get(o.external_id!);
    if (!ev?.contactId) {
      console.log(`  ${o.code}  — external_id ${o.external_id} not in GHL (deleted?), skipped`);
      continue;
    }
    matched++;
    console.log(`  ${o.code}  → ${ev.contactId}  [${ev.appointmentStatus ?? "?"}]`);

    if (write) {
      // Guarded on `contact_id is null` so a concurrent write is never clobbered.
      const rows = await sql`
        update bookings set contact_id = ${ev.contactId}, updated_at = now()
        where code = ${o.code} and contact_id is null
      `;
      updated += rows.count;
    }
  }

  /**
   * Second pass: inherit through the reschedule chain.
   *
   * A reschedule deletes the old GHL appointment and mints a new booking linked
   * by `replaced_by_code`, so a superseded row's own external_id is gone from GHL
   * and pass one cannot resolve it. But a reschedule is by definition the same
   * guest, so the replacement's contact_id is exactly right — this is an exact
   * inheritance, not a guess. Repeated until nothing changes, since a booking can
   * be moved more than once (a chain, not just a pair).
   */
  let inherited = 0;
  for (let pass = 0; pass < 10; pass++) {
    const links = await sql<{ code: string; heir: string; contact_id: string }[]>`
      select b.code, r.code as heir, r.contact_id
      from bookings b
      join bookings r on r.code = b.replaced_by_code
      where b.contact_id is null and r.contact_id is not null
    `;
    if (!links.length) break;

    for (const l of links) {
      console.log(`  ${l.code}  → ${l.contact_id}  [inherited from replacement ${l.heir}]`);
      inherited++;
      if (write) {
        const rows = await sql`
          update bookings set contact_id = ${l.contact_id}, updated_at = now()
          where code = ${l.code} and contact_id is null
        `;
        updated += rows.count;
      }
    }
    // Without --write nothing changed, so the same rows would match forever.
    if (!write) break;
  }

  const stillNull = await sql<{ code: string; full_name: string | null }[]>`
    select code, full_name from bookings where contact_id is null
  `;

  console.log(
    write
      ? `\n${updated} row(s) updated (${matched} from GHL, ${inherited} inherited)`
      : `\n${matched + inherited} row(s) recoverable (${matched} from GHL, ${inherited} inherited) — pass --write to apply`,
  );

  if (stillNull.length) {
    console.log(
      `\n${stillNull.length} row(s) remain unresolvable — their GHL appointment is gone and no\n` +
        `replacement carries a contact id. They will show on Contact 360 as bookings with no\n` +
        `CRM link, which is honest: we genuinely cannot say which contact they belong to.\n` +
        stillNull.map((r) => `  ${r.code}  ${r.full_name ?? "(no name)"}`).join("\n"),
    );
  }
  console.log();
} finally {
  await sql.end();
}
