import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { desc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { socialPosts, socialStats } from "./schema.js";
import type { SocialStatistics } from "./client.js";

export interface RecordedPost {
  id: string;
  platform: string;
  topic: string;
  status: string;
  postedAt?: string;
  weekday?: number;
  /**
   * How many callers asked about this topic. Provenance GoHighLevel has no field
   * for, and the reason this mirror is worth keeping alongside GHL's own list.
   */
  askedBy?: number;
  /** Why a submission failed, for rows that never reached GHL. */
  error?: string;
}

/** Engagement by day of the week, best first. */
export interface WeekdayInsight {
  weekday: number;
  name: string;
  days: number;
  avgImpressions: number;
  avgLikes: number;
  avgComments: number;
  /** Impressions + likes + comments, averaged. Used only for ranking. */
  score: number;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export class SocialStore {
  private readonly sql?: ReturnType<typeof postgres>;
  private readonly db: PostgresJsDatabase;

  constructor(urlOrDb: string | PostgresJsDatabase | undefined = process.env.DATABASE_URL) {
    if (typeof urlOrDb === "string") {
      this.sql = postgres(urlOrDb);
      this.db = drizzle(this.sql);
    } else if (urlOrDb) {
      this.db = urlOrDb;
    } else {
      throw new Error("DATABASE_URL not set — needed for SocialStore");
    }
  }

  async recordPost(post: {
    id: string;
    industry: string;
    platform: string;
    accountId: string;
    topic: string;
    askedBy: number;
    text: string;
    status: string;
    postedAt?: string;
    error?: string;
  }): Promise<void> {
    const when = post.postedAt ? new Date(post.postedAt) : undefined;
    await this.db
      .insert(socialPosts)
      .values({
        ...post,
        postedAt: when,
        // Denormalised at write time. Deriving it later would mean converting
        // timezones on every query, and getting that wrong silently skews the
        // whole ranking.
        weekday: when?.getDay(),
        hour: when?.getHours(),
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  }

  async markPosted(id: string, status: string, postedAt?: string): Promise<void> {
    const when = postedAt ? new Date(postedAt) : new Date();
    await this.db
      .update(socialPosts)
      .set({ status, postedAt: when, weekday: when.getDay(), hour: when.getHours() })
      .where(eq(socialPosts.id, id));
  }

  async recentPosts(limit = 20): Promise<RecordedPost[]> {
    const rows = await this.db
      .select()
      .from(socialPosts)
      .orderBy(desc(socialPosts.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      topic: r.topic,
      status: r.status,
      postedAt: r.postedAt?.toISOString(),
      weekday: r.weekday ?? undefined,
      askedBy: r.askedBy,
      error: r.error ?? undefined,
    }));
  }

  /**
   * Snapshots GHL's 7-day series into per-day rows.
   *
   * Upserts on `${profileId}:${date}`, so running this twice in a day corrects
   * the numbers rather than doubling them. The collector is expected to run on a
   * schedule and possibly by hand, so idempotence isn't optional.
   */
  async snapshot(
    profileId: string,
    platform: string,
    stats: SocialStatistics,
    now = new Date(),
  ): Promise<number> {
    const series = stats.postPerformance;
    const days = stats.dayRange?.length ?? 0;
    if (!days) return 0;

    let written = 0;

    for (let i = 0; i < days; i++) {
      /**
       * `dayRange` is ordered oldest-first and ends on today, so index i maps to
       * (days - 1 - i) days ago. Getting this backwards would invert the whole
       * dataset while still looking plausible, which is why it's spelled out.
       */
      const daysAgo = days - 1 - i;
      const date = new Date(now.getTime() - daysAgo * 86_400_000);
      const key = date.toISOString().slice(0, 10);

      const posts = Object.values(series.posts ?? {}).reduce(
        (n, arr) => n + (Array.isArray(arr) ? (arr[i] ?? 0) : 0),
        0,
      );

      await this.db
        .insert(socialStats)
        .values({
          id: `${profileId}:${key}`,
          profileId,
          platform,
          date: key,
          weekday: date.getDay(),
          posts,
          impressions: series.impressions?.[i] ?? 0,
          likes: series.likes?.[i] ?? 0,
          comments: series.comments?.[i] ?? 0,
          extra: { totals: stats.totals, breakdowns: stats.breakdowns },
          collectedAt: now,
        })
        .onConflictDoUpdate({
          target: socialStats.id,
          set: {
            posts,
            impressions: series.impressions?.[i] ?? 0,
            likes: series.likes?.[i] ?? 0,
            comments: series.comments?.[i] ?? 0,
            collectedAt: now,
          },
        });
      written++;
    }

    return written;
  }

  /**
   * Average engagement per weekday across everything collected so far.
   *
   * Only counts days that actually had a post — a Sunday with no post scoring
   * zero would drag Sundays down for a reason that has nothing to do with
   * Sundays.
   */
  async weekdayInsights(): Promise<WeekdayInsight[]> {
    const rows = await this.db
      .select({
        weekday: socialStats.weekday,
        days: sql<number>`count(*)::int`,
        impressions: sql<number>`coalesce(avg(${socialStats.impressions}), 0)::float`,
        likes: sql<number>`coalesce(avg(${socialStats.likes}), 0)::float`,
        comments: sql<number>`coalesce(avg(${socialStats.comments}), 0)::float`,
      })
      .from(socialStats)
      .where(sql`${socialStats.posts} > 0`)
      .groupBy(socialStats.weekday);

    return rows
      .map((r) => ({
        weekday: r.weekday,
        name: WEEKDAY_NAMES[r.weekday] ?? "?",
        days: r.days,
        avgImpressions: Math.round(r.impressions * 10) / 10,
        avgLikes: Math.round(r.likes * 10) / 10,
        avgComments: Math.round(r.comments * 10) / 10,
        score: Math.round((r.impressions + r.likes + r.comments) * 10) / 10,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /** How many distinct days of data exist. Below ~20 the ranking is noise. */
  async dataDays(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(distinct ${socialStats.date})::int` })
      .from(socialStats);
    return row?.n ?? 0;
  }

  async close(): Promise<void> {
    await this.sql?.end();
  }
}
