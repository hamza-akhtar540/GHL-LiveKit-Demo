/**
 * Contact-shaping helpers shared by every path that writes a person to the CRM —
 * bookings, group enquiries, and lead ingestion.
 *
 * These lived privately inside the booking store until a second caller needed
 * them. One definition matters here: both fixes below came from real bugs, and a
 * copy that drifts is a bug that comes back.
 */

/**
 * Force US numbers into E.164 so GHL can't reinterpret them under the
 * sub-account's country. A bare 10-digit number in a Pakistan-region account
 * comes back as +92…, which then can't receive a US confirmation text. An
 * explicit +1 removes the guesswork. Anything already in +… form is left alone.
 */
export function normalizePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed; // unknown shape — hand it over untouched rather than mangle it
}

/** Digits only, for comparing two phone numbers written differently. */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function normalizeEmail(email?: string): string | undefined {
  return email?.trim().toLowerCase() || undefined;
}

/**
 * Split a spoken full name into GHL's two fields.
 *
 * `defaultFirstName` is deliberately opt-in. The booking path wants "Guest" when
 * nobody gave a name; every other path must NOT, because GHL's upsert matches on
 * email/phone — so a nameless enquiry carrying a known phone number would match
 * a real customer and overwrite their first name with "Guest".
 */
export function splitName(
  fullName?: string,
  defaultFirstName?: string,
): { firstName?: string; lastName?: string } {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? defaultFirstName;
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
  return { ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}) };
}

/** Slug for a tag value. GHL tags are lowercased and space-separated reads badly. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
