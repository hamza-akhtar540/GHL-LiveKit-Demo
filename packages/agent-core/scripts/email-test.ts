/**
 * End-to-end proof of the engagement pieces, against real Postgres and real
 * Gemini:
 *
 *   1. persist a conversation to the DB
 *   2. read it back
 *   3. compose each follow-up type from that actual transcript
 *
 *   pnpm --filter @ghl-lk/agent-core email:test
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { PgConversationStore } = await import("../src/conversation/pg-store.js");
const { composeEmail } = await import("../src/email/compose.js");
const { hotel } = await import("../src/industries/hotel.js");

const store = new PgConversationStore();
const id = "demo-email-test";
const t = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

// A realistic hotel exchange that stopped short of booking.
await store.open(id, { industry: "hotel", channel: "chat" }, t(30));
for (const m of [
  { role: "caller" as const, text: "hi, do you have a suite free the weekend of the 26th? it's our anniversary", at: t(29) },
  { role: "agent" as const, text: "Happy to help — a Terrace Suite for your anniversary sounds lovely. Two nights, the 26th and 27th?", at: t(28) },
  { role: "caller" as const, text: "yes two nights. and is the rooftop restaurant open late?", at: t(27) },
  { role: "agent" as const, text: "It is — Halcyon serves till 10, bar till midnight. Shall I check suite availability for those nights?", at: t(26) },
  { role: "caller" as const, text: "let me talk to my partner and come back", at: t(25) },
]) {
  await store.append(id, m);
}
await store.update(id, {
  contact: { full_name: "Daniel Osei", occasion: "anniversary" },
  outcome: "abandoned",
  updatedAt: t(25),
});

const convo = await store.get(id);
console.log(`\nstored & reloaded: ${convo?.messages.length} messages, contact=${convo?.contact.full_name}\n`);
if (!convo) throw new Error("conversation did not persist");

for (const trigger of ["abandoned_1h", "abandoned_24h", "thank_you"] as const) {
  const email = await composeEmail(hotel, convo, trigger);
  console.log("─".repeat(70));
  console.log(`TRIGGER: ${trigger}`);
  console.log(`SUBJECT: ${email.subject}`);
  console.log(email.body);
  console.log();
}

await store.close();
