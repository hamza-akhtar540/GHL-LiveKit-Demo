# AI Lead Intake & Booking — Task List

Plain-language checklist for the full 2-week build.

**Legend:** 🧑 = you (account setup, judgement calls, recording) · 🤖 = me (building) · 🔒 = blocks other work

---

## Week 1 — Make it work

### Day 1 — Accounts and foundations

- [x] 🤖 Set up the project structure
- [x] 🤖 Build the connection layer to GoHighLevel
- [x] 🤖 Build a checker that confirms our credentials work
- [x] 🤖 Build a listener that catches incoming emails so we can inspect them
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

- [ ] 🤖 Fix any details that came back different from expected in the checker
- [ ] 🤖 Build the six things the agent can do:
  - [ ] Create or update a contact
  - [ ] Look up open appointment times
  - [ ] Book an appointment
  - [ ] Score the lead hot / warm / cold
  - [ ] Save the conversation to the contact record
  - [ ] Hand off to a human when asked
- [ ] 🤖 Build one place that handles all dates and times (prevents timezone bugs)
- [ ] 🤖 Write tests that actually create a contact and book a real appointment
- [ ] 🧑 Check GoHighLevel and confirm the test appointment really appeared

### Day 3 — The conversation itself

- [ ] 🤖 Set up the database that remembers conversations
- [ ] 🤖 Build the core conversation engine
- [ ] 🤖 Write the agent's personality and qualifying questions for roofing
- [ ] 🤖 Turn on cost-saving so we don't re-pay for conversation history every reply
- [ ] 🤖 Build a terminal tool for testing conversations quickly
- [ ] 🧑 Have 5–10 test conversations and tell me what feels wrong
- [ ] 🧑 Decide: how pushy should it be about booking?

> Day 3 is where product quality is decided. The prompt gets tuned here, in a
> fast loop, not later in a browser where every change takes a minute to test.

### Day 4 — Chat on a website

- [ ] 🤖 Build the chat service
- [ ] 🤖 Build the chat bubble and window
- [ ] 🤖 Build the fake roofing company website to demo it on
- [ ] 🧑 Write the website copy (or approve mine) — company name, services, testimonials
- [ ] 🧑 Full test: chat on the site → contact appears in GoHighLevel → appointment booked → confirmation text arrives on your phone
- [ ] 🧑 Screen-record that loop once it works

### Day 5 — Voice

- [ ] 🤖 Add speech-to-text, the voice, and turn-taking
- [ ] 🤖 Build the "Talk to us" button that switches chat → voice **without losing the conversation**
- [ ] 🤖 Pre-load appointment times so there's no awkward silence while it checks
- [ ] 🤖 Handle interruptions when someone talks over it
- [ ] 🧑 Pick the voice — I'll give you 3–4 options to listen to
- [ ] 🧑 Call it 10 times and note anywhere it sounds robotic or pauses too long

> The chat-to-voice handoff keeping context is the thing competitors don't have.
> It's the moment worth building the whole demo around.

---

## Week 2 — Email, polish, and selling it

### Day 6 — Email replies

- [ ] 🤖 Build the receiver for incoming emails
- [ ] 🤖 Stop the agent replying to itself (this causes infinite email loops)
- [ ] 🤖 Make sure it only replies once even if the same email arrives twice
- [ ] 🤖 Load the full prior conversation so replies have real context
- [ ] 🤖 Re-check appointment availability before booking (times quoted hours ago may be gone)
- [ ] 🧑 Email the address from Gmail and confirm the reply references your earlier chat
- [ ] 🧑 Try to break it: reply twice fast, reply to an old thread, send a blank email

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
- [ ] 🤖 Build human handoff — tags the contact and notifies the team
- [ ] 🤖 Build the results dashboard: conversations, bookings, conversion rate, response time, cost per lead
- [ ] 🧑 Confirm the scoring matches your gut on 10 test conversations
- [ ] 🧑 Decide which numbers go in the case study

### Day 9 — Automation and hardening

- [ ] 🤖 Set up the reminder and no-show workflows in GoHighLevel
- [ ] 🤖 Sync reschedules and cancellations back so the agent knows
- [ ] 🤖 Build the HVAC and med spa versions (should be quick — mostly config)
- [ ] 🤖 Handle every failure gracefully: no slots free, GoHighLevel down, voice drops
- [ ] 🧑 Try to break it for 20 minutes — weird answers, silence, nonsense, hostile replies
- [ ] 🧑 *(cut this if Day 1's email test went badly)* Put the widget on a real WordPress site

> Day 9 is overloaded. If something slips, drop the WordPress test — the claim
> holds without it.

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

## Decisions you still owe me

- [ ] 🧑 Company name for the demo — I've used "Summit Peak Roofing", change it if you want
- [ ] 🧑 Voice choice (Day 5)
- [ ] 🧑 How aggressively it pushes for the booking (Day 3)
- [ ] 🧑 Whether the med spa demo is worth it, given the medical-privacy questions it invites
- [ ] 🧑 Your Upwork rate for this offer

## Running risks

| Risk | When we'll know | Fallback |
|---|---|---|
| Email needs extra setup | Day 1 | Add half a day, drop the WordPress test |
| Voice feels slow | Day 5 | Pre-load more, shorten the agent's replies |
| Prompt needs more tuning than planned | Day 3 | Borrow from Day 8, ship one industry instead of three |
| Day 9 overloaded | Day 9 | Drop WordPress test, move extra industries to Week 3 |
