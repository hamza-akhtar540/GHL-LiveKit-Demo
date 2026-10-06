/**
 * Sample data for demos: ~30 rows in each table the admin console reads.
 *
 *   pnpm --filter @ghl-lk/agent-core seed:demo           # add (safe to re-run)
 *   pnpm --filter @ghl-lk/agent-core seed:demo --clear   # remove only the demo rows
 *
 * Everything here is marked so `--clear` can find it again and real data is never
 * touched: database rows are `demo-` / `DEMO-`, and the GoHighLevel contacts carry
 * a `demo-data` tag. It writes REAL records into the GHL sub-account — 30
 * contacts, 30 opportunities and appointments on the calendars — so Contacts,
 * Opportunities and Bookings fill up as well as the database-backed pages. No
 * email or message is sent to anyone.
 *
 * Two rules keep the running automation from acting on this data:
 *  - lead rows are never in a retryable state (`failed` rows have used all 6
 *    attempts, and there are no `received` rows), so the retry sweeper skips them
 *  - conversations that could still be followed up are older than the abandoned
 *    sweep's 7-day window, so no email is composed for them
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { max: 1 });

const { GhlClient } = await import("../src/ghl/client.js");
const { CrmSync } = await import("../src/crm/sync.js");
const { paths } = await import("../src/ghl/endpoints.js");
const ghl = new GhlClient();
const crm = new CrmSync(ghl);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--clear")) {
  // GHL first, while the database still remembers which contacts are ours.
  // Deleting a contact removes its opportunities and appointments with it. Each
  // contact is checked for the demo tag before deletion, so a real contact can
  // never be removed by a stale id.
  const ours = await sql`select distinct contact_id from conversations where id like 'demo-%' and contact_id is not null`;
  let removed = 0;
  for (const { contact_id: id } of ours) {
    try {
      const got = await ghl.request<{ contact?: { tags?: string[] } }>(paths.getContact(id));
      if (!(got.contact?.tags ?? []).map((t) => t.toLowerCase()).includes("demo-data")) continue;
      await ghl.request(paths.getContact(id), { method: "DELETE" });
      removed++;
      await sleep(250);
    } catch (err) {
      console.log(`  could not remove GHL contact ${id}: ${String(err).slice(0, 80)}`);
    }
  }
  console.log(`  ghl contacts     removed ${removed}`);
  const counts = {
    conversations: await sql`delete from conversations where id like 'demo-%'`,
    bookings: await sql`delete from bookings where code like 'DEMO-%'`,
    lead_events: await sql`delete from lead_events where id like 'demo-%'`,
    lead_identities: await sql`delete from lead_identities where key like '%@demo.example'`,
    lead_emails: await sql`delete from lead_emails where id like 'demo-%'`,
    social_posts: await sql`delete from social_posts where id like 'demo-%'`,
    social_stats: await sql`delete from social_stats where id like 'demo-%'`,
  };
  for (const [t, r] of Object.entries(counts)) console.log(`  ${t.padEnd(16)} removed ${r.count}`);
  await sql.end();
  process.exit(0);
}

// ------------------------------------------------------------------ helpers --

/** Deterministic, so re-running produces the same rows rather than new ones. */
let seed = 20261006;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number, hour = between(8, 21)) => {
  const d = new Date(NOW - days * DAY);
  d.setHours(hour, between(0, 59), 0, 0);
  return d;
};
const iso = (d: Date) => d.toISOString();

const FIRST = ["Daniel", "Sara", "Omar", "Ayesha", "Liam", "Noor", "Hassan", "Emma", "Zain", "Maya", "Bilal", "Chloe", "Imran", "Sofia", "Ali", "Hina", "Noah", "Layla", "Usman", "Grace", "Farah", "Ethan", "Mariam", "Tariq", "Isla", "Rayan", "Amna", "Jack", "Zara", "Kabir"];
const LAST = ["Osei", "Khan", "Malik", "Ahmed", "Carter", "Hussain", "Raza", "Bell", "Sheikh", "Ali", "Qureshi", "Evans", "Butt", "Rossi", "Iqbal", "Shah", "Reed", "Nasser", "Chaudhry", "Hall", "Siddiqui", "Moore", "Javed", "Mirza", "Young", "Haider", "Rana", "Cole", "Aziz", "Lone"];

interface Person { name: string; email: string; phone: string; contactId: string }
const people: Person[] = FIRST.map((f, i) => ({
  name: `${f} ${LAST[i]}`,
  email: `${f}.${LAST[i]}@demo.example`.toLowerCase(),
  phone: `+9230${between(10000000, 99999999)}`,
  contactId: `demo-c-${String(i + 1).padStart(2, "0")}`,
}));

const TOPICS = [
  { key: "suite", ask: "Do you have a Terrace Suite free for our anniversary weekend?", reply: "Happy to help — the Terrace Suite is lovely for an anniversary. Which nights are you thinking?", followup: "the 26th and 27th, two guests", close: "Let me check with my partner and come back to you." },
  { key: "parking", ask: "Is there parking at the hotel and what does it cost?", reply: "We offer valet parking at $42 per night with unlimited in-and-out. There is no self-parking on site.", followup: "ok, and is the valet 24 hours?", close: "Thanks, that's helpful. I'll let you know." },
  { key: "restaurant", ask: "Is the rooftop restaurant open late on weekends?", reply: "Halcyon serves until 10pm and the bar stays open until midnight.", followup: "can I book a table for six on Saturday?", close: "Great, I'll confirm the numbers with the group first." },
  { key: "pets", ask: "Are dogs allowed in the rooms?", reply: "Small dogs under 25 lbs are welcome for a one-time fee. Which breed do you have?", followup: "a beagle, about 20 lbs", close: "Perfect, thanks for the info." },
  { key: "checkin", ask: "What time is check-in and is early check-in possible?", reply: "Check-in is from 3pm. Early check-in depends on availability on the day — I can note the request.", followup: "we land at 9am, would be great", close: "Thanks, we'll see how the flight goes." },
  { key: "shuttle", ask: "Do you run an airport shuttle?", reply: "Yes, there is an airport shuttle. It runs on request — I can pass your flight details to the front desk.", followup: "arriving at 6pm on Friday", close: "Brilliant, thank you." },
  { key: "events", ask: "We're planning a 40-person meeting, do you have event space?", reply: "We do have meeting and event space. Could you share the date and what setup you need?", followup: "mid-November, boardroom style", close: "I'll send the details to my manager and revert." },
] as const;

function thread(p: Person, topic: (typeof TOPICS)[number], start: Date, turns: 2 | 3 | 4, abandonedLast: boolean) {
  const t = (m: number) => iso(new Date(start.getTime() + m * 60_000));
  const msgs: { role: string; text: string; at: string }[] = [
    { role: "caller", text: topic.ask, at: t(0) },
    { role: "agent", text: topic.reply, at: t(1) },
  ];
  if (turns >= 3) {
    msgs.push({ role: "caller", text: topic.followup, at: t(3) });
    msgs.push({ role: "agent", text: "Thanks. Shall I check live availability for that?", at: t(4) });
  }
  if (turns === 4) msgs.push({ role: "caller", text: abandonedLast ? topic.close : `Yes please — it's ${p.name}, ${p.email}`, at: t(6) });
  return msgs;
}

// -------------------------------------------------------------- conversations --

type Outcome = "booked" | "abandoned" | "enquiry_only" | "handed_off" | "no_show";
const OUTCOMES: Outcome[] = [
  ...Array<Outcome>(9).fill("booked"),
  ...Array<Outcome>(9).fill("abandoned"),
  ...Array<Outcome>(6).fill("enquiry_only"),
  ...Array<Outcome>(4).fill("handed_off"),
  ...Array<Outcome>(2).fill("no_show"),
];
const CHANNELS = ["chat", "chat", "chat", "voice", "voice", "instagram", "facebook"] as const;

const convos = people.map((p, i) => {
  const outcome = OUTCOMES[i]!;
  const topic = TOPICS[i % TOPICS.length]!;
  // Anything the abandoned sweep could still act on is pushed outside its 7-day window.
  const followable = outcome === "abandoned" || outcome === "enquiry_only";
  const days = followable ? between(8, 28) : between(0, 26);
  const start = ago(days);
  const channel = CHANNELS[i % CHANNELS.length]!;
  const messages = thread(p, topic, start, pick([2, 3, 4] as const), outcome === "abandoned");
  const code = outcome === "booked" ? `DEMO-${String(i + 1).padStart(4, "0")}` : null;
  return {
    id: `demo-convo-${String(i + 1).padStart(2, "0")}`,
    channel, outcome, topic, p, code,
    createdAt: start,
    updatedAt: new Date(messages.at(-1)!.at),
    messages,
  };
});

// ------------------------------------------------------------ booking plan --

const RESOURCES = [
  { id: "room_king", mins: 60, env: "GHL_CALENDAR_ROOM_KING", label: "a King room", detail: { guests: "2", room: "King" } },
  { id: "room_queen", mins: 60, env: "GHL_CALENDAR_ROOM_QUEEN", label: "a room with two queens", detail: { guests: "3", room: "Two queens" } },
  { id: "room_suite", mins: 60, env: "GHL_CALENDAR_ROOM_SUITE", label: "a Terrace Suite", detail: { guests: "2", room: "Terrace Suite", occasion: "anniversary" } },
  { id: "table", mins: 90, env: "GHL_CALENDAR_TABLE", label: "a table at Halcyon", detail: { party_size: "4" } },
] as const;
const BOOKING_STATUS = [
  ...Array(19).fill("confirmed"), ...Array(5).fill("cancelled"), ...Array(4).fill("showed"), ...Array(2).fill("no_show"),
] as string[];

/** Karachi is UTC+5 all year; the calendars and GHL_TIMEZONE are set to it. */
const KHI = "+05:00";
const pad = (n: number) => String(n).padStart(2, "0");
const plan = people.map((_p, i) => {
  const res = RESOURCES[i % RESOURCES.length]!;
  // The first four fall inside the next 48 hours so "Bookings, next 48h" has data.
  const offsetDays = i < 4 ? [0, 1, 1, 2][i]! : between(-14, 20);
  const day = new Date(NOW + offsetDays * DAY);
  const hour = res.id === "table" ? between(12, 21) : between(15, 21); // inside each calendar's hours
  const local = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(hour)}:00:00${KHI}`;
  const start = new Date(local);
  return {
    res, start, end: new Date(start.getTime() + res.mins * 60_000), local,
    status: i < 4 ? "confirmed" : BOOKING_STATUS[i - 4] ?? "confirmed",
    externalId: null as string | null,
  };
});

// ------------------------------------------------- GoHighLevel (real records) --

const STAGE = { new: "new", qualified: "qualified", booked: "booked", lost: "lost" } as const;
const stageFor = (o: Outcome, bookingStatus: string) =>
  o === "booked" && bookingStatus !== "cancelled" ? STAGE.booked
  : o === "booked" || o === "no_show" || o === "abandoned" && rnd() < 0.4 ? STAGE.lost
  : o === "handed_off" ? STAGE.qualified
  : STAGE.new;
const APPT_STATUS: Record<string, string> = { confirmed: "confirmed", cancelled: "cancelled", showed: "showed", no_show: "noshow" };

console.log("Creating demo records in GoHighLevel…");
let ghlContacts = 0, ghlOpps = 0, ghlAppts = 0;
for (const [i, c] of convos.entries()) {
  const p = c.p;
  const id = await crm.upsertContact({ fullName: p.name, email: p.email, phone: p.phone });
  if (!id) { console.log(`  ! contact failed for ${p.name}`); continue; }
  p.contactId = id; ghlContacts++;
  await crm.addTags(id, ["demo-data", `lead-source-${c.channel}`, pick(["lead-hot", "lead-warm", "lead-cold"])]);

  const plan_i = plan[i]!;
  const [existing] = await sql`select external_id from bookings where code = ${c.code ?? `DEMO-${String(i + 101).padStart(4, "0")}`}`;
  if (existing?.external_id) {
    plan_i.externalId = existing.external_id; // already created on an earlier run
  } else {
    try {
      const appt = await ghl.request<{ id?: string; appointmentId?: string }>(paths.bookAppointment(), {
        method: "POST",
        body: {
          calendarId: process.env[plan_i.res.env],
          locationId: ghl.env.locationId,
          contactId: id,
          // Required once slot validation is skipped: GHL will not assign a host itself.
          assignedUserId: process.env.GHL_USER_ID,
          startTime: plan_i.local,
          endTime: plan_i.end.toISOString(),
          title: `${plan_i.res.label} — ${p.name}`,
          appointmentStatus: APPT_STATUS[plan_i.status] ?? "confirmed",
          // Past dates and seeded variety must not be refused as "not a free slot".
          ignoreDateRange: true,
          ignoreFreeSlotValidation: true,
        },
      });
      plan_i.externalId = appt.id ?? appt.appointmentId ?? null;
      if (plan_i.externalId) ghlAppts++;
    } catch (err) {
      console.log(`  ! appointment failed for ${p.name}: ${String(err).slice(0, 110)}`);
    }
  }

  const opp = await crm.createOpportunity({
    contactId: id,
    name: `${p.name} — The Fairmount (${c.channel})`,
    score: "warm",
    outcome: stageFor(c.outcome, plan_i.status),
    monetaryValue: between(1, 9) * 150,
  });
  if (opp) ghlOpps++;
  await sleep(450); // GHL allows ~100 requests per 10s; one person costs ~5
}
console.log(`  GHL: ${ghlContacts} contacts, ${ghlOpps} opportunities, ${ghlAppts} appointments\n`);

for (const c of convos) {
  await sql`insert into conversations (id, industry, channel, contact_id, contact, messages, outcome, booking_code, created_at, updated_at)
    values (${c.id}, 'hotel', ${c.channel}, ${c.p.contactId},
      ${sql.json({ full_name: c.p.name, email: c.p.email, phone: c.p.phone, source: c.channel === "instagram" ? "instagram_dm" : c.channel === "facebook" ? "facebook_dm" : c.channel })},
      ${sql.json(c.messages)}, ${c.outcome}, ${c.code}, ${c.createdAt}, ${c.updatedAt})
    on conflict (id) do nothing`;
}

// ------------------------------------------------------------------ bookings --

for (let i = 0; i < 30; i++) {
  const p = people[i]!;
  const convo = convos[i]!;
  const b = plan[i]!;
  const code = convo.code ?? `DEMO-${String(i + 101).padStart(4, "0")}`;
  await sql`insert into bookings (code, external_id, resource_id, industry, starts_at, ends_at, status, contact_id, email, phone, full_name, details, created_at, updated_at)
    values (${code}, ${b.externalId}, ${b.res.id}, 'hotel', ${b.start}, ${b.end}, ${b.status},
      ${p.contactId}, ${p.email}, ${p.phone}, ${p.name}, ${sql.json({ ...b.res.detail })}, ${ago(Math.max(0, -Math.round((b.start.getTime() - NOW) / DAY)) + 2)}, ${new Date()})
    on conflict (code) do update set external_id = coalesce(bookings.external_id, excluded.external_id)`;
}

// --------------------------------------------------------------------- leads --

const SOURCES = ["web_form", "web_form", "facebook_lead_ad", "instagram_dm", "facebook_dm", "chat", "chat", "voice", "email", "webhook"] as const;
const SOURCE_TAG: Record<string, string> = { web_form: "web-form", facebook_lead_ad: "facebook-lead-ad", instagram_dm: "instagram-dm", facebook_dm: "facebook-dm", chat: "chat", voice: "voice", email: "email", webhook: "webhook" };
const ENQUIRIES = [
  "Looking for a suite for our anniversary", "Rates for a family room next month", "Do you host small weddings?",
  "Corporate rate for 10 rooms", "Table for 8 on Saturday", "Is breakfast included?", "Airport pickup for two",
  "Availability for the long weekend", "Do you have accessible rooms?", "Quote for a 40-person meeting",
];
// created 20, merged 5, duplicate 2, rejected 2, failed 1 (all attempts used)
const LEAD_STATUS = [...Array(20).fill("created"), ...Array(5).fill("merged"), ...Array(2).fill("duplicate"), ...Array(2).fill("rejected"), "failed"] as string[];

for (let i = 0; i < 30; i++) {
  const p = people[i]!;
  const source = SOURCES[i % SOURCES.length]!;
  const status = LEAD_STATUS[i]!;
  const received = ago(between(0, 27));
  const rejected = status === "rejected";
  const lead = {
    source,
    fullName: rejected ? null : p.name,
    email: rejected ? null : p.email,
    phone: rejected ? null : p.phone,
    message: ENQUIRIES[i % ENQUIRIES.length],
    fields: { ...(source === "web_form" ? { nights: String(between(1, 4)) } : {}) },
    capturedAt: iso(received),
  };
  const tags = rejected ? [] : [`lead-source-${SOURCE_TAG[source]}`, "ai-captured", pick(["lead-hot", "lead-warm", "lead-cold"])];
  await sql`insert into lead_events (id, source, external_id, identity_key, contact_id, conversation_id, status, reason, tags, lead, enrichment, tags_synced, note_added, attempts, seen_count, captured_at, received_at, processed_at)
    values (${`demo-lead-${String(i + 1).padStart(2, "0")}`}, ${source}, ${`demo-ext-${i + 1}`},
      ${rejected ? null : `email:${p.email}`}, ${rejected ? null : p.contactId}, ${rejected ? null : convos[i]!.id},
      ${status}, ${rejected ? "no email or phone" : status === "failed" ? "CRM upsert failed" : null},
      ${sql.json(tags)}, ${sql.json(lead)}, 'not_needed', ${!rejected && status !== "failed"}, ${!rejected && status !== "failed"},
      ${status === "failed" ? 6 : 1}, ${status === "duplicate" ? 2 : 1}, ${received}, ${received}, ${status === "failed" ? null : received})
    on conflict (id) do nothing`;
  if (!rejected && status !== "failed") {
    await sql`insert into lead_identities (key, contact_id, first_source, sources, tags, conversation_id, last_lead_id, created_at, updated_at)
      values (${`email:${p.email}`}, ${p.contactId}, ${source}, ${sql.json([source])}, ${sql.json(tags)}, ${convos[i]!.id}, ${`demo-lead-${String(i + 1).padStart(2, "0")}`}, ${received}, ${received})
      on conflict (key) do nothing`;
  }
}

// -------------------------------------------------------------------- emails --

const TRIGGERS = ["new_lead", "thank_you", "abandoned_1h", "abandoned_24h", "abandoned_3d", "no_show"] as const;
const EMAIL_STATUS = [...Array(12).fill("sent"), ...Array(10).fill("send_disabled"), ...Array(3).fill("failed"), ...Array(2).fill("discarded"), ...Array(3).fill("skipped_already_contacted")] as string[];

function emailCopy(trigger: (typeof TRIGGERS)[number], p: Person, topic: (typeof TOPICS)[number]) {
  const first = p.name.split(" ")[0]!;
  const sign = "Warmly,\nThe Fairmount";
  switch (trigger) {
    case "thank_you": return { subject: "Your stay at The Fairmount is confirmed", body: `Hi ${first},\n\nThank you for booking with us — we're looking forward to welcoming you. If anything changes, just reply to this email.\n\n${sign}` };
    case "new_lead": return { subject: `About your enquiry: ${topic.key}`, body: `Hi ${first},\n\nThanks for getting in touch. ${topic.reply}\n\nWould you like me to check availability for you?\n\n${sign}` };
    case "abandoned_1h": return { subject: "Picking up where we left off", body: `Hi ${first},\n\nJust following up on your question — ${topic.ask.toLowerCase()} Happy to check what's open whenever you're ready.\n\n${sign}` };
    case "abandoned_24h": return { subject: "Still thinking it over?", body: `Hi ${first},\n\nA quick note in case you're still deciding. Would you like me to check availability?\n\n${sign}` };
    case "abandoned_3d": return { subject: "One last note from The Fairmount", body: `Hi ${first},\n\nI'll leave the door open — reply any time and I'll take it from there.\n\n${sign}` };
    default: return { subject: "We missed you", body: `Hi ${first},\n\nWe're sorry we missed you. Rebooking takes a moment — just reply and we'll sort it.\n\n${sign}` };
  }
}

for (let i = 0; i < 30; i++) {
  const p = people[i]!;
  const convo = convos[i]!;
  const trigger = TRIGGERS[i % TRIGGERS.length]!;
  const status = EMAIL_STATUS[i]!;
  const copy = emailCopy(trigger, p, convo.topic);
  const composed = ago(between(0, 25));
  const held = status === "send_disabled";
  await sql`insert into lead_emails (id, lead_id, contact_id, conversation_id, trigger, recipient, subject, body, status, reason, send_error, attempts, composed_at, sent_at)
    values (${`demo-email-${String(i + 1).padStart(2, "0")}:${trigger}`}, ${`demo-lead-${String(i + 1).padStart(2, "0")}`}, ${p.contactId}, ${convo.id}, ${trigger}, ${p.email},
      ${copy.subject}, ${copy.body}, ${status},
      ${held ? "autosend is dry_run" : status === "skipped_already_contacted" ? "this contact already had a first-touch email" : status === "discarded" ? "discarded by operator" : null},
      ${status === "failed" ? "GHL 400: recipient mailbox unavailable" : null}, ${status === "sent" ? 1 : status === "failed" ? 2 : 0},
      ${composed}, ${status === "sent" ? new Date(composed.getTime() + 60_000) : null})
    on conflict (id) do nothing`;
}

// -------------------------------------------------------------------- social --

const POST_STATUS = [...Array(18).fill("published"), ...Array(5).fill("scheduled"), ...Array(4).fill("draft"), ...Array(3).fill("failed")] as string[];
const PLATFORMS = ["facebook", "instagram", "facebook", "instagram", "linkedin"] as const;
const POSTS: Record<string, string> = {
  parking: "Wondering where to park? We offer valet parking for $42 a night with unlimited in-and-out. Just pull up to the front.",
  restaurant: "Halcyon on the rooftop serves until 10pm, and the bar stays open until midnight. Book a table for the weekend.",
  pets: "Travelling with a small dog? Pups under 25 lbs are welcome — ask us about the one-time pet fee.",
  checkin: "Check-in starts at 3pm. Landing earlier? Tell us your arrival time and we'll do our best to have your room ready.",
  shuttle: "Our airport shuttle runs on request. Share your flight details and the front desk will take care of the rest.",
  suite: "Celebrating something special? Our Terrace Suite is made for anniversaries.",
  events: "Planning a meeting or small event? Ask about our event space and setups.",
};
for (let i = 0; i < 30; i++) {
  const topic = TOPICS[i % TOPICS.length]!;
  const platform = PLATFORMS[i % PLATFORMS.length]!;
  const status = POST_STATUS[i]!;
  const when = status === "scheduled" ? new Date(NOW + between(1, 9) * DAY) : ago(between(1, 40), between(9, 18));
  await sql`insert into social_posts (id, industry, platform, account_id, topic, asked_by, text, status, error, posted_at, weekday, hour, created_at)
    values (${`demo-post-${String(i + 1).padStart(2, "0")}`}, 'hotel', ${platform}, ${`demo-account-${platform}`}, ${topic.key}, ${between(0, 14)},
      ${POSTS[topic.key] ?? topic.ask}, ${status}, ${status === "failed" ? "Gemini 503: model overloaded" : null},
      ${status === "draft" ? null : when}, ${when.getDay()}, ${when.getHours()}, ${ago(between(1, 41))})
    on conflict (id) do nothing`;
}

// 30 days of engagement, with weekends a little stronger so "best day" has a real answer.
for (let d = 0; d < 30; d++) {
  const day = new Date(NOW - (d + 1) * DAY);
  const weekday = day.getDay();
  const boost = weekday === 0 || weekday === 6 ? 1.6 : weekday === 5 ? 1.25 : 1;
  const date = day.toISOString().slice(0, 10);
  await sql`insert into social_stats (id, profile_id, platform, date, weekday, posts, impressions, likes, comments, collected_at)
    values (${`demo-stat-${date}`}, 'demo-profile', 'facebook', ${date}, ${weekday}, ${between(0, 2)},
      ${Math.round(between(300, 900) * boost)}, ${Math.round(between(15, 60) * boost)}, ${Math.round(between(1, 9) * boost)}, ${day})
    on conflict (id) do nothing`;
}

// ------------------------------------------------------------------- summary --

const tables = ["conversations", "bookings", "lead_events", "lead_identities", "lead_emails", "social_posts", "social_stats"] as const;
const keys: Record<(typeof tables)[number], string> = {
  conversations: "id like 'demo-%'", bookings: "code like 'DEMO-%'", lead_events: "id like 'demo-%'",
  lead_identities: "key like '%@demo.example'", lead_emails: "id like 'demo-%'", social_posts: "id like 'demo-%'", social_stats: "id like 'demo-%'",
};
for (const t of tables) {
  const [row] = await sql.unsafe(`select count(*)::int n from ${t} where ${keys[t]}`);
  console.log(`  ${t.padEnd(16)} ${row!.n} demo row(s)`);
}
await sql.end();
