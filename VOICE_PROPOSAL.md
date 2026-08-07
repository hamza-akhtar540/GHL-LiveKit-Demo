# Voice Agent — What to Build Next

A proposal for the **voice channel only**. Researched July 2026, then checked
against what's actually installed here, so nothing below is aspirational unless
it says so.

---

## Where we actually stand

Measured in a real browser session today:

| | ours | the 2026 bar |
|---|---|---|
| Time to first token | ~400ms (warm) | — |
| Reply complete | ~2–3s | — |
| End-to-end voice round trip | **not yet measured** | under 800ms feels smooth; 800–1200ms is fine for business calls; past 1500ms the caller knows it's a machine |
| Median production agent, 2026 | — | 680ms p50, 1180ms p95 |

We're in decent shape on the text path. **We have never measured the voice
round trip** — mic to first audio back — and that's the only number that
matters for a phone call. First job below.

Our architecture (separate STT → LLM → TTS) is the right one. The research is
clear that cascaded pipelines still dominate production in 2026: they're
debuggable, you can swap any component, and tool-calling is more reliable.
Speech-to-speech models are faster in a straight line but cost anywhere from
$0.0017 to $0.30 a minute depending on provider, and when a call goes wrong you
can't see what the model heard. **Recommendation: stay cascaded.**

---

## Tier 1 — Ship this week, all available today

These are the highest ratio of impact to effort. I verified each one exists in
the version we already have installed.

### 1. Kill the dead air during tool calls 🔴

Right now, when the agent checks availability, the caller hears **silence**.
On a phone call, two seconds of silence reads as a dropped call. This is the
single worst thing about our voice experience today.

Two fixes, both cheap:

- **`BackgroundAudioPlayer`** — already in our installed version. It plays a
  sound while the agent is in the `thinking` state and stops automatically.
  Ships with `KEYBOARD_TYPING` and `OFFICE_AMBIENCE` clips. A front desk that
  sounds like a front desk — faint keyboard while it looks up your booking — is
  genuinely uncanny in a demo.
- **Verbal cover** — prompt it to say "let me check that for you" *before*
  calling the tool. Costs nothing, works everywhere.

### 2. Background voice cancellation

`@livekit/noise-cancellation-node` exists and drops into the session. Callers
ring from cars, kitchens, job sites. Without this, a TV in the background gets
transcribed as caller speech and derails the conversation. This is also the
fix for a specific demo failure: someone talking near the buyer's phone.

### 3. Make it sound like a person, not a press release

Prompt-only, zero infrastructure. LiveKit's own guidance is that vague
instructions ("be conversational") do nothing — you have to *show* the pattern:

> Bad: "I can definitely handle that for you."
> Better: `"Yeah, um <break time="300ms"/> so, I can do that, no problem."`

Two things that matter: every standalone "um" needs a `<break>` after it and a
recovery word ("so"), or it sounds like a glitch rather than a person thinking.
And use *calm* emotional framing as the baseline — big emotions read as fake.

### 4. Measure the round trip, then tune endpointing

We can't improve what we haven't measured. Once we have the number, the
endpointing delays (`minDelay`/`maxDelay`, currently 300/3000ms) are the main
dial between "interrupts me mid-sentence" and "awkward pause."

---

## Tier 2 — The thing that actually sells it

### 5. A real phone number 🌟

**This is the biggest single win available to us, and it isn't close.**

LiveKit Phone Numbers went GA — you can pick a local or toll-free US number
with the area code you want, and their own claim is *zero to ringing in 60
seconds*. Inbound, outbound, DTMF, and SIP transfer are all first-class.

Why this matters more than anything else on this list: right now our demo is
"open my laptop and click a bubble." With a phone number, the sales pitch
becomes:

> "Here's a number. Call it from your phone, right now, while we're talking."

The buyer uses their own phone, hears their own hold music, and watches the CRM
fill in. No web page, no explaining, no trust gap. Every competitor demo is a
screen recording; ours would be a live phone call the buyer initiates. For a
roofing contractor or a hotel GM, a phone number is the *only* format that maps
to how they already do business.

### 6. Warm transfer to a human

"Let me get someone for you" — and a real phone actually rings. LiveKit
supports both cold forwarding and agent-assisted (warm) transfers. We already
have a `handoffToHuman` tool that currently just logs; wiring it to a real
transfer turns it from a stub into the moment that closes the deal, because the
first objection any buyer raises is *"what happens when it can't handle it?"*

### 7. Post-call artefacts

After the call ends: a summary, the structured fields, the outcome, and a
recording link — written to the CRM. This is what makes it a *system* rather
than a toy, and it's what Day 8's dashboard needs anyway.

---

## Tier 3 — Worth considering, not now

- **Backchannelling** ("mm-hmm" while the caller talks). Research says it
  measurably improves perceived naturalness. LiveKit has it in development —
  I found the internals in our installed build but **it is not a public API in
  1.5.3**, and there's an open PR from June 2026. Revisit when it lands.
- **Voice cloning / a signature voice.** ElevenLabs advertises 11,000+ voices
  and sub-100ms latency. Worth it if a client wants their own receptionist's
  voice; not worth it for the generic demo.
- **Multilingual.** Only if a specific client asks. Sounds impressive, adds
  real testing burden.
- **Simulated-caller test suites** (Coval, Hamming). They run thousands of
  concurrent calls with AI personas of varied accents, speaking speed and
  patience. Genuinely how serious teams catch regressions — but this is a tool
  for when we have paying clients, not for a two-week demo build.

---

## Traps

Things that sound impressive and aren't:

- **Chasing speech-to-speech for latency.** A well-engineered cascaded pipeline
  beats many S2S models anyway, and we'd lose tool-calling reliability and
  debuggability — the two things a booking agent can least afford.
- **Believing published TTS latency numbers.** Most quote Time To First *Byte*,
  which is often just container headers — a provider can return bytes in 50ms
  while actual audio starts 200ms later. Time To First **Audio** is the honest
  metric. Cartesia (what we use) is among the fastest on TTFA.
- **Overdoing the filler words.** Done badly it's worse than a clean robotic
  voice. It needs the pause timing, not just the "um".
- **Comparing per-minute prices naively.** Most platforms are bring-your-own-key
  — the headline rate is only orchestration, with STT, LLM, TTS and telephony
  billed separately. Vapi's $0.05/min becomes $7,200–8,800/month at 40k minutes
  once components are added; Retell lands nearer $2,800 for the same volume.
  Relevant to us twice: for our own cost-per-lead number, and because we can
  quote all-inclusive pricing that undercuts them honestly.

---

## What I'd actually do

**This week, in order:**

1. Measure end-to-end voice latency. Everything else is guesswork until then.
2. Fill the tool-call silence — `BackgroundAudioPlayer` + verbal cover. Biggest
   quality jump per hour of work.
3. Add noise cancellation.
4. Rework the prompt for spoken delivery, with break timing.

**Then the one that changes the sales conversation:**

5. Get a real phone number and make the demo a live inbound call.
6. Wire `handoffToHuman` to an actual warm transfer.

Items 1–4 are perhaps a day. Item 5 is the difference between a demo people
watch and a demo people *use*, and by LiveKit's own account the setup is
minutes, not days.

---

## Sources

- [Voice AI latency: typical numbers and standards — Telnyx](https://telnyx.com/resources/low-latency-voice-ai)
- [2026 AI voice agent benchmark: latency & cost per minute — DestiLabs](https://www.destilabs.com/blog/ai-voice-agent-benchmark-2026)
- [TTS latency benchmark 2026: TTFA compared — Gradium](https://gradium.ai/content/tts-latency-benchmark-2026)
- [Cascaded voice agents vs speech-to-speech — Gradium](https://gradium.ai/content/cascaded-voice-agent-vs-speech-to-speech-2026)
- [Speech-to-speech vs cascade architecture — Deepgram](https://deepgram.com/learn/speech-to-speech-vs-cascade-voice-agent-architecture)
- [Prompting voice agents to sound more realistic — LiveKit](https://livekit.com/blog/prompting-voice-agents-to-sound-more-realistic)
- [Adaptive interruption handling — LiveKit](https://livekit.com/blog/adaptive-interruption-handling)
- [Agent speech and audio — LiveKit docs](https://docs.livekit.io/agents/multimodality/audio/)
- [Introducing LiveKit Phone Numbers — LiveKit](https://livekit.com/blog/introducing-livekit-phone-numbers-zero-to-ringing-in-60-seconds)
- [Agents telephony integration — LiveKit docs](https://docs.livekit.io/telephony/agents-integration/)
- [@livekit/noise-cancellation-node](https://www.npmjs.com/package/@livekit/noise-cancellation-node)
- [Vapi vs ElevenLabs vs Retell vs Bland: true per-minute cost 2026](https://devaland.com/blog/voice-ai-pricing-comparison-2025)
- [Voice AI agents for business: ElevenLabs vs Vapi vs Retell vs Bland](https://www.digitalapplied.com/blog/voice-ai-agents-business-elevenlabs-vapi-retell-bland)
- [Coval vs Hamming: voice AI eval compared 2026](https://www.coval.ai/blog/coval-vs-hamming)
- [Hamming: enterprise voice agent testing](https://hamming.ai/)
