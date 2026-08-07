# Attracting customers from Facebook & Instagram

Researched July 2026. Unlike LinkedIn, Meta has real official APIs for this — the
answer is genuinely yes, with one rule that shapes the whole design.

---

## The rule everything else follows from

**You can only message someone within 24 hours of them interacting with you.**

A user message, comment, story reply, reaction to a story or reel, or a
click-to-DM ad tap opens a 24-hour window. Inside it you can exchange freely,
including promotional content. Once it closes, the API blocks outbound messages
until they engage again. Every new message from them resets it.

Rate limit: **200 automated DMs per hour** per account, on a rolling
sixty-minute window.

Read that as a constraint and it looks restrictive. Read it properly and it's the
best news in this document — **the window punishes slow responders and rewards
instant ones.** A hotel replying to an Instagram DM the next morning has often
watched the window close. Our agent replies in about two seconds.

That is the entire commercial argument for this feature.

---

## ✅ What we can build

### 1. Click-to-Messenger / Click-to-Instagram-Direct ads 🌟

The strongest pattern available. Instead of an ad pointing at a landing page or a
lead form, the tap **opens a DM conversation**. The user's first message starts
the 24-hour window with genuine intent attached.

So the flow becomes:

```
Instagram ad  ->  taps "Send message"  ->  DM opens
              ->  our agent answers in ~2s, qualifies, checks real
                  availability, books
              ->  contact + booking + transcript land in GoHighLevel
```

No form. No "we'll be in touch." No lead sitting in a queue while the intent
cools. Compare that to a lead form, where the best case is a callback hours
later — the industry's own framing is that click-to-message ads "let prospects
start a chat while their interest is hottest."

### 2. Comment-to-DM

Someone comments on a post — "how much?", "do you take dogs?" Their comment
opens the window, so the agent can reply publicly *and* open a DM with the real
answer. It's already grounded in the business facts, so the answer is accurate
rather than "DM us for prices!"

This turns every post's comment section into an intake funnel, which is why
tools like ManyChat exist — except ours books, rather than collecting an email.

### 3. Story replies and reaction follow-up

A story reply or a reaction to a reel opens the window. Someone reacting to a
story about the rooftop restaurant is a warm lead with an open channel and no
form to fill in.

### 4. Lead Ads with instant follow-up

Meta's traditional lead forms still work, and GHL ingests them natively. Weaker
than click-to-DM because there's no conversation, but useful where you want
structured fields. The value we add is *speed* — the form submission becomes a
call or an email from the agent within seconds rather than the next working day.

### 5. Organic content that feeds the same funnel

GHL's social planner schedules posts across Facebook and Instagram. The
interesting part is what to post: the agent knows what customers actually ask.
"Do you allow dogs?" asked forty times is a post, a story, and a blog entry. The
content writes itself from the conversation log.

### 6. WhatsApp, same shape

Worth noting since Meta owns it and the pattern is identical — official Business
API, click-to-WhatsApp ads, a messaging window. For hotels especially, WhatsApp
is how a lot of the world actually books.

---

## 🚫 What is not possible

Being blunt, because the temptation here is real:

**You cannot DM people who haven't interacted with you.** The API blocks it —
this isn't a policy you can quietly ignore, the request fails. So "automatically
attract users" cannot mean messaging strangers.

**You cannot scrape followers, commenters, or competitors' audiences** to build a
list. Same category as the LinkedIn problem: ToS violation, account risk, and it
would be the client's real business account.

**No browser bots.** Any tool driving Instagram through a headless browser rather
than the official API is a ban waiting to happen.

So the honest framing: **we can't do outbound. We can do inbound, at machine
speed.** The job is to manufacture inbound intent — via ads, content and comments
— then convert it instantly. That's a better business anyway, because everyone
who reaches the agent actually wanted something.

---

## Why our agent fits this unusually well

Three things we've already built map directly onto it:

**The brain is transport-agnostic.** `agent-core` holds the prompt, the grounded
facts and the six tools; each channel is a thin adapter. Instagram DM is another
adapter, exactly like email. It reuses the qualification, the availability
checks, the booking, and the CRM writes with no changes.

**Conversation persistence already exists.** A DM thread that goes quiet for two
days and resumes is the same problem as an email thread, and the Postgres
conversation store already handles it. When they message again — reopening the
window — the agent picks up mid-thought.

**Speed is already there.** ~2s to a reply, measured. The 24-hour window is a
race, and it's the one thing that's hard to retrofit.

---

## What I'd build, in order

1. **Meta connection in GHL** — connect the Facebook page and Instagram account
   in the sub-account. Needs you: it's an OAuth flow with page admin rights.
2. **DM channel adapter** — inbound DM → `agent-core` → reply. Same shape as the
   email handler, and it can share most of it.
3. **Comment-to-DM** — watch comments, reply publicly, open the DM.
4. **Window awareness** — track when each conversation's 24 hours expires, and
   never queue a message that would be rejected. If it's closed, fall back to
   email, which has no such limit.
5. **Click-to-DM ad** — one real campaign, small budget, to prove the loop end to
   end and produce the demo footage.
6. **Attribution back to GHL** so the case study can say "this ad produced nine
   bookings", not "nine clicks".

Item 4 is the one that's easy to skip and shouldn't be. A queue of messages the
API silently refuses looks exactly like a working system until someone checks.

---

## One thing to decide

Whether to run a **real ad campaign** for the demo. A live click-to-DM ad with
$50 behind it would produce genuine strangers talking to the agent — which is
far more convincing footage than us typing at it, and it tests behaviour we
cannot simulate. It also risks the agent meeting a real member of the public
before we've hardened it. My instinct is yes, but late, and to a tightly
targeted audience.

---

## Sources

- [Instagram Messaging API 24-hour window policy (2026)](https://www.keyapi.ai/blog/instagram-messaging-api-policy/)
- [Instagram DM automation rules — full guide 2026](https://www.spurnow.com/en/blogs/instagram-dm-automation-rules)
- [Instagram DM compliance 2026: Meta's allowed vs banned](https://creatorflow.so/blog/instagram-dm-compliance-meta-rules/)
- [Navigating Instagram API rate limits for safe DM automation](https://instantdm.com/blog/navigating-instagram-api-rate-limits-for-safe-dm-automation-in-2026)
- [Click to Instagram Direct ads: a practical guide](https://respond.io/blog/click-to-instagram-direct-ads)
- [Instagram Lead Ads vs DM Ads (2026)](https://www.spurnow.com/en/blogs/instagram-lead-ads-vs-dm-ads)
- [Lead ads that click to Messenger and Instagram — Meta](https://www.facebook.com/business/help/2398917563501477)
- [Click-to-chat ads for lead generation](https://respond.io/blog/click-to-chat-ads)
