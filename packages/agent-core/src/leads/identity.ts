import { createHash } from "node:crypto";
import { normalizeEmail, phoneDigits } from "../crm/contacts.js";
import type { Lead } from "./types.js";

/**
 * Two different questions, and conflating them is the classic way this breaks:
 *
 *   submissionIdFor — "have I already processed THIS submission?"  (idempotency)
 *   identityKeysFor — "is this the same HUMAN as before?"          (merging)
 *
 * A webhook redelivered twice is one submission. The same person arriving from
 * Facebook and then a web form is two submissions and one human.
 */

/**
 * Stable id for a submission, so redelivery is a no-op.
 *
 * When the source gives us its own id (Meta's `leadgen_id`, a form submission id)
 * that's authoritative. Otherwise we hash the content.
 *
 * **`capturedAt` is deliberately excluded from the hash.** A parser that defaults
 * it to "now" would produce a different hash on every redelivery, and the whole
 * ledger would silently never match anything — the failure mode being that
 * duplicate contacts and duplicate emails look like correct behaviour.
 */
export function submissionIdFor(lead: Lead): string {
  if (lead.externalId?.trim()) {
    return `${lead.source}:${lead.externalId.trim()}`;
  }

  // Sorted keys so JSON key order can't change the hash.
  const canonical = JSON.stringify({
    email: normalizeEmail(lead.email) ?? "",
    phone: lead.phone ? phoneDigits(lead.phone) : "",
    fullName: lead.fullName?.trim().toLowerCase() ?? "",
    message: lead.message?.trim() ?? "",
    fields: Object.fromEntries(
      Object.entries(lead.fields ?? {})
        .map(([k, v]) => [k, String(v ?? "").trim()] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  });

  return `${lead.source}:c:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/**
 * Phone numbers shorter than this are junk from a half-filled form. Without the
 * floor, `phone: "0000"` becomes an identity key that every other junk lead
 * matches — quietly merging unrelated people into one contact.
 */
const MIN_PHONE_DIGITS = 8;

/**
 * Every key this lead could be recognised by. Usually two — email and phone —
 * both pointing at the same contact, which is what makes "same person, phone
 * only this time" merge rather than creating a second record.
 */
export function identityKeysFor(lead: {
  email?: string;
  phone?: string;
}): string[] {
  const keys: string[] = [];

  const email = normalizeEmail(lead.email);
  if (email?.includes("@")) keys.push(`email:${email}`);

  if (lead.phone) {
    const digits = phoneDigits(lead.phone);
    if (digits.length >= MIN_PHONE_DIGITS) keys.push(`phone:${digits}`);
  }

  return keys;
}

/** A lead with neither is not a lead — there's no way to reply to it. */
export function isContactable(lead: { email?: string; phone?: string }): boolean {
  return identityKeysFor(lead).length > 0;
}
