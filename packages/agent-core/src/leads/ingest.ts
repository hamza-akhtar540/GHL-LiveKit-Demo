import type { CrmSync } from "../crm/sync.js";
import type { ConversationStore } from "../conversation/types.js";
import type { IndustryConfig } from "../industries/types.js";
import { scoreLead } from "../scoring.js";
import { identityKeysFor, isContactable, submissionIdFor } from "./identity.js";
import { tagsFor } from "./tags.js";
import type { LeadStore } from "./store.js";
import type { IngestResult, Lead } from "./types.js";

/**
 * Takes a normalised `Lead` from any source and lands it in the CRM: one contact,
 * every source tagged, scored, with a conversation record so it can be followed
 * up like anything else the agent handled.
 *
 * Two rules shape the whole thing:
 *
 * 1. **The claim is the barrier.** Nothing before it is retryable; everything
 *    after it is. A redelivered webhook stops at the claim.
 * 2. **Only the contact upsert is fatal.** Tags, notes, score, opportunity and
 *    email are best-effort — a missing tag is recoverable, a lost lead is not.
 */
export interface IngestDeps {
  store: LeadStore;
  crm?: CrmSync;
  conversations?: ConversationStore;
  cfg: IndustryConfig;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
}

export class LeadIngestor {
  constructor(private readonly deps: IngestDeps) {}

  async ingest(lead: Lead, raw?: Record<string, unknown>): Promise<IngestResult> {
    const { store, onLog = () => {} } = this.deps;
    const id = submissionIdFor(lead);

    // --- the idempotency barrier -------------------------------------------
    const claim = await store.claim(id, lead, raw);
    if (!claim.claimed) {
      onLog("duplicate submission", { id, status: claim.existing?.status });
      return {
        leadId: id,
        status: "duplicate",
        tags: claim.existing?.tags ?? [],
        contactId: claim.existing?.contactId,
        conversationId: claim.existing?.conversationId,
      };
    }

    return this.process(id, lead);
  }

  /**
   * Everything after the idempotency claim — the CRM work.
   *
   * Split out so it can be RE-run for a submission that was claimed but never
   * finished. `ingest()` cannot do that job: it starts with the claim, so a
   * second call for the same lead returns `duplicate` and does nothing, which is
   * correct for a redelivered webhook and useless for a retry.
   *
   * Safe to repeat. The contact upsert matches on email/phone, tag writes are
   * additive, the seeded opening turn is guarded on the transcript being empty,
   * and `tagsSynced` / `noteAdded` / `opportunityId` record what already
   * happened. Re-running resumes rather than duplicating — the one exception
   * being GHL notes, which have no idempotency key and can double up.
   */
  async process(id: string, lead: Lead): Promise<IngestResult> {
    const { store, crm, conversations, cfg, onLog = () => {} } = this.deps;

    /**
     * Meta first, and this ordering matters.
     *
     * A leadgen webhook carries only ids — the answers need a separate Graph
     * call with a page access token we don't have. So it legitimately arrives
     * with no email and no phone, and the contactable check below would reject
     * it as junk. Holding it as `pending` keeps the lead (and its ad and form
     * attribution, which are real and arrive now) so it can be backfilled the
     * moment a token exists.
     */
    const needsEnrichment =
      lead.source === "facebook_lead_ad" && !lead.email && !lead.phone && !!lead.externalId;

    if (needsEnrichment) {
      await store.update(id, {
        status: "received",
        enrichment: "pending",
        reason: "awaiting Meta field data",
      });
      onLog("meta lead held for enrichment", { id, externalId: lead.externalId });
      return { leadId: id, status: "created", tags: [], reason: "awaiting Meta field data" };
    }

    // --- nothing to reply to is not a lead ---------------------------------
    if (!isContactable(lead)) {
      await store.update(id, {
        status: "rejected",
        reason: "no email or phone",
        processed: true,
      });
      onLog("lead rejected — not contactable", { id, source: lead.source });
      return { leadId: id, status: "rejected", tags: [], reason: "no email or phone" };
    }

    const keys = identityKeysFor(lead);
    const tags = tagsFor(lead);

    // --- who is this? ------------------------------------------------------
    const existing = await store.findIdentities(keys);
    const distinct = [...new Set(existing.map((e) => e.contactId))];

    let contactId: string | undefined;
    let merged = false;

    if (distinct.length === 1) {
      contactId = distinct[0];
      merged = true;
    } else if (distinct.length > 1) {
      /**
       * The same lead's email and phone point at two different contacts —
       * someone was entered twice before we existed. Oldest wins, and both get
       * flagged rather than silently picking one: GHL has no reliable contact
       * merge, and dropping one person's history to look tidy is worse than
       * asking a human to sort it.
       */
      const oldest = [...existing].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
      contactId = oldest.contactId;
      merged = true;
      onLog("conflicting identities — flagged for a human", { id, contacts: distinct });
      if (crm) {
        for (const c of distinct) {
          await crm.addTags(c, ["duplicate-identity"]);
          await crm.addNote(
            c,
            `Possible duplicate: this person also exists as ${distinct.filter((x) => x !== c).join(", ")}.\n` +
              `Matched while ingesting a ${lead.source} lead. Kept ${contactId} as primary — worth merging by hand.`,
          );
        }
      }
    }

    // --- create or update the contact (the one fatal step) -----------------
    if (crm) {
      if (!contactId) {
        // No defaultFirstName here on purpose. GHL's upsert matches on
        // email/phone, so passing "Guest" for a nameless lead would rename a
        // real customer who happens to share the phone number.
        contactId = (await crm.upsertContact({
          fullName: lead.fullName,
          email: lead.email,
          phone: lead.phone,
          fields: lead.fields,
        })) ?? undefined;
      } else {
        // Known person: add what's new without clobbering what's there.
        await crm.upsertContact({
          fullName: lead.fullName,
          email: lead.email,
          phone: lead.phone,
          fields: lead.fields,
        });
      }

      if (!contactId) {
        // Left as `received` deliberately, so the sweeper retries rather than
        // this being written off.
        await store.update(id, { status: "received", reason: "CRM upsert failed" });
        onLog("CRM upsert failed — will retry", { id });
        return { leadId: id, status: "rejected", tags, reason: "CRM upsert failed" };
      }
    }

    // --- identity rows, so the next arrival merges -------------------------
    if (contactId) {
      for (const key of keys) {
        await store.linkIdentity(key, contactId, lead.source, tags, id);
      }
    }

    // --- everything below is best-effort ----------------------------------
    if (crm && contactId) {
      // Accumulated tags across every source this person has used, so the merge
      // is visible on the record rather than only in our database.
      const identities = await store.findIdentities(keys);
      const allTags = [...new Set([...tags, ...identities.flatMap((i) => i.tags)])];
      const tagged = await crm.addTags(contactId, allTags);
      await store.update(id, { tags: allTags, tagsSynced: tagged });

      const { score, reason } = scoreLead(cfg, { ...lead.fields, source: lead.source });
      await crm.writeScore(contactId, score, reason);

      await crm.addNote(contactId, renderNote(lead));
      await store.update(id, { noteAdded: true });

      const opportunityId = await crm.createOpportunity({
        contactId,
        name: `${lead.fullName ?? "Lead"} — ${cfg.business.name} (${lead.source})`,
        score,
        outcome: merged ? "qualified" : "new",
      });
      if (opportunityId) await store.update(id, { opportunityId });
    }

    // --- a conversation, so existing follow-up machinery picks it up -------
    let conversationId: string | undefined;
    if (conversations) {
      conversationId = lead.source === "chat" || lead.source === "voice"
        ? lead.externalId
        : `lead-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

      if (conversationId) {
        const convo = await conversations.open(conversationId, {
          industry: cfg.id,
          channel: lead.source === "voice" ? "voice" : lead.source === "chat" ? "chat" : "email",
        });
        // Only seed when empty — a retry must not duplicate the opening turn.
        if (!convo.messages.length && lead.message) {
          await conversations.append(conversationId, {
            role: "caller",
            text: lead.message,
            at: lead.capturedAt,
          });
        }
        await conversations.update(conversationId, {
          contactId,
          contact: {
            ...(lead.fullName ? { full_name: lead.fullName } : {}),
            ...(lead.email ? { email: lead.email } : {}),
            ...(lead.phone ? { phone: lead.phone } : {}),
            source: lead.source,
            ...lead.fields,
          },
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const status = merged ? "merged" : "created";
    await store.update(id, {
      status,
      contactId,
      conversationId,
      identityKey: keys[0],
      processed: true,
    });

    onLog(`lead ${status}`, { id, source: lead.source, contactId, tags: tags.length });
    return { leadId: id, status, contactId, conversationId, tags };
  }
}

/**
 * Rendered into a note as well as customFields, because the account has no
 * custom fields provisioned — a field write goes nowhere silently, whereas a note
 * is what a human actually reads.
 */
function renderNote(lead: Lead): string {
  const lines = [`NEW LEAD — ${lead.source.replace(/_/g, " ").toUpperCase()}`, ""];
  if (lead.message) lines.push(lead.message, "");

  for (const [k, v] of Object.entries(lead.fields)) {
    if (v?.trim() && k !== "contactId") lines.push(`${k.replace(/_/g, " ")}: ${v}`);
  }

  const a = lead.attribution;
  if (a && Object.keys(a).length) {
    lines.push("", "Attribution:");
    if (a.campaign) lines.push(`  campaign: ${a.campaign}`);
    if (a.adId) lines.push(`  ad: ${a.adId}`);
    if (a.formId) lines.push(`  form: ${a.formId}`);
    if (a.pageUrl) lines.push(`  page: ${a.pageUrl}`);
    if (a.utm) for (const [k, v] of Object.entries(a.utm)) lines.push(`  ${k}: ${v}`);
  }

  lines.push("", `Captured ${new Date(lead.capturedAt).toLocaleString("en-US")}`);
  return lines.join("\n");
}
