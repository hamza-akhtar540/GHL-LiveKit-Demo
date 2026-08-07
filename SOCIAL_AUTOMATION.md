# Social posting + learning loop — feasibility

Can we post to Facebook/Instagram automatically with generated content, read the
engagement back, learn the best time to post, and have the agent handle anyone
who replies?

**Short answer: three of the four parts, yes. The "learn the best time" part is
not a GoHighLevel feature and has to be built — and it needs weeks of real data
before it says anything true.**

Checked July 2026 by calling GHL's own social API against our account.

---

## 1. Post automatically with generated content — ✅ yes

GHL exposes a real social posting API, confirmed present:

| endpoint | what it does |
|---|---|
| `social-media-posting/create-post` | Facebook, Instagram, LinkedIn, Google Business, TikTok. Text, media, scheduling, tags, and a follow-up comment. |
| `social-media-posting/get-posts` | filter by `scheduled`, `published`, `failed`, `draft`, and by account or date |
| `social-media-posting/edit-post` | change a scheduled post before it goes |
| `social-media-posting/get-account` | which channels are connected |

Content generation is ours, and this is the part where we have an unfair
advantage: **the agent already knows what customers actually ask.** The
conversation store has every question anyone put to it. "Do you allow dogs?"
asked forty times is a post that will land, because it's a real question rather
than a marketer's guess at one. Nobody else generating social content has that
input.

Scheduling is handled by GHL, so we don't build a cron for it — we hand it a
`scheduleDate`.

## 2. Read likes / views / engagement back — ✅ better than expected

**Verified live** against the connected page on 2026-07-28. `get-social-media-statistics`
returns more than its description implies — not a single 7-day total, but a
**daily series**:

```
dayRange:  [Thu, Fri, Sat, Sun, Mon, Tue, Wed]
grouping:  "daily"
postPerformance: { posts, impressions, likes, comments }   // 7 values each
breakdowns:      totals + change vs the previous 7 days
platformTotals:  impressions / followers / likes, per platform, as series
demographics:    gender split and age bands (13-17 … 65+)
```

The demographics were a bonus — nothing asked for them and they're genuinely
useful for deciding what to post.

Two real limits found:

**`grouping` is `"daily"`, and there is no hourly option.** This is the one that
matters for part 3, below.

**`get-posts` only returns posts created through GHL.** It came back empty while
statistics reported `posts: 1` — because that post was made natively on Facebook
and the account has `syncPosts: false`. Not a problem for us (we'll be creating
the posts) but it means historical native posts can't be analysed.

## 3. Learn the best posting time and adapt — ✅ day of week · ❌ hour of day

Now split by what the verified data actually supports:

**Best day of the week — yes, and directly.** The statistics series is keyed by
weekday, so "Saturdays outperform Tuesdays" is a question GHL can answer today.
Accumulate those weekly snapshots and the pattern emerges without any Meta
integration.

**Best hour of the day — no.** `grouping` is `"daily"` and there is no hourly
option. GHL cannot tell us that 7pm beats 2pm.

Getting hour-of-day would need **Meta's own Insights API** — a Meta app, a page
access token, and App Review. That's days of work for a refinement, so my
recommendation is to ship day-of-week first and treat hour-of-day as a later
upgrade if a client actually asks. "We post on your best days" is a real,
defensible claim; the extra precision is not worth blocking on.

The build is otherwise straightforward, since we already have the pieces:

```
we schedule the post  ->  we know exactly when it went out
poll statistics daily ->  store the numbers against that post in Postgres
enough posts later    ->  correlate time-of-day and weekday with engagement
                      ->  schedule the next one where the data points
```

The storage is a small table next to `conversations` and `bookings`, and the
polling is one scheduled job. No new infrastructure.

**Two things worth being honest about before promising this to anyone:**

**It needs weeks before it means anything.** Best-time-to-post is a statistical
claim, and with five posts you have noise, not a pattern. Realistically 20–30
posts spread across different days and times before the ranking is worth acting
on — call it 4–6 weeks of consistent posting. A demo can show the mechanism and
the dashboard; it cannot show a real conclusion. Any product that claims to know
your best posting time in week one is guessing.

**Engagement depends far more on the content than the hour.** A good post at a
mediocre time beats a weak post at the perfect time, every time. So the honest
framing of this feature is "we stop posting at 3am and we learn your audience's
rhythm", not "we found the magic hour". Overselling it is easy and it will not
survive contact with a client's actual numbers.

Given that, the sequencing I'd suggest: build the posting and the measurement
first, let data accumulate while the rest of the demo is being built, and turn the
adaptive scheduling on once there's something to adapt to.

## 4. Agent handles anyone who interacts — ✅ yes, and this is the strongest part

Someone comments or DMs, and the agent answers with full context, qualifies, and
books. This is already most of the way built:

- Their comment or DM **opens Meta's 24-hour messaging window**, which is what
  makes replying legal and automatable — see `SOCIAL_ACQUISITION.md` for the rule
  and its consequences.
- GHL's `conversations` API delivers the message and sends the reply, and we
  already use both for email.
- The brain, the six tools, the grounded facts, the CRM writes and the
  conversation store are all done and channel-agnostic. Instagram DM is another
  adapter, the same shape as email.
- Response speed is the whole advantage. The 24-hour window punishes slow
  repliers; we answer in about two seconds.

So the loop closes: generated post → someone comments → agent converses → contact,
score and booking land in the CRM → attribution shows which post produced it.

---

## Needs you

1. **Add the Social Planner scopes to the Private Integration Token.** Everything
   in parts 1–3 returns `401 The token is not authorized for this scope` today.
   Scopes can be added to the existing integration without regenerating it — see
   `docs/GHL_SETUP.md` §5.
2. **Connect the Facebook page and Instagram account in the sub-account.** OAuth,
   needs page-admin rights. This is also the step that unlocks the inbound DM path
   in part 4 without us needing a Meta app at all.
3. Optional, only if `get-post` turns out not to carry per-post engagement: a Meta
   app with a page access token, for Insights.

Once (1) and (2) are done I can verify the statistics shape immediately and say
definitively whether part 3 needs Meta's API or not.

## What I'd build, in order

1. **Post generation + scheduling** — content drawn from real customer questions
   in the conversation store, scheduled through GHL.
2. **Engagement collection** — a daily poll storing numbers against each post, so
   the dataset starts accumulating from day one.
3. **Inbound comment/DM → agent** — the highest-value piece, and mostly a matter
   of wiring an existing brain to a new channel.
4. **Timing analysis** — last, once there's data. Until then it would be a
   confident-looking chart built on nothing.
