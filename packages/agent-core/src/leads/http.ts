import { createHmac, timingSafeEqual } from "node:crypto";
import {
  parseGenericWebhook,
  parseGhlWebhook,
  parseMetaLeadgen,
  parseWebForm,
} from "./parsers.js";
import type { LeadIngestor } from "./ingest.js";
import type { LeadFollowUp } from "./follow-up.js";
import type { Lead } from "./types.js";

/**
 * Transport-agnostic HTTP handling for lead intake.
 *
 * Lives here rather than in `apps/web` so the webhook logic isn't buried in a
 * static-file server, and so the exact code path can be exercised by a script
 * with nothing listening. The web app just maps a request onto this and writes
 * whatever comes back.
 *
 * `work` is the deliberate part of the shape: the caller writes the response
 * first and *then* awaits it. GHL and Meta both retry on slow responses as well
 * as failures, so doing CRM writes before responding causes retry storms.
 */
export interface LeadHttpRequest {
  method: string;
  pathname: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  /** Raw bytes, never a parsed object — see `verifyMetaSignature`. */
  raw: Buffer;
}

export interface LeadHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Run after the response is written. */
  work?: () => Promise<void>;
}

export interface LeadHttpDeps {
  ingestor: LeadIngestor;
  followUp?: LeadFollowUp;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
}

const JSON_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
};

const ok = (body: unknown): LeadHttpResponse => ({
  status: 200,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

const fail = (status: number, message: string): LeadHttpResponse => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify({ ok: false, error: message }),
});

/**
 * Meta signs the request with HMAC-SHA256 over the **exact bytes**. This is why
 * the raw buffer has to survive all the way here: parsing and re-serialising
 * reorders keys and the signature can then never match.
 *
 * Returns true when no secret is configured — an unsigned endpoint is acceptable
 * while URLs are temporary ngrok tunnels, but this must be set before anything
 * public and permanent.
 */
export function verifyMetaSignature(raw: Buffer, header?: string): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  if (!header?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

/** Accepts JSON or the urlencoded body a bare HTML `<form>` posts. */
function parseBody(raw: Buffer, contentType?: string): Record<string, unknown> | undefined {
  const text = raw.toString("utf8").trim();
  if (!text) return {};

  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const header = (h: LeadHttpRequest["headers"], name: string): string | undefined => {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Shared-secret check for the GHL workflow webhook.
 *
 * GHL's Custom Webhook action can send arbitrary headers, so the workflow sends
 * `x-webhook-secret: <GHL_WEBHOOK_SECRET>`. Without this the endpoint accepts a
 * lead from anyone who learns the URL — and each accepted lead writes a contact,
 * tags, a note and an opportunity into the CRM.
 *
 * Open when no secret is configured, same as the Meta check above, so local
 * development works unconfigured; set it before the URL is public.
 */
export function verifyGhlSecret(headerValue?: string, queryValue?: string): boolean {
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) return true;
  const given = headerValue ?? queryValue ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLeadPath(pathname: string): boolean {
  return pathname.startsWith("/api/leads") || pathname.startsWith("/webhooks/");
}

export async function handleLeadRequest(
  req: LeadHttpRequest,
  deps: LeadHttpDeps,
): Promise<LeadHttpResponse> {
  const { ingestor, followUp, onLog = () => {} } = deps;

  // Preflight. A browser posting JSON from a client's own site sends this first,
  // and without a reply the form submission never happens at all.
  if (req.method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
      body: "",
    };
  }

  /**
   * Meta's subscription handshake. It must echo `hub.challenge` back as plain
   * text — JSON fails verification. Worth having before the Meta app exists,
   * because it can be tested with curl and de-risks registration.
   */
  if (req.pathname === "/webhooks/meta/leads" && req.method === "GET") {
    const expected = process.env.META_VERIFY_TOKEN;
    if (!expected || req.query["hub.verify_token"] !== expected) {
      return fail(403, "verify token mismatch");
    }
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: req.query["hub.challenge"] ?? "",
    };
  }

  if (req.method !== "POST") {
    return { status: 405, headers: { ...JSON_HEADERS, allow: "POST, OPTIONS" }, body: JSON.stringify({ ok: false, error: "method not allowed" }) };
  }

  const contentType = header(req.headers, "content-type");
  const payload = parseBody(req.raw, contentType);
  if (!payload) {
    onLog("unparseable lead body", { pathname: req.pathname, bytes: req.raw.length });
    // 200 on purpose: a malformed body will be malformed on every retry, so
    // asking the sender to try again just wastes both sides' time.
    return ok({ ok: true, ignored: "unparseable body" });
  }

  let leads: Lead[];

  switch (req.pathname) {
    case "/webhooks/meta/leads": {
      if (!verifyMetaSignature(req.raw, header(req.headers, "x-hub-signature-256"))) {
        // The one deliberate non-2xx. A forged request must not be retried, and
        // a 401 says so unambiguously.
        onLog("meta signature mismatch", {});
        return fail(401, "invalid signature");
      }
      leads = parseMetaLeadgen(payload);
      break;
    }
    case "/webhooks/ghl":
      if (!verifyGhlSecret(header(req.headers, "x-webhook-secret"), req.query.secret)) {
        onLog("ghl webhook secret mismatch", {});
        return fail(401, "invalid secret");
      }
      leads = [parseGhlWebhook(payload)];
      break;
    case "/api/leads/form":
      leads = [
        parseWebForm(
          payload,
          header(req.headers, "referer") ?? req.query.pageUrl,
          header(req.headers, "referrer"),
        ),
      ];
      break;
    case "/api/leads/generic":
    case "/api/leads/webhook":
      leads = [parseGenericWebhook(payload)];
      break;
    default:
      return fail(404, "unknown lead endpoint");
  }

  if (!leads.length) {
    // Meta's page subscription also delivers comments, messages and more. Those
    // aren't errors — they're just not leadgen events.
    return ok({ ok: true, leads: 0, ignored: "no lead events in payload" });
  }

  /**
   * Respond now, process after. But note what is NOT deferred: the claim inside
   * `ingest` writes the ledger row, and that has to happen for the lead to
   * survive a crash. Deferring everything and returning 200 would mean a process
   * death loses the lead *and* tells the sender not to retry.
   */
  return {
    ...ok({ ok: true, leads: leads.length }),
    work: async () => {
      for (const lead of leads) {
        try {
          const result = await ingestor.ingest(lead, payload);
          if (result.status === "duplicate" || result.status === "rejected") continue;

          if (followUp && result.conversationId && lead.email) {
            await followUp.send({
              leadId: result.leadId,
              contactId: result.contactId,
              conversationId: result.conversationId,
              recipient: lead.email,
            });
          }
        } catch (err) {
          // Swallowed on purpose: the response is already sent, and the ledger
          // row keeps the lead recoverable by the sweeper.
          onLog("lead processing failed", { source: lead.source, err: String(err) });
        }
      }
    },
  };
}
