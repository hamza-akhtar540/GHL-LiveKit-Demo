# AI Lead Intake & Booking

Conversational AI (voice, in-app chat, email) that qualifies inbound leads,
creates the contact in GoHighLevel, checks real calendar availability, and books
an appointment — in one conversation, across three channels.

## Architecture

The brain is separate from the transport. `agent-core` holds the system prompt,
the qualification state machine, and the six GHL tools. Each channel is a thin
adapter over it.

```
apps/web      Next.js — demo site, embeddable widget, LiveKit token mint,
              GHL webhook receiver, outbound-sequence cron
apps/agent    LiveKit worker (long-lived; cannot run on serverless) —
              voice pipeline + text mode over the lk.chat topic
packages/
  agent-core  system prompt, qualification, 6 GHL tools, Claude tool loop,
              industry configs
  db          Drizzle schema — conversations, messages, sequence steps
```

Voice and in-app text share one LiveKit session, so "Talk to us" mid-chat keeps
full context instead of restarting qualification. Email runs the same
`agent-core` over a webhook, since a realtime session framework is the wrong
shape for async, days-apart correspondence.

## Setup

```bash
pnpm install
cp .env.example .env      # then fill in the values
pnpm ghl:smoke            # verify credentials + endpoint shapes (read-only)
pnpm webhook:listen       # day-1 inbound-email gate
```

## Status

- [x] **T1.1** monorepo scaffold
- [x] **T1.3** GHL client (auth, retry/backoff, typed errors) + smoke test
- [x] **T1.4** webhook probe + capture harness



