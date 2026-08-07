/**
 * The full engagement loop, for real:
 *
 *   contact in GHL -> conversation in Postgres -> composed from that transcript
 *   -> actually sent
 *
 *   pnpm --filter @ghl-lk/agent-core email:send you@example.com [trigger]
 *
 * Sends a real email to a real inbox through GoHighLevel. Address is required
 * as an argument rather than defaulted, so nobody gets mailed by accident.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { PgConversationStore } = await import("../src/conversation/pg-store.js");
const { composeEmail } = await import("../src/email/compose.js");
type Trigger = import("../src/email/compose.js").Trigger;
const { sendEmail } = await import("../src/email/send.js");
const { GhlClient } = await import("../src/ghl/client.js");
const { paths } = await import("../src/ghl/endpoints.js");
const { hotel } = await import("../src/industries/hotel.js");

const to = process.argv[2];
const trigger = (process.argv[3] ?? "abandoned_1h") as Trigger;
if (!to?.includes("@")) {
  console.error("Usage: email:send <address> [trigger]");
  process.exit(1);
}

const client = new GhlClient();
const store = new PgConversationStore();
const id = `email-send-${to.replace(/[^a-z0-9]/gi, "-")}`;
const t = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

// 1. A conversation that stopped short of booking.
await store.open(id, { industry: "hotel", channel: "chat" }, t(70));
const turns = [
  ["caller", "hi — do you have a suite free the weekend of the 26th? it's our anniversary"],
  ["agent", "Happy to help — a Terrace Suite for your anniversary sounds lovely. Two nights, the 26th and 27th?"],
  ["caller", "yes, two nights. is the rooftop restaurant open late?"],
  ["agent", "It is — Halcyon serves until 10, and the bar runs to midnight. Shall I check suite availability for those nights?"],
  ["caller", "let me check with my partner and come back to you"],
] as const;
for (const [i, [role, text]] of turns.entries()) {
  await store.append(id, { role, text, at: t(69 - i) });
}
await store.update(id, {
  contact: { full_name: "Hamza Akhtar", email: to, occasion: "anniversary" },
  outcome: "abandoned",
  updatedAt: t(64),
});

const convo = await store.get(id);
if (!convo) throw new Error("conversation did not persist");
console.log(`\n1. conversation stored: ${convo.messages.length} turns`);

// 2. Contact in GHL — the email has to be threaded against a real contact.
const upserted = await client.request<{ contact?: { id?: string }; id?: string }>(
  paths.upsertContact(),
  {
    method: "POST",
    body: {
      locationId: client.env.locationId,
      firstName: "Hamza",
      lastName: "Akhtar",
      email: to,
    },
  },
);
const contactId = upserted.contact?.id ?? upserted.id;
if (!contactId) throw new Error("no contact id from GHL upsert");
console.log(`2. GHL contact: ${contactId}`);

// 3. Compose from the transcript, not a template.
const email = await composeEmail(hotel, convo, trigger);
console.log(`3. composed (${trigger})`);
console.log(`\n   SUBJECT: ${email.subject}`);
console.log(
  email.body
    .split("\n")
    .map((l) => `   ${l}`)
    .join("\n"),
);

// 4. Send it.
const result = await sendEmail({ contactId, email });
console.log(`\n4. sent -> ${to}`);
console.log(`   messageId      = ${result.messageId ?? "(none)"}`);
console.log(`   conversationId = ${result.conversationId ?? "(none)"}`);
console.log(`   emailMessageId = ${result.emailMessageId ?? "(none)"}`);

await store.close();
