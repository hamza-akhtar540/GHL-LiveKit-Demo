/**
 * Live verification for the admin console's write paths.
 *
 *   pnpm --filter @ghl-lk/agent-core admin:write-test                  # read-only checks
 *   pnpm --filter @ghl-lk/agent-core admin:write-test --only=social --write
 *
 * Read-only by default, like `ghl-booking-test.ts`. `--write` opts into real
 * mutations, and every mutation in here is performed against something this
 * script created itself and then removes — never against pre-existing data, and
 * never against a published post.
 *
 * `--only=<domain>` scopes the run so this is usable as a per-stage gate rather
 * than an all-or-nothing check at the end of the build.
 *
 * Why a script and not a unit test: these assertions are about what GoHighLevel
 * actually does. A mock would only ever confirm what we already believed, and
 * every bug this file exists to catch was a case where GHL's real behaviour
 * differed from the documented shape.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { SocialClient, assertGhlPostId } = await import("../src/social/client.js");

const args = process.argv.slice(2);
const write = args.includes("--write");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : undefined;

const wants = (domain: string) => !only || only.includes(domain);

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
  console.log("─".repeat(72));
}

// ---------------------------------------------------------------- social ----

if (wants("social")) {
  section("social");
  const client = new SocialClient();

  /**
   * Removes anything a previous run of this script left behind. A run that fails
   * mid-cycle leaks a draft, and a leaked draft shows up on the dashboard and in
   * the next run's list — so sweeping first keeps repeated runs honest.
   */
  if (args.includes("--cleanup")) {
    const sweep = await client.listPosts({
      fromDate: new Date(Date.now() - 90 * 864e5).toISOString(),
      toDate: new Date(Date.now() + 120 * 864e5).toISOString(),
      limit: 100,
    });
    const strays = sweep.filter(
      (p) => !p.deleted && /admin-write-test|shape probe/i.test(p.summary),
    );
    console.log(`  · sweeping ${strays.length} leftover test post(s) of ${sweep.length} live`);
    for (const s of strays) {
      await client.deletePost(s.id).catch(() => {});
      console.log(`    deleted ${s.id} [${s.status}] ${s.summary.slice(0, 50)}`);
    }
  }

  // --- the id guard, which needs no network ------------------------------
  for (const [bad, why] of [
    ["local-facebook-1753876543210", "synthetic mirror id"],
    ["failed-instagram-1753876543210", "synthetic failed-row id"],
    ["urn:li:share:7488531531649433601", "LinkedIn platform id"],
    ["1452839210194289", "Facebook platform id"],
  ] as const) {
    let threw = false;
    try {
      assertGhlPostId(bad, "edit");
    } catch {
      threw = true;
    }
    check(`refuses ${why}`, threw, `${bad} was accepted`);
  }

  let guardOk = true;
  try {
    assertGhlPostId("6a6b248010862dad767dd1c7", "edit");
  } catch (err) {
    guardOk = false;
    console.log(`      ${String(err)}`);
  }
  check("accepts a real GHL _id", guardOk);

  // --- list, which proves the read shape --------------------------------
  const now = new Date();
  const posts = await client.listPosts({
    fromDate: new Date(now.getTime() - 30 * 864e5).toISOString(),
    toDate: new Date(now.getTime() + 60 * 864e5).toISOString(),
    limit: 50,
  });

  check("listPosts returns posts", posts.length > 0, `got ${posts.length}`);
  check(
    "every post has a real GHL id",
    posts.every((p) => /^[a-f0-9]{24}$/i.test(p.id)),
    `offenders: ${posts.filter((p) => !/^[a-f0-9]{24}$/i.test(p.id)).map((p) => p.id).join(", ")}`,
  );

  // The bug that made social management impossible. If createPost still failed
  // to read `_id`, a newly created post would come back with no id at all.
  if (write) {
    const accounts = await client.accounts();
    const target = accounts.find((a) => a.platform === "facebook" && !a.isExpired);

    if (!target) {
      check("a facebook account is connected to test against", false);
    } else {
      const marker = `admin-write-test ${new Date().toISOString()}`;
      const created = await client.createPost({
        accountIds: [target.id],
        text: `${marker} — safe to delete.`,
        status: "draft",
      });

      check(
        "createPost returns GHL's real _id (B1)",
        !!created.id && /^[a-f0-9]{24}$/i.test(created.id),
        `got ${JSON.stringify(created.id)}`,
      );

      if (created.id && /^[a-f0-9]{24}$/i.test(created.id)) {
        try {
          check("getPost finds the new post", !!(await client.getPost(created.id)));

          // --- edit -------------------------------------------------------
          const edited = `${marker} — edited.`;
          await client.editPost(created.id, { summary: edited });

          const after = await client.getPost(created.id);
          check("summary was updated", after?.summary === edited, `got ${after?.summary?.slice(0, 60)}`);
          // The reason editPost does a read-modify-write internally: a bare
          // {type, summary} PUT 422s with "accountIds should not be empty",
          // even though the published schema lists only id+type as required.
          check(
            "accountIds survived the edit",
            (after?.accountIds ?? []).includes(target.id),
            `accountIds became ${JSON.stringify(after?.accountIds)}`,
          );

          // --- reschedule -------------------------------------------------
          const when = new Date(now.getTime() + 7 * 864e5);
          when.setUTCHours(11, 0, 0, 0);
          await client.editPost(created.id, {
            status: "scheduled",
            scheduleDate: when.toISOString(),
          });

          const rescheduled = await client.getPost(created.id);
          check(
            "scheduleDate moved",
            rescheduled?.scheduleDate === when.toISOString(),
            `got ${rescheduled?.scheduleDate}, wanted ${when.toISOString()}`,
          );
          check("status became scheduled", rescheduled?.status === "scheduled", `got ${rescheduled?.status}`);
        } finally {
          // Always clean up, even if an assertion above threw — a leaked draft
          // would show up on the dashboard and in the next run's list.
          await client.deletePost(created.id).catch(() => {});
        }

        const gone = await client.getPost(created.id).catch(() => undefined);
        check("deleted post is gone", !gone || gone.deleted === true, `still present: ${JSON.stringify(gone?.status)}`);
      }
    }
  } else {
    console.log("  · skipped create/edit/delete — pass --write to run them");
  }
}

// -------------------------------------------------------------- bookings ----

if (wants("bookings")) {
  section("bookings");

  const { AdminData } = await import("../src/admin/data.js");
  const { getIndustry } = await import("../src/industries/index.js");
  const cfg = getIndustry(process.env.INDUSTRY ?? "roofing");
  const data = new AdminData();

  try {
    // A gate that dies with a connection stack trace teaches nothing. Postgres
    // runs in Docker here and stops more often than you would like.
    const merged = await data.bookingsMerged(cfg, 200).catch((err) => {
      if (String(err).includes("ECONNREFUSED")) {
        throw new Error("Postgres is not reachable — run `docker start ghl-pg` and try again.");
      }
      throw err;
    });
    console.log(
      `  · ${merged.counts.total} appointment(s): ${merged.counts.both} synced, ` +
        `${merged.counts.indexOnly} ours-only, ${merged.counts.ghlOnly} GHL-only`,
    );

    check("merge returns the business timezone for display", !!merged.timezone, "missing — times would render in the viewer's zone");
    check(
      "no row claims it can be cancelled without a reference",
      merged.items.every((r) => !r.canCancel || !!r.code),
      "a GHL-only row offered Cancel, which would be a silent no-op",
    );

    // Appointments a human marked in the GHL UI that our index never learned
    // about. Not a failure — the whole point of the merge is to show them — but
    // worth printing, because before this existed they were invisible.
    const divergent = merged.items.filter((r) => r.indexStatus && r.indexStatus !== r.status);
    if (divergent.length) {
      console.log(`  · ${divergent.length} row(s) where GHL disagrees with our index:`);
      for (const d of divergent) console.log(`      ${d.code}: GHL says ${d.status}, we had ${d.indexStatus}`);
    }

    const leftovers = merged.items.filter(
      (r) => /Test Booking \(delete me\)|E2E Console Test|admin-write-test/i.test(String(r.fullName ?? "")) && r.status !== "cancelled",
    );
    if (leftovers.length) {
      console.log(`  · ${leftovers.length} live test appointment(s) still present:`);
      for (const l of leftovers) {
        console.log(`      ${l.code ?? "(no ref)"}  ${l.startTimeRaw}  ${l.fullName}  [${l.source}]`);
      }
      console.log(`      These show up on the dashboard. Cancel the ones with a reference from the console;`);
      console.log(`      GHL-only ones must be deleted in GoHighLevel directly.`);
    } else {
      check("no live test appointments left lying around", true);
    }
  } finally {
    await data.close();
  }
}

// ---------------------------------------------------------------- report ----

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
