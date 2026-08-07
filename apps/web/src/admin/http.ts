import {
  AdminData,
  AdminWriteError,
  AdminWriter,
  BookingIndex,
  CrmSync,
  GhlBookingStore,
  LeadIngestor,
  LiveSessions,
  PgConversationStore,
  PgLeadStore,
  SocialPublisher,
  SocialStore,
  WRITE_RISK,
  type IndustryConfig,
} from "@ghl-lk/agent-core";
import { checkCredentials, clearCookie, createSession, readSessionCookie, sessionCookie, verifySession } from "./auth.js";

/**
 * The admin dashboard's HTTP surface. Same shape as `leads/http.ts` in
 * agent-core — a pure function from a request description to a response
 * description — but this one is small enough, and specific enough to `apps/web`
 * (cookies, HTML), to live here rather than in the shared package.
 *
 * Three things are gated in exactly one place each, so a new route cannot forget
 * any of them:
 *
 *  - **auth** — every `/admin/api/*` route requires a valid session cookie.
 *  - **CSRF** — every non-GET is checked for same-origin provenance. See
 *    `sameOrigin` for why `SameSite=Strict` is not sufficient on its own.
 *  - **capabilities** — each route declares `needs: ["db"]` / `["ghl"]`, and the
 *    dispatcher returns 503 before the handler runs. This replaced a blanket
 *    "no DATABASE_URL ⇒ 503 everything" check that also blocked contact and
 *    opportunity writes, which need only GHL credentials.
 *
 * Routes are matched by exact segment count, NOT by prefix. A `startsWith`
 * match on `conversations/` silently swallows `conversations/<id>/reply` and
 * treats the whole tail as a conversation id — a 404 for a route that is wired
 * up correctly on the client. Every sub-resource added here would hit that.
 */

export interface AdminHttpRequest {
  method: string;
  pathname: string;
  query: Record<string, string>;
  cookie?: string;
  /**
   * Request headers, lowercased. Needed for the CSRF check — and note that
   * `server.ts` only reads a request BODY when the method is POST, which is why
   * every browser-facing write here is a POST rather than a PUT or DELETE. A PUT
   * would arrive with `body: undefined` and fail as a silent no-op, which is the
   * worst failure shape available: the operator clicks Save and nothing happens.
   */
  headers?: Record<string, string | string[] | undefined>;
  /** Parsed JSON body. Present for any POST, not just login. */
  body?: Record<string, unknown>;
}

export interface AdminHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const json = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): AdminHttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...extraHeaders },
  body: JSON.stringify(body),
});

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function header(req: AdminHttpRequest, name: string): string | undefined {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * CSRF defence for state-changing requests.
 *
 * `SameSite=Strict` on the session cookie (see `auth.ts`) kills classic
 * cross-*origin* CSRF, but SameSite is scoped to the registrable *site* — scheme
 * and port do not create a new site. So in development, a page on
 * `localhost:8080` can `fetch("http://localhost:3000/admin/api/...", {method:
 * "POST", credentials:"include"})` and the cookie rides along. Several write
 * routes need no request body at all, which makes them CORS-simple requests that
 * no preflight protects, and an attacker never needs to read the response — the
 * write has already happened. In production, any sibling or compromised
 * subdomain has the same power.
 *
 * Two independent checks, because either alone has a gap:
 *
 *  1. `Sec-Fetch-Site: same-origin`. Browser-set and unspoofable by page JS, but
 *     absent on older browsers and on non-browser clients like curl.
 *  2. `Origin` matching `Host`. Covers the case where Sec-Fetch-Site is missing.
 *
 * And a `content-type: application/json` requirement on writes, which a
 * cross-site HTML `<form>` physically cannot set — forms are limited to
 * urlencoded, multipart and text/plain.
 */
function sameOrigin(req: AdminHttpRequest): { ok: true } | { ok: false; why: string } {
  const site = header(req, "sec-fetch-site");
  if (site && site !== "same-origin") {
    return { ok: false, why: `cross-site request (sec-fetch-site: ${site})` };
  }

  if (!site) {
    const origin = header(req, "origin");
    const host = header(req, "host");
    if (origin && host) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return { ok: false, why: "unparseable Origin header" };
      }
      if (originHost !== host) {
        return { ok: false, why: `Origin ${originHost} does not match Host ${host}` };
      }
    }
  }

  const contentType = header(req, "content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    // Deliberately strict: a cross-site <form> cannot set this, so requiring it
    // closes the no-preflight hole even when Sec-Fetch-Site and Origin are both
    // absent. Every legitimate caller is our own fetch().
    return { ok: false, why: "writes must send content-type: application/json" };
  }

  return { ok: true };
}

export interface AdminDeps {
  cfg: IndustryConfig;
  /** Injected rather than reading the filesystem directly from this module. */
  readHtml: (page: "shell" | "login") => Promise<string>;
  /**
   * Serves the dashboard's own JS/CSS. Required because `server.ts` routes ALL
   * of `/admin/*` into this handler before its static-file fall-through, so
   * without this every asset under `/admin/` 404s no matter that it exists on
   * disk. Returns undefined for anything that isn't a known asset.
   */
  readAsset?: (name: string) => Promise<{ body: string; contentType: string } | undefined>;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
}

/** What a route needs in order to work at all. */
type Capability = "db" | "ghl";

interface RouteContext {
  req: AdminHttpRequest;
  params: Record<string, string>;
  data: AdminData;
  writer?: AdminWriter;
  live?: LiveSessions;
  publisher?: SocialPublisher;
  onLog: (msg: string, data?: Record<string, unknown>) => void;
}

interface AdminRoute {
  method: "GET" | "POST";
  /** Segments after `/admin/api/`. `:name` captures one segment. */
  path: string;
  needs?: Capability[];
  handle: (ctx: RouteContext) => Promise<AdminHttpResponse>;
}

/** Exact segment match. Never a prefix match — see the module doc-comment. */
function matchRoute(
  routes: AdminRoute[],
  method: string,
  section: string,
): { route: AdminRoute; params: Record<string, string> } | undefined {
  const actual = section.split("/").filter(Boolean).map(decodeURIComponent);

  for (const route of routes) {
    if (route.method !== method) continue;
    const expected = route.path.split("/").filter(Boolean);
    if (expected.length !== actual.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    for (const [i, part] of expected.entries()) {
      if (part.startsWith(":")) params[part.slice(1)] = actual[i]!;
      else if (part !== actual[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return undefined;
}

/**
 * Collaborators open their own connections (a postgres pool, a LiveKit HTTP
 * client), so they're built once here rather than per-request. Each is optional
 * and its absence is reported per-route rather than crashing the server: a dev
 * box with no LiveKit keys should still be able to see everything else.
 */
export function createAdminHandler(deps: AdminDeps) {
  const hasDb = !!process.env.DATABASE_URL;
  const hasGhl = !!process.env.GHL_PIT;

  const data = hasDb ? new AdminData() : undefined;

  let live: LiveSessions | undefined;
  try {
    live = new LiveSessions();
  } catch {
    live = undefined; // LiveKit env vars missing — the live-sessions page says so
  }

  // The writer is a deliberate sibling of the read-only AdminData rather than
  // methods on it: `AdminData`'s doc-comment asserts it never issues a GHL
  // POST/PUT/DELETE, and that assertion is grep-verifiable documentation worth
  // keeping true. Same reasoning as SocialPublisher below, which established the
  // pattern.
  /**
   * The SAME booking store the voice agent uses, with the index attached —
   * without the index, `cancel` and `reschedule` return null through their early
   * guards and every booking action becomes a silent no-op.
   */
  const bookingStore =
    hasGhl && hasDb
      ? new GhlBookingStore(deps.cfg.resources, undefined, new BookingIndex(), deps.cfg.id)
      : undefined;

  /**
   * The same ingestion pipeline the webhooks use, so a retry from the console
   * runs identical logic rather than a second implementation of it.
   */
  const ingestor =
    hasDb && hasGhl
      ? new LeadIngestor({
          store: new PgLeadStore(),
          crm: new CrmSync(),
          conversations: new PgConversationStore(),
          cfg: deps.cfg,
          onLog: deps.onLog,
        })
      : undefined;

  const writer = hasGhl
    ? new AdminWriter({
        operator: process.env.ADMIN_EMAIL,
        onLog: deps.onLog,
        booking: bookingStore,
        leads: hasDb ? new PgLeadStore() : undefined,
        conversations: hasDb ? new PgConversationStore() : undefined,
        /**
         * `process`, not `ingest` — the latter begins with the idempotency claim
         * and would return `duplicate` for an already-claimed lead, doing nothing.
         */
        reprocessLead:
          hasDb && ingestor
            ? (id, lead) => ingestor.process(id, lead as never).then((r) => ({ status: r.status }))
            : undefined,
      })
    : undefined;

  const publisher = hasDb
    ? new SocialPublisher({
        cfg: deps.cfg,
        conversations: new PgConversationStore(),
        store: new SocialStore(),
      })
    : undefined;

  const routes: AdminRoute[] = [
    // ---------------------------------------------------------------- reads --
    { method: "GET", path: "overview", needs: ["db"], handle: (c) => c.data.overview().then((r) => json(200, r)) },
    {
      method: "GET",
      path: "conversations",
      needs: ["db"],
      handle: (c) => c.data.conversations(limitOf(c.req)).then((r) => json(200, r)),
    },
    {
      method: "GET",
      path: "conversations/:id",
      needs: ["db"],
      handle: async (c) => {
        const convo = await c.data.conversation(c.params.id!);
        return convo ? json(200, convo) : json(404, { ok: false, error: "not found" });
      },
    },
    /**
     * The merged view — live GHL appointments UNIONed with our index. This is
     * what makes the page truthful: our index alone hides appointments booked by
     * a human in GHL, and reports a stale status for ones they have since marked
     * showed or no-show.
     */
    {
      method: "GET",
      path: "bookings",
      needs: ["db"],
      handle: (c) => c.data.bookingsMerged(deps.cfg, limitOf(c.req) ?? 50).then((r) => json(200, r)),
    },
    {
      method: "GET",
      path: "calendars",
      needs: ["db", "ghl"],
      handle: async (c) =>
        json(200, {
          calendars: await c.data.calendars(deps.cfg),
          // The resources the console may actually book, i.e. those with a
          // calendar configured. Anything else is shown read-only with a reason.
          resources: deps.cfg.resources.map((r) => ({
            id: r.id,
            label: r.label,
            durationMin: r.durationMin,
            params: r.params,
          })),
          timezone: deps.cfg.business.timezone,
        }),
    },
    {
      method: "GET",
      path: "bookings/slots",
      needs: ["db", "ghl"],
      handle: async (c) => {
        const resourceId = c.req.query.resourceId;
        const date = c.req.query.date;
        if (!resourceId || !date) {
          return json(400, { ok: false, error: "resourceId and date are both required" });
        }
        return json(200, await c.data.slotsWithOccupancy(deps.cfg, { resourceId, date, limit: 50 }));
      },
    },
    {
      method: "GET",
      path: "leads",
      needs: ["db"],
      handle: (c) =>
        c.data
          .leads({
            limit: limitOf(c.req) ?? 50,
            offset: Number(c.req.query.offset ?? 0) || 0,
            status: c.req.query.status,
            sort: c.req.query.sort,
            dir: c.req.query.dir,
          })
          .then((r) => json(200, r)),
    },
    {
      method: "GET",
      path: "leads/:id",
      needs: ["db"],
      handle: async (c) => {
        const row = await c.data.lead(c.params.id!);
        return row ? json(200, row) : json(404, { ok: false, error: "not found" });
      },
    },
    {
      method: "GET",
      path: "emails",
      needs: ["db"],
      handle: async (c) => {
        const [ours, ghl] = await Promise.all([
          c.data.emails(limitOf(c.req)),
          c.data.emailConversations(limitOf(c.req)).catch((err) => {
            c.onLog("email conversations fetch failed", { err: String(err) });
            return [];
          }),
        ]);
        return json(200, { composed: ours, ghlThreads: ghl });
      },
    },
    {
      method: "GET",
      path: "conversations/:id/thread",
      needs: ["db", "ghl"],
      handle: async (c) => {
        const contactId = c.req.query.contactId;
        if (!contactId) return json(200, { conversationId: null, messages: [], activity: [] });
        return json(200, await c.data.ghlThread(contactId));
      },
    },
    {
      method: "GET",
      path: "emails/:id",
      needs: ["db"],
      handle: async (c) => {
        const row = await c.data.email(c.params.id!);
        return row ? json(200, row) : json(404, { ok: false, error: "not found" });
      },
    },
    {
      method: "GET",
      path: "needs-human",
      needs: ["db"],
      handle: (c) => c.data.needsHuman(limitOf(c.req) ?? 50).then((r) => json(200, r)),
    },
    {
      method: "GET",
      path: "opportunities",
      needs: ["db", "ghl"],
      handle: (c) =>
        c.data
          .opportunities({ limit: limitOf(c.req) ?? 25, status: c.req.query.status })
          .then((r) => json(200, r)),
    },
    {
      method: "GET",
      path: "contacts",
      needs: ["db", "ghl"],
      handle: (c) =>
        c.data
          .contacts({
            limit: limitOf(c.req) ?? 25,
            query: c.req.query.q,
            startAfter: c.req.query.startAfter,
            startAfterId: c.req.query.startAfterId,
          })
          .then((r) => json(200, r)),
    },
    /**
     * Contact 360 — one fan-out rather than five browser round-trips. Ordered
     * after the plain `contacts` route but matched by exact segment count, so
     * there is no shadowing either way.
     */
    {
      method: "GET",
      path: "contacts/:id",
      needs: ["db", "ghl"],
      handle: (c) => c.data.contact360(deps.cfg, c.params.id!).then((r) => json(200, r)),
    },
    { method: "GET", path: "social", needs: ["db", "ghl"], handle: (c) => c.data.social().then((r) => json(200, r)) },
    {
      method: "GET",
      path: "social/analytics",
      needs: ["ghl"],
      handle: async (c) => {
        const { profileId, platform } = c.req.query;
        if (!profileId || !platform) return json(400, { ok: false, error: "profileId and platform are required" });
        const a = await c.data.socialAnalytics(profileId, platform);
        return a ? json(200, a) : json(404, { ok: false, error: "no analytics for that account" });
      },
    },
    {
      method: "GET",
      path: "pipelines",
      needs: ["ghl"],
      handle: async (c) => json(200, { pipelines: await c.data.pipelines() }),
    },
    {
      method: "GET",
      path: "live",
      handle: async (c) =>
        c.live ? json(200, { rooms: await c.live.list() }) : json(200, { rooms: [], error: "LiveKit env vars not set" }),
    },

    /**
     * The confirm-posture table, served rather than duplicated in the client.
     * One definition of "which actions are irreversible" for the whole console.
     */
    { method: "GET", path: "write-policy", handle: async () => json(200, { risks: WRITE_RISK }) },

    // --------------------------------------------------------------- writes --
    {
      method: "POST",
      path: "bookings/create",
      needs: ["db", "ghl"],
      handle: async (c) => {
        const b = c.req.body ?? {};
        const booking = await c.writer!.createBooking({
          resourceId: String(b.resourceId ?? ""),
          start: String(b.start ?? ""),
          contact: asStringMap(b.contact),
          details: asStringMap(b.details),
        });
        return json(200, { booking });
      },
    },
    {
      method: "POST",
      path: "bookings/cancel",
      needs: ["db", "ghl"],
      handle: async (c) => {
        const booking = await c.writer!.cancelBooking(String(c.req.body?.code ?? ""));
        return json(200, { booking });
      },
    },
    {
      method: "POST",
      path: "bookings/reschedule",
      needs: ["db", "ghl"],
      handle: async (c) => {
        const booking = await c.writer!.rescheduleBooking(
          String(c.req.body?.code ?? ""),
          String(c.req.body?.start ?? ""),
        );
        return json(200, { booking });
      },
    },
    {
      method: "POST",
      path: "leads/retry",
      needs: ["db", "ghl"],
      handle: async (c) => json(200, await c.writer!.retryLead(String(c.req.body?.id ?? ""))),
    },
    {
      method: "POST",
      path: "conversations/reply",
      needs: ["db", "ghl"],
      handle: async (c) => {
        const b = c.req.body ?? {};
        const out = await c.writer!.replyToConversation({
          conversationId: String(b.conversationId ?? ""),
          contactId: String(b.contactId ?? ""),
          channel: b.channel === "SMS" ? "SMS" : "Email",
          message: String(b.message ?? ""),
          subject: b.subject ? String(b.subject) : undefined,
        });
        return json(200, out);
      },
    },
    {
      method: "POST",
      path: "contacts/update",
      needs: ["ghl"],
      handle: async (c) => {
        const { id, patch } = c.req.body ?? {};
        await c.writer!.updateContact(String(id ?? ""), (patch ?? {}) as never);
        // Read back so the UI renders the CRM's truth rather than local state.
        return json(200, { contact: await c.data.contactDetail(String(id ?? "")) });
      },
    },
    {
      method: "POST",
      path: "contacts/tags/add",
      needs: ["ghl"],
      handle: async (c) => {
        const tags = await c.writer!.addContactTags(String(c.req.body?.id ?? ""), asStringArray(c.req.body?.tags));
        return json(200, { tags });
      },
    },
    {
      method: "POST",
      path: "contacts/tags/remove",
      needs: ["ghl"],
      handle: async (c) => {
        const tags = await c.writer!.removeContactTags(String(c.req.body?.id ?? ""), asStringArray(c.req.body?.tags));
        return json(200, { tags });
      },
    },
    {
      method: "POST",
      path: "contacts/note",
      needs: ["ghl"],
      handle: async (c) => {
        await c.writer!.addContactNote(String(c.req.body?.id ?? ""), String(c.req.body?.body ?? ""));
        return json(200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "emails/send",
      needs: ["db", "ghl"],
      handle: async (c) => json(200, await c.writer!.sendQueuedEmail(String(c.req.body?.id ?? ""))),
    },
    {
      method: "POST",
      path: "emails/discard",
      needs: ["db"],
      handle: async (c) => json(200, { email: await c.writer!.discardQueuedEmail(String(c.req.body?.id ?? "")) }),
    },
    {
      method: "POST",
      path: "opportunities/update",
      needs: ["ghl"],
      handle: async (c) => {
        const b = c.req.body ?? {};
        await c.writer!.updateOpportunity(String(b.id ?? ""), (b.patch ?? {}) as never);
        return json(200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "opportunities/create",
      needs: ["ghl"],
      handle: async (c) => {
        const b = c.req.body ?? {};
        const out = await c.writer!.createOpportunity({
          name: String(b.name ?? ""),
          contactId: String(b.contactId ?? ""),
          pipelineId: String(b.pipelineId ?? ""),
          pipelineStageId: String(b.pipelineStageId ?? ""),
          monetaryValue: b.monetaryValue === undefined ? undefined : Number(b.monetaryValue),
        });
        return json(200, out);
      },
    },
    {
      method: "POST",
      path: "social/edit",
      needs: ["ghl"],
      handle: async (c) => {
        const b = c.req.body ?? {};
        await c.writer!.editSocialPost(String(b.id ?? ""), {
          summary: b.summary === undefined ? undefined : String(b.summary),
          scheduleDate: b.scheduleDate === undefined ? undefined : String(b.scheduleDate),
          status: b.status === undefined ? undefined : String(b.status),
        });
        return json(200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "social/delete-many",
      needs: ["ghl"],
      handle: async (c) => {
        const ids = asStringArray(c.req.body?.ids);
        if (!ids.length) return json(400, { ok: false, error: "no posts selected" });
        return json(200, { results: await c.writer!.deleteSocialPosts(ids) });
      },
    },
    {
      method: "POST",
      path: "social/delete",
      needs: ["ghl"],
      handle: async (c) => {
        await c.writer!.deleteSocialPost(String(c.req.body?.id ?? ""));
        return json(200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "social/draft",
      needs: ["db"],
      handle: async (c) => {
        const results = await c.publisher!.publish({ status: "draft", platforms: asPlatforms(c.req.body?.platforms) });
        c.onLog("admin drafted social posts", { count: results.length });
        return json(200, { results });
      },
    },
    {
      method: "POST",
      path: "social/schedule",
      needs: ["db"],
      handle: async (c) => {
        const out = await c.publisher!.scheduleAtBestTime({ platforms: asPlatforms(c.req.body?.platforms) });
        c.onLog("admin scheduled social posts", { count: out.results.length, scheduledFor: out.scheduledFor });
        return json(200, out);
      },
    },
    {
      method: "POST",
      path: "social/publish",
      needs: ["db"],
      handle: async (c) => {
        const results = await c.publisher!.publish({ status: "published", platforms: asPlatforms(c.req.body?.platforms) });
        c.onLog("admin published social posts", { count: results.length });
        return json(200, { results });
      },
    },
  ];

  return async function handleAdminRequest(req: AdminHttpRequest): Promise<AdminHttpResponse> {
    const onLog = deps.onLog ?? (() => {});

    // CSRF first, above everything including login — a forced login or forced
    // logout is also an attack, just a less interesting one.
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = sameOrigin(req);
      if (!origin.ok) {
        onLog("admin request rejected", { pathname: req.pathname, why: origin.why });
        return json(403, { ok: false, error: "forbidden", detail: origin.why });
      }
    }

    // --- unauthenticated routes -------------------------------------------
    if (req.pathname === "/admin/login" && req.method === "POST") {
      const email = String(req.body?.email ?? "");
      const password = String(req.body?.password ?? "");

      if (!checkCredentials(email, password)) {
        onLog("admin login failed", { email });
        return json(401, { ok: false, error: "invalid email or password" });
      }

      onLog("admin login", { email });
      return json(200, { ok: true }, { "set-cookie": sessionCookie(createSession()) });
    }

    if (req.pathname === "/admin/logout" && req.method === "POST") {
      return json(200, { ok: true }, { "set-cookie": clearCookie });
    }

    // --- everything else needs a valid session ------------------------------
    const authed = verifySession(readSessionCookie(req.cookie));

    // The page shell itself: unauth'd gets the login screen instead of a 401,
    // since this is meant to be opened directly in a browser tab.
    if (req.pathname === "/admin" && req.method === "GET") {
      const body = await deps.readHtml(authed ? "shell" : "login");
      return {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          // A console full of destructive buttons is a clickjacking target, and
          // authed HTML should not sit in an intermediary's cache.
          "x-frame-options": "DENY",
          "content-security-policy": "frame-ancestors 'none'",
          "cache-control": "no-store",
        },
        body,
      };
    }

    // --- the dashboard's own JS/CSS ---------------------------------------
    // Must sit before the /admin/api/ gate below, which 404s everything else.
    if (req.method === "GET" && deps.readAsset && !req.pathname.startsWith("/admin/api/")) {
      const name = req.pathname.slice("/admin/".length);
      if (name && !name.includes("/")) {
        const asset = await deps.readAsset(name);
        if (asset) {
          return {
            status: 200,
            headers: {
              "content-type": asset.contentType,
              // no-store, not a long max-age: these change with every deploy and
              // a stale app.js against a new API is a confusing failure.
              "cache-control": "no-store",
            },
            body: asset.body,
          };
        }
      }
    }

    if (!req.pathname.startsWith("/admin/api/")) {
      return json(404, { ok: false, error: "not found" });
    }

    if (!authed) return json(401, { ok: false, error: "not authenticated" });

    const section = req.pathname.slice("/admin/api/".length);
    const matched = matchRoute(routes, req.method, section);
    if (!matched) return json(404, { ok: false, error: `unknown admin route: ${req.method} ${section}` });

    // Capability gate: reported per-route, so a GHL-only deployment can still
    // edit contacts and a database-only one can still read conversations.
    for (const need of matched.route.needs ?? []) {
      if (need === "db" && !data) {
        return json(503, { ok: false, error: "this needs DATABASE_URL, which is not set" });
      }
      if (need === "ghl" && !writer && !hasGhl) {
        return json(503, { ok: false, error: "this needs GHL_PIT, which is not set" });
      }
    }
    if (matched.route.path.startsWith("social/") && !publisher) {
      return json(503, { ok: false, error: "social publishing needs DATABASE_URL" });
    }

    try {
      return await matched.route.handle({
        req,
        params: matched.params,
        data: data!,
        writer,
        live,
        publisher,
        onLog,
      });
    } catch (err) {
      // A write that could not happen must say so loudly. AdminWriteError
      // carries an operator-readable reason and its own status; anything else is
      // an upstream failure we describe as one.
      if (err instanceof AdminWriteError) {
        onLog("admin write failed", { section, op: err.op, err: err.message });
        return json(err.status, { ok: false, error: err.message, op: err.op });
      }
      onLog("admin request failed", { section, err: String(err) });
      return json(502, { ok: false, error: "upstream call failed", detail: String(err).slice(0, 300) });
    }
  };
}

/**
 * Coerce a client-supplied object to a flat string map, dropping anything that
 * isn't a scalar. The body is attacker-controlled once this is exposed, and these
 * values flow into a live CRM write.
 */
function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = String(v).trim();
      if (s) out[k] = s.slice(0, 500);
    }
  }
  return out;
}

/**
 * Which platforms to post to. `undefined` keeps the publisher's own default (all
 * of them), so an omitted field behaves exactly as before.
 */
function asPlatforms(value: unknown): ("facebook" | "instagram" | "linkedin")[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const allowed = ["facebook", "instagram", "linkedin"] as const;
  const picked = allowed.filter((p) => value.includes(p));
  return picked.length ? [...picked] : undefined;
}

/** Client-supplied array of tag strings, bounded and sanitised. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 25);
}

function limitOf(req: AdminHttpRequest): number | undefined {
  const raw = req.query.limit;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : undefined;
}
