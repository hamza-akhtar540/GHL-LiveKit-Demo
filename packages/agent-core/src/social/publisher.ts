import type { ConversationStore } from "../conversation/types.js";
import type { IndustryConfig } from "../industries/types.js";
import { SocialClient, type PostStatus } from "./client.js";
import { findPostIdeas, generatePost, type Platform } from "./content.js";
import { nextOccurrence, weekdayIn } from "./schedule-time.js";
import { SocialStore } from "./store.js";

/**
 * Picks a topic, writes the post, submits it, and records when it went out.
 *
 * `draft` is the default status everywhere. These accounts have real audiences,
 * and a live post can't be recalled from the feed of anyone who already saw it.
 * Publishing is an explicit choice per call.
 */
export interface PublisherDeps {
  cfg: IndustryConfig;
  conversations: ConversationStore;
  store: SocialStore;
  client?: SocialClient;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface PublishResult {
  platform: Platform;
  topic: string;
  askedBy: number;
  text: string;
  status: string;
  postId?: string;
  error?: string;
}

/**
 * Below this many days of collected data, weekday rankings are noise dressed up
 * as insight. Roughly 3 weeks — enough for each weekday to appear a few times.
 */
const MIN_DAYS_FOR_TIMING = 20;

export class SocialPublisher {
  private readonly client: SocialClient;

  constructor(private readonly deps: PublisherDeps) {
    this.client = deps.client ?? new SocialClient();
  }

  /**
   * Generate and submit one post per requested platform.
   *
   * Each platform gets a different *idea*, not the same text reworded — the same
   * post appearing verbatim across three networks is the most obvious tell of
   * automation there is.
   */
  async publish(opts: {
    platforms?: Platform[];
    status?: PostStatus;
    scheduleDate?: string;
  } = {}): Promise<PublishResult[]> {
    const { cfg, conversations, store, onLog = () => {} } = this.deps;
    const status = opts.status ?? "draft";
    const platforms = opts.platforms ?? ["facebook", "instagram", "linkedin"];

    const ideas = await findPostIdeas(cfg, conversations, platforms.length + 2);
    if (!ideas.length) return [];

    const results: PublishResult[] = [];

    for (const [i, platform] of platforms.entries()) {
      const idea = ideas[i % ideas.length]!;

      const accounts = await this.client.accountsFor(platform);
      if (!accounts.length) {
        onLog("no connected account", { platform });
        results.push({
          platform,
          topic: idea.topic,
          askedBy: idea.askedBy,
          text: "",
          status: "skipped",
          error: `no connected ${platform} account`,
        });
        continue;
      }

      let generated;
      try {
        generated = await generatePost(cfg, idea, platform);
      } catch (err) {
        onLog("generation failed", { platform, err: String(err) });
        results.push({
          platform,
          topic: idea.topic,
          askedBy: idea.askedBy,
          text: "",
          status: "failed",
          error: String(err),
        });
        continue;
      }

      const account = accounts[0]!;

      try {
        const created = await this.client.createPost({
          accountIds: [account.id],
          text: generated.text,
          status,
          scheduleDate: opts.scheduleDate,
        });

        // Recorded even as a draft, so the topic isn't picked again next run and
        // so there's a row to attach engagement to once it goes live.
        await store.recordPost({
          id: created.id ?? `local-${platform}-${Date.now()}`,
          industry: cfg.id,
          platform,
          accountId: account.id,
          topic: generated.topic,
          askedBy: generated.askedBy,
          text: generated.text,
          status: created.status ?? status,
          postedAt: status === "published" ? new Date().toISOString() : opts.scheduleDate,
        });

        onLog("post created", { platform, status: created.status, topic: idea.topic });
        results.push({
          platform,
          topic: generated.topic,
          askedBy: generated.askedBy,
          text: generated.text,
          status: created.status ?? status,
          postId: created.id,
        });
      } catch (err) {
        onLog("post submit failed", { platform, err: String(err) });
        // Still recorded, so the copy isn't lost with the error.
        await store.recordPost({
          id: `failed-${platform}-${Date.now()}`,
          industry: cfg.id,
          platform,
          accountId: account.id,
          topic: generated.topic,
          askedBy: generated.askedBy,
          text: generated.text,
          status: "failed",
          error: String(err).slice(0, 400),
        });
        results.push({
          platform,
          topic: generated.topic,
          askedBy: generated.askedBy,
          text: generated.text,
          status: "failed",
          error: String(err),
        });
      }
    }

    return results;
  }

  /**
   * Generates posts and schedules them for the best available time.
   *
   * "Best" is honest about what we actually know. GHL's own analytics are
   * day-level only — `grouping` is always `"daily"`, there is no hourly
   * breakdown — so we can genuinely learn the best DAY of the week once enough
   * data exists, but the HOUR is always a fixed, sensible default. Getting real
   * hour-of-day would need Meta's own Insights API. See SOCIAL_AUTOMATION.md §3.
   *
   * Below `MIN_DAYS_FOR_TIMING` days of collected data, there is no learned
   * "best day" to use — see `bestDays()`. Rather than invent a winner, this
   * falls back to simply "tomorrow", which is the neutral choice: it schedules
   * a real post without pretending to know something we don't yet.
   */
  async scheduleAtBestTime(opts: {
    platforms?: Platform[];
    /** 0–23, business-local. Default from SOCIAL_POST_HOUR, else 11 (late morning). */
    hour?: number;
  } = {}): Promise<{
    results: PublishResult[];
    scheduledFor: string;
    /**
     * Pre-formatted in the BUSINESS's timezone, not the caller's. `scheduledFor`
     * is a plain ISO instant, and formatting it with a bare `toLocaleString()` —
     * on the machine running the CLI, or in whoever's browser is viewing the
     * dashboard — shows the wrong local time for anyone not sitting in the same
     * timezone as the business. Caught exactly this: "11am Chicago" rendered as
     * "9:00 PM" on a Karachi machine, correct instant, misleading display.
     */
    scheduledForDisplay: string;
    usedLearnedData: boolean;
    dataDays: number;
  }> {
    const { cfg, onLog = () => {} } = this.deps;
    const hour = opts.hour ?? Number(process.env.SOCIAL_POST_HOUR ?? 11);
    const timezone = cfg.business.timezone;

    const { ready, days, ranking } = await this.bestDays();
    const targetWeekday = ready && ranking.length
      ? ranking[0]!.weekday
      : weekdayIn(timezone, new Date(Date.now() + 24 * 3600_000)); // tomorrow — not a guess dressed up as insight

    const scheduleDate = nextOccurrence(timezone, targetWeekday, hour).toISOString();
    const scheduledForDisplay = `${new Date(scheduleDate).toLocaleString("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: timezone,
    })} (${timezone})`;

    onLog("scheduling at best available time", {
      scheduleDate,
      timezone,
      usedLearnedData: ready,
      dataDays: days,
      basis: ready ? `learned: ${ranking[0]!.name}s perform best` : "not enough data yet — defaulted to tomorrow",
    });

    const results = await this.publish({ platforms: opts.platforms, status: "scheduled", scheduleDate });
    return { results, scheduledFor: scheduleDate, scheduledForDisplay, usedLearnedData: ready, dataDays: days };
  }

  /** Snapshot today's analytics for every connected account. */
  async collectStats(): Promise<{ profileId: string; platform: string; days: number }[]> {
    const { store, onLog = () => {} } = this.deps;
    const accounts = await this.client.accounts();
    const out: { profileId: string; platform: string; days: number }[] = [];

    for (const account of accounts) {
      if (!account.hasStatisticsPermissions || account.isExpired) continue;
      const stats = await this.client.statistics([account.profileId], [account.platform as Platform]);
      if (!stats) continue;
      const days = await store.snapshot(account.profileId, account.platform, stats);
      onLog("stats snapshotted", { platform: account.platform, days });
      out.push({ profileId: account.profileId, platform: account.platform, days });
    }

    return out;
  }

  /**
   * Best day to post, or an honest refusal.
   *
   * Returning a confident ranking off five days of data would be the easiest way
   * to make this feature look good and be wrong. Best-time-to-post is a
   * statistical claim, and below three weeks there isn't one — so it says so
   * rather than inventing a winner.
   */
  async bestDays(): Promise<{ ready: boolean; days: number; ranking: Awaited<ReturnType<SocialStore["weekdayInsights"]>> }> {
    const { store } = this.deps;
    const days = await store.dataDays();
    const ranking = await store.weekdayInsights();
    return { ready: days >= MIN_DAYS_FOR_TIMING, days, ranking };
  }
}
