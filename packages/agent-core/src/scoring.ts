import type { IndustryConfig } from "./industries/types.js";

/**
 * Turns the `scoring` rules that have sat unread in every industry config into
 * an actual hot/warm/cold verdict.
 *
 * The rules are deliberately strings (`"urgency=active_leak"`, `"nights>=3"`)
 * rather than functions, so a new vertical stays a config file rather than
 * needing code. This is the one place that understands them.
 *
 * Evaluated hot-first: a caller with an active leak who is "just researching"
 * is still a hot lead. Anything matching neither list is warm — the honest
 * default, since most callers are neither urgent nor tyre-kickers.
 */

export type LeadScore = "hot" | "warm" | "cold";

/** `key=value`, `key>=n`, `key<=n`. Unknown shapes never match, rather than throwing. */
function matches(rule: string, facts: Record<string, string>): boolean {
  const ge = rule.match(/^([a-z_]+)>=(-?\d+(?:\.\d+)?)$/i);
  if (ge) {
    const actual = Number(facts[ge[1]!]);
    return Number.isFinite(actual) && actual >= Number(ge[2]);
  }

  const le = rule.match(/^([a-z_]+)<=(-?\d+(?:\.\d+)?)$/i);
  if (le) {
    const actual = Number(facts[le[1]!]);
    return Number.isFinite(actual) && actual <= Number(le[2]);
  }

  const eq = rule.match(/^([a-z_]+)=(.+)$/);
  if (eq) {
    // Case-insensitive: the model writes "ASAP" where the config says "asap".
    return (facts[eq[1]!] ?? "").trim().toLowerCase() === eq[2]!.trim().toLowerCase();
  }

  return false;
}

export interface ScoreResult {
  score: LeadScore;
  /** Which rule decided it — goes in the CRM note so a human can see why. */
  reason?: string;
}

/**
 * `facts` is everything we collected: qualification answers, resource params,
 * plus `intent` and `booked` which the caller supplies.
 */
export function scoreLead(cfg: IndustryConfig, facts: Record<string, string>): ScoreResult {
  for (const rule of cfg.scoring.hot) {
    if (matches(rule, facts)) return { score: "hot", reason: rule };
  }
  for (const rule of cfg.scoring.cold) {
    if (matches(rule, facts)) return { score: "cold", reason: rule };
  }
  return { score: "warm" };
}

/**
 * A booking outranks the rules. Someone who actually reserved something is hot
 * regardless of what they said on the way there — and a config that happened to
 * mark their intent "cold" shouldn't bury a real customer.
 */
export function scoreWithBooking(
  cfg: IndustryConfig,
  facts: Record<string, string>,
  booked: boolean,
): ScoreResult {
  if (booked) return { score: "hot", reason: "booked" };
  return scoreLead(cfg, facts);
}
