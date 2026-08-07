/**
 * The ingestion pipeline, end to end, with nothing running.
 *
 *   pnpm --filter @ghl-lk/agent-core leads:demo
 *
 * Uses MemoryLeadStore and no CRM, so it proves the logic — dedup, identity
 * merging, rejection — without touching Postgres or GoHighLevel. Pass --live to
 * run the same sequence against the real database and CRM.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });
const {
  LeadIngestor, MemoryLeadStore, FileConversationStore,
  parseWebForm, parseMetaLeadgen, parseGenericWebhook, hotel, submissionIdFor,
} = await import("@ghl-lk/agent-core");

/**
 * A stand-in CRM. Identity merging is keyed on the contact id the CRM returns,
 * so without one nothing can ever merge — the pipeline genuinely cannot be
 * exercised without something in this slot. This fakes GHL's upsert behaviour:
 * match on email or phone, otherwise mint a new id.
 */
const contacts = new Map<string, string>(); // identity key -> contact id
let nextId = 1;
const fakeCrm = {
  async upsertContact({ email, phone }: { email?: string; phone?: string }) {
    const keys = [
      email ? `email:${email.trim().toLowerCase()}` : undefined,
      phone ? `phone:${phone.replace(/\D/g, "")}` : undefined,
    ].filter(Boolean) as string[];
    const found = keys.map((k) => contacts.get(k)).find(Boolean);
    const id = found ?? `contact-${nextId++}`;
    for (const k of keys) contacts.set(k, id);
    return id;
  },
  async addTags() { return true; },
  async writeScore() { return true; },
  async addNote() { return true; },
  async createOpportunity() { return null; },
} as unknown as import("../src/crm/sync.js").CrmSync;

const store = new MemoryLeadStore();
const conversations = new FileConversationStore(
  resolve(dirname(fileURLToPath(import.meta.url)), "../lead-convos"),
);
const ing = new LeadIngestor({ store, conversations, crm: fakeCrm, cfg: hotel });
const show = (label: string, r: any) =>
  console.log(`${label.padEnd(34)} ${String(r.status).padEnd(10)} tags=${r.tags.length}` +
              (r.reason ? `  (${r.reason})` : ""));

// 1. web form
const form = parseWebForm({
  full_name: "Nadia Hussain", email: "nadia@example.com", phone: "512-555-0611",
  message: "looking for a suite for our anniversary", nights: "2",
  utm_source: "google", utm_campaign: "spring-suites",
}, "https://thefairmount.test/rooms");
show("1 web form (new person)", await ing.ingest(form));

// 2. same submission again — idempotency
show("2 same form replayed", await ing.ingest(form));

// 3. same human, different source + different email, SAME phone
const generic = parseGenericWebhook({
  id: "zap-9001", name: "Nadia Hussain",
  email: "nadia.work@example.com", phone: "(512) 555-0611",
  enquiry: "following up about the suite",
});
show("3 other source, same phone", await ing.ingest(generic));

// 4. nothing to reply to
show("4 no email, no phone", await ing.ingest(parseGenericWebhook({ id: "junk-1", message: "hi" })));

// 5. junk phone must not become an identity everyone matches
show("5 junk phone 0000", await ing.ingest(parseGenericWebhook({ id: "junk-2", phone: "0000" })));

// 6. Meta leadgen — ids only, no answers
const metas = parseMetaLeadgen({
  object: "page",
  entry: [{ id: "p1", time: 0, changes: [
    { field: "leadgen", value: { leadgen_id: "LG-1", form_id: "F-77", ad_id: "AD-5", created_time: 1780000000 } },
    { field: "leadgen", value: { leadgen_id: "LG-2", form_id: "F-77", ad_id: "AD-5", created_time: 1780000001 } },
    { field: "messages", value: {} },
  ]}],
});
console.log(`\nmeta payload -> ${metas.length} leads (expect 2, 'messages' ignored)`);
for (const m of metas) show(`  meta ${m.externalId}`, await ing.ingest(m));

console.log("\n--- submission id stability ---");
const a = submissionIdFor(parseWebForm({ email: "x@y.com", phone: "5125550000", full_name: "A B" }));
await new Promise(r => setTimeout(r, 1100));
const b = submissionIdFor(parseWebForm({ full_name: "A B", phone: "5125550000", email: "x@y.com" }));
console.log(`  reordered keys, 1.1s apart: ${a === b ? "SAME (correct)" : "DIFFERENT (bug)"}`);

console.log("\n--- identity merge: one contact, all sources ---");
for (const key of ["email:nadia@example.com", "email:nadia.work@example.com", "phone:5125550611"]) {
  const [row] = await store.findIdentities([key]);
  console.log(`  ${key.padEnd(34)} ${row ? `${row.contactId}  sources=[${row.sources}]  tags=${row.tags.length}` : "(none)"}`);
}

console.log("\n--- ledger ---");
for (const r of await store.recent()) console.log(`  ${r.status.padEnd(10)} ${r.source}`);
