import type { IndustryConfig } from "./industries/types.js";

/**
 * Words the speech recogniser will otherwise get wrong.
 *
 * Deepgram's `keyterm` parameter boosts recognition of specific terms. Without
 * it, "Halcyon" comes back as "how see on", "Fairmount" as "fair mount", and
 * "Rainey Street" as "rainy street" — and once the transcript is wrong the agent
 * is answering a question nobody asked.
 *
 * Derived from the industry config rather than hand-listed, so a new vertical
 * gets its own vocabulary for free. Proper nouns are what matter: a model
 * already knows "reservation", it does not know your restaurant's name.
 */

/** Words a general model already handles; boosting them just dilutes the list. */
const TOO_COMMON = new Set([
  "the", "and", "for", "with", "from", "your", "our", "you", "we", "a", "an",
  "room", "rooms", "table", "tables", "hotel", "night", "nights", "guest",
  "guests", "booking", "bookings", "free", "repair", "damage", "service",
  "services", "inspection", "replacement", "roof", "gutter", "gutters",
]);

function words(phrase: string): string[] {
  return phrase
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Capitalised words are the signal — they're the proper nouns. Two things this
 * has to avoid:
 *
 * - **Sentence-initial capitals.** "There's a fitness room…" would otherwise
 *   contribute "There's", and every wasted keyterm costs a little accuracy on
 *   the ones that matter. So a capitalised word only counts if it isn't opening
 *   a sentence — which is exactly the test for a real proper noun.
 * - **Contractions**, which are never names.
 */
function properNouns(phrase: string): string[] {
  const out: string[] = [];

  for (const sentence of phrase.split(/(?<=[.!?])\s+/)) {
    const ws = words(sentence);
    // Skip index 0: whatever opens a sentence is capitalised by grammar, not
    // because it's a name.
    for (const w of ws.slice(1)) {
      if (w.length <= 2) continue;
      if (!/^\p{Lu}/u.test(w)) continue;
      if (w.includes("'")) continue;
      if (TOO_COMMON.has(w.toLowerCase())) continue;
      out.push(w);
    }
  }
  return out;
}

/** For short phrases (a name, a service) every word counts, including the first. */
function allProperNouns(phrase: string): string[] {
  return words(phrase).filter(
    (w) => w.length > 2 && /^\p{Lu}/u.test(w) && !w.includes("'") && !TOO_COMMON.has(w.toLowerCase()),
  );
}

export function keytermsFor(cfg: IndustryConfig): string[] {
  const terms = new Set<string>();

  // The business name, whole and in parts. "The Fairmount" and "Fairmount" both
  // get said, and the multi-word form helps the model more than either alone.
  terms.add(cfg.business.name);
  for (const w of allProperNouns(cfg.business.name)) terms.add(w);

  // City and any street or landmark named in the blurb.
  for (const w of allProperNouns(cfg.business.city)) terms.add(w);
  for (const w of properNouns(cfg.business.blurb)) terms.add(w);

  // Service names, and the label of anything bookable ("a table at Halcyon").
  for (const s of cfg.services) for (const w of allProperNouns(s)) terms.add(w);
  for (const r of cfg.resources) for (const w of allProperNouns(r.label)) terms.add(w);

  // Grounded facts mention the things people actually ring up about — brand
  // names, certifications, room types.
  for (const f of cfg.knowledge) for (const w of properNouns(f.answer)) terms.add(w);

  // Closed-set option values are deliberately NOT included. They're ordinary
  // English ("asap", "just_researching", "within_2_weeks") that the model
  // already transcribes correctly, and the LLM maps the phrasing to the option
  // anyway. Adding them contributed "Just", "Within" and "Months" — pure
  // dilution of the names that actually get mangled.

  // Deepgram degrades with very long keyterm lists — each one costs a little
  // accuracy elsewhere. Longest first: multi-word proper nouns are the most
  // valuable and the most often mangled.
  return [...terms]
    .filter((t) => t.length > 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 40);
}
