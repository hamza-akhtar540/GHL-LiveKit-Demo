import { pgTable, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";

/**
 * Two tables, and the reason for both is the same: GoHighLevel's statistics
 * endpoint only exposes a rolling 7-day window. Anything longer-term — "which
 * day of the week performs best" — has to be accumulated by us, from day one,
 * or the data simply doesn't exist when we come to ask the question.
 */

/**
 * Every post we created, with the wall-clock time it went out.
 *
 * `postedAt` and `weekday` are the whole point. GHL can tell us engagement per
 * day-of-week for the last 7 days, but it cannot tell us which of *our* posts
 * that engagement belongs to. Recording when we posted is what makes the
 * correlation possible at all.
 */
export const socialPosts = pgTable(
  "social_posts",
  {
    /** GHL's post id, or a local id when it was never submitted. */
    id: text("id").primaryKey(),
    industry: text("industry").notNull(),
    platform: text("platform").notNull(),
    accountId: text("account_id").notNull(),
    /** What the post is about, so performance can be compared by subject. */
    topic: text("topic").notNull(),
    /** How many real callers asked about this — the reason we posted it. */
    askedBy: integer("asked_by").notNull().default(0),
    text: text("text").notNull(),
    /** draft | scheduled | published | failed */
    status: text("status").notNull(),
    error: text("error"),
    /** When it actually goes out. Null while it's a draft. */
    postedAt: timestamp("posted_at", { withTimezone: true }),
    /** 0 = Sunday. Denormalised deliberately — every timing query groups on it. */
    weekday: integer("weekday"),
    hour: integer("hour"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byPosted: index("social_posts_posted_idx").on(t.postedAt),
    byWeekday: index("social_posts_weekday_idx").on(t.weekday),
    byPlatform: index("social_posts_platform_idx").on(t.platform),
  }),
);

/**
 * A daily snapshot of account analytics.
 *
 * One row per account per day, taken from GHL's 7-day series. Snapshotting means
 * that after a few weeks we hold months of history the API itself would have
 * long since forgotten.
 *
 * The primary key is `${profileId}:${date}`, so re-running the collector on the
 * same day overwrites rather than double-counting — the collector is expected to
 * run more than once a day and must be idempotent.
 */
export const socialStats = pgTable(
  "social_stats",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull(),
    platform: text("platform").notNull(),
    /** The day these numbers describe (YYYY-MM-DD), not when we collected them. */
    date: text("date").notNull(),
    weekday: integer("weekday").notNull(),
    posts: integer("posts").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    likes: integer("likes").notNull().default(0),
    comments: integer("comments").notNull().default(0),
    /** Everything else GHL returned, including demographics. */
    extra: jsonb("extra").$type<Record<string, unknown>>(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byProfile: index("social_stats_profile_idx").on(t.profileId),
    byWeekday: index("social_stats_weekday_idx").on(t.weekday),
    byDate: index("social_stats_date_idx").on(t.date),
  }),
);
