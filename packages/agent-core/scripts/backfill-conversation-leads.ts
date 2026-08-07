/**
 * One-off backfill: push existing conversations through the lead pipeline.
 *
 *   pnpm --filter @ghl-lk/agent-core backfill:conversation-leads          # dry run
 *   pnpm --filter @ghl-lk/agent-core backfill:conversation-leads --write
 *
 * The agent now ingests a conversation when the session ends, so anything from
 * here on gets a CRM contact automatically. This catches up the ones that
 * happened before that existed: conversations that collected an email or a phone
 * number, never booked, and therefore produced a transcript in our database and
 * nothing at all in the CRM — no contact, no tags, no score, no follow-up.
 *
 * They are also invisible on their own contact's page in the console, because
 * Contact 360 joins on `contact_id` and theirs is null.
 *
 * Safe to re-run: the ingestor's idempotency barrier is keyed on the submission
 * id, which is derived from the conversation id, so a second pass reports
 * `duplicate` and does nothing.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { LeadIngestor } = await import("../src/leads/ingest.js");
const { PgLeadStore } = await import("../src/leads/store.js");
const { PgConversationStore } = await import("../src/conversation/pg-store.js");
const { CrmSync } = await import("../src/crm/sync.js");
const { getIndustry } = await import("../src/industries/index.js");

const write = process.argv.includes("--write");
const cfg = getIndustry(process.env.INDUSTRY ?? "roofing");

const conversations = new PgConversationStore();
const store = new PgLeadStore();
const ingestor = new LeadIngestor({
  store,
  crm: new CrmSync(),
  conversations,
  cfg,
  onLog: (msg, data) => console.log(`    · ${msg}`, data ? JSON.stringify(data) : ""),
});

try {
  const all = await conversations.recent(500);

  const eligible = all.filter((c) => {
    if (c.contactId) return false; // already linked
    if (c.outcome === "booked" || c.bookingCode) return false; // the booking path owns these
    return !!(c.contact.email?.trim() || c.contact.phone?.trim());
  });

  const skipped = all.filter((c) => !c.contactId && !eligible.includes(c));

  console.log(`\n${all.length} conversation(s); ${eligible.length} eligible to ingest, ${skipped.length} skipped\n`);

  for (const c of eligible) {
    console.log(`  ${c.id}  ${c.contact.full_name ?? "(no name)"}  ${c.contact.email ?? c.contact.phone}`);
    if (!write) continue;

    const result = await ingestor.ingest({
      source: c.channel === "voice" ? "voice" : "chat",
      externalId: c.id,
      fullName: c.contact.full_name,
      email: c.contact.email?.trim(),
      phone: c.contact.phone?.trim(),
      message: c.messages.find((m) => m.role === "caller")?.text,
      fields: c.contact,
      capturedAt: c.createdAt,
      attribution: {},
    });
    console.log(`      → ${result.status}${result.contactId ? ` contact ${result.contactId}` : ""}`);
  }

  if (skipped.length) {
    console.log(`\n  skipped (nothing to contact them on, or already handled by the booking path):`);
    for (const c of skipped.slice(0, 10)) {
      console.log(`    ${c.id}  outcome=${c.outcome ?? "none"}  ${c.contact.email ?? c.contact.phone ?? "no details"}`);
    }
  }

  console.log(write ? `\nDone.\n` : `\nDry run — pass --write to ingest them.\n`);
} finally {
  await conversations.close();
  await store.close();
}
