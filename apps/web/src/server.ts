/**
 * Serves the demo site, the embeddable widget, and mints join tokens.
 *
 *   pnpm --filter @ghl-lk/web dev
 *
 * Token minting must stay server-side. A browser that mints its own needs the
 * API secret in client JS, which hands anyone with devtools the whole LiveKit
 * project.
 *
 * The LiveKit browser SDK is served from node_modules rather than a CDN — a
 * demo being recorded should never depend on someone else's uptime.
 */
import { createServer, type IncomingMessage } from "node:http";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname, extname, normalize } from "node:path";
import { createRequire } from "node:module";
import { AccessToken } from "livekit-server-sdk";
import {
  CrmSync,
  LeadFollowUp,
  LeadIngestor,
  PgConversationStore,
  PgLeadStore,
  getIndustry,
  handleLeadRequest,
  isLeadPath,
} from "@ghl-lk/agent-core";
import { config as loadEnv } from "dotenv";
import { createAdminHandler, isAdminPath } from "./admin/http.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../public");
loadEnv({ path: resolve(here, "../../../.env") });

const require = createRequire(import.meta.url);

/**
 * livekit-client's `exports` map exposes neither the UMD build nor
 * package.json, so neither can be resolved as a subpath. Resolve the main entry
 * — which is exported — and look for the UMD build around it. Lazy and cached,
 * so a packaging change breaks this one route instead of refusing to boot.
 */
let livekitClientPath: string | undefined;
async function resolveLivekitClient(): Promise<string> {
  if (livekitClientPath) return livekitClientPath;

  const mainDir = dirname(require.resolve("livekit-client"));
  const candidates = [
    resolve(mainDir, "livekit-client.umd.js"),
    resolve(mainDir, "dist/livekit-client.umd.js"),
    resolve(mainDir, "../dist/livekit-client.umd.js"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      livekitClientPath = candidate;
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(`Could not find livekit-client.umd.js near ${mainDir}`);
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

/** Same switch the agent worker uses, so both answer for the same business. */
const industry = getIndustry(process.env.INDUSTRY ?? "roofing");

const PORT = Number(process.env.WEB_PORT ?? 3000);

/** A form post shouldn't be able to exhaust memory. */
const MAX_BODY_BYTES = Number(process.env.LEAD_MAX_BODY_BYTES ?? 1_000_000);

/**
 * Reads the body as **raw bytes** and never as a string or parsed object.
 *
 * Meta signs webhooks with HMAC-SHA256 over the exact payload, so any
 * `JSON.parse` → `JSON.stringify` round-trip reorders keys and the signature can
 * then never be verified. Keeping the buffer is the only way to leave that door
 * open, and retrofitting it later is genuinely painful.
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { statusCode: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Lead ingestion, constructed once and only when a database exists — without it
 * there's nowhere to record a claim, and un-deduplicated ingestion is worse than
 * none.
 */
/**
 * The admin dashboard. Kept separate from `leadDeps` since it needs GHL and
 * LiveKit collaborators the lead pipeline doesn't, and it's fine for it to be
 * unavailable (503, not a crash) on a box with no database configured.
 */
const adminHandler = createAdminHandler({
  cfg: industry,
  readHtml: (page) => readFile(resolve(publicDir, "admin", `${page}.html`), "utf8"),
  /**
   * The dashboard's own JS/CSS. Needed because the admin route below claims all
   * of `/admin/*` before the static fall-through, so these files are otherwise
   * unreachable however correctly they sit on disk.
   *
   * Allow-listed by extension rather than serving any path: this handler is
   * reached before the session check, so a path-traversal here would read
   * arbitrary files with no auth at all.
   */
  readAsset: async (name) => {
    const ext = extname(name);
    if (ext !== ".js" && ext !== ".css") return undefined;
    if (name.includes("..") || name.includes("/") || name.includes("\\")) return undefined;
    try {
      const body = await readFile(resolve(publicDir, "admin", name), "utf8");
      return { body, contentType: MIME[ext]! };
    } catch {
      return undefined;
    }
  },
  onLog: (msg, data) => console.log(`[admin] ${msg}`, data ? JSON.stringify(data) : ""),
});

const leadDeps = process.env.DATABASE_URL
  ? (() => {
      const store = new PgLeadStore();
      const conversations = new PgConversationStore();

      // Passed to every layer, not just the HTTP handler. Without it a
      // successful ingest is completely silent, and "did that webhook actually
      // land" is the first question anyone asks of a system like this.
      const onLog = (msg: string, data?: Record<string, unknown>) =>
        console.log(`[leads] ${msg}`, data ? JSON.stringify(data) : "");

      const crm = process.env.GHL_PIT
        ? new CrmSync(undefined, (err, op) => onLog(`crm ${op} failed`, { err: String(err).slice(0, 160) }))
        : undefined;

      return {
        ingestor: new LeadIngestor({ store, conversations, crm, cfg: industry, onLog }),
        followUp: new LeadFollowUp({ store, conversations, cfg: industry, onLog }),
        onLog,
      };
    })()
  : undefined;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/api/token") {
      const room = url.searchParams.get("room") ?? `web-${Date.now()}`;
      const identity =
        url.searchParams.get("identity") ?? `visitor-${Math.random().toString(36).slice(2, 8)}`;

      const at = new AccessToken(req("LIVEKIT_API_KEY"), req("LIVEKIT_API_SECRET"), {
        identity,
        ttl: "1h",
      });
      at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });

      response.writeHead(200, {
        "content-type": "application/json",
        // The widget is meant to be embedded on someone else's domain.
        "access-control-allow-origin": "*",
      });
      response.end(JSON.stringify({ url: req("LIVEKIT_URL"), token: await at.toJwt(), room, identity }));
      return;
    }

    /**
     * The admin dashboard. Also before the static fall-through — `/admin`
     * would otherwise try to read a file called literally "admin" off disk.
     */
    if (isAdminPath(url.pathname)) {
      const raw = request.method === "POST" ? await readRawBody(request) : Buffer.alloc(0);
      const body = raw.length ? (safeJson(raw.toString("utf8")) as Record<string, unknown> | undefined) : undefined;

      const result = await adminHandler({
        method: request.method ?? "GET",
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        cookie: request.headers.cookie,
        // Needed for the same-origin check on writes: Sec-Fetch-Site, Origin,
        // Host and content-type all live here.
        headers: request.headers,
        body,
      });

      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    /**
     * Lead intake. Must sit before the static fall-through, which would
     * otherwise try to read `/webhooks/ghl` off disk and 404 it.
     */
    if (isLeadPath(url.pathname)) {
      if (!leadDeps) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "lead ingestion needs DATABASE_URL" }));
        return;
      }

      const raw =
        request.method === "GET" || request.method === "OPTIONS"
          ? Buffer.alloc(0)
          : await readRawBody(request);

      const result = await handleLeadRequest(
        {
          method: request.method ?? "GET",
          pathname: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: request.headers,
          raw,
        },
        leadDeps,
      );

      response.writeHead(result.status, result.headers);
      response.end(result.body);

      /**
       * Only now do the CRM work. Both GHL and Meta retry on slow responses as
       * well as failures, so anything expensive has to happen after the socket is
       * answered. The ledger claim already happened inside `handleLeadRequest`, so
       * a crash here leaves a recoverable row rather than a lost lead.
       */
      if (result.work) {
        void result.work().catch((err) => console.error("[leads] deferred work failed", err));
      }
      return;
    }

    if (url.pathname === "/vendor/livekit-client.umd.js") {
      const js = await readFile(await resolveLivekitClient());
      response.writeHead(200, { "content-type": MIME[".js"]!, "cache-control": "public, max-age=3600" });
      response.end(js);
      return;
    }

    // Everything else is a static file. `normalize` collapses any ../ before we
    // touch the filesystem, so a crafted path can't climb out of public/.
    const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    const file = resolve(publicDir, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
    if (!file.startsWith(publicDir)) {
      response.writeHead(403).end("forbidden");
      return;
    }

    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "access-control-allow-origin": "*",
    });
    response.end(body);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    // An oversized body is the client's problem, not ours — say so specifically
    // rather than reporting a server error for it.
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status !== 500) {
      response.writeHead(status, { "content-type": "text/plain" }).end((err as Error).message);
      return;
    }
    console.error(err);
    response.writeHead(500, { "content-type": "text/plain" }).end("server error");
  }
});

/**
 * Dev machines have things on 3000 already. Walk up to the next free port
 * rather than crashing — but only when the port wasn't asked for explicitly,
 * since a deliberate WEB_PORT silently moving would be worse than an error.
 */
function listen(port: number, attemptsLeft: number): void {
  // Both handlers must be torn down together. `listen(port, cb)` registers cb
  // as a 'listening' listener that survives a failed attempt, so leaving it
  // attached makes the retry announce the port that didn't work.
  const onListening = () => {
    server.removeListener("error", onError);
    console.log(`\n  Summit Peak Roofing demo:  http://localhost:${port}\n`);
    console.log(`  worker must be running:    pnpm --filter @ghl-lk/agent dev\n`);
  };

  const onError = (err: NodeJS.ErrnoException) => {
    server.removeListener("listening", onListening);
    if (err.code !== "EADDRINUSE" || attemptsLeft === 0 || process.env.WEB_PORT) {
      throw err;
    }
    console.log(`  port ${port} in use, trying ${port + 1}…`);
    listen(port + 1, attemptsLeft - 1);
  };

  server.once("listening", onListening);
  server.once("error", onError);
  server.listen(port);
}

listen(PORT, 10);
