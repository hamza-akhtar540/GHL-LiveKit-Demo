# GoHighLevel setup

All manual UI work, about 40 minutes. Do it in order — each step produces an id
that goes into `.env`. When you're finished, `pnpm ghl:smoke` should pass.

This is written for **The Fairmount** (the hotel demo, `INDUSTRY=hotel`). If
you're setting up the roofing demo instead, the shape is identical — one
calendar instead of two, and the field list comes from `roofing.ts`.

> **Nothing in the codebase is blocked on anything else here.** The agent
> already talks to a `BookingStore` interface, so connecting GHL is one new
> implementation of that interface — no prompt or tool changes. This setup is
> the only thing standing in the way.

---

## 1. Sub-account

Agency view → **Sub-Accounts** → **Create Sub-Account**.

- Name: `The Fairmount (Demo)`
- Address / timezone: Austin, TX — **America/Chicago**
- Set a business email — you'll send a real email to it in step 6.

Get the location id from the URL once you're inside the sub-account:

`app.gohighlevel.com/v2/location/`**`<GHL_LOCATION_ID>`**`/dashboard`

```
GHL_LOCATION_ID=...
GHL_TIMEZONE=America/Chicago
```

> Set the timezone here **and** in `.env`, and make them agree. A mismatch puts
> every booking off by hours, and you won't notice until a demo.

---

## 2. Calendars — you need two

The hotel books two different things. They can't share a calendar: different
durations, different opening hours, different staff looking at them.

**Calendars → Create Calendar**, twice. Pick **Class booking** for both.

> **Why Class booking, and not Personal booking.** Personal booking allows one
> appointment per slot. With 96 rooms that's fatal — the first guest books 3pm
> and the agent then tells everyone else 3pm is full. Class booking is the type
> that permits multiple bookings in the same slot up to a **capacity** limit.
> "One host, multiple participants" sounds like webinars, but mechanically it is
> "one resource pool, N at once", which is what a hotel and a restaurant are.
>
> Not the others: *Round robin* and *Collective* route by team member and we
> have no staff to assign; *Event calendar* carries GHL's own "key differences"
> warning and has no host association, which changes how slots resolve; *Service
> booking* would put rooms and tables in one calendar, but our config maps one
> resource to one calendar.

| | Rooms | Restaurant |
|---|---|---|
| Type | **Class booking** | **Class booking** |
| Name | `Room Check-in` | `Halcyon Table` |
| Capacity per slot | 10 | 12 |
| Duration | 60 min | 90 min |
| Availability | Every day, 15:00–22:00 | Every day, 17:00–22:00 |
| Slot interval | 60 min | 90 min |
| Timezone | America/Chicago | America/Chicago |
| Minimum notice | 2 hours | 2 hours |
| Date range | 60 days out | 30 days out |

Capacity is the number you can genuinely serve at once — check-ins you'd handle
in an hour, tables in the restaurant. It's the number the agent's availability
answers depend on, so it's worth setting honestly rather than high.

### Filling in the New calendar dialog

**"At least one team member is required."** Class booking wants a host even
though what we care about is capacity. Pick **yourself** (the sub-account user)
— the host is just the calendar's owner and does not cap how many people can
book the same slot. If the dropdown is empty, create a user first under
**Settings → My Staff → Add Employee**, then come back.

Two things to fix on that first dialog before you press Confirm:

- **Service duration defaults to 30 minutes.** Set it to **90** for Halcyon
  Table and **60** for Room Check-in.
- **Capacity, business hours and timezone are not on this dialog.** They're
  behind **Advanced settings**, bottom left. Capacity is the important one —
  skip it and you're back to one booking per slot, which is the failure this
  whole section exists to avoid.

Copy each calendar's id from its settings:

```
GHL_CALENDAR_ROOM=...
GHL_CALENDAR_TABLE=...
```

The names match the `resources[]` ids in `hotel.ts` — `room` and `table` — and
the code resolves `GHL_CALENDAR_<RESOURCE_ID>` automatically. Add a resource to
the config later and you just add the matching variable.

> Check each calendar actually shows open slots in the next few days. If it
> doesn't, the smoke test reports an empty availability map and you can't tell a
> config problem from a parsing bug.

> **Confirm capacity actually works before building on it.** Book the same slot
> twice by hand in the GHL UI. If the second booking is refused, the calendar is
> behaving as one-per-slot and we need a different type — tell me before going
> further, because every availability answer the agent gives depends on this.
> `pnpm ghl:smoke` prints the raw `free-slots` response, which is the other half
> of the check.

---

## 3. Pipeline

**Opportunities → Pipelines → Create**: `Hotel Enquiries`

Stages: `New Enquiry` → `Qualified` → `Booked` → `Stayed` → `Lost`

```
GHL_PIPELINE_ID=...
GHL_PIPELINE_STAGE_NEW=...     # the "New Enquiry" stage id
```

---

## 4. Custom fields

**Settings → Custom Fields → Create custom field**, thirteen times.

On each dialog:

| Box | Value |
|---|---|
| Field type | **Single line** (we write strings, not enums, deliberately) |
| Add to object | **Contact** |
| Folder name | Create `AI Intake` once, then reuse it for all thirteen |
| Field name | from the table below |
| Key | **auto-generated — check it before saving** |
| Description, Placeholder | leave blank |

**The Key is the part that matters.** GHL derives it from the field name, and
the agent looks fields up by exact key. Type the names below verbatim — title
case, spaces, **no hyphens** — and the key should come out right:

| Type this as Field name | Key it must produce |
|---|---|
| Check In | `check_in` |
| Nights | `nights` |
| Guests | `guests` |
| Room Type | `room_type` |
| Occasion | `occasion` |
| Party Size | `party_size` |
| Dining Date | `dining_date` |
| Seating | `seating` |
| Dietary | `dietary` |
| Event Type | `event_type` |
| Headcount | `headcount` |
| Event Date | `event_date` |
| Lead Score | `lead_score` |

Name, phone and email are **built-in** GHL contact fields — don't create custom
ones for those.

> If GHL generates a key that doesn't match — a `contact.` prefix, a trailing
> word, anything — **don't fight it**. Note what it actually produced and send
> me the list. Mapping our keys to GHL's is a few lines in the store; renaming
> thirteen fields by hand is not.

> **Short on time?** The first nine cover rooms, tables and scoring — the whole
> demo path. `event_type`, `headcount` and `event_date` only serve the event
> enquiry intent and can wait.

---

## 5. Private Integration Token

**Settings → Private Integrations → Create New Integration**

Name it `AI Intake Agent`. Enable:

- `contacts.readonly`, `contacts.write`
- `calendars.readonly`, `calendars.write`
- `calendars/events.readonly`, `calendars/events.write`
- `conversations.readonly`, `conversations.write`
- `conversations/message.readonly`, `conversations/message.write`
- `opportunities.readonly`, `opportunities.write`
- `locations/customFields.readonly`

Also enable **`locations.readonly`** — it's what lets us read the sub-account's
country and timezone, which is how a wrong setting gets caught before a demo
rather than during one.

For social posting and analytics, the Social Planner scopes are needed too —
those and the channel connections are in
**[SOCIAL_PLANNER_SETUP.md](SOCIAL_PLANNER_SETUP.md)**, since Instagram has
prerequisites that have to be sorted first.

> Scopes can be added to an existing Private Integration without regenerating the
> token. If you do regenerate, the new token must go into `.env` — the old one
> stops working immediately.

```
GHL_PIT=...
```

**The token is shown once.** Copy it now.

> We use a Private Integration Token rather than an OAuth marketplace app on
> purpose: same rate limits (100 req/10s, 200k/day per location), no redirect
> URI, no refresh flow. An OAuth app costs 2–3 days for zero demo value. Revisit
> only if we sell into multiple sub-accounts.

Then run:

```bash
pnpm ghl:smoke
```

It is **read-only** — it creates nothing. It confirms the token authenticates,
the calendar ids resolve, and prints the raw `free-slots` response so we can
check our parsing against reality instead of assumption. Send me the output;
anything marked `VERIFY` in `src/ghl/endpoints.ts` gets confirmed or corrected
from it.

---

## 6. The email gate — do this one first if you're short on time

This single step decides whether the email channel is a 2-day build or 2.5, and
it has been the longest-standing blocker on the plan.

```bash
# terminal 1
pnpm webhook:listen

# terminal 2
ngrok http 4000
```

Register the ngrok HTTPS URL + `/webhooks/ghl` in GHL:

- **Settings → Webhooks** if your plan exposes it, **or**
- **Automation → Workflows → Create**, trigger *Customer Replied* (Email), with
  a single **Webhook** action (POST) pointing at that URL.

Now **send a real email from Gmail** to the sub-account's address.

### What we're looking for

The probe prints one of two verdicts:

- **`✓ GATE PASSED`** — the payload carried `contactId`, `conversationId` and a
  `messageId`. Email is a plain webhook handler and Days 6–7 stand as planned.
- **Missing fields** — email needs a Conversation Provider. Add half a day and
  tell me; Week 2 loses its slack and we drop the WordPress test.

Every payload is saved to `packages/agent-core/webhook-captures/`. **Don't
delete them** — they become the fixtures for the inbound-email parser, so we
build against real payloads instead of an invented shape.

While the probe is running, also **reply from the sub-account** and confirm the
outbound echo arrives with `direction: "outbound"`. That's the event the email
handler must ignore, and missing it is what causes infinite email loops.

---

## Your finished `.env`

```bash
GHL_PIT=pit-...
GHL_LOCATION_ID=...
GHL_CALENDAR_ROOM=...
GHL_CALENDAR_TABLE=...
GHL_PIPELINE_ID=...
GHL_PIPELINE_STAGE_NEW=...
GHL_TIMEZONE=America/Chicago
GHL_API_VERSION=2021-07-28
```

---

## What happens after you send me the smoke output

1. I fix whatever the smoke test reports as different from expected.
2. I write `GhlBookingStore` against the existing `BookingStore` interface and
   swap it for `MemoryBookingStore` — one line in `apps/agent/src/agent.ts`.
3. Contacts, lead scoring, transcripts and human handoff get wired to the CRM.
4. Bookings made in the demo start appearing in GoHighLevel live, which is the
   thing that actually sells this.
