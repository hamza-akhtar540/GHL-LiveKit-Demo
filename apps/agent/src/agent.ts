import {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  log,
  tool,
} from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import { BackgroundVoiceCancellation } from "@livekit/noise-cancellation-node";
import { RoomEvent, TrackKind } from "@livekit/rtc-node";
import {
  BookingIndex,
  ConversationRecorder,
  CrmSync,
  FallbackConversationStore,
  FileConversationStore,
  GhlBookingStore,
  GhlClient,
  LeadFollowUp,
  LeadIngestor,
  MemoryBookingStore,
  PgConversationStore,
  PgLeadStore,
  buildInstructions,
  createTools,
  getIndustry,
  keytermsFor,
  scoreLead,
  scoreWithBooking,
  slug,
  todayIn,
} from "@ghl-lk/agent-core";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Env lives at the repo root, not in this package.
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

/**
 * Speech always goes through LiveKit Inference — no extra credentials, and the
 * STT/TTS providers there are the ones we'd pick anyway.
 */
const STT_MODEL = process.env.LK_STT_MODEL ?? "deepgram/nova-3";
/**
 * Accent handling. Plain "en" is tuned for American English; a caller with an
 * Indian, British or Australian accent gets measurably worse results from it.
 * nova-3 accepts regional variants (en-IN, en-GB, en-AU) and "multi", which
 * detects the language per segment of speech. Set LK_STT_LANGUAGE to match the
 * callers a given client actually gets.
 */
const STT_LANGUAGE = process.env.LK_STT_LANGUAGE ?? "en";
const TTS_MODEL = process.env.LK_TTS_MODEL ?? "cartesia/sonic-3";

/**
 * The brain is swappable because the choice isn't settled yet.
 *
 * - `livekit` routes through LiveKit Cloud (no extra key, draws LiveKit credit).
 *   Its catalogue is OpenAI / Gemini / DeepSeek / Grok — no Anthropic.
 * - `google` calls Gemini directly with our own key, so the spend is visible
 *   and separable from LiveKit credit.
 *
 * Whatever we ship on, the prompt should be tuned on that same model — prompt
 * behaviour doesn't transfer cleanly between them, and day 3 is where the
 * qualification prompt gets its shape.
 */
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? "livekit";
const LK_LLM_MODEL = process.env.LK_LLM_MODEL ?? "google/gemini-3.1-flash-lite";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

function buildLLM() {
  if (LLM_PROVIDER === "google") {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("LLM_PROVIDER=google but GOOGLE_API_KEY is not set in .env");
    return new google.LLM({ model: GEMINI_MODEL, apiKey });
  }
  return new inference.LLM({ model: LK_LLM_MODEL });
}

/** Which business the agent is answering for. `INDUSTRY=hotel pnpm dev`. */
const cfg = getIndustry(process.env.INDUSTRY ?? "roofing");

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log();

    /**
     * Real bookings when GHL is configured, in-memory otherwise.
     *
     * The fallback isn't laziness — it keeps the conversation testable without
     * credentials, and stops a missing env var from turning into a dead agent
     * mid-demo. Which one is live gets logged at session start, because "did
     * that booking actually reach the CRM" must never be a guess.
     */
    // The index is what makes "look up / move / cancel my booking" possible —
    // GHL can't find an appointment by the reference we read aloud, so we keep
    // our own map. Without a database the agent can still book, it just can't
    // talk about a booking afterwards.
    const bookingIndex = process.env.DATABASE_URL ? new BookingIndex() : undefined;

    const store = process.env.GHL_PIT
      ? new GhlBookingStore(cfg.resources, new GhlClient(), bookingIndex, cfg.id)
      : new MemoryBookingStore(cfg.resources);

    // Flipped when the caller publishes a microphone. Read by the metrics
    // handler, so it has to exist before the session starts.
    let spokenMode = false;

    /**
     * Transcripts go to Postgres when DATABASE_URL is set, otherwise to files.
     * Either way the conversation survives the session, which is what lets a
     * follow-up email reference what was actually said instead of a template.
     *
     * Keyed by room name: the same visitor switching chat → voice stays in one
     * room, so the transcript stays one conversation across both.
     */
    const transcriptDir = resolve(fileURLToPath(import.meta.url), "../../transcripts");
    const conversations = process.env.DATABASE_URL
      ? // Postgres, but never at the cost of losing a transcript. If the database
        // is unreachable the turns land on disk instead — a lead we can still
        // follow up beats a clean failure. Learned the hard way: Docker stopped
        // mid-session and seven turns of a real conversation went nowhere.
        new FallbackConversationStore(
          new PgConversationStore(),
          new FileConversationStore(transcriptDir),
          (err: unknown) => logger.warn({ err }, "database unreachable — transcript written to disk"),
        )
      : new FileConversationStore(transcriptDir);

    // Named so the CRM sync can read the same conversation back.
    const recorderId = ctx.job.room?.name ?? `room-${Date.now()}`;

    const recorder = new ConversationRecorder(
      conversations,
      recorderId,
      { industry: cfg.id, channel: "chat" },
      (err: unknown) => logger.warn({ err }, "transcript write failed"),
    );

    /**
     * The CRM side of the demo: a booking should also produce a scored,
     * tagged contact with the transcript attached, so a buyer watching the
     * pipeline sees it fill in while the conversation is still going.
     *
     * All of it is best-effort and fired without awaiting — a slow CRM write
     * must never add latency to a live reply.
     */
    const crm = process.env.GHL_PIT
      ? new CrmSync(new GhlClient(), (err: unknown, op: string) => logger.warn({ err, op }, "crm write failed"))
      : undefined;

    /**
     * The lead pipeline, so a conversation that collected contact details but
     * did not book still lands in the CRM. Shares this worker's stores rather
     * than opening its own, and is only built when there is a CRM to write to.
     */
    const leadStore = crm && process.env.DATABASE_URL ? new PgLeadStore() : undefined;

    const leadIngestor = leadStore && crm
      ? new LeadIngestor({
          store: leadStore,
          crm,
          conversations,
          cfg,
          onLog: (msg: string, data?: Record<string, unknown>) => logger.info(data ?? {}, msg),
        })
      : undefined;

    /**
     * The follow-up email, on the same terms as a web-form lead.
     *
     * Without this a conversation would get a contact, tags and a score but no
     * message — the webhook path sends one and this path did not, which is the
     * kind of inconsistency nobody notices until a customer does. Whether it
     * actually SENDS is `LEAD_AUTOSEND`'s call, not this file's.
     */
    const leadFollowUp = leadStore
      ? new LeadFollowUp({
          store: leadStore,
          conversations,
          cfg,
          onLog: (msg: string, data?: Record<string, unknown>) => logger.info(data ?? {}, msg),
        })
      : undefined;

    async function syncBookedLead(contact: Record<string, string>, code: string): Promise<void> {
      const contactId = contact.contactId;
      if (!crm || !contactId) return;

      /**
       * Link the conversation to the contact.
       *
       * Without this the transcript is orphaned: Contact 360 joins on
       * `contact_id`, so a guest who booked would have their appointment on
       * their page but not the conversation that produced it. Six existing
       * booked conversations are in exactly that state.
       */
      recorder.patch({ contactId });

      // A booking outranks whatever the qualification rules said — see
      // scoreWithBooking. `facts` carries the answers the rules are written over.
      const { score, reason } = scoreWithBooking(cfg, contact, true);
      await crm.writeScore(contactId, score, reason);
      await crm.addTags(contactId, [`booked-${cfg.id}`]);
      await crm.createOpportunity({
        contactId,
        name: `${contact.full_name ?? "Guest"} — ${cfg.business.name} (${code})`,
        score,
        // They booked, so the deal belongs in Booked — not sitting in New
        // Enquiry where a human would chase someone who's already confirmed.
        outcome: "booked",
      });

      const convo = await conversations.get(recorderId);
      if (convo) await crm.saveTranscript(contactId, convo.messages);
      logger.info({ contactId, score }, "crm updated for booking");
    }

    /**
     * A group or event enquiry — usually worth more than a single booking, and
     * previously the worst-served path: the agent would say "I've flagged this
     * for our team" having flagged nothing at all.
     *
     * Creates a real opportunity with every detail collected, so whoever picks
     * it up doesn't have to make the caller repeat themselves.
     */
    async function syncEnquiry(info: {
      kind: string;
      summary: string;
      details: Record<string, string>;
      contact: Record<string, string>;
    }): Promise<void> {
      if (!crm) return;

      // The caller may never have been through a booking, so there may be no
      // contact yet. Create one — an enquiry we can't reply to is not a lead.
      const contactId =
        info.contact.contactId ??
        (await crm.upsertContact({
          fullName: info.contact.full_name,
          email: info.contact.email,
          phone: info.contact.phone,
        }));
      if (!contactId) {
        logger.error({ kind: info.kind }, "enquiry logged but no CRM contact — lead at risk");
        return;
      }

      // Same reason as the booking path: otherwise the transcript never shows up
      // on the contact it belongs to.
      recorder.patch({ contactId });

      const { score, reason } = scoreLead(cfg, { ...info.details, intent: "group_enquiry" });
      await crm.writeScore(contactId, score, reason);
      await crm.addTags(contactId, ["group-enquiry", `enquiry-${slug(info.kind)}`, "needs-quote"]);

      // Details as a note, because the account has no custom fields — and a note
      // is what a human actually reads.
      await crm.addNote(
        contactId,
        [
          `GROUP / EVENT ENQUIRY — ${info.kind.toUpperCase()}`,
          "",
          info.summary,
          "",
          ...Object.entries(info.details)
            .filter(([, v]) => v?.trim())
            .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`),
          "",
          `Contact: ${info.contact.full_name ?? "unknown"} · ${info.contact.phone ?? "no phone"} · ${info.contact.email ?? "no email"}`,
          "",
          "Needs a human to quote. The agent has told them someone will be in touch.",
        ].join("\n"),
      );

      // "Qualified" rather than "New Enquiry": they've given real dates and
      // numbers, so this is further along than a cold enquiry and should sit
      // where someone will actually work it.
      await crm.createOpportunity({
        contactId,
        name: `${info.contact.full_name ?? "Group"} — ${info.kind} (${info.details.arrival_date ?? "date TBC"})`,
        score,
        outcome: "qualified",
      });

      const convo = await conversations.get(recorderId);
      if (convo) await crm.saveTranscript(contactId, convo.messages);
      recorder.patch({ contactId, contact: info.contact, outcome: "handed_off" });
      logger.info({ contactId, kind: info.kind, score }, "group enquiry recorded as opportunity");
    }

    async function syncHandoff(reason: string, summary: string): Promise<void> {
      const convo = await conversations.get(recorderId);
      const contactId = convo?.contact.contactId;
      if (!crm || !contactId) {
        // Anonymous visitor — no contact to flag. Say so rather than failing
        // silently, because a handoff nobody sees is worse than no handoff.
        logger.warn({ reason }, "handoff requested but no CRM contact yet");
        return;
      }
      await crm.flagForHuman(contactId, reason, summary);
      if (convo) await crm.saveTranscript(contactId, convo.messages);
      logger.info({ contactId }, "contact flagged for human callback");
    }

    const promptFor = (channel: "text" | "voice") =>
      buildInstructions(cfg, {
        today: todayIn(cfg.business.timezone),
        canBook: true,
        channel,
      });

    const agent = Agent.create({
      // Starts in text mode. Spoken-delivery rules ("say forty-two dollars, not
      // $42") are swapped in below, the moment a microphone actually appears.
      instructions: promptFor("text"),
      // agent-core defines the tools transport-agnostically so the email channel
      // can call `execute` directly; this maps them onto LiveKit's wrapper.
      tools: createTools(cfg, store, {
        // What the caller told us, captured at the moment it becomes real. A
        // follow-up email needs to know whether they actually booked and what
        // name to use — neither is reliably recoverable from the transcript.
        onBooked: ({ code, contact }) => {
          recorder.patch({ bookingCode: code, contact, outcome: "booked" });
          logger.info({ code }, "booking recorded on conversation");
          void syncBookedLead(contact, code);
        },
        onEnquiry: (info) => {
          void syncEnquiry(info);
        },
        onHandoff: ({ reason, summary }) => {
          recorder.patch({ outcome: "handed_off" });
          logger.info({ reason }, "handed off to a human");
          void syncHandoff(reason, summary);
        },
      }).map((t) =>
        tool({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          execute: async (args: unknown) => t.execute(args),
        }),
      ),
    });

    const session = new AgentSession({
      /**
       * Hearing accuracy. Three separate problems, three settings.
       *
       * `keyterm` — boosts our proper nouns. Without it "Halcyon" comes back as
       * "how see on" and "Rainey" as "rainy", and the agent then answers a
       * question nobody asked. Derived from the industry config, so a new
       * vertical gets its own vocabulary automatically.
       *
       * `numerals` — converts spoken numbers to digits. This is the phone-number
       * fix: "five one two five five five" arrives as 512555 instead of words.
       *
       * `smart_format` — formats numbers, dates and currency properly, which
       * matters for dates said aloud ("the twenty sixth").
       *
       * `filler_words: false` — drops "um" and "uh" from the transcript. The
       * caller's hesitation is not part of what they asked for.
       */
      stt: new inference.STT({
        model: STT_MODEL,
        language: STT_LANGUAGE,
        modelOptions: {
          keyterm: keytermsFor(cfg),
          numerals: true,
          smart_format: true,
          filler_words: false,
          /**
           * The fragmented-phone-number fix, and the most important setting here.
           *
           * Deepgram's default is 25ms of silence to end a turn. Someone reading
           * "zero three two one" pauses roughly 200ms between digits, so at the
           * default each digit arrives as its own separate turn — which is how a
           * dictated number became four fragments that then got stitched into a
           * number the caller never said.
           *
           * 300ms holds a digit group together. It is additive with the session's
           * endpointing.minDelay, so this plus 500 is the real wait; both are
           * deliberately modest so the total stays under a second.
           */
          endpointing: 300,
          /**
           * Off by default this returns results without waiting for surrounding
           * audio — faster, but it guesses on ambiguous sounds, and digits and
           * names are exactly where guessing hurts.
           */
          no_delay: false,
        },
      }),
      llm: buildLLM(),
      tts: new inference.TTS({ model: TTS_MODEL, voice: cfg.persona.voice }),
      // The agent talks; it doesn't write. Markdown leaking into TTS is the
      // fastest way to make a demo sound synthetic.
      ttsTextTransforms: ["filter_markdown", "filter_emoji"],
      // Word-level timing from Cartesia, so the caption tracks the voice
      // properly rather than being paced by a guess.
      useTtsAlignedTranscript: true,
      /**
       * Tuned against a real call that went badly. Symptoms were: single
       * utterances arriving as three fragments ("Would like" / "make a booking"),
       * the agent's own sentences interleaved with stray caller words, and a
       * phone number dictated in pieces then stitched into a wrong number.
       *
       * All milliseconds. LiveKit's own troubleshooting matrix maps
       * "agent cuts users off mid-thought" to endpointing.minDelay and
       * "interrupted by short acknowledgments" to interruption.minWords.
       */
      turnHandling: {
        interruption: {
          mode: "adaptive",
          /**
           * The important one. Default is 0, so ONE word — "No", "Yeah", or a
           * misheard fragment — cuts the agent off mid-sentence. That's what
           * shredded the last call. Requiring a couple of words means a genuine
           * interruption still lands but a grunt or a bit of noise doesn't.
           */
          minWords: 2,
          /** Raised from the 500 default: brief noise shouldn't count as speech. */
          minDuration: 700,
          // If we do get cut off by nothing, pick the sentence back up.
          resumeFalseInterruption: true,
          falseInterruptionTimeout: 2000,
        },
        endpointing: {
          /**
           * Fixed rather than dynamic. Dynamic adapts to the caller's average
           * pause, which is the wrong instinct for dictated details: someone
           * reading out a phone number pauses far longer between digit groups
           * than in normal speech, and an average pulls the threshold below
           * what those pauses need.
           */
          mode: "fixed",
          /** The default. We were running 300, which is why turns were cut short. */
          minDelay: 500,
          maxDelay: 4000,
        },
        // Starts inference while the caller is still talking. This is most of
        // the answer to "why does it pause before every reply".
        preemptiveGeneration: { enabled: true },
      },
    });

    session.on(AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      logger.info({ transcript: ev.transcript, final: ev.isFinal }, "user");
    });

    /**
     * Record every completed turn. Deliberately ConversationItemAdded rather
     * than UserInputTranscribed: the latter also fires for interim speech
     * guesses, which would fill the transcript with half-sentences. This fires
     * once per settled turn, for both sides.
     */
    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== "message") return;

      // Content is an array of parts, and non-text parts (audio) appear here too.
      const text = item.content
        .filter((part): part is string => typeof part === "string")
        .join(" ");
      if (!text.trim()) return;

      recorder.record(
        item.role === "assistant" ? "agent" : "caller",
        text,
        new Date(ev.createdAt).toISOString(),
      );
    });

    // A provider outage or a rate limit must not end the call silently. Without
    // this the failure surfaces as an unhandled rejection, the job dies, and the
    // caller is left listening to nothing — the worst possible failure in a demo.
    session.on(AgentSessionEventTypes.Error, (ev) => {
      logger.error({ err: ev.error }, "session error");
      if (ev.error?.recoverable === false) {
        session.say(
          `Sorry — I'm having trouble on my end. Give us a call on ${cfg.business.phone} and someone will pick up.`,
        );
      }
    });

    /**
     * The number we were missing: how long a caller waits between finishing
     * their sentence and hearing the first syllable back.
     *
     * It is a sum, not a single measurement — end-of-turn detection, then the
     * model's first token, then the first audio out of TTS. Logging the parts
     * is what makes it fixable; a single total only tells you it's bad. The
     * 2026 bar is under 800ms to feel smooth and 1500ms before a caller can
     * tell they're talking to a machine.
     */
    // These arrive already in milliseconds — don't scale them.
    let eouMs = 0;
    let llmTtftMs = 0;

    session.on(AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics;

      if (m.type === "eou_metrics") {
        eouMs = Math.round(m.endOfUtteranceDelayMs);
        return;
      }
      if (m.type === "llm_metrics") {
        llmTtftMs = Math.round(m.ttftMs);
        return;
      }
      if (m.type !== "tts_metrics") return;

      const ttsTtfbMs = Math.round(m.ttfbMs);

      // End-of-utterance detection only runs on speech, so a typed message has
      // no EOU leg. Reporting a chat reply against the spoken-turnaround budget
      // would flatter the number — keep them apart.
      if (!spokenMode || eouMs === 0) {
        logger.info({ llmTtftMs, ttsTtfbMs }, "chat reply");
        return;
      }

      const totalMs = eouMs + llmTtftMs + ttsTtfbMs;
      logger.info(
        { eouMs, llmTtftMs, ttsTtfbMs, totalMs },
        totalMs <= 800
          ? "turnaround: good"
          : totalMs <= 1500
            ? "turnaround: acceptable"
            : "turnaround: SLOW — the caller can hear the wait",
      );
      eouMs = 0;
    });

    ctx.addShutdownCallback(async () => {
      logger.info({ usage: session.usage }, "session usage");
      // Drains queued transcript writes and sets an outcome if nothing did.
      // A conversation left with no outcome is one the follow-up sequence will
      // never pick up, so this is what makes an abandoned chat followable.
      await recorder.finish();

      /**
       * Feed the conversation into the lead pipeline.
       *
       * Without this, a chat or call that collected an email but did not end in
       * a booking produces a transcript in our database and NOTHING in the CRM —
       * no contact, no tags, no score, no follow-up. It also leaves the
       * conversation row with no `contactId`, so it never appears on that
       * person's page in the console: 20 of 26 existing conversations are in
       * exactly that state.
       *
       * Deliberately after `recorder.finish()`, so the outcome is already set
       * and the transcript is fully drained before anything reads it.
       *
       * Booked conversations are skipped: `syncBookedLead` has already created
       * the contact, score, tags and opportunity, and re-running that here would
       * add a second first-touch on top.
       */
      await ingestConversation().catch((err) => logger.warn({ err }, "conversation ingestion failed"));
    });

    /**
     * Turn a finished conversation into a lead, when there is something to
     * contact the person with.
     */
    async function ingestConversation(): Promise<void> {
      if (!leadIngestor) return;

      const convo = await conversations.get(recorderId);
      if (!convo) return;

      // Already handled by the booking path — see the note above.
      if (convo.outcome === "booked" || convo.bookingCode) return;

      const email = convo.contact.email?.trim();
      const phone = convo.contact.phone?.trim();
      if (!email && !phone) {
        // Nothing to reach them on. A transcript with no contact details is not
        // a lead, and forcing one into the CRM would create an unreachable
        // contact that clutters the pipeline.
        logger.info({ id: recorderId }, "not ingesting — no email or phone collected");
        return;
      }

      const result = await leadIngestor.ingest({
        source: convo.channel === "voice" ? "voice" : "chat",
        // The conversation id, so a redelivery of the same session is caught by
        // the ingestor's own idempotency barrier rather than creating a second
        // contact.
        externalId: recorderId,
        fullName: convo.contact.full_name,
        email,
        phone,
        message: convo.messages.find((m) => m.role === "caller")?.text,
        fields: convo.contact,
        capturedAt: convo.createdAt,
        attribution: {},
      });

      logger.info(
        { id: recorderId, status: result.status, contactId: result.contactId },
        "conversation ingested as a lead",
      );

      // Same treatment a web-form lead gets. `duplicate` means this session was
      // already ingested, so re-sending would be a second first-touch.
      if (leadFollowUp && result.status !== "duplicate" && result.status !== "rejected") {
        const sent = await leadFollowUp.send({
          leadId: result.leadId,
          contactId: result.contactId,
          conversationId: result.conversationId ?? recorderId,
          recipient: email,
        });
        logger.info({ id: recorderId, status: sent.status, reason: sent.reason }, "follow-up");
      }
    }

    // Voice and text share this one session. That is the whole trick behind
    // "Talk to us" mid-chat keeping context: same session, second modality,
    // no re-qualification. Both input modes are on by default.
    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        // Callers ring from cars, kitchens and job sites. Without this, a TV in
        // the background gets transcribed as caller speech and derails the
        // conversation. Use the telephony variant once we're on real phone
        // lines — it's tuned for the narrower codec band.
        noiseCancellation: BackgroundVoiceCancellation(),
      },
      outputOptions: {
        /**
         * Pace the caption to the audio, so the text appears as the agent says
         * it rather than a full reply landing seconds before you hear a word.
         *
         * This was previously false, which fixed a real problem in the wrong
         * place: with sync on and audio muted, a chat reply took 14 seconds to
         * appear because it was being paced to speech nobody was listening to.
         * Turning it off made chat fast and voice wrong.
         *
         * It only applies when there is audio output, and chat mode mutes the
         * sink immediately after start — so leaving it on should give voice
         * proper sync while chat stays fast. That interaction is worth
         * re-measuring after any change to how audio is gated.
         */
        syncTranscription: true,
      },
    });

    logger.info(
      {
        industry: cfg.id,
        store: store.kind,
        tools: 5,
        brain: LLM_PROVIDER === "google" ? `google:${GEMINI_MODEL}` : `livekit:${LK_LLM_MODEL}`,
      },
      store.kind === "memory"
        ? "bookings are IN-MEMORY — real conversation, nothing reaches a CRM"
        : "bookings are LIVE — this writes real contacts and appointments to GoHighLevel",
    );

    /**
     * Chat and voice share this session, so the prompt starts in text mode and
     * upgrades when a microphone shows up. This is the "Talk to us" handoff seen
     * from the agent's side: same session, same history, delivery rules swapped.
     */
    ctx.room.on(RoomEvent.TrackPublished, (publication, participant) => {
      if (spokenMode || publication.kind !== TrackKind.KIND_AUDIO) return;
      spokenMode = true;
      logger.info({ participant: participant.identity }, "caller went to voice — speaking back");

      // Both sides are on mic now, so the agent may speak.
      session.output.setAudioEnabled(true);

      agent.updateInstructions(promptFor("voice")).catch((err) => {
        // Non-fatal: the conversation continues with the text-mode prompt.
        logger.warn({ err }, "could not switch to the spoken prompt");
      });
    });

    /**
     * Text visitors get text — a chat widget that starts talking at you
     * unprompted is startling, and synthesising speech nobody hears costs money
     * and adds TTS to every reply.
     *
     * Silenced HERE rather than via `audioEnabled: false` on `session.start`.
     * That option stops the audio track being published at all, and switching
     * it back on later does not publish one — the caller then hears everything
     * except the agent. Starting enabled publishes the track; muting the sink
     * afterwards leaves something to un-mute when the mic arrives.
     */
    session.output.setAudioEnabled(false);

    session.say(`Thanks for calling ${cfg.business.name}. How can I help?`);
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
