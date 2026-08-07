# Sending-domain setup

Follow-up email is built and works — compose, contact, send, and CRM threading
all succeeded on the first attempt. The only thing missing is a sending identity
Gmail will accept.

## What went wrong, so the fix makes sense

We sent a real follow-up. GHL reported `status: "delivered"`. It never arrived —
not the inbox, not spam, nothing. The message record shows why:

```
from     = Qbatch <hamza.akhtar+qbatch.com@mail.msgsndrroute.com>
provider = mailgun
status   = delivered
```

`mail.msgsndrroute.com` is GoHighLevel's **shared fallback domain**, used when a
sub-account has no dedicated one. Thousands of GHL accounts send from it, so its
reputation isn't ours, and Gmail drops it at the gateway.

Also worth internalising: **"delivered" from Mailgun means the receiving server
accepted the handoff.** It says nothing about whether a human ever saw it. Never
report a provider's `delivered` as proof an email landed.

---

## Use a subdomain, not your main domain

Send from `mail.qbatch.com` or `send.qbatch.com` — **not** `qbatch.com`.

This matters more than it looks. Email reputation attaches to the sending
domain. If early follow-ups draw spam complaints on your root domain, your
ordinary company email starts landing in spam too, and recovery takes weeks.
A subdomain keeps that risk contained.

If you'd rather not touch the company domain at all, a cheap dedicated demo
domain (`thefairmount-demo.com`) is the safer choice and is what I'd pick for
a demo that will send to strangers.

---

## Steps

### 1. Add the domain in GHL

Sub-account → **Settings → Email Services → Add Domain**.

Enter your subdomain (`mail.yourdomain.com`). GHL generates DNS records unique
to your account — an SPF entry, a DKIM key, and usually a tracking CNAME.

### 2. Add the DNS records

Wherever the domain's DNS lives (Cloudflare, Namecheap, GoDaddy…), add exactly
what GHL gave you. Typically:

| Type | Host | Purpose |
|---|---|---|
| TXT | `mail` | SPF — authorises Mailgun to send as you |
| TXT | `smtp._domainkey.mail` | DKIM — signs each message |
| CNAME | `email.mail` | click/open tracking |

Copy the values verbatim. A single stray character makes verification fail with
no useful error.

### 3. Add DMARC — do not skip this

GHL doesn't always generate it, and Gmail has required it since Feb 2024.

| Type | Host | Value |
|---|---|---|
| TXT | `_dmarc.mail` | `v=DMARC1; p=none; rua=mailto:you@yourdomain.com` |

Start at `p=none` — it monitors and reports without rejecting anything while
you confirm SPF and DKIM are aligned. Tighten to `p=quarantine` later, once
reports are clean. Going straight to `p=reject` on day one is how people
accidentally block their own mail.

### 4. Verify

Back in GHL, hit **Verify**. DNS propagation is usually minutes but can take a
few hours. All records must show green — a partial pass still leaves you
filtered.

### 5. Tell me when it's verified

I'll re-run the send. The code doesn't change at all — the `from` address stops
being `msgsndrroute.com` and starts being yours, which is the entire fix.

---

## Then: warm it up

A brand-new sending domain that suddenly emails hundreds of people looks exactly
like a spammer. For the demo it barely matters — a handful of sends a day is
fine. Before real client volume:

- Start at ~10–20 emails/day, roughly double weekly
- Keep spam complaints under **0.3%** and bounces under **2%** — these are
  enforced thresholds now, not guidelines
- Watch [Google Postmaster Tools](https://postmaster.google.com) for the domain

---

## Sources

- [GoHighLevel dedicated email domain setup](https://mailflowauthority.com/gohighlevel-email/gohighlevel-dedicated-email-domain)
- [GoHighLevel email authentication: SPF, DKIM, DMARC](https://mailflowauthority.com/gohighlevel-email/gohighlevel-email-authentication)
- [Email authentication — DMARC (HighLevel)](https://help.gohighlevel.com/support/solutions/articles/48001224630-email-authentication-dmarc)
- [Fix SPF, DKIM and DMARC errors (HighLevel)](https://help.gohighlevel.com/support/solutions/articles/155000006793-email-authentication-errors-fix-spf-dkim-and-dmarc-issues)
- [GoHighLevel email deliverability setup guide 2026](https://www.thestackinsiders.com/blog/gohighlevel-email-deliverability)
