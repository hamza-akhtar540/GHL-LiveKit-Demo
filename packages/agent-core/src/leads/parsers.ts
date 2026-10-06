import type { Lead, LeadSource } from "./types.js";
import type { Conversation } from "../conversation/types.js";

/**
 * One function per source, each turning a payload into a `Lead`.
 *
 * Every parser here is deliberately forgiving. Two of these shapes have never
 * been seen in the wild — no real Meta or GHL webhook has ever been captured
 * against this account — so a parser that throws on an unexpected field would
 * lose the lead entirely. Instead: take what's recognisable, put the rest in
 * `fields`, and let the raw payload be stored for replay once we know better.
 */

/** Field names sources use for the same thing, in rough order of preference. */
const EMAIL_KEYS = ["email", "email_address", "e-mail", "emailAddress", "work_email"];
const PHONE_KEYS = ["phone", "phone_number", "phoneNumber", "mobile", "tel", "telephone"];
const NAME_KEYS = ["full_name", "fullName", "name", "your_name"];
const FIRST_KEYS = ["first_name", "firstName", "fname", "given_name"];
const LAST_KEYS = ["last_name", "lastName", "lname", "surname", "family_name"];
const MESSAGE_KEYS = ["message", "notes", "comments", "enquiry", "inquiry", "how_can_we_help", "body"];

/** Case- and separator-insensitive lookup: `full_name`, `fullName`, `Full Name`. */
function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const flat = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || typeof v === "object") continue;
    const value = String(v).trim();
    if (value) flat.set(k.toLowerCase().replace(/[^a-z0-9]/g, ""), value);
  }
  for (const key of keys) {
    const hit = flat.get(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (hit) return hit;
  }
  return undefined;
}

/** Anything we didn't map to a known slot. Qualification answers live here. */
function leftovers(obj: Record<string, unknown>, used: string[]): Record<string, string> {
  const consumed = new Set(used.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || typeof v === "object") continue;
    const norm = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (consumed.has(norm)) continue;
    const value = String(v).trim();
    if (value) out[k] = value;
  }
  return out;
}

const ALL_KNOWN = [...EMAIL_KEYS, ...PHONE_KEYS, ...NAME_KEYS, ...FIRST_KEYS, ...LAST_KEYS, ...MESSAGE_KEYS];

function joinName(obj: Record<string, unknown>): string | undefined {
  const full = pick(obj, NAME_KEYS);
  if (full) return full;
  const first = pick(obj, FIRST_KEYS);
  const last = pick(obj, LAST_KEYS);
  return [first, last].filter(Boolean).join(" ") || undefined;
}

/** Shared shape-mapping for any flat key/value payload. */
function fromFlat(
  obj: Record<string, unknown>,
  source: LeadSource,
  extra: Partial<Lead> = {},
): Lead {
  return {
    source,
    fullName: joinName(obj),
    email: pick(obj, EMAIL_KEYS),
    phone: pick(obj, PHONE_KEYS),
    message: pick(obj, MESSAGE_KEYS),
    fields: leftovers(obj, ALL_KNOWN),
    capturedAt: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Website forms
// ---------------------------------------------------------------------------

/**
 * Our own site's forms, and any plain HTML form post. Accepts JSON or the
 * `application/x-www-form-urlencoded` body a bare `<form>` sends.
 */
export function parseWebForm(
  payload: Record<string, unknown>,
  pageUrl?: string,
  referrer?: string,
): Lead {
  const utm = Object.fromEntries(
    Object.entries(payload)
      .filter(([k]) => k.toLowerCase().startsWith("utm_"))
      .map(([k, v]) => [k, String(v)]),
  );

  return fromFlat(payload, "web_form", {
    externalId: pick(payload, ["submission_id", "submissionId", "id"]),
    attribution: {
      ...(pageUrl ? { pageUrl } : {}),
      ...(referrer ? { referrer } : {}),
      ...(Object.keys(utm).length ? { utm } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Meta lead ads
// ---------------------------------------------------------------------------

/**
 * Meta's leadgen webhook. It carries **no answers** — only ids — so the field
 * values must be fetched separately from the Graph API with a page access token.
 *
 * Both `entry[]` and `changes[]` are arrays, so one delivery can carry several
 * leads. Each becomes its own `Lead` with its own `leadgen_id` as `externalId`,
 * which is what keeps them individually idempotent.
 *
 * The same page subscription also delivers `messages`, `comments` and others, so
 * anything that isn't `field === "leadgen"` is ignored here.
 */
export function parseMetaLeadgen(payload: Record<string, unknown>): Lead[] {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const leads: Lead[] = [];

  for (const entry of entries) {
    const changes = Array.isArray((entry as Record<string, unknown>)?.changes)
      ? ((entry as Record<string, unknown>).changes as Record<string, unknown>[])
      : [];

    for (const change of changes) {
      if (change.field !== "leadgen") continue;
      const v = (change.value ?? {}) as Record<string, unknown>;
      const leadgenId = v.leadgen_id ?? v.leadgenId;
      if (!leadgenId) continue;

      leads.push({
        source: "facebook_lead_ad",
        externalId: String(leadgenId),
        // Empty until enriched from the Graph API. The lead is still worth
        // recording: the attribution below is real and arrives now.
        fields: {},
        attribution: {
          ...(v.form_id ? { formId: String(v.form_id) } : {}),
          ...(v.ad_id ? { adId: String(v.ad_id) } : {}),
          ...(v.campaign_id ? { campaign: String(v.campaign_id) } : {}),
        },
        capturedAt: v.created_time
          ? new Date(Number(v.created_time) * 1000).toISOString()
          : new Date().toISOString(),
      });
    }
  }

  return leads;
}

/**
 * Merges Graph API `field_data` into a lead created by `parseMetaLeadgen`.
 * Shape: `[{ name: "email", values: ["a@b.com"] }, …]`.
 */
export function enrichMetaLead(lead: Lead, fieldData: unknown): Lead {
  if (!Array.isArray(fieldData)) return lead;

  const flat: Record<string, unknown> = {};
  for (const item of fieldData) {
    const name = (item as Record<string, unknown>)?.name;
    const values = (item as Record<string, unknown>)?.values;
    if (typeof name !== "string" || !Array.isArray(values) || !values.length) continue;
    flat[name] = String(values[0]);
  }

  const mapped = fromFlat(flat, lead.source);
  return {
    ...lead,
    fullName: mapped.fullName ?? lead.fullName,
    email: mapped.email ?? lead.email,
    phone: mapped.phone ?? lead.phone,
    message: mapped.message ?? lead.message,
    fields: { ...lead.fields, ...mapped.fields },
  };
}

// ---------------------------------------------------------------------------
// GoHighLevel webhooks
// ---------------------------------------------------------------------------

/**
 * Which social inbox a GHL reply came from, if any. The workflow's webhook body
 * is ours to design, so `channel` is what we ask it to send; the other names are
 * what GHL's own payloads use, accepted as a fallback.
 *
 * Instagram is checked first: its name never contains "facebook", but a Meta
 * payload can mention both, and a DM that arrived on Instagram is Instagram.
 */
function dmChannel(flat: Record<string, unknown>): LeadSource | undefined {
  const hint = (pick(flat, ["channel", "replyChannel", "messageType", "type", "provider"]) ?? "").toLowerCase();
  if (hint.includes("instagram")) return "instagram_dm";
  if (hint.includes("facebook") || hint.includes("messenger") || hint === "fb") return "facebook_dm";
  return undefined;
}

/**
 * A GHL workflow webhook — a form submission, or a Facebook/Instagram lead that
 * GHL's own native integration already fetched for us.
 *
 * **This shape is unverified.** No GHL webhook has ever been captured against
 * this account (`webhook-captures/` has never recorded anything), so the field
 * names below are read off `scripts/webhook.ts`'s assumptions. Hence the tolerant
 * lookup and hence storing the raw payload: the first real delivery will correct
 * this, and we replay rather than lose leads in the meantime.
 */
export function parseGhlWebhook(payload: Record<string, unknown>): Lead {
  // GHL nests the interesting parts inconsistently depending on trigger type.
  const nested = ["contact", "customData", "data"]
    .map((k) => payload[k])
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));

  const flat: Record<string, unknown> = Object.assign({}, ...nested, payload);

  // A reply trigger's standard payload carries `message` as an object
  // ({ body, type, ... }), which `pick` skips because it only reads scalars.
  // Unwrapping it here is what keeps the DM text from being dropped.
  if (flat.message && typeof flat.message === "object") {
    const m = flat.message as Record<string, unknown>;
    flat.message = typeof m.body === "string" ? m.body : "";
  }

  const dm = dmChannel(flat);
  const isFacebookAd = !dm && JSON.stringify(payload).toLowerCase().includes("facebook");
  const source: LeadSource = dm ?? (isFacebookAd ? "facebook_lead_ad" : "web_form");
  const contactId = pick(flat, ["contactId", "contact_id"]);

  const lead = fromFlat(flat, source, {
    // A DM is one lead per PERSON, not per message. GHL's message id changes on
    // every reply, so keying on it would open a new lead, opportunity and tag
    // write for each message in a conversation. Keyed on the contact, the first
    // DM creates the lead and later replies are recognised as the same one.
    externalId: dm && contactId
      ? `dm:${contactId}`
      : pick(flat, ["messageId", "id", "submissionId", "leadId"]),
    attribution: {
      ...(pick(flat, ["formId", "form_id"]) ? { formId: pick(flat, ["formId", "form_id"]) } : {}),
      ...(pick(flat, ["campaignId", "campaign"]) ? { campaign: pick(flat, ["campaignId", "campaign"]) } : {}),
    },
  });

  // GHL already made the contact, so carry its id — that saves an upsert and
  // avoids any chance of creating a second record for the same person.
  if (contactId) lead.fields.contactId = contactId;

  return lead;
}

// ---------------------------------------------------------------------------
// Our own conversations
// ---------------------------------------------------------------------------

/**
 * A chat or voice conversation the agent already had, entering the same pipeline
 * as any external lead so it gets deduped, tagged and followed up identically.
 */
export function parseConversation(convo: Conversation): Lead {
  const firstFromCaller = convo.messages.find((m) => m.role === "caller")?.text;

  return {
    source: convo.channel === "voice" ? "voice" : "chat",
    // The conversation id is already unique and stable, so re-ingesting the same
    // conversation is naturally idempotent.
    externalId: convo.id,
    fullName: convo.contact.full_name,
    email: convo.contact.email,
    phone: convo.contact.phone,
    message: firstFromCaller,
    fields: Object.fromEntries(
      Object.entries(convo.contact).filter(
        ([k]) => !["full_name", "email", "phone"].includes(k),
      ),
    ),
    capturedAt: convo.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Anything else
// ---------------------------------------------------------------------------

/**
 * Zapier, Make, or any tool that can POST. Deliberately the most permissive:
 * nested objects are flattened one level so `{contact: {email}}` still works.
 */
export function parseGenericWebhook(payload: Record<string, unknown>): Lead {
  const flat: Record<string, unknown> = { ...payload };
  for (const [k, v] of Object.entries(payload)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        if (!(nk in flat)) flat[nk] = nv;
      }
      delete flat[k];
    }
  }
  return fromFlat(flat, "webhook", {
    externalId: pick(flat, ["id", "submissionId", "externalId", "eventId"]),
  });
}
