import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/**
 * Session auth for the admin dashboard.
 *
 * Deliberately dependency-free: a signed cookie is enough for one operator, and
 * pulling in a session library would mean a store to run and configure for no
 * gain at this size.
 *
 * ── A warning that belongs in the code, not just a chat message ──
 * This dashboard exposes real customer data: names, phone numbers, email
 * addresses and full conversation transcripts. The default credentials are weak
 * on purpose (they were asked for) which is fine for localhost and NOT fine on a
 * public URL. Before this is reachable from the internet:
 *   - change ADMIN_PASSWORD to something real
 *   - set ADMIN_SESSION_SECRET (otherwise it is random per restart, so every
 *     deploy silently logs everyone out)
 *   - put it behind HTTPS, since the password is sent in the request body
 */

const SESSION_COOKIE = "gl_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — a working day, then re-auth

/**
 * Random per process when unset. That means restarts invalidate sessions, which
 * is the safe direction to fail: an unset secret can't become a predictable
 * signing key that survives a deploy.
 */
const secret = process.env.ADMIN_SESSION_SECRET ?? randomBytes(32).toString("hex");

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** `<expiry>.<signature>` — no user data in the cookie, nothing to leak. */
export function createSession(): string {
  const expires = String(Date.now() + SESSION_TTL_MS);
  return `${expires}.${sign(expires)}`;
}

export function verifySession(token?: string): boolean {
  if (!token) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature) return false;

  if (Number(expires) < Date.now()) return false;

  const expected = sign(expires);
  if (expected.length !== signature.length) return false;
  // Constant-time, so a wrong cookie can't be brute-forced by timing.
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function checkCredentials(email: string, password: string): boolean {
  const expectedEmail = process.env.ADMIN_EMAIL;
  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedEmail || !expectedPassword) return false;

  // Compare both even when the email is wrong, so response time doesn't reveal
  // which field failed.
  const emailOk = safeEqual(email.trim().toLowerCase(), expectedEmail.trim().toLowerCase());
  const passwordOk = safeEqual(password, expectedPassword);
  return emailOk && passwordOk;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sessionCookie(token: string): string {
  // No Secure flag: this has to work over http://localhost. Add it — or better,
  // terminate TLS in front — before exposing this anywhere real.
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export const clearCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function readSessionCookie(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}
