/**
 * The automation runner. One long-lived process that does the recurring work.
 *
 *   pnpm --filter @ghl-lk/agent-core scheduler          # dry run — says what it WOULD do
 *   pnpm --filter @ghl-lk/agent-core scheduler --write  # actually does it
 *
 * Everything else in this system is event-driven: a webhook arrives, a caller
 * hangs up, an operator clicks. These are the jobs nothing triggers — they have
 * to happen on a clock or they never happen at all, which is why the retry
 * sweeper and the stats collector had never once run before now.
 *
 * ── Why a process rather than crontab entries ──
 * A cron line per job means four places to configure, four ways to forget, and
 * no shared view of what ran. This runs anywhere Node runs — a container, a
 * `pm2` process, a systemd unit — and logs every tick, so "did the sweeper run"
 * is answerable from the same log as everything else. If you would rather use
 * cron, each job is still a standalone script; see the table below.
 *
 * ── Every job is idempotent ──
 * A missed tick is never a problem and a doubled tick is never a problem. The
 * sweeper claims rows atomically, stats snapshots upsert on
 * `${profileId}:${date}`, and social scheduling checks for an existing post in
 * the target slot before adding another. That matters more than precise timing:
 * a process that restarts mid-job must not corrupt anything.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { LeadIngestor } = await import("../src/leads/ingest.js");
const { PgLeadStore } = await import("../src/leads/store.js");
const { PgConversationStore } = await import("../src/conversation/pg-store.js");
const { CrmSync } = await import("../src/crm/sync.js");
const { SocialPublisher } = await import("../src/social/publisher.js");
const { SocialClient } = await import("../src/social/client.js");
const { SocialStore } = await import("../src/social/store.js");
const { getIndustry } = await import("../src/industries/index.js");

const write = process.argv.includes("--write");
const once = process.argv.includes("--once");
const cfg = getIndustry(process.env.INDUSTRY ?? "roofing");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How often each job runs. Overridable so a demo can speed things up without
 * editing code, and so social posting can be switched off entirely.
 */
const EVERY = {
  /** Unfinished leads. Frequent because a stuck lead is a lead going cold. */
  leadRetry: Number(process.env.SCHED_LEAD_RETRY_MIN ?? 5) * MINUTE,
  /** Engagement snapshots. Daily is enough — GHL reports a rolling 7 days. */
  socialCollect: Number(process.env.SCHED_SOCIAL_COLLECT_HOURS ?? 24) * HOUR,
  /**
   * Automatic social posting. OFF by default (0) — posting to a client's real
   * audience on a timer is a decision someone has to make deliberately, not a
   * default they discover afterwards.
   */
  socialPost: Number(process.env.SCHED_SOCIAL_POST_HOURS ?? 0) * HOUR,
} as const;

const log = (job: string, msg: string, data?: Record<string, unknown>) =>
  console.log(`[${new Date().toISOString()}] ${job.padEnd(14)} ${msg}`, data ? JSON.stringify(data) : "");

// ---------------------------------------------------------------- shared ----

const leadStore = new PgLeadStore();
const conversations = new PgConversationStore();
const socialStore = new SocialStore();
const socialClient = new SocialClient();

const ingestor = new LeadIngestor({
  store: leadStore,
  crm: new CrmSync(),
  conversations,
  cfg,
  onLog: (m, d) => log("lead-retry", m, d),
});

const publisher = new SocialPublisher({
  cfg,
  conversations,
  store: socialStore,
  client: socialClient,
  onLog: (m, d) => log("social", m, d),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ jobs ----

/**
 * Finish leads that were claimed but never completed.
 *
 * Ingestion answers the webhook 200 as soon as it claims a submission, because
 * GHL and Meta both retry slow responses as well as failures. Once claimed, the
 * sender's retries can no longer help us — this is the only thing that finishes
 * a row the process died halfway through.
 */
async function leadRetry(): Promise<void> {
  const pending = await leadStore.findRetryable(25);
  if (!pending.length) return log("lead-retry", "nothing pending");

  log("lead-retry", `${pending.length} unfinished`);
  if (!write) return;

  for (const row of pending) {
    const claimed = await leadStore.claimForRetry(row.id);
    if (!claimed) continue; // someone else has it, or it is out of attempts
    try {
      const r = await ingestor.process(claimed.id, claimed.lead);
      log("lead-retry", `→ ${r.status}`, { id: row.id, contactId: r.contactId });
    } catch (err) {
      await leadStore.update(row.id, { status: "failed", reason: String(err).slice(0, 300) }).catch(() => {});
      log("lead-retry", `✗ ${String(err).slice(0, 120)}`, { id: row.id });
    } finally {
      await leadStore.releaseRetryLock(row.id).catch(() => {});
    }
    // GHL allows ~100 requests per 10s and one lead costs about five, so a
    // parallel sweep would rate-limit itself into failures that look real.
    await sleep(1200);
  }
}

/** Snapshot engagement, so "best day to post" has something to learn from. */
async function socialCollect(): Promise<void> {
  if (!write) return log("social-stats", "would snapshot engagement for every connected account");
  const out = await publisher.collectStats();
  log("social-stats", `snapshotted ${out.length} account(s)`, Object.fromEntries(out.map((o) => [o.platform, o.days])));
}

/**
 * Generate and schedule posts.
 *
 * Guarded against the duplicate-slot problem: `scheduleAtBestTime` resolves to
 * the same computed slot every time it runs, so an unguarded timer would stack
 * identical posts on one slot — which is exactly what four existing posts did.
 * If that slot already holds a scheduled post, this skips rather than adding to
 * the pile.
 */
async function socialPost(): Promise<void> {
  const now = Date.now();
  const existing = await socialClient
    .listPosts({
      fromDate: new Date(now - 2 * 864e5).toISOString(),
      toDate: new Date(now + 30 * 864e5).toISOString(),
      limit: 100,
    })
    .catch(() => []);

  const scheduled = existing.filter((p) => p.status === "scheduled" && p.scheduleDate);
  if (scheduled.length) {
    return log("social-post", `skipped — ${scheduled.length} post(s) already scheduled`, {
      next: scheduled.map((p) => p.scheduleDate).sort()[0],
    });
  }

  if (!write) return log("social-post", "would generate and schedule posts");
  const out = await publisher.scheduleAtBestTime();
  log("social-post", `scheduled ${out.results.filter((r) => r.status === "scheduled").length}`, {
    for: out.scheduledForDisplay,
    learned: out.usedLearnedData,
  });
}

// ------------------------------------------------------------------ loop ----

interface Job {
  name: string;
  every: number;
  run: () => Promise<void>;
}

const jobs: Job[] = [
  { name: "lead-retry", every: EVERY.leadRetry, run: leadRetry },
  { name: "social-stats", every: EVERY.socialCollect, run: socialCollect },
  ...(EVERY.socialPost > 0 ? [{ name: "social-post", every: EVERY.socialPost, run: socialPost }] : []),
];

/** One job failing must never stop the loop — that is the whole point of it. */
async function safely(job: Job): Promise<void> {
  try {
    await job.run();
  } catch (err) {
    log(job.name, `✗ ${String(err).slice(0, 200)}`);
  }
}

console.log(`\nScheduler ${write ? "RUNNING" : "in DRY RUN (pass --write to act)"} — industry "${cfg.id}"\n`);
for (const j of jobs) console.log(`  ${j.name.padEnd(14)} every ${Math.round(j.every / MINUTE)} min`);
if (!EVERY.socialPost) {
  console.log(`  social-post    OFF — set SCHED_SOCIAL_POST_HOURS to enable automatic posting`);
}
console.log();

// Run everything once at startup so a restart is not a gap in coverage.
for (const j of jobs) await safely(j);

if (once) {
  await Promise.all([leadStore.close(), conversations.close(), socialStore.close()]);
  process.exit(0);
}

for (const j of jobs) setInterval(() => void safely(j), j.every);

// Shut down cleanly so Postgres connections are released rather than left to
// time out — this process is meant to be restarted often.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — closing`);
    void Promise.allSettled([leadStore.close(), conversations.close(), socialStore.close()]).then(() =>
      process.exit(0),
    );
  });
}
