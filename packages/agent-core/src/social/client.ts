import { GhlClient } from "../ghl/client.js";
import type { Platform } from "./content.js";

/**
 * GoHighLevel's social posting API.
 *
 * Everything defaults to `draft`. These endpoints publish to real accounts with
 * real audiences, and an accidental live post can't be unpublished from anyone's
 * feed who already saw it. Publishing is opt-in per call, never the default.
 */

const PATHS = {
  accounts: (locationId: string) => `/social-media-posting/${locationId}/accounts`,
  posts: (locationId: string) => `/social-media-posting/${locationId}/posts`,
  post: (locationId: string, postId: string) => `/social-media-posting/${locationId}/posts/${postId}`,
  list: (locationId: string) => `/social-media-posting/${locationId}/posts/list`,
  statistics: () => `/social-media-posting/statistics`,
} as const;

export interface SocialAccount {
  id: string;
  profileId: string;
  name: string;
  platform: string;
  /** GHL stops being able to post once this passes; reconnecting is manual. */
  expire?: string;
  isExpired?: boolean;
  hasStatisticsPermissions?: boolean;
}

export type PostStatus = "draft" | "scheduled" | "published";

export interface CreatePostInput {
  accountIds: string[];
  text: string;
  /** Draft unless explicitly told otherwise. */
  status?: PostStatus;
  /** ISO. Required by GHL when status is `scheduled`. */
  scheduleDate?: string;
  type?: "post" | "story" | "reel";
}

/**
 * A post as GHL actually stores it. This is the authoritative record — our own
 * Postgres mirror knows the `topic`/`askedBy` provenance GHL has no field for,
 * but only GHL knows whether a post still exists and what its real status is.
 *
 * `id` here is always GHL's `_id`. See `assertGhlPostId` for why that matters.
 */
export interface GhlPost {
  id: string;
  status: string;
  type: string;
  summary: string;
  accountIds: string[];
  scheduleDate?: string;
  publishedAt?: string;
  createdAt?: string;
  /**
   * NOT trustworthy until the post fires. Verified live: four draft/scheduled
   * posts all reported `"google"` while their accountIds were Facebook pages.
   * Resolve the real platform by joining `accountIds` against `accounts()`.
   */
  reportedPlatform?: string;
  deleted?: boolean;
}

/** GHL's own wire shape, mapped immediately so `_id` never escapes this module. */
interface RawGhlPost {
  _id?: string;
  status?: string;
  type?: string;
  summary?: string;
  accountIds?: string[];
  scheduleDate?: string;
  publishedAt?: string | null;
  createdAt?: string;
  platform?: string;
  deleted?: boolean;
}

function toGhlPost(raw: RawGhlPost): GhlPost {
  return {
    id: raw._id ?? "",
    status: raw.status ?? "unknown",
    type: raw.type ?? "post",
    summary: raw.summary ?? "",
    accountIds: raw.accountIds ?? [],
    scheduleDate: raw.scheduleDate,
    publishedAt: raw.publishedAt ?? undefined,
    createdAt: raw.createdAt,
    // Renamed on the way out so no caller can mistake it for the real platform.
    reportedPlatform: raw.platform,
    deleted: raw.deleted,
  };
}

/**
 * Refuses anything that is not one of GHL's own post ids.
 *
 * Three distinct kinds of not-a-GHL-id reach this code, and each fails
 * differently and confusingly if passed through:
 *
 *  - `local-…` / `failed-…`: synthetic ids our own mirror invented while the
 *    `_id` extraction bug was live. Every row created before that fix has one.
 *  - `urn:li:share:…`: LinkedIn's platform id, from the `postId` field.
 *  - `1452839210194289`: Facebook's numeric platform id, same field.
 *
 * A platform id 404s; a synthetic id 404s or, worse, hits an unrelated record.
 * Better to refuse loudly here than to let the UI offer a button that cannot work.
 */
export function assertGhlPostId(id: string, action: string): void {
  const reason =
    /^(local|failed)-/.test(id)
      ? "this post was recorded before we captured GHL's real id, so GHL has no record we can address"
      : id.includes(":")
        ? "that is a LinkedIn platform id (urn:…), not GHL's post id"
        : /^\d+$/.test(id)
          ? "that is a Facebook platform id, not GHL's post id"
          : !/^[a-f0-9]{24}$/i.test(id)
            ? "not a GHL post id (expected a 24-character hex id)"
            : undefined;

  if (reason) throw new Error(`Cannot ${action} post ${id} — ${reason}.`);
}

/** A 7-day daily series per metric, plus week-on-week change. */
export interface SocialStatistics {
  dayRange: string[];
  grouping: string;
  totals: Record<string, number>;
  postPerformance: {
    posts: Record<string, number[]>;
    impressions?: number[];
    likes?: number[];
    comments?: number[];
  };
  breakdowns?: Record<string, unknown>;
}

export class SocialClient {
  constructor(private readonly client: GhlClient = new GhlClient()) {}

  private get locationId(): string {
    return this.client.env.locationId;
  }

  async accounts(): Promise<SocialAccount[]> {
    const res = await this.client.request<{
      results?: { accounts?: SocialAccount[] };
    }>(PATHS.accounts(this.locationId));
    return res.results?.accounts ?? [];
  }

  /** Accounts we can post to right now, for a given platform. */
  async accountsFor(platform: Platform): Promise<SocialAccount[]> {
    return (await this.accounts()).filter(
      (a) => a.platform === platform && !a.isExpired,
    );
  }

  async createPost(input: CreatePostInput): Promise<{ id?: string; status?: string }> {
    const status = input.status ?? "draft";
    if (status === "scheduled" && !input.scheduleDate) {
      throw new Error("scheduled posts need a scheduleDate");
    }

    const userId = process.env.GHL_USER_ID;
    if (!userId) {
      // GHL requires it and rejects the call without it, so fail with something
      // that says what to do rather than surfacing a raw 422.
      throw new Error("GHL_USER_ID not set in .env — required by the social posting API");
    }

    const res = await this.client.request<{
      results?: { post?: RawGhlPost };
    }>(PATHS.posts(this.locationId), {
      method: "POST",
      body: {
        accountIds: input.accountIds,
        summary: input.text,
        type: input.type ?? "post",
        status,
        // GHL rejects the request without this field present — confirmed live:
        // draft creation tolerates its absence, but `published`/`scheduled`
        // 422s with "media must be an array with media objects or an empty
        // array". All our posts are text-only, so an empty array is correct,
        // not a placeholder for something we forgot to fill in.
        media: [],
        userId,
        ...(input.scheduleDate ? { scheduleDate: input.scheduleDate, scheduleTimeUpdated: true } : {}),
      },
    });

    // `results.post._id` — and both halves of that path were previously wrong.
    // The old code read `res.post?.id ?? res.id`: wrong nesting (the envelope is
    // `results`, exactly as `listPosts` already assumed) AND wrong field name
    // (GHL's key is `_id`; there is no `id` anywhere in the response). So it
    // returned undefined on every call ever made, `recordPost` fell through to a
    // synthetic `local-<platform>-<timestamp>` id, and nothing this system
    // created could afterwards be edited or deleted. Both halves verified by
    // dumping a real create response.
    //
    // Do NOT reach for `postId` as a fallback. It is the *platform's* id once
    // published (`urn:li:share:…`, `1452839210194289`), it is ABSENT on drafts,
    // and it happens to equal `_id` on scheduled posts — so it would look
    // correct in exactly the case you tested first, then 404 on published posts.
    const post = res.results?.post;
    return { id: post?._id, status: post?.status ?? status };
  }

  /**
   * Verified live: GHL confirms with `{"message":"Deleted Post"}`.
   *
   * Takes GHL's own `_id`. A 404 is treated as success by callers — a post a
   * human already removed in the GHL UI is in the desired state either way, and
   * re-deleting must not read as a failure.
   */
  async deletePost(postId: string): Promise<void> {
    assertGhlPostId(postId, "delete");
    await this.client.request(PATHS.post(this.locationId, postId), { method: "DELETE" });
  }

  /**
   * Only returns posts created *through* GHL. Posts made natively on the platform
   * don't appear unless the account has `syncPosts` enabled — verified: the list
   * came back empty while statistics reported existing native posts.
   */
  async listPosts(opts: {
    fromDate: string;
    toDate: string;
    limit?: number;
    skip?: number;
  }): Promise<GhlPost[]> {
    const res = await this.client.request<{
      results?: { posts?: RawGhlPost[]; count?: number };
    }>(PATHS.list(this.locationId), {
      method: "POST",
      body: {
        fromDate: opts.fromDate,
        toDate: opts.toDate,
        skip: String(opts.skip ?? 0),
        limit: String(opts.limit ?? 50),
        includeUsers: "true",
        type: "all",
      },
    });

    // `count` came back as 7 against a limit of 20, which is indistinguishable
    // between "7 total" and "7 on this page" — so it is deliberately not
    // returned or used for pagination. Page with `skip` until a short page
    // arrives instead.
    return (res.results?.posts ?? []).map(toGhlPost);
  }

  /** A single post by GHL's own `_id`. */
  async getPost(postId: string): Promise<GhlPost | undefined> {
    assertGhlPostId(postId, "read");
    const res = await this.client.request<{ results?: { post?: RawGhlPost } }>(
      PATHS.post(this.locationId, postId),
    );
    const post = res.results?.post;
    return post ? toGhlPost(post) : undefined;
  }

  /**
   * Edit an existing post. Takes a PATCH-shaped `changes` argument but performs a
   * **read-modify-write internally**, because GHL's edit endpoint is not a patch.
   *
   * Established the hard way, from a real 422: sending only `{type, summary}`
   * fails with "accountIds must be an array with Account IDs / should not be
   * empty" — even though the published schema lists only `id` and `type` as
   * required. The required set is larger than documented and there is no way to
   * know which other fields join it, so the only safe contract is to re-send the
   * post's whole current state with the caller's changes layered on top.
   *
   * Doing the fetch in here rather than asking callers to is deliberate: every
   * call site would otherwise have to remember a rule that is invisible until it
   * 422s, and one that forgets it silently corrupts a scheduled post.
   */
  async editPost(
    postId: string,
    changes: {
      summary?: string;
      status?: string;
      accountIds?: string[];
      scheduleDate?: string;
      type?: string;
    },
  ): Promise<GhlPost | undefined> {
    assertGhlPostId(postId, "edit");

    const current = await this.getPost(postId);
    if (!current) throw new Error(`Cannot edit post ${postId} — GHL has no such post.`);

    const next = {
      type: changes.type ?? current.type,
      accountIds: changes.accountIds ?? current.accountIds,
      summary: changes.summary ?? current.summary,
      status: changes.status ?? current.status,
      scheduleDate: changes.scheduleDate ?? current.scheduleDate,
    };

    if (!next.accountIds.length) {
      throw new Error(`Cannot edit post ${postId} — it has no accountIds and GHL requires at least one.`);
    }

    // Same guard as createPost, for the same reason: GHL rejects the call
    // without it and the raw 422 does not say what to do. It is an *optional*
    // field on the edit schema, so omitting it fails at runtime rather than at
    // compile time.
    const userId = process.env.GHL_USER_ID;
    if (!userId) {
      throw new Error("GHL_USER_ID not set in .env — required by the social posting API");
    }

    const res = await this.client.request<{ results?: { post?: RawGhlPost } }>(
      PATHS.post(this.locationId, postId),
      {
        method: "PUT",
        body: {
          type: next.type,
          accountIds: next.accountIds,
          summary: next.summary,
          status: next.status,
          media: [],
          userId,
          // Moving a scheduled post needs BOTH — the date alone is silently
          // ignored, the same pairing createPost already relies on.
          ...(next.scheduleDate
            ? {
                scheduleDate: next.scheduleDate,
                scheduleTimeUpdated: changes.scheduleDate !== undefined,
              }
            : {}),
        },
      },
    );

    const post = res.results?.post;
    return post ? toGhlPost(post) : undefined;
  }

  /**
   * Analytics for the last 7 days, as a daily series.
   *
   * `grouping` is always `"daily"` — there is no hourly option, which is why
   * best-day-of-week is answerable from this and best-hour-of-day is not.
   */
  async statistics(profileIds: string[], platforms?: Platform[]): Promise<SocialStatistics | undefined> {
    if (!profileIds.length) return undefined;
    const res = await this.client.request<{ results?: SocialStatistics }>(PATHS.statistics(), {
      method: "POST",
      /**
       * `locationId` goes in the QUERY STRING on this endpoint, not the body —
       * established by the API contradicting itself. Omit it entirely and it
       * fails `401 "Location ID is required"`, which reads as an auth problem
       * and is not one. Put it in the body instead and it fails
       * `422 "property locationId should not exist"`. Only the query works.
       *
       * This is why `collectStats` had never once succeeded, and therefore why
       * the best-day-to-post analysis has always had zero data to work from.
       */
      query: { locationId: this.locationId },
      body: { profileIds, ...(platforms?.length ? { platforms } : {}) },
    });
    return res.results;
  }
}
