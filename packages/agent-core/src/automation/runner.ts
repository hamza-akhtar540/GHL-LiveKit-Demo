import type { IndustryConfig } from "../industries/types.js";
import { CrmSync } from "../crm/sync.js";
import { PgConversationStore } from "../conversation/pg-store.js";
import { LeadFollowUp } from "../leads/follow-up.js";
import { LeadIngestor } from "../leads/ingest.js";
import { PgLeadStore } from "../leads/store.js";
import { SocialClient } from "../social/client.js";
import { SocialPublisher } from "../social/publisher.js";
import { SocialStore } from "../social/store.js";
import { runAbandonedFollowUps } from "./abandoned.js";
import { syncSocialDms } from "../social/dm-sync.js";

/**
 * Everything that has to happen on a clock, in one place.
 *
 * Everything else in this system is event-driven: a webhook arrives, a caller
 * hangs up, an operator clicks. These are the jobs nothing triggers. The web
 * server starts this at boot, so running the product means running one process —
 * nobody has to remember a second command for follow-ups to go out.
 *
 * Every job is idempotent. A missed tick is harmless and a doubled tick is
 * harmless: the sweeper claims rows atomically, the abandoned sweep checks for a
 * stored email before composing, and social posting skips when a post is already
 * scheduled. That matters more than precise timing, because a process that
 * restarts mid-job must not corrupt anything.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AutomationOptions {
  cfg: IndustryConfig;
  /** `false` = report what would happen and change nothing. */
  write: boolean;
  /** Run every job once, then stop. For scripts and tests. */
  once?: boolean;
  log?: (job: string, msg: string, data?: Record<string, unknown>) => void;
}

export interface Automation {
  stop(): Promise<void>;
  /** Names and intervals, for a startup banner or the admin console. */
  jobs: { name: string; everyMs: number; note?: string }[];
}

interface Job {
  name: string;
  every: number;
  note?: string;
  run: () => Promise<void>;
}

export function automationEnabled(): boolean {
  return (process.env.AUTOMATION ?? "on").trim().toLowerCase() !== "off";
}

export async function startAutomation(opts: AutomationOptions): Promise<Automation> {
  const { cfg, write, once = false } = opts;
  const log =
    opts.log ??
    ((job: string, msg: string, data?: Record<string, unknown>) =>
      console.log(`[${new Date().toISOString()}] ${job.padEnd(16)} ${msg}`, data ? JSON.stringify(data) : ""));

  const hasGhl = Boolean(process.env.GHL_PIT);

  const leadStore = new PgLeadStore();
  const conversations = new PgConversationStore();
  const socialStore = new SocialStore();
  // Built only when GHL is connected: the client reads GHL_PIT in its
  // constructor and throws without it, which would take the email follow-ups down
  // with the social jobs they have nothing to do with.
  const socialClient = hasGhl ? new SocialClient() : undefined;

  const ingestor = new LeadIngestor({
    store: leadStore,
    crm: hasGhl ? new CrmSync() : undefined,
    conversations,
    cfg,
    onLog: (m, d) => log("lead-retry", m, d),
  });
  const followUp = new LeadFollowUp({
    store: leadStore,
    conversations,
    cfg,
    onLog: (m, d) => log("follow-up", m, d),
  });
  const publisher = socialClient
    ? new SocialPublisher({
        cfg,
        conversations,
        store: socialStore,
        client: socialClient,
        onLog: (m, d) => log("social", m, d),
      })
    : undefined;

  // ------------------------------------------------------------------ jobs --

  /**
   * Finish leads that were claimed but never completed. Ingestion answers the
   * webhook 200 as soon as it claims a submission, so once claimed the sender's
   * retries can no longer help — this is the only thing that finishes a row the
   * process died halfway through.
   */
  async function leadRetry(): Promise<void> {
    const pending = await leadStore.findRetryable(25);
    if (!pending.length) return;
    log("lead-retry", `${pending.length} unfinished`);
    if (!write) return;

    for (const row of pending) {
      const claimed = await leadStore.claimForRetry(row.id);
      if (!claimed) continue;
      try {
        const r = await ingestor.process(claimed.id, claimed.lead);
        log("lead-retry", `→ ${r.status}`, { id: row.id, contactId: r.contactId });
      } catch (err) {
        await leadStore.update(row.id, { status: "failed", reason: String(err).slice(0, 300) }).catch(() => {});
        log("lead-retry", `✗ ${String(err).slice(0, 120)}`, { id: row.id });
      } finally {
        await leadStore.releaseRetryLock(row.id).catch(() => {});
      }
      // GHL allows ~100 requests per 10s and one lead costs about five.
      await sleep(1200);
    }
  }

  /** Nudge people who went quiet without booking — 1h, 24h, then 3 days. */
  async function abandoned(): Promise<void> {
    if (!write) return;
    const r = await runAbandonedFollowUps({
      conversations,
      store: leadStore,
      followUp,
      onLog: (m, d) => log("abandoned", m, d),
    });
    if (r.results.length) log("abandoned", `handled ${r.results.length}`, { considered: r.considered, due: r.due });
  }

  /**
   * Pull Facebook and Instagram DMs out of GHL into our database and turn each
   * person into a lead. Read-only against GHL apart from the CRM tags and note the
   * ingestor already writes, so it runs even in a dry run of the other jobs.
   */
  async function socialDms(): Promise<void> {
    const r = await syncSocialDms({ conversations, ingestor, industry: cfg.id, onLog: (m, d) => log("social-dms", m, d) });
    if (r.synced) log("social-dms", `${r.synced} thread(s), ${r.newMessages} new message(s), ${r.newLeads} new lead(s)`);
  }

  /** Snapshot engagement, so "best day to post" has something to learn from. */
  async function socialCollect(): Promise<void> {
    if (!write || !publisher) return;
    const out = await publisher.collectStats();
    log("social-stats", `snapshotted ${out.length} account(s)`, Object.fromEntries(out.map((o) => [o.platform, o.days])));
  }

  /**
   * Generate and schedule posts through GHL's Social Planner.
   *
   * Always `scheduled`, never published on the spot: a scheduled post can still
   * be cancelled from the planner before it fires, a published one cannot. That
   * is what makes it safe to leave this running.
   *
   * Guarded against the duplicate-slot problem: `scheduleAtBestTime` resolves to
   * the same slot every time, so an unguarded timer would stack identical posts
   * on it. If anything is already scheduled, this skips.
   */
  async function socialPost(): Promise<void> {
    if (!publisher || !socialClient) return;
    const now = Date.now();
    const existing = await socialClient
      .listPosts({
        fromDate: new Date(now - 2 * 864e5).toISOString(),
        toDate: new Date(now + 30 * 864e5).toISOString(),
        limit: 100,
      })
      .catch(() => []);

    const scheduled = existing.filter((p) => p.status === "scheduled" && p.scheduleDate);
    if (scheduled.length) return;
    if (!write) return;

    const out = await publisher.scheduleAtBestTime();
    log("social-post", `scheduled ${out.results.filter((r) => r.status === "scheduled").length}`, {
      for: out.scheduledForDisplay,
      learned: out.usedLearnedData,
    });
  }

  // ---------------------------------------------------------------- config --

  const everyMin = (name: string, fallback: number) => Number(process.env[name] ?? fallback) * MINUTE;
  const everyHour = (name: string, fallback: number) => Number(process.env[name] ?? fallback) * HOUR;

  // Social posting runs by default once GHL is connected. Switch it off with
  // SOCIAL_AUTOPOST=off, or by setting SCHED_SOCIAL_POST_HOURS=0.
  const socialAuto = (process.env.SOCIAL_AUTOPOST ?? "on").trim().toLowerCase() !== "off";
  const socialPostEvery = socialAuto ? everyHour("SCHED_SOCIAL_POST_HOURS", 24) : 0;

  const jobs: Job[] = [
    { name: "lead-retry", every: everyMin("SCHED_LEAD_RETRY_MIN", 5), run: leadRetry },
    { name: "abandoned", every: everyMin("SCHED_ABANDONED_MIN", 5), note: "1h / 24h / 3d follow-ups", run: abandoned },
    ...(hasGhl && (process.env.SOCIAL_DM_SYNC ?? "on").trim().toLowerCase() !== "off"
      ? [{ name: "social-dms", every: everyMin("SCHED_DM_MIN", 2), note: "Facebook + Instagram DMs → leads", run: socialDms } as Job]
      : []),
    ...(hasGhl
      ? [{ name: "social-stats", every: everyHour("SCHED_SOCIAL_COLLECT_HOURS", 24), run: socialCollect } as Job]
      : []),
    ...(hasGhl && socialPostEvery > 0
      ? [{ name: "social-post", every: socialPostEvery, note: "scheduled, cancellable in Social Planner", run: socialPost } as Job]
      : []),
  ];

  /** One job failing must never stop the loop — that is the whole point of it. */
  async function safely(job: Job): Promise<void> {
    try {
      await job.run();
    } catch (err) {
      log(job.name, `✗ ${String(err).slice(0, 200)}`);
    }
  }

  for (const j of jobs) await safely(j); // a restart is not a gap in coverage

  const closeStores = () =>
    Promise.allSettled([leadStore.close(), conversations.close(), socialStore.close()]).then(() => undefined);

  if (once) {
    await closeStores();
    return { stop: async () => {}, jobs: jobs.map((j) => ({ name: j.name, everyMs: j.every, note: j.note })) };
  }

  const timers = jobs.map((j) => setInterval(() => void safely(j), j.every));
  return {
    jobs: jobs.map((j) => ({ name: j.name, everyMs: j.every, note: j.note })),
    stop: async () => {
      for (const t of timers) clearInterval(t);
      await closeStores();
    },
  };
}
