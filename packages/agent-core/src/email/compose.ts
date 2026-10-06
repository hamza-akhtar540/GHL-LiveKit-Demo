import type { IndustryConfig } from "../industries/types.js";
import type { Conversation } from "../conversation/types.js";
import { geminiJson } from "../llm/gemini.js";

/**
 * Turns a stored conversation into a follow-up email that sounds like the
 * person who took the call wrote it — because it's the same brain, reading the
 * same transcript.
 *
 * This is the whole reason to build our own layer instead of using GHL's
 * template merge-fields. GHL sends "Hi {{first_name}}, thanks for booking!".
 * This sends "Thanks for calling about the terrace suite for your anniversary —
 * here's the parking detail I promised." One is a mail-merge; the other read
 * the conversation.
 *
 * Deliberately NOT on the LiveKit stack. Email is async and days-apart; a
 * realtime session framework is the wrong shape, so this calls the LLM provider
 * directly over HTTP. Same reasoning the README gives for the email channel.
 */

export type Trigger =
  | "new_lead" // came in from a form or ad, never spoken to anyone
  | "thank_you" // booked — confirm warmly, set expectations
  | "abandoned_1h" // left mid-conversation an hour ago
  | "abandoned_24h" // still nothing, a day later
  | "abandoned_3d" // last touch, three days on
  | "no_show" // booked but didn't turn up
  | "reply"; // a genuine inbound reply to answer

export interface ComposedEmail {
  subject: string;
  body: string;
}

const TRIGGER_INTENT: Record<Trigger, string> = {
  new_lead:
    "They have just come in from a form or an ad and have NOT spoken to anyone here " +
    "yet. Acknowledge specifically what they asked about, answer it if you safely " +
    "can from what's here, and give one easy way forward. Do not imply you've " +
    "spoken before, and don't thank them for 'getting in touch again'.",
  thank_you:
    "They just booked. Confirm it warmly in your own words, restate the key detail " +
    "(what, when), and say what happens next. Short. Don't upsell.",
  abandoned_1h:
    "They were talking to us and dropped off about an hour ago without booking. " +
    "Nudge gently — pick up the specific thread they left, make it easy to continue. " +
    "One light question, not a pitch.",
  abandoned_24h:
    "A day since they went quiet. Warmer and briefer than the first nudge. Give them " +
    "one easy way forward — a direct question, or an offer to check availability. " +
    "Assume they're busy.",
  abandoned_3d:
    "Three days. This is the last follow-up — say so implicitly by leaving the door " +
    "open rather than chasing. No guilt, no pressure. One line they can reply to.",
  no_show:
    "They booked but didn't show. No scolding. Assume life happened, make rebooking " +
    "effortless, keep it light.",
  reply:
    "They replied. Answer what they actually said, using the conversation so far. " +
    "If it needs a booking or a real availability check, say you're on it.",
};

/** The transcript, compact, so the model writes from what was actually said. */
function renderTranscript(convo: Conversation): string {
  if (!convo.messages.length) return "(no prior messages)";
  return convo.messages
    .map((m) => `${m.role === "caller" ? "Them" : "Us"}: ${m.text}`)
    .join("\n");
}

function buildPrompt(cfg: IndustryConfig, convo: Conversation, trigger: Trigger): string {
  const known = Object.entries(convo.contact)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  return [
    `You write follow-up emails for ${cfg.business.name}, ${cfg.business.blurb}`,
    `Phone: ${cfg.business.phone}.`,
    "",
    "# This email",
    TRIGGER_INTENT[trigger],
    "",
    "# The conversation so far",
    renderTranscript(convo),
    "",
    known ? `# What we know about them\n${known}` : "",
    convo.bookingCode ? `# Booking reference\n${convo.bookingCode}` : "",
    "",
    "# How to write it",
    "- Sound like the person who took the call, not a marketing department.",
    "- Reference something specific they actually said. That's the whole point.",
    "- Two short paragraphs at most. A real person is busy.",
    "- No subject-line clickbait, no emoji, no 'I hope this email finds you well'.",
    "- Use their name if we have it. Sign off as the business, warmly.",
    "",
    "# The one hard rule",
    "You are writing an email, not taking a booking. You have NO calendar access",
    "here and no idea what is free.",
    "- Never name a specific time or date as available. Not \"2pm or 4:30pm\", not",
    "  \"we have Thursday free\". You would be guessing, and a guess that turns out",
    "  wrong costs the business the customer.",
    "- Offer to CHECK availability instead. \"Want me to see what's open?\" is always",
    "  safe; \"we have 8pm\" is not.",
    "- The only times, dates, prices or promises you may repeat are ones already",
    "  stated in the conversation above. Nothing new.",
    "",
    "Return ONLY strict JSON: {\"subject\": \"...\", \"body\": \"...\"}. Body is plain",
    "text with real line breaks (\\n), not HTML.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Calls Gemini over REST. Kept as a thin function rather than a class so the
 * caller can swap providers by passing a different `generate`. Model and key
 * come from env, same as the worker's fallback path.
 */
function geminiGenerate(prompt: string): Promise<string> {
  return geminiJson(prompt, { purpose: "composing email", temperature: 0.7, model: process.env.EMAIL_MODEL });
}

export async function composeEmail(
  cfg: IndustryConfig,
  convo: Conversation,
  trigger: Trigger,
  generate: (prompt: string) => Promise<string> = geminiGenerate,
): Promise<ComposedEmail> {
  const raw = await generate(buildPrompt(cfg, convo, trigger));

  let parsed: ComposedEmail;
  try {
    parsed = JSON.parse(raw) as ComposedEmail;
  } catch {
    // A model that ignored the JSON instruction still produced usable prose —
    // salvage it rather than failing the send outright.
    parsed = { subject: `Following up — ${cfg.business.name}`, body: raw.trim() };
  }
  if (!parsed.subject?.trim() || !parsed.body?.trim()) {
    throw new Error("Composed email missing subject or body");
  }
  return parsed;
}
