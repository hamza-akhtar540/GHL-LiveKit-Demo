import type { ConversationStore } from "../conversation/types.js";
import type { IndustryConfig } from "../industries/types.js";
import { geminiJson } from "../llm/gemini.js";

/**
 * Generates social posts from what customers actually asked.
 *
 * This is the whole reason to build our own rather than use a generic content
 * tool: the conversation store holds every question anyone put to the agent. "Do
 * you allow dogs?" asked forty times is a post that will land, because it's a
 * real question rather than a marketer's guess at one. Nobody generating social
 * content from a keyword list has that input.
 *
 * Falls back to the grounded knowledge base when there aren't enough real
 * questions yet — a fresh account has no conversation history, and a post is
 * still better than an empty schedule.
 */

export type Platform = "facebook" | "instagram" | "linkedin";

/** Hard caps, so a post isn't silently truncated by the platform. */
const LIMITS: Record<Platform, number> = {
  // Facebook allows far more, but long posts get collapsed behind "See more"
  // and the tail is never read.
  facebook: 600,
  // Instagram's cap is 2200, but engagement falls off a cliff past a few lines.
  instagram: 400,
  // LinkedIn truncates around 200 in the feed; the rest needs a click.
  linkedin: 700,
};

export interface PostIdea {
  /** What this post is about, for our own records. */
  topic: string;
  /** How many callers asked about it. 0 when drawn from the knowledge base. */
  askedBy: number;
  /** The grounded answer, so the post can't invent a policy. */
  answer: string;
}

/**
 * Mines recurring themes from real conversations.
 *
 * Deliberately keyword-matched against the knowledge base rather than clustered
 * by an LLM: we need the post's *answer* to be a grounded fact, not a paraphrase.
 * A post that invents a pet policy is worse than no post.
 */
export async function findPostIdeas(
  cfg: IndustryConfig,
  conversations: ConversationStore,
  limit = 5,
): Promise<PostIdea[]> {
  const recent = await conversations.recent(200);

  // Everything a caller ever said, lowercased.
  const callerText = recent
    .flatMap((c) => c.messages.filter((m) => m.role === "caller").map((m) => m.text.toLowerCase()))
    .join(" \n ");

  const scored = cfg.knowledge.map((fact) => {
    // Score a fact by how often its distinctive words appear in caller speech.
    const terms = fact.topic
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3);

    const askedBy = terms.reduce(
      (n, term) => n + (callerText.split(term).length - 1),
      0,
    );

    return { topic: fact.topic, answer: fact.answer, askedBy };
  });

  const asked = scored.filter((s) => s.askedBy > 0).sort((a, b) => b.askedBy - a.askedBy);

  // Top up from the knowledge base when real demand is thin, preferring facts
  // that weren't already picked.
  const filler = scored
    .filter((s) => s.askedBy === 0)
    .filter((s) => !asked.some((a) => a.topic === s.topic));

  return [...asked, ...filler].slice(0, limit);
}

function buildPrompt(cfg: IndustryConfig, idea: PostIdea, platform: Platform): string {
  const voice: Record<Platform, string> = {
    facebook:
      "Warm and local. People scroll Facebook socially, so this should read like " +
      "the business talking to its neighbours, not an advert.",
    instagram:
      "Visual and short. Lead with the hook in the first line because the rest is " +
      "hidden behind 'more'. A few relevant hashtags at the end, not a wall.",
    linkedin:
      "Professional but not stiff. LinkedIn rewards a specific observation over a " +
      "promotion. No hashtag spam, at most two.",
  };

  return [
    `You write social posts for ${cfg.business.name}, ${cfg.business.blurb}`,
    `Located in ${cfg.business.city}.`,
    "",
    "# What this post is about",
    `Topic: ${idea.topic}`,
    `The true answer: ${idea.answer}`,
    idea.askedBy > 0
      ? `Real customers have asked about this ${idea.askedBy} time(s) — write it as ` +
        `something people genuinely want to know, because they do.`
      : "",
    "",
    `# Platform: ${platform}`,
    voice[platform],
    `Hard limit: ${LIMITS[platform]} characters. Going over means it gets cut.`,
    "",
    "# Rules",
    "- The answer above is the only factual claim you may make. Do not invent",
    "  prices, policies, dates, offers or availability. Not one detail.",
    "- No 'DM us for details' when the answer is right here. Just answer it.",
    "- No manufactured urgency, no 'Book now!!', no emoji soup.",
    "- Write like a person who works there, not a marketing department.",
    "- One clear idea. Don't cram the whole business into one post.",
    "",
    'Return ONLY strict JSON: {"text": "..."} with real line breaks as \\n.',
  ]
    .filter(Boolean)
    .join("\n");
}

function geminiGenerate(prompt: string): Promise<string> {
  // Temperature is higher than the email composer's: social copy that reads
  // templated is worse than useless.
  return geminiJson(prompt, { purpose: "generating post content", temperature: 0.9, model: process.env.SOCIAL_MODEL });
}

export interface GeneratedPost {
  topic: string;
  platform: Platform;
  text: string;
  askedBy: number;
}

export async function generatePost(
  cfg: IndustryConfig,
  idea: PostIdea,
  platform: Platform,
  generate: (prompt: string) => Promise<string> = geminiGenerate,
): Promise<GeneratedPost> {
  const raw = await generate(buildPrompt(cfg, idea, platform));

  let text: string;
  try {
    text = String((JSON.parse(raw) as { text?: string }).text ?? "").trim();
  } catch {
    // Model ignored the JSON instruction but the prose is still usable.
    text = raw.trim();
  }
  if (!text) throw new Error("generated post was empty");

  // Truncate at a sentence rather than mid-word if it overran.
  if (text.length > LIMITS[platform]) {
    const cut = text.slice(0, LIMITS[platform]);
    const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
    text = lastStop > LIMITS[platform] * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
  }

  return { topic: idea.topic, platform, text, askedBy: idea.askedBy };
}
