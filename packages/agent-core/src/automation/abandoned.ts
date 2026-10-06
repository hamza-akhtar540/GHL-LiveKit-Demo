import type { Conversation, ConversationStore } from "../conversation/types.js";
import type { Trigger } from "../email/compose.js";
import type { LeadFollowUp } from "../leads/follow-up.js";
import type { LeadStore } from "../leads/store.js";

/**
 * Follows up conversations that went quiet without booking, on a clock.
 *
 * The ladder is 1 hour, 24 hours, 3 days. Each rung is composed from the actual
 * transcript by `composeEmail`, so the email picks up the thread the person left
 * rather than starting over.
 *
 * Why this exists as a sweep rather than an event: nothing happens when someone
 * stops talking. The session-end hook can tell us a chat finished, but only a
 * timer can tell us it has now been an hour.
 *
 * Every rule below is a reason NOT to email someone, because the failure that
 * matters here is a nurture email landing on a person who already booked, already
 * came back, or already got a human:
 *
 *  - booked / handed off / no-show conversations are someone else's job
 *  - a newer conversation with the same contact means they came back
 *  - any booked conversation for the same contact means they converted
 *  - older than `MAX_AGE` is stale — a "just checking in" after two weeks reads
 *    as a bot that lost track of time
 */

const HOUR = 60 * 60 * 1000;

/** Highest rung first, so the first match is the one that is due. */
const LADDER: { trigger: Extract<Trigger, `abandoned_${string}`>; after: number }[] = [
  { trigger: "abandoned_3d", after: 72 * HOUR },
  { trigger: "abandoned_24h", after: 24 * HOUR },
  { trigger: "abandoned_1h", after: 1 * HOUR },
];

const MAX_AGE = 7 * 24 * HOUR;

/** Outcomes that mean a person or another process owns this conversation. */
const NOT_ABANDONED = new Set(["booked", "handed_off", "no_show"]);

export interface AbandonedDeps {
  conversations: ConversationStore;
  store: LeadStore;
  followUp: LeadFollowUp;
  /** Cap per sweep, so a first run over a backlog can't spend a day's quota. */
  maxPerRun?: number;
  now?: () => number;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface AbandonedRunResult {
  considered: number;
  due: number;
  results: { conversationId: string; trigger: string; status: string; reason?: string }[];
}

/** The lead id the session-end ingest used: `<source>:<conversation id>`. */
export function leadIdFor(convo: Conversation): string {
  return `${convo.channel === "voice" ? "voice" : "chat"}:${convo.id}`;
}

/**
 * Which rung, if any, is due for this conversation right now. Pure, so the
 * timing rules can be checked without a database.
 */
export function dueTrigger(convo: Conversation, nowMs: number): Trigger | undefined {
  const age = nowMs - new Date(convo.updatedAt).getTime();
  if (age > MAX_AGE) return undefined;
  return LADDER.find((rung) => age >= rung.after)?.trigger;
}

export async function runAbandonedFollowUps(deps: AbandonedDeps): Promise<AbandonedRunResult> {
  const { conversations, store, followUp, maxPerRun = 10, onLog = () => {} } = deps;
  const nowMs = (deps.now ?? Date.now)();

  // Enough to cover a week of traffic at demo and small-client volume. A client
  // with real volume would swap this for a query on outcome and updatedAt.
  const recent = await conversations.recent(500);

  const converted = new Set<string>();
  const latestFor = new Map<string, number>();
  for (const c of recent) {
    if (!c.contactId) continue;
    if (c.outcome === "booked" || c.bookingCode) converted.add(c.contactId);
    latestFor.set(c.contactId, Math.max(latestFor.get(c.contactId) ?? 0, new Date(c.updatedAt).getTime()));
  }

  const out: AbandonedRunResult = { considered: 0, due: 0, results: [] };

  for (const convo of recent) {
    if (out.results.length >= maxPerRun) break;
    if (!convo.contactId || !convo.contact.email?.trim()) continue;
    // A DM thread is a live conversation with staff in the social inbox. Emailing
    // someone who is mid-DM, from a different channel, reads as a bot that did not
    // notice the conversation was still going.
    if (convo.channel === "instagram" || convo.channel === "facebook") continue;
    if (convo.outcome && NOT_ABANDONED.has(convo.outcome)) continue;
    if (convo.bookingCode) continue;
    if (!convo.messages.some((m) => m.role === "caller")) continue;
    out.considered++;

    if (converted.has(convo.contactId)) continue;
    // A newer conversation means they came back — the thread this email would
    // pick up is no longer the live one.
    if ((latestFor.get(convo.contactId) ?? 0) > new Date(convo.updatedAt).getTime()) continue;

    const trigger = dueTrigger(convo, nowMs);
    if (!trigger) continue;
    out.due++;

    const leadId = leadIdFor(convo);
    // Any stored row for this rung, whatever its status, means it was handled.
    // Checking only for `sent` would re-compose every tick in dry_run, where
    // nothing is ever sent, and spend LLM quota on an email that already exists.
    if (await store.getEmail(`${leadId}:${trigger}`)) continue;

    const res = await followUp.send({
      leadId,
      contactId: convo.contactId,
      conversationId: convo.id,
      recipient: convo.contact.email,
      trigger,
    });
    onLog("abandoned follow-up", { conversationId: convo.id, trigger, status: res.status, reason: res.reason });
    out.results.push({ conversationId: convo.id, trigger, status: res.status, reason: res.reason });
  }

  return out;
}
