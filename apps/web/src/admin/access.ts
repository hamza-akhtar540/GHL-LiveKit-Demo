import type { AdminHttpResponse } from "./http.js";

/**
 * What the read-only role may not see.
 *
 * Route paths as declared in `http.ts`. These return raw customer content —
 * message text, email bodies, the original webhook payload, a contact's full
 * record — which cannot be masked field by field because it is free text.
 * Refusing the whole route is the only version of this that is honest.
 */
export const ADMIN_ONLY_READS = new Set([
  "conversations/:id",
  "conversations/:id/thread",
  "emails/:id",
  "leads/:id",
  "contacts/:id",
]);

/** Keys whose values are contact details wherever they appear in a response. */
const EMAIL_KEYS = new Set(["email", "recipient", "identityKey"]);
const PHONE_KEYS = new Set(["phone"]);
/** Free text lifted out of a conversation into list rows. */
const TEXT_KEYS = new Set(["lastMessage", "message"]);

export function maskEmail(value: string): string {
  const [user = "", domain = ""] = value.split("@");
  if (!domain) return "•••";
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${user.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`;
}

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length > 4 ? `••• ••• ${digits.slice(-4)}` : "•••";
}

function maskValue(key: string, value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  if (EMAIL_KEYS.has(key)) return value.includes("@") ? maskEmail(value) : "•••";
  if (PHONE_KEYS.has(key)) return maskPhone(value);
  if (TEXT_KEYS.has(key)) return "Hidden for read-only accounts";
  return value;
}

export function maskDeep(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(maskDeep);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = typeof v === "string" ? maskValue(k, v) : maskDeep(v);
    }
    return out;
  }
  return node;
}

/** Masks a JSON response; anything that is not JSON passes through untouched. */
export function maskForViewer(res: AdminHttpResponse): AdminHttpResponse {
  if (!res.headers["content-type"]?.includes("application/json")) return res;
  try {
    return { ...res, body: JSON.stringify(maskDeep(JSON.parse(res.body))) };
  } catch {
    return res;
  }
}
