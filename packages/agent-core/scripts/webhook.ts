/**
 * T1.4 — Inbound email webhook probe. THE day-1 gate.
 *
 *   terminal 1:  pnpm webhook:listen
 *   terminal 2:  ngrok http 4000
 *   GHL:         Settings > Webhooks (or a workflow with a Webhook action)
 *                → point at  https://<ngrok>.ngrok-free.app/webhooks/ghl
 *   then:        send a real email from Gmail to the sub-account address
 *
 * We need to see an InboundMessage fire for messageType "Email" carrying a
 * contactId, a conversationId, and the body. If it does, the email channel is
 * a plain webhook handler (days 6-7 as planned). If it doesn't — if email only
 * arrives via a Conversation Provider — that's an extra half-day we need to
 * know about now, while there's still slack in the schedule.
 *
 * Every payload is written to webhook-captures/ so we can build the parser and
 * fixtures against real data instead of inventing a shape.
 */
import "dotenv/config";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.WEBHOOK_PORT ?? 4000);
const CAPTURES = resolve(process.cwd(), "webhook-captures");
mkdirSync(CAPTURES, { recursive: true });

let seq = 0;

const dim = (m: string) => `\x1b[90m${m}\x1b[0m`;
const green = (m: string) => `\x1b[32m${m}\x1b[0m`;
const yellow = (m: string) => `\x1b[33m${m}\x1b[0m`;
const red = (m: string) => `\x1b[31m${m}\x1b[0m`;

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200).end("webhook probe up");
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    // Always 200 immediately. GHL retries on non-2xx and on slow responses,
    // and a retry storm during the probe would muddy what we're measuring.
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');

    const raw = Buffer.concat(chunks).toString("utf8");
    const n = ++seq;

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.log(red(`\n[${n}] non-JSON body:`), raw.slice(0, 300));
      return;
    }

    const file = resolve(CAPTURES, `${String(n).padStart(3, "0")}-${payload.type ?? "unknown"}.json`);
    writeFileSync(file, JSON.stringify(payload, null, 2));

    console.log(`\n${green(`[${n}]`)} ${payload.type ?? "(no type field)"}  ${dim(`→ ${file}`)}`);
    console.log(dim(`     headers: ${JSON.stringify(pickHeaders(req.headers))}`));

    analyze(payload);
  });
});

function pickHeaders(h: Record<string, unknown>) {
  // Signature header name is what we'll verify against in T6.1 — capture it now.
  const keep = ["x-wh-signature", "x-ghl-signature", "user-agent", "content-type"];
  return Object.fromEntries(Object.entries(h).filter(([k]) => keep.includes(k.toLowerCase())));
}

function analyze(p: any) {
  const type = p.type ?? "";
  if (type !== "InboundMessage" && type !== "OutboundMessage") {
    console.log(dim(`     (not a message event — noted and saved)`));
    return;
  }

  const fields = {
    direction: p.direction,
    messageType: p.messageType,
    contactId: p.contactId,
    conversationId: p.conversationId,
    messageId: p.messageId ?? p.id,
    locationId: p.locationId,
    from: p.from,
    subject: p.subject,
    bodyLen: typeof p.body === "string" ? p.body.length : undefined,
  };
  console.log(dim(`     ${JSON.stringify(fields)}`));

  const isEmail = String(p.messageType ?? "").toLowerCase().includes("email");
  const isInbound = String(p.direction ?? "").toLowerCase() === "inbound";

  if (!isEmail) {
    console.log(yellow(`     messageType is "${p.messageType}" — send an EMAIL, not an SMS, to test the email path.`));
    return;
  }
  if (!isInbound) {
    console.log(dim(`     outbound echo — this is exactly what T6.1's direction guard must drop.`));
    return;
  }

  const missing = (["contactId", "conversationId"] as const).filter((k) => !p[k]);
  const hasDedupeKey = Boolean(p.messageId ?? p.id);

  if (missing.length === 0 && hasDedupeKey) {
    console.log(green("     ✓ GATE PASSED — inbound email carries contactId + conversationId + a dedupe key."));
    console.log(green("       Email channel is a plain webhook handler. Days 6-7 stand as planned."));
  } else {
    if (missing.length) console.log(red(`     ✗ missing: ${missing.join(", ")}`));
    if (!hasDedupeKey) console.log(red(`     ✗ no messageId/id — we have no dedupe key; T6.1 needs a different strategy.`));
    console.log(yellow("       Likely means email needs a Conversation Provider. Budget +0.5 day."));
  }
}

server.listen(PORT, () => {
  console.log(`\nWebhook probe listening on :${PORT}`);
  console.log(dim(`  POST endpoint : http://localhost:${PORT}/webhooks/ghl`));
  console.log(dim(`  captures      : ${CAPTURES}`));
  console.log(dim(`\n  next: ngrok http ${PORT}  →  register the https URL in GHL  →  email the sub-account\n`));
});
