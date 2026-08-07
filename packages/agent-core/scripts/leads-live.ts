/**
 * The ingestion pipeline against everything real: Postgres, GoHighLevel, Gemini.
 *
 *   pnpm --filter @ghl-lk/agent-core leads:live
 *
 * Creates real contacts and opportunities in the CRM. Follow-up emails are
 * composed and stored but not sent unless LEAD_AUTOSEND=on, which is why the
 * default is dry_run.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { LeadIngestor } = await import("../src/leads/ingest.js");
const { PgLeadStore } = await import("../src/leads/store.js");
const { LeadFollowUp, autosendMode } = await import("../src/leads/follow-up.js");
const { PgConversationStore } = await import("../src/conversation/pg-store.js");
const { CrmSync } = await import("../src/crm/sync.js");
const { parseWebForm, parseGenericWebhook } = await import("../src/leads/parsers.js");
const { hotel } = await import("../src/industries/hotel.js");

const store = new PgLeadStore();
const conversations = new PgConversationStore();
const crm = new CrmSync(undefined, (err, op) => console.error(`  crm ${op} failed:`, String(err).slice(0, 120)));
const ingestor = new LeadIngestor({ store, conversations, crm, cfg: hotel });
const followUp = new LeadFollowUp({ store, conversations, cfg: hotel });

// Unique per run, so repeat runs don't collide with earlier test contacts.
const stamp = Date.now().toString().slice(-6);
const email = `lead.test.${stamp}@example.com`;
const phone = `512555${stamp.slice(-4)}`;

console.log(`\nautosend mode: ${autosendMode()}\n`);

// 1. A web form from someone new.
const form = parseWebForm(
  {
    full_name: "Priya Raman",
    email,
    phone,
    message: "Do you have a terrace suite free the first weekend of September? Two of us.",
    nights: "2",
    utm_source: "google",
    utm_campaign: "suites-september",
  },
  "https://thefairmount.test/rooms",
);
const a = await ingestor.ingest(form, { fixture: "web-form" });
console.log(`1 web form          -> ${a.status}  contact=${a.contactId}  tags=${a.tags.length}`);

// 2. Same person, different source, same phone written differently.
const zap = parseGenericWebhook({
  id: `zap-${stamp}`,
  name: "Priya Raman",
  email: `priya.work.${stamp}@example.com`,
  phone: `(512) 555-${stamp.slice(-4)}`,
  enquiry: "following up on the suite",
});
const b = await ingestor.ingest(zap, { fixture: "zapier" });
console.log(`2 other source      -> ${b.status}  contact=${b.contactId}  tags=${b.tags.length}`);
console.log(`   same contact?      ${a.contactId === b.contactId ? "YES — merged correctly" : "NO — merge failed"}`);

// 3. Redelivery of the first one.
const c = await ingestor.ingest(form, { fixture: "web-form" });
console.log(`3 form replayed     -> ${c.status}`);

// 4. Compose the follow-up from the real conversation.
const fu = await followUp.send({
  leadId: (await store.recent(20)).find((r) => r.contactId === a.contactId)?.id ?? "",
  contactId: a.contactId,
  conversationId: a.conversationId,
  recipient: email,
});
console.log(`\n4 follow-up         -> ${fu.status}${fu.reason ? `  (${fu.reason})` : ""}`);
if (fu.subject) console.log(`   subject: ${fu.subject}`);

// 5. Second follow-up for the merged lead must be suppressed.
const fu2 = await followUp.send({
  leadId: (await store.recent(20)).find((r) => r.contactId === b.contactId && r.source === "webhook")?.id ?? "",
  contactId: b.contactId,
  conversationId: b.conversationId,
  recipient: `priya.work.${stamp}@example.com`,
});
console.log(`5 second follow-up  -> ${fu2.status}${fu2.reason ? `  (${fu2.reason})` : ""}`);

console.log("\n--- ledger ---");
for (const r of (await store.recent(6))) {
  console.log(`  ${r.status.padEnd(10)} ${r.source.padEnd(16)} ${r.contactId ?? "-"}`);
}

await store.close();
await conversations.close();
console.log(`\nCheck GHL for contact ${a.contactId}\n`);
