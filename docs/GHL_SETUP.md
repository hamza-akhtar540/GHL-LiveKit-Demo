# T1.2 — GHL sub-account setup

Everything here is manual UI work. Do it in order; each step produces an id that
goes into `.env`. When you're done, `pnpm ghl:smoke` should pass.

---

## 1. Sub-account

Agency view → **Sub-Accounts** → **Create Sub-Account**.

- Name: `Summit Peak Roofing (Demo)`
- Address/timezone: Austin, TX — **America/Chicago**
- Set the business email; you'll email this address in step 6.

Grab the location id from the URL once you're inside it:
`app.gohighlevel.com/v2/location/`**`<GHL_LOCATION_ID>`**`/dashboard`

> Set the timezone here **and** in `.env`. They must agree. A mismatch puts every
> booking off by hours and it won't be obvious until a demo.

---

## 2. Calendar

**Calendars → Create Calendar** (type: *Event / Service*)

| Setting | Value |
|---|---|
| Name | `Free Roof Inspection` |
| Duration | 60 min |
| Availability | Mon–Fri, 8:00–17:00 |
| Timezone | America/Chicago |
| Slot interval | 60 min |
| Minimum notice | 2 hours |
| Date range | 21 days out |

Open the calendar's settings and copy its id → `GHL_CALENDAR_ID`.

> Make sure availability actually produces open slots in the next 7 days, or the
> smoke test will report an empty availability map and you won't know whether
> that's a config problem or a parsing bug.

---

## 3. Pipeline

**Opportunities → Pipelines → Create**: `Roofing Leads`

Stages: `New Lead` → `Qualified` → `Inspection Booked` → `Quoted` → `Won`

Copy the pipeline id → `GHL_PIPELINE_ID`, and the *New Lead* stage id →
`GHL_PIPELINE_STAGE_NEW`.

---

## 4. Custom fields

**Settings → Custom Fields → Add Field**, one per `qualify` key in
`packages/agent-core/src/industries/roofing.ts`. Type: **Single Line Text** for
all of them (keep it simple — we're writing strings, not enums).

| Field name | Key |
|---|---|
| Service Type | `service_type` |
| Property Type | `property_type` |
| Urgency | `urgency` |
| Timeline | `timeline` |
| Insurance Claim | `insurance_claim` |
| Lead Score | `lead_score` |

> The keys must match the config exactly. If you rename one here, rename it in
> `roofing.ts` in the same commit.

---

## 5. Private Integration Token

**Settings → Private Integrations → Create New Integration**

Name it `AI Intake Agent`. Enable these scopes:

- `contacts.readonly`, `contacts.write`
- `calendars.readonly`, `calendars.write`
- `calendars/events.readonly`, `calendars/events.write`
- `conversations.readonly`, `conversations.write`
- `conversations/message.readonly`, `conversations/message.write`
- `opportunities.readonly`, `opportunities.write`
- `locations/customFields.readonly`

Copy the token → `GHL_PIT`. **It is shown once.**

> We're deliberately using a PIT, not an OAuth marketplace app. Same rate limits
> (100 req/10s, 200k/day per location), no redirect URI, no token refresh. An
> OAuth app would burn 2–3 days for zero demo value. We revisit only if we sell
> to multiple sub-accounts.

Now run:

```bash
pnpm ghl:smoke
```

It's read-only — it creates nothing. It confirms the token authenticates, the
calendar id resolves, and prints the raw `free-slots` response so we can confirm
our parsing assumptions against reality.

---

## 6. Webhook probe — the day-1 gate

This is the step that decides whether the email channel is a 2-day build.

```bash
# terminal 1
pnpm webhook:listen

# terminal 2
ngrok http 4000
```

In GHL, register the ngrok HTTPS URL + `/webhooks/ghl`:

- **Settings → Webhooks** if your plan exposes it, **or**
- **Automation → Workflows → Create** with trigger *Customer Replied* (Email)
  and a single **Webhook** action (POST) pointing at the URL.

Then **send a real email from Gmail** to the sub-account's email address.

### What we're looking for

The probe prints one of two verdicts:

- **`✓ GATE PASSED`** — the inbound email carried `contactId`, `conversationId`,
  and a `messageId`. The email channel is a plain webhook handler. Days 6–7
  stand as planned.
- **Missing fields** — email likely requires a Conversation Provider. Budget an
  extra half-day and tell me; Week 2 loses its slack and we cut T9.5.

Every payload lands in `packages/agent-core/webhook-captures/`. Don't delete
them — they become the fixtures for the T6.1 parser, so we build against real
payloads instead of an invented shape.

Also worth doing while the probe is up: reply *from* the sub-account and confirm
the outbound echo arrives with `direction: "outbound"`. That's the event T6.1's
guard has to drop, and it's the one that causes infinite email loops if missed.
