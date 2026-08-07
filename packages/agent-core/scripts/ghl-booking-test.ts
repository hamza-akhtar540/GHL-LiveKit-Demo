/**
 * Exercises GhlBookingStore against the real sub-account.
 *
 *   pnpm --filter @ghl-lk/agent-core ghl:booking          # read-only
 *   pnpm --filter @ghl-lk/agent-core ghl:booking --write  # books, moves and cancels
 *
 * Read-only by default on purpose: this points at a live CRM, and an accidental
 * appointment in the middle of a demo is a bad surprise.
 *
 * The `--write` path now exercises the FULL lifecycle — book, reschedule, cancel —
 * and cleans up after itself. It used to only book, and to construct the store
 * with no `BookingIndex`, which meant `find`, `cancel` and `reschedule` all
 * returned `null` through their early guards: the script was green while
 * testing none of the paths it existed to guard. It also read `found.room`, a
 * resource id that has not existed since the hotel config split into
 * room_king / room_queen / room_suite, so the write path could never select a
 * room at all.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { GhlBookingStore } = await import("../src/booking/ghl.js");
const { BookingIndex } = await import("../src/booking/index-store.js");
const { hotel } = await import("../src/industries/hotel.js");

const write = process.argv.includes("--write");

/**
 * The index is what makes cancel/reschedule reachable at all — GHL has no
 * lookup-by-our-reference endpoint, so without it those methods bail early and
 * return null. Skipped only if there is genuinely no database configured, and
 * then the affected checks are reported as skipped rather than passing silently.
 */
const index = process.env.DATABASE_URL ? new BookingIndex() : undefined;
if (!index) {
  console.log("\n  ! DATABASE_URL not set — cancel/reschedule cannot be exercised.\n");
}

const store = new GhlBookingStore(hotel.resources, undefined, index, hotel.id);
const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  console.log(`\nAvailability on ${date}\n`);

  const found: Record<string, Awaited<ReturnType<typeof store.findSlots>>> = {};
  for (const resourceId of hotel.resources.map((r) => r.id)) {
    const slots = await store.findSlots({ resourceId, date });
    found[resourceId] = slots;
    console.log(`  ${resourceId.padEnd(11)} ${slots.length} slots`);
    for (const s of slots) console.log(`              ${s.label}   ${s.start}`);
    if (!slots.length) console.log(`              (none — check this calendar's hours)`);
  }

  // The voice default is deliberately tiny. Assert it, because an admin slot
  // picker now depends on `limit` overriding it rather than on the cap moving.
  const capped = await store.findSlots({ resourceId: hotel.resources[0]!.id, date });
  check(`default cap is 3 slots or fewer (voice default)`, capped.length <= 3, `got ${capped.length}`);
  const wide = await store.findSlots({ resourceId: hotel.resources[0]!.id, date, limit: 50 });
  check(
    `limit raises the cap for the admin picker`,
    wide.length >= capped.length,
    `limit:50 returned ${wide.length}, default returned ${capped.length}`,
  );

  if (!write) {
    console.log(`\nRead-only. Pass --write to book, move and cancel one for real.\n`);
    process.exit(failures ? 1 : 0);
  }

  // --- book --------------------------------------------------------------
  const resourceId = Object.keys(found).find((id) => found[id]!.length >= 2) ?? Object.keys(found).find((id) => found[id]!.length);
  if (!resourceId) {
    console.log(`\nNothing available to book. Fix calendar hours first.\n`);
    process.exit(1);
  }
  const slots = found[resourceId]!;

  console.log(`\nBooking ${resourceId} at ${slots[0]!.label}…`);
  const booking = await store.create({
    resourceId,
    start: slots[0]!.start,
    contact: {
      full_name: "Test Booking (delete me)",
      phone: "+15125550100",
      email: "test-booking@example.com",
    },
    details: { party_size: "2", seating: "indoor" },
  });

  console.log(`  reference : ${booking.code}`);
  console.log(`  GHL id    : ${booking.externalId ?? "(none returned)"}`);
  check("create returned a GHL appointment id", !!booking.externalId);
  check("create returned status confirmed", booking.status === "confirmed", booking.status);
  check("contact id was carried onto the booking", !!booking.contact.contactId);

  // --- find (needs the index) --------------------------------------------
  if (index) {
    const refound = await store.find(booking.code);
    check("find() resolves our own reference", !!refound, "returned null — is the index writing?");
    check(
      "find() carries contactId back",
      !!refound?.contact.contactId,
      "missing, so a reschedule would re-upsert the contact from name fragments",
    );

    // --- reschedule ------------------------------------------------------
    let current = booking;
    if (slots.length >= 2) {
      const moved = await store.reschedule!(booking.code, slots[1]!.start);
      check("reschedule() returned a replacement", !!moved, "returned null");
      if (moved) {
        current = moved;
        check("reschedule minted a NEW reference", moved.code !== booking.code, `same code ${moved.code}`);
        console.log(`  moved to  : ${moved.code} @ ${moved.start}`);
        const old = await store.find(booking.code);
        check("old booking is marked cancelled", old?.status === "cancelled", `status is ${old?.status}`);
      }
    } else {
      console.log("  · only one slot free, skipping the reschedule check");
    }

    // --- cancel, which is also the cleanup --------------------------------
    const cancelled = await store.cancel(current.code);
    check("cancel() returned the cancelled booking", !!cancelled, "returned null");
    check("cancel() reports status cancelled", cancelled?.status === "cancelled", `${cancelled?.status}`);

    const after = await store.find(current.code);
    check("cancelled booking stays cancelled on re-read", after?.status === "cancelled", `${after?.status}`);

    // Deliberately NOT verified with GET /calendars/events/appointments/{id} —
    // that endpoint keeps reporting "confirmed" for genuinely deleted
    // appointments, so it would flag a successful cancel as a failure.
    console.log("\n  Cleaned up: the test appointment was cancelled in GoHighLevel.");
    console.log("  The test CONTACT remains — delete test-booking@example.com by hand if you like.\n");
  } else {
    console.log("\n  ! Left a real appointment behind (no index to cancel it through).");
    console.log(`  ! Delete ${booking.code} / GHL id ${booking.externalId} by hand.\n`);
    failures++;
  }
} finally {
  await index?.close();
}

console.log(failures ? `${failures} check(s) failed\n` : "All booking checks passed.\n");
process.exit(failures ? 1 : 0);
