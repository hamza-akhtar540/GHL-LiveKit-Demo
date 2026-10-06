import type { ConversationStore, Message } from "../conversation/types.js";
import { GhlClient } from "../ghl/client.js";
import { paths } from "../ghl/endpoints.js";
import type { LeadIngestor } from "../leads/ingest.js";
import type { Lead, LeadSource } from "../leads/types.js";

/**
 * Pulls every Facebook and Instagram DM thread out of GoHighLevel into our own
 * database, and turns each person into a lead.
 *
 * Why poll rather than receive a webhook: a workflow's Custom Webhook action is
 * a premium (per-execution) action, and GHL's event subscriptions need a
 * Marketplace OAuth app. Reading the Conversations API needs neither — the
 * Private Integration token already in use is enough, and it can't miss a message
 * because of a tunnel that was down, since the next poll simply picks it up.
 *
 * What lands where:
 *  - the whole thread -> our `conversations` table, one row per GHL conversation
 *    (id `ghl-<conversationId>`), so the admin shows the transcript
 *  - the person -> `lead_events` through the normal ingestor (tags, score, CRM
 *    note, opportunity), keyed on the GHL contact, so a person is one lead however
 *    many messages they send
 */

const TYPES: { type: "TYPE_FACEBOOK" | "TYPE_INSTAGRAM"; source: LeadSource; channel: "facebook" | "instagram" }[] = [
  { type: "TYPE_INSTAGRAM", source: "instagram_dm", channel: "instagram" },
  { type: "TYPE_FACEBOOK", source: "facebook_dm", channel: "facebook" },
];

/** GHL rejects a search limit above 100 with a 422. */
const PAGE = 100;

interface GhlConversation {
  id: string;
  contactId?: string;
  fullName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  lastMessageDate?: number;
}

interface GhlMessage {
  id?: string;
  direction?: string;
  body?: string;
  messageType?: string;
  dateAdded?: string;
}

export interface DmSyncDeps {
  ghl?: GhlClient;
  conversations: ConversationStore;
  ingestor: LeadIngestor;
  industry: string;
  /** Cap per run, so a first sync over a large inbox cannot run for minutes. */
  maxConversations?: number;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface DmSyncResult {
  seen: number;
  synced: number;
  newMessages: number;
  newLeads: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyOf = (m: Pick<Message, "role" | "text" | "at">) => `${m.at}|${m.role}|${m.text}`;

export async function syncSocialDms(deps: DmSyncDeps): Promise<DmSyncResult> {
  const ghl = deps.ghl ?? new GhlClient();
  const { conversations, ingestor, onLog = () => {}, maxConversations = 100 } = deps;
  const out: DmSyncResult = { seen: 0, synced: 0, newMessages: 0, newLeads: 0 };

  for (const kind of TYPES) {
    // Newest first, paged by the last row's date. Stops at a short page.
    let startAfterDate: number | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await ghl.get<{ conversations?: GhlConversation[] }>(paths.searchConversations(), {
        locationId: ghl.env.locationId,
        lastMessageType: kind.type,
        sortBy: "last_message_date",
        sort: "desc",
        limit: PAGE,
        ...(startAfterDate ? { startAfterDate } : {}),
      });
      const batch = res.conversations ?? [];

      for (const gc of batch) {
        if (out.seen >= maxConversations) return out;
        out.seen++;
        if (!gc.id || !gc.contactId) continue;

        const ours = await conversations.get(`ghl-${gc.id}`);
        const ourLatest = ours?.messages.at(-1)?.at;
        // Nothing newer than what we hold: skip the messages call entirely.
        if (ours && ourLatest && gc.lastMessageDate && gc.lastMessageDate <= new Date(ourLatest).getTime()) continue;

        const added = await syncOne(gc, kind, deps, ghl, !ours);
        out.synced++;
        out.newMessages += added.messages;
        if (added.lead) out.newLeads++;
        await sleep(300); // GHL allows ~100 requests per 10s
      }

      if (batch.length < PAGE) break;
      startAfterDate = batch.at(-1)?.lastMessageDate;
      if (!startAfterDate) break;
    }
  }

  if (out.synced) onLog("social DMs synced", { ...out });
  return out;
}

async function syncOne(
  gc: GhlConversation,
  kind: (typeof TYPES)[number],
  deps: DmSyncDeps,
  ghl: GhlClient,
  isNew: boolean,
): Promise<{ messages: number; lead: boolean }> {
  const { conversations, ingestor, industry } = deps;
  const id = `ghl-${gc.id}`;

  // `messages` is double-nested in this response: { messages: { messages: [...] } }.
  const res = await ghl.get<{ messages?: { messages?: GhlMessage[] } }>(paths.conversationMessages(gc.id), { limit: 100 });
  const thread = (res.messages?.messages ?? [])
    // Activity records ("appointment created") are system noise, not DM content.
    .filter((m) => !String(m.messageType ?? "").startsWith("TYPE_ACTIVITY_") && (m.body ?? "").trim() && m.dateAdded)
    .map((m): Message => ({
      // Inbound is the person. Outbound is us — staff or a workflow — so `admin`,
      // never `agent`: the AI did not write it.
      role: m.direction === "inbound" ? "caller" : "admin",
      text: (m.body ?? "").trim(),
      at: new Date(m.dateAdded!).toISOString(),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  await conversations.open(id, { industry, channel: kind.channel });
  const existing = new Set(((await conversations.get(id))?.messages ?? []).map(keyOf));
  let added = 0;
  for (const m of thread) {
    if (existing.has(keyOf(m))) continue;
    await conversations.append(id, m);
    added++;
  }

  // The person. The search row already carries name, email and phone; the contact
  // record adds the rest, and is only fetched when the thread is new to us.
  let contact: Record<string, unknown> = {};
  if (isNew) {
    contact = (await ghl.get<{ contact?: Record<string, unknown> }>(paths.getContact(gc.contactId!)).catch(() => ({ contact: {} })))
      .contact ?? {};
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const fullName =
    str(gc.fullName) ?? str(gc.contactName) ??
    ([str(contact.firstName), str(contact.lastName)].filter(Boolean).join(" ") || undefined);
  const email = str(gc.email) ?? str(contact.email);
  const phone = str(gc.phone) ?? str(contact.phone);

  await conversations.update(id, {
    contactId: gc.contactId,
    contact: {
      ...(fullName ? { full_name: fullName } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      source: kind.source,
    },
  });

  if (!isNew) return { messages: added, lead: false };

  const firstInbound = thread.find((m) => m.role === "caller");
  const lead: Lead = {
    source: kind.source,
    // One lead per person. A message id would open a new lead for every reply.
    externalId: `dm:${gc.contactId}`,
    conversationRef: id,
    fullName,
    email,
    phone,
    message: firstInbound?.text,
    fields: {
      contactId: gc.contactId!,
      ghlConversationId: gc.id,
      ...(str(contact.source) ? { contactSource: str(contact.source)! } : {}),
      ...(Array.isArray(contact.tags) && contact.tags.length ? { contactTags: contact.tags.join(", ") } : {}),
      ...(str(contact.city) ? { city: str(contact.city)! } : {}),
      ...(str(contact.country) ? { country: str(contact.country)! } : {}),
    },
    capturedAt: firstInbound?.at ?? new Date().toISOString(),
    attribution: {},
  };
  const r = await ingestor.ingest(lead);
  return { messages: added, lead: r.status === "created" || r.status === "merged" };
}
