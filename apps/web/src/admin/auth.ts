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
 * Two roles, deliberately.
 *
 *  - `admin`  — everything, including every write and full customer content.
 *  - `viewer` — read-only. Every write is refused, emails and phone numbers are
 *    masked, and routes that return raw customer content (transcripts, email
 *    bodies, original webhook payloads, a contact's full record) are refused.
 *
 * Enforced server-side in `http.ts`. The UI hides what a viewer cannot do, but
 * that is courtesy: hiding a button is not access control.
 */
export type Role = "admin" | "viewer";

export interface SessionUser {
  email: string;
  role: Role;
}

/**
 * Random per process when unset. That means restarts invalidate sessions, which
 * is the safe direction to fail: an unset secret can't become a predictable
 * signing key that survives a deploy.
 */
const secret = process.env.ADMIN_SESSION_SECRET ?? randomBytes(32).toString("hex");

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * `<expiry>.<role>.<email>.<signature>`. The role is inside the signed payload,
 * so it cannot be edited in the cookie to promote a viewer to an admin.
 */
export function createSession(user: SessionUser): string {
  const payload = `${Date.now() + SESSION_TTL_MS}.${user.role}.${Buffer.from(user.email).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token?: string): SessionUser | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [expires, role, email, signature] = parts as [string, string, string, string];

  if (Number(expires) < Date.now()) return null;
  if (role !== "admin" && role !== "viewer") return null;

  const expected = sign(`${expires}.${role}.${email}`);
  if (expected.length !== signature.length) return null;
  // Constant-time, so a wrong cookie can't be brute-forced by timing.
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  return { email: Buffer.from(email, "base64url").toString("utf8"), role };
}

/**
 * Accounts come from the environment: `ADMIN_EMAIL` / `ADMIN_PASSWORD` for the
 * admin, and an optional `VIEWER_EMAIL` / `VIEWER_PASSWORD` for the read-only
 * account. No user table — two accounts do not need a database, and this keeps
 * the console usable when Postgres is down.
 */
export function checkCredentials(email: string, password: string): SessionUser | null {
  const accounts: { role: Role; email?: string; password?: string }[] = [
    { role: "admin", email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
    { role: "viewer", email: process.env.VIEWER_EMAIL, password: process.env.VIEWER_PASSWORD },
  ];

  let match: SessionUser | null = null;
  for (const acct of accounts) {
    if (!acct.email || !acct.password) continue;
    // Every configured account is compared in full, so response time doesn't
    // reveal which field failed or which account exists.
    const emailOk = safeEqual(email.trim().toLowerCase(), acct.email.trim().toLowerCase());
    const passwordOk = safeEqual(password, acct.password);
    if (emailOk && passwordOk && !match) match = { email: acct.email.trim(), role: acct.role };
  }
  return match;
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
