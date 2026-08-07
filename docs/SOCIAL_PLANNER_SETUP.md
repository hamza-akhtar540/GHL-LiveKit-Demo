# Social Planner setup

Connecting Facebook and Instagram so the agent can post, read engagement, and
answer anyone who replies.

About 20 minutes, most of it waiting on Meta's permission screens. Two steps need
doing in order — the token scopes, then the channel connections.

Related: [SOCIAL_AUTOMATION.md](../SOCIAL_AUTOMATION.md) for what's feasible and
what isn't, and [SOCIAL_ACQUISITION.md](../SOCIAL_ACQUISITION.md) for the 24-hour
messaging rule that governs replies.

---

## 0. Prerequisites — check these first

This is where people get stuck, and none of it can be fixed from our side.

**Facebook: it must be a Page, not a profile.** Personal Facebook profiles cannot
be connected — only Pages. You need an **admin** role on the Page (editor is not
enough for some scopes).

**Instagram: it must be a Business or Creator account, and it must be linked to a
Facebook Page.** A personal Instagram account cannot be connected at all, and a
Business account that isn't linked to a Page won't appear in the connection
dialog even though the account exists.

To check and fix Instagram:

1. Instagram app → **Settings → Account type and tools → Switch to professional
   account** (pick Business).
2. Then **Settings → Account type and tools → Sharing to other apps → Facebook**
   and link it to the Page.

Do this *before* starting step 2 below. If Instagram isn't set up properly, the
connection screen simply won't offer it and there's no error explaining why.

---

## 1. Add the Social Planner scopes to the token

Our Private Integration Token currently has no social permissions — every social
API call returns `401 The token is not authorized for this scope`. Verified, not
assumed.

**Settings → Private Integrations → open `AI Intake Agent` → edit scopes.**

Enable everything under **Social Planner**:

- `socialplanner/post.readonly`, `socialplanner/post.write`
- `socialplanner/account.readonly`
- `socialplanner/statistics.readonly`
- plus any other `socialplanner/*` entries the list offers — the exact names vary
  by GHL version, so enable the whole group rather than matching these strings

While you're in there, also enable:

- **`locations.readonly`** — unrelated to social, but it's what lets us read the
  sub-account's country and timezone. That check has been blocked on this scope,
  and it's the reason phone numbers were saving as `+92` unnoticed.

> **Scopes can be added without regenerating the token.** If you do regenerate it,
> the new value must go into `.env` immediately — the old token stops working the
> moment a new one is issued, which will take the booking demo down with it.

---

## 2. Connect the channels

**Marketing → Social Planner → Settings (or "Connect an account").**

Pick **Facebook**. You'll be sent to Meta to authorise.

**Accept every permission it asks for.** This matters more than it looks: Meta
presents the scopes as individually toggleable, and declining any one of them
tends to fail quietly later — a post that never publishes, or an Instagram account
that doesn't appear — rather than erroring at connection time.

Then choose:

- the **Page** to post as
- the **Instagram account** linked to it (offered in the same flow — you don't
  authorise Instagram separately)

Repeat for any other channel you want. LinkedIn is **Pages only** and TikTok is
**Business accounts only**, per GHL's own API notes.

---

## 3. Verified — 2026-07-30

Ran against the live account. All three channels connected and returning data.

| platform | account | profileId | stats | expires |
|---|---|---|---|---|
| Facebook Page | Fashion icons | `6a684f955edefc66a8866a79` | ✅ | 2026-09-26 |
| Instagram | l_a_a_j_ | `6a6b07b610862dad76679bbd` | ✅ | 2026-09-28 |
| LinkedIn Page | Top Trending Blogs | `6a6b07f72a54c01b4e6b6950` | ✅ | 2026-09-28 |

`hasStatisticsPermissions: true` on all three, and real numbers came back —
Instagram reported 1 post, 7 impressions, reach 3. That's the proof the
permissions were granted properly rather than just appearing connected.

Instagram shows `meta.loginType: "instagram"`, meaning it authorised directly
rather than through the Facebook Page. Worth noting because the direct login is
the newer path and doesn't require the Page link that older guides insist on.

LinkedIn is `type: "page"` with `urn:li:organization:107349438` — a Company Page,
which is the only kind GHL supports. A personal LinkedIn profile cannot be
connected.

**What statistics returns** — more than documented: a 7-day daily series per
metric (posts, impressions, likes, comments), totals with week-on-week change,
per-platform series, and age/gender demographics.

**Two limits.**

`grouping` is `"daily"` with no hourly option, so **best-day-of-week is
answerable and best-hour-of-day is not.** Hour-level data would need Meta's own
Insights API — a Meta app plus App Review. See
[SOCIAL_AUTOMATION.md](../SOCIAL_AUTOMATION.md) §3.

`get-posts` returns only posts created *through GHL*. It came back empty while
statistics reported posts, because those were made natively and every account has
`syncPosts: false`. Fine going forward, but existing native history can't be
analysed.

### Outstanding

- **All three tokens expire late September 2026.** Reconnect before recording a
  demo rather than discovering it mid-session.
- **Almost no engagement yet** — one post per account. Nothing to analyse until
  posting starts, which is expected and is why the timing analysis has to come
  last.

---

## 4. What this enables

Once connected:

**Posting** — scheduled posts to Facebook, Instagram, LinkedIn, Google Business
and TikTok, with media and a follow-up comment. Content generated from the
questions real customers have actually asked the agent, which is a better source
than a marketer guessing at them.

**Replies** — and this is the valuable half. A comment or DM opens Meta's 24-hour
messaging window, GHL's conversations API delivers it, and the agent answers with
full context, qualifies, and books. The window rewards fast replies, and we answer
in about two seconds where a human replies the next morning.

**Measurement** — engagement collected daily and stored, so a dataset starts
building from the first post.

**Not yet** — adaptive posting times. That needs 20–30 posts across varied days
and hours (4–6 weeks of consistent posting) before it's a pattern rather than
noise. The mechanism can be demonstrated; a conclusion can't be faked.

---

## Troubleshooting

**Instagram doesn't appear in the connection dialog.** Almost always the
prerequisites in §0 — either it's still a personal account, or it isn't linked to
the Page. Fix that and reconnect; nothing on our side changes.

**`401 The token is not authorized for this scope`.** Step 1 wasn't saved, or the
scope group was only partly enabled. Re-open the integration and check.

**Posts schedule but never publish.** Usually a declined Meta permission. Meta
does not warn you at connection time. Disconnect the channel and reconnect,
accepting everything.

**Connection drops after a few weeks.** Meta tokens expire, and a password change
or a Page role change invalidates them early. Reconnecting is the fix, and it's
worth checking before recording a demo rather than during one.

**"Connected" but the account list is empty.** The signed-in Facebook user isn't
an admin of the Page. Editor is not enough.

---

## Sources

- [GoHighLevel Social Planner — complete guide 2026](https://supplygem.com/gohighlevel-social-planner/)
- [Connect Instagram in GoHighLevel](https://consultevo.com/gohighlevel-connect-instagram-facebook-link/)
- [GoHighLevel Social Planner setup & management](https://ghlcrm.me/gohighlevel-social-planner/)
- [GoHighLevel social media planner 2026](https://www.gohighlevel.ai/blog/gohighlevel-social-media-planner)
