/**
 * The lead retry sweeper.
 *
 *   pnpm --filter @ghl-lk/agent-core leads:retry          # show what it would do
 *   pnpm --filter @ghl-lk/agent-core leads:retry --write  # actually reprocess
 *
 * Run it on a schedule (cron, or a container restart loop) — every few minutes
 * is plenty.
 *
 * ── Why this has to exist ──
 * Lead ingestion answers the webhook with a 200 as soon as the submission is
 * claimed, then does the CRM work afterwards. That is deliberate: GoHighLevel and
 * Meta both retry on a SLOW response as well as a failed one, so anything
 * expensive has to happen after the socket is answered.
 *
 * The consequence is that once we claim a submission, the sender's own retries
 * can no longer help us — we have already told it we have the lead. If the
 * process dies, or GHL 500s mid-way, the row sits at `received` forever. This
 * sweeper is the only thing that finishes those.
 *
 * ── Deliberately sequential ──
 * One lead at a time, with a pause between. GoHighLevel allows roughly 100
 * requests per 10 seconds and a single lead costs about five of them, so a
 * parallel sweep over a backlog would rate-limit itself into failures that then
 * look like real errors and burn the attempt counter.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { LeadIngestor } = await import("../src/leads/ingest.js");
const { PgLeadStore } = await import("../src/leads/store.js");
const { PgConversationStore } = await import("../src/conversation/pg-store.js");
const { CrmSync } = await import("../src/crm/sync.js");
const { getIndustry } = await import("../src/industries/index.js");

const write = process.argv.includes("--write");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 25;

const cfg = getIndustry(process.env.INDUSTRY ?? "roofing");
const store = new PgLeadStore();
const conversations = new PgConversationStore();
const ingestor = new LeadIngestor({
  store,
  crm: new CrmSync(),
  conversations,
  cfg,
  onLog: (msg, data) => console.log(`      · ${msg}`, data ? JSON.stringify(data) : ""),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let done = 0;
let failed = 0;
let skipped = 0;

try {
  const pending = await store.findRetryable(limit);
  console.log(`\n${pending.length} unfinished lead(s)${pending.length ? "" : " — nothing to do"}\n`);

  for (const row of pending) {
    console.log(`  ${row.id}`);
    console.log(`      status=${row.status} attempts=${row.attempts} received=${row.receivedAt}`);

    if (!write) continue;

    // Claimed individually, so two sweepers running at once cannot both take
    // the same row — the claim is a single guarded UPDATE.
    const claimed = await store.claimForRetry(row.id);
    if (!claimed) {
      skipped++;
      console.log(`      skipped — already locked, finished, or out of attempts`);
      continue;
    }

    try {
      const result = await ingestor.process(claimed.id, claimed.lead);
      done++;
      console.log(`      → ${result.status}${result.contactId ? ` contact ${result.contactId}` : ""}`);
    } catch (err) {
      failed++;
      // Left at its current status with the attempt counted, so the next sweep
      // picks it up again until it either succeeds or hits the ceiling.
      await store.update(row.id, { status: "failed", reason: String(err).slice(0, 300) }).catch(() => {});
      console.log(`      ✗ ${String(err).slice(0, 160)}`);
    } finally {
      await store.releaseRetryLock(row.id).catch(() => {});
    }

    // See the header: GHL's rate limit is the reason this is not parallel.
    await sleep(1200);
  }

  console.log(
    write
      ? `\n${done} reprocessed, ${failed} failed, ${skipped} skipped\n`
      : `\nDry run — pass --write to reprocess them.\n`,
  );
} finally {
  await store.close();
  await conversations.close();
}

process.exit(failed ? 1 : 0);
