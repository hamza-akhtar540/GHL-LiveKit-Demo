/**
 * Validation for the contact-details form the widget shows the guest.
 *
 * The browser validates too, for instant feedback, but this is the copy that
 * counts: the value is going into a booking and a CRM record, and anything a
 * client sends is untrusted. Both sides must agree on the rules, so they are kept
 * deliberately small enough to state in one sentence each.
 *
 * Why a form at all: a name, an email address and a phone number are exactly the
 * three things speech recognition and typing both get wrong, and a wrong one is
 * not a small error — the confirmation goes nowhere and the lead cannot be
 * reached. A field the guest typed and checked themselves cannot be misheard.
 */
export type ContactField = "full_name" | "email" | "phone";

export const CONTACT_FIELDS: readonly ContactField[] = ["full_name", "email", "phone"];

export type ContactCheck =
  | { ok: true; values: Partial<Record<ContactField, string>> }
  | { ok: false; errors: Partial<Record<ContactField, string>> };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizePhone(raw: string): string {
  let s = raw.trim().replace(/[\s().-]/g, "");
  // 00 is how much of the world writes the + on a keypad.
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return s;
}

export function validateContactForm(
  raw: Record<string, unknown>,
  need: readonly ContactField[] = CONTACT_FIELDS,
): ContactCheck {
  const values: Partial<Record<ContactField, string>> = {};
  const errors: Partial<Record<ContactField, string>> = {};
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");

  for (const field of need) {
    if (field === "full_name") {
      const name = str("full_name").trim().replace(/\s+/g, " ");
      if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name)) errors.full_name = "Enter your full name";
      else values.full_name = name;
    }
    if (field === "email") {
      const email = str("email").trim();
      if (!EMAIL.test(email) || email.length > 120) errors.email = "Enter a valid email address";
      else values.email = email.replace(/@(.+)$/, (_m, d: string) => `@${d.toLowerCase()}`);
    }
    if (field === "phone") {
      const phone = normalizePhone(str("phone"));
      if (!/^\+?\d{8,15}$/.test(phone)) errors.phone = "Enter a phone number, with country code if outside your region";
      else values.phone = phone;
    }
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}
