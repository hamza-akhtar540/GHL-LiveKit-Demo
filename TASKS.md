# AI Lead Intake & Booking — Task List

Plain-language checklist for the full 2-week build.

**Legend:** 🧑 = you (account setup, judgement calls, recording) · 🤖 = me (building) · 🔒 = blocks other work

**Status marks:** `[x]` done and verified · `[~]` built but not proven end-to-end · `[ ]` not started

---

## What's left, shortest path first

Everything below is what remains. Ordered by what unblocks the most.

### 🔒 Blocked on you — nothing else moves until these happen

1. 🧑 **Create the GoHighLevel sub-account** (Austin, TX / Central). Everything
   in group 2 waits on this.
2. 🧑 Create the calendar, the pipeline, and the custom fields.
3. 🧑 Generate the access token, paste it into `.env`, run `pnpm ghl:smoke`.
4. 🧑 **Send a test email to the sub-account and reply from it.** Still the
   single highest-value five minutes available — it decides whether email is 2
   days or 2.5, and it has now slipped several days.
5. 🧑 **Test the voice path with a real microphone.** Built and instrumented,
   never once spoken to. I cannot do this — headless Chromium has no mic.

### Then: GoHighLevel integration (the real remaining engineering)

6. 🤖 Write `GhlBookingStore` against the existing `BookingStore` interface.
   The agent talks to that interface already, so this is one swap — no prompt
   or tool changes.
7. 🤖 Create/update contact, and write the collected fields to the CRM.
8. 🤖 Write the hot/warm/cold score and move the opportunity to the right stage.
   Rules already exist in each industry config; nothing reads them yet.
9. 🤖 Save full transcripts to the contact record.
10. 🤖 Make `handoffToHuman` tag the contact and notify the team — today it only
    logs.
11. 🤖 Fix whatever the smoke test reports as different from expected.
12. 🤖 Live-sandbox tests that create a real contact and book a real appointment.

### Conversation storage — blocks most of Week 2

13. 🤖 `packages/db` is still an **empty folder**. Conversations live only in the
    LiveKit session and vanish when it ends. Email replies and follow-ups both
    need conversations that outlive the session.

### Email (Days 6–7) — untouched

14. 🤖 Inbound receiver, self-reply loop guard, idempotency, thread context.
15. 🤖 Outbound sequences, and 🔒 **stop the sequence the moment someone replies**.

### Measurement and packaging

16. 🤖 Results dashboard: conversations, bookings, conversion rate, response
    time, cost per lead.
17. 🤖 Reminder / no-show workflows, and syncing reschedules back.
18. 🧑 Record the three demos; 🤖 edit the split-screen video and case study.

### Voice polish — see VOICE_PROPOSAL.md

19. 🤖 **Get a real phone number** (LiveKit Phone Numbers). The biggest single
    win available and roughly an hour's work.
20. 🤖 Wire `handoffToHuman` to a real warm transfer.
21. 🤖 Post-call summary + recording written to the CRM.

---

## Where things actually stand

The conversation engine, the voice pipeline and the booking tools are built and
working — against an **in-memory** booking store, not GoHighLevel. A full
conversation (ask questions → check real availability → book → get a reference)
runs today with no CRM connected.

Everything that writes to GoHighLevel is still blocked on the sub-account.
That swap is deliberately one line: the agent talks to a `BookingStore`
interface, never to GHL directly.

**Two things are ahead of schedule:** the agent became conversational rather
than a booking funnel (it answers questions, handles enquiries that never book,
and changes existing reservations), and the multi-industry work from Day 9 is
effectively solved — a second vertical is now a config file, proven with a hotel
that books both rooms and restaurant tables.

**One risk got worse by staying unknown:** the Day 1 email test still hasn't
run, so we don't know if email is 2 days or 2.5.

---

## Week 1 — Make it work

### Day 1 — Accounts and foundations

- [x] 🤖 Set up the project structure
- [x] 🤖 Build the connection layer to GoHighLevel
- [~] 🤖 Build a checker that confirms our credentials work *(written, never run against a real account)*
- [~] 🤖 Build a listener that catches incoming emails *(written, never received a real email)*
- [ ] 🧑 Create the demo sub-account in GoHighLevel (Austin, TX / Central time)
- [ ] 🧑 Create the "Free Roof Inspection" calendar — weekdays 8–5, 1-hour slots
- [ ] 🧑 Create the sales pipeline: New Lead → Qualified → Inspection Booked → Quoted → Won
- [ ] 🧑 Add the custom fields the agent fills in (service type, urgency, timeline, etc.)
- [ ] 🧑 Generate the access token and paste it into our settings file
- [ ] 🧑 Run the credential checker and send me the output
- [ ] 🧑 🔒 **Send a test email to the sub-account and confirm we receive it**
- [ ] 🧑 Reply from the sub-account too, so we can see what an outgoing email looks like

> **Why the email test matters:** it tells us whether email is simple to build
> (2 days) or needs an extra piece of setup (2.5 days). If it needs the extra
> piece, Week 2 has no spare time and we drop the "test on an outside website"
> task at the end.

### Day 2 — Teach the system to talk to GoHighLevel

- [ ] 🤖 Fix any details that came back different from expected in the checker *(needs the checker run first)*
- [ ] 🤖 Build the six things the agent can do:
  - [ ] Create or update a contact *(needs GHL)*
  - [x] Look up open appointment times *(works — in-memory calendar)*
  - [x] Book an appointment *(works — in-memory, real state, double-booking fails properly)*
  - [ ] Score the lead hot / warm / cold *(rules written in config, not wired up)*
  - [ ] Save the conversation to the contact record *(needs GHL + the database below)*
  - [~] Hand off to a human when asked *(works, but only logs — doesn't tag or notify yet)*
- [~] 🤖 Build one place that handles all dates and times *(timezone pinned per business and the agent knows today's date; not yet a single shared module)*
- [ ] 🤖 Write tests that actually create a contact and book a real appointment
- [ ] 🧑 Check GoHighLevel and confirm the test appointment really appeared

> **Extra, not originally planned:** two more tools — look up an existing
> booking, and cancel one. Needed the moment the agent handles "I want to change
> my reservation", which the hotel scenario made obvious.

### Day 3 — The conversation itself

- [ ] 🤖 Set up the database that remembers conversations *(**not started** — the folder is empty)*
- [x] 🤖 Build the core conversation engine
- [x] 🤖 Write the agent's personality and qualifying questions for roofing
- [ ] 🤖 Turn on cost-saving so we don't re-pay for conversation history every reply
- [x] 🤖 Build a terminal tool for testing conversations quickly
- [~] 🧑 Have 5–10 test conversations and tell me what feels wrong *(you've done 1 — it found two real problems)*
- [ ] 🧑 Decide: how pushy should it be about booking?

> **The database gap matters more than it looks.** Right now a conversation only
> exists inside the live call. When it ends, it's gone. Email (Day 6) and
> follow-ups (Day 7) both need conversations that outlive the session, so this
> blocks most of Week 2.

### Day 4 — Chat on a website

- [~] 🤖 Build the chat service *(token endpoint + dev server work; not the real service yet)*
- [ ] 🤖 Build the chat bubble and window *(there's a bare test page, not a widget)*
- [ ] 🤖 Build the fake roofing company website to demo it on
- [ ] 🧑 Write the website copy (or approve mine) — company name, services, testimonials
- [ ] 🧑 Full test: chat on the site → contact appears in GoHighLevel → appointment booked → confirmation text arrives on your phone
- [ ] 🧑 Screen-record that loop once it works

### Day 5 — Voice

- [~] 🤖 Add speech-to-text, the voice, and turn-taking *(built and wired; the agent speaks — confirmed — but nobody has spoken back to it yet)*
- [x] 🤖 Build the "Talk to us" button that switches chat → voice **without losing the conversation** *(built in the widget; one session, so context carries. The agent also swaps to spoken-delivery phrasing the moment a mic appears.)*
- [x] 🤖 Pre-load appointment times so there's no awkward silence while it checks *(solved differently and better — the agent says "let me check" before the tool call, and a faint keyboard plays while it looks up. Real front-desk sound rather than a prefetch cache.)*
- [~] 🤖 Handle interruptions when someone talks over it *(configured, unverified — needs a mic)*
- [x] 🤖 Cancel background noise so a TV or a car doesn't get transcribed as speech
- [x] 🤖 Measure the spoken turnaround time and flag it when it's too slow
- [ ] 🧑 Pick the voice — I'll give you 3–4 options to listen to
- [ ] 🧑 Call it 10 times and note anywhere it sounds robotic or pauses too long

> The chat-to-voice handoff keeping context is the thing competitors don't have.
> It's the moment worth building the whole demo around.

---

## Week 2 — Email, polish, and selling it

### Day 6 — Email replies

- [ ] 🤖 Build the receiver for incoming emails *(the day-1 probe exists; the real receiver doesn't)*
- [ ] 🤖 Stop the agent replying to itself (this causes infinite email loops)
- [ ] 🤖 Make sure it only replies once even if the same email arrives twice
- [ ] 🤖 Load the full prior conversation so replies have real context *(blocked on the database)*
- [ ] 🤖 Re-check appointment availability before booking (times quoted hours ago may be gone)
- [ ] 🧑 Email the address from Gmail and confirm the reply references your earlier chat
- [ ] 🧑 Try to break it: reply twice fast, reply to an old thread, send a blank email

> Groundwork done: the agent's tools live apart from the voice framework
> specifically so email can reuse the same brain without dragging a realtime
> session framework into async correspondence.

### Day 7 — Email that goes out on its own

- [ ] 🤖 Build the scheduling system for follow-up emails
- [ ] 🤖 Write the follow-up sequences:
  - [ ] Abandoned chat — 1 hour, 24 hours, 3 days
  - [ ] After booking — reminder and prep
  - [ ] No-show recovery
- [ ] 🤖 Make follow-ups reference the actual conversation, not a generic template
- [ ] 🤖 🔒 **Stop the sequence the moment someone replies**
- [ ] 🧑 Abandon a chat, wait for the follow-up, reply, confirm nothing else sends

> A nurture email firing *after* someone already booked is the worst thing that
> can happen in a live demo. This is the one to test hardest.

### Day 8 — Make it smart and measurable

- [ ] 🤖 Write the hot/warm/cold score into GoHighLevel and move the deal to the right stage
- [ ] 🤖 Save full conversation transcripts to the contact record for all three channels
- [~] 🤖 Build human handoff — tags the contact and notifies the team *(the agent hands off correctly; the tagging and notifying need GHL)*
- [ ] 🤖 Build the results dashboard: conversations, bookings, conversion rate, response time, cost per lead
- [ ] 🧑 Confirm the scoring matches your gut on 10 test conversations
- [ ] 🧑 Decide which numbers go in the case study

### Day 9 — Automation and hardening

- [ ] 🤖 Set up the reminder and no-show workflows in GoHighLevel
- [~] 🤖 Sync reschedules and cancellations back so the agent knows *(look-up and cancel work in-memory; the GHL sync doesn't exist)*
- [x] 🤖 Build the HVAC and med spa versions (should be quick — mostly config) *(**the mechanism is proven, not the two configs.** A hotel — harder than either, with two different bookable things — is now a single config file with no new code. HVAC and med spa are an hour each, whenever you want them.)*
- [~] 🤖 Handle every failure gracefully: no slots free, GoHighLevel down, voice drops *(no-slots and double-booking handled; GHL-down and voice-drop not)*
- [ ] 🧑 Try to break it for 20 minutes — weird answers, silence, nonsense, hostile replies
- [ ] 🧑 *(cut this if Day 1's email test went badly)* Put the widget on a real WordPress site

> Day 9 is much lighter than planned — the multi-industry work landed early.

### Day 10 — Package it for selling

- [ ] 🧑 Record demo 1 — roofing storm damage, **voice**
- [ ] 🧑 Record demo 2 — HVAC, **chat**
- [ ] 🧑 Record demo 3 — med spa, **email**, with a real time gap between replies
- [ ] 🤖 Edit the split-screen video: conversation on the left, GoHighLevel updating live on the right
- [ ] 🤖 Build the case study page with the real dashboard numbers
- [ ] 🧑 Rewrite the Upwork profile
- [ ] 🧑 Write 3 proposal templates — one per industry
- [ ] 🧑 Send 5 test proposals and see what lands

> The split-screen shot is the one that sells. Watching the CRM fill in while
> someone is still talking is what makes it real to a buyer.

---

## Done that wasn't on the plan

- **No AI subscriptions needed.** The language model, speech-to-text and
  text-to-speech all run through the LiveKit account you already had. Nothing to
  sign up for, no extra keys. It draws on LiveKit credit rather than being free
  forever — worth a look at the balance before recording demos.
- **The agent stopped being a booking funnel.** It answers questions, handles
  people who never book, and picks up an existing reservation to change it.
  Callers who have to answer five qualifying questions before anyone will tell
  them the check-out time hang up.
- **Grounded answers.** Business facts live in config and the agent answers only
  from those — anything else becomes "I'll have someone confirm that." Without
  this it invents warranty terms.
- **Caught: it was confirming appointments it couldn't make.** With no calendar
  attached, it still told you "you're all set for tomorrow afternoon." Fixed —
  it now says a human will confirm, until real booking is wired.
- **Caught: no contact details were ever collected.** You spotted this. Name,
  phone and address are now required before anything is confirmed.

## Decisions you still owe me

- [ ] 🧑 Company name for the demo — I've used "Summit Peak Roofing", change it if you want
- [ ] 🧑 Voice choice (Day 5)
- [ ] 🧑 How aggressively it pushes for the booking (Day 3) — **it currently asks
      two or three questions per turn; tell me if that reads pushy in voice**
- [ ] 🧑 Whether the med spa demo is worth it, given the medical-privacy questions it invites
- [ ] 🧑 Your Upwork rate for this offer

## Running risks

| Risk | When we'll know | Status |
|---|---|---|
| Email needs extra setup | Day 1 | **Still unknown** — the test hasn't run. The longer this slips the less room Week 2 has. |
| Voice feels slow | Day 5 | Unknown — needs someone to speak to it. Latency mitigations are already on. |
| Prompt needs more tuning than planned | Day 3 | Looking fine. One session found two real bugs, both fixed. |
| Day 9 overloaded | Day 9 | **Cleared.** Multi-industry landed early. |
| No conversation storage yet | Day 3 | **New.** Conversations vanish when the call ends. Blocks Days 6–8. |
