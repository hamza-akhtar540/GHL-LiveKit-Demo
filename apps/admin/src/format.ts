export function fmtDate(iso?: string | null, timeZone?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
}

export function ago(iso?: string | null): string {
  if (!iso) return "—";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const units: [number, string][] = [
    [60, "m"],
    [3600, "h"],
    [86400, "d"],
  ];
  let out = "just now";
  for (const [size, label] of units) if (secs >= size) out = `${Math.floor(secs / size)}${label} ago`;
  return out;
}

export function money(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : "—";
}

export const TRIGGER_LABEL: Record<string, string> = {
  new_lead: "New lead",
  thank_you: "Thank you",
  abandoned_1h: "Nudge · 1 hour",
  abandoned_24h: "Nudge · 24 hours",
  abandoned_3d: "Nudge · 3 days",
  no_show: "No-show",
  reply: "Reply",
};

export const SOURCE_LABEL: Record<string, string> = {
  web_form: "Web form",
  facebook_lead_ad: "Facebook ad",
  instagram_dm: "Instagram DM",
  facebook_dm: "Facebook DM",
  chat: "Chat",
  voice: "Voice",
  email: "Email",
  webhook: "Webhook",
  manual: "Manual",
};
