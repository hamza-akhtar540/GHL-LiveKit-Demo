import { GhlClient } from "../ghl/client.js";
import { paths } from "../ghl/endpoints.js";

/**
 * Sending a message to a contact through GoHighLevel, on any channel it supports.
 *
 * A sibling to `email/send.ts` rather than a replacement: `sendEmail` keeps its
 * exact signature and now delegates here, so there is one POST to
 * `/conversations/messages` in the codebase instead of two drifting copies.
 *
 * ── Threading is by CONTACT, not by conversation ──
 * Confirmed against the API: the send endpoint requires `type` and `contactId`
 * and has NO conversationId parameter at all. Two consequences that the UI has
 * to respect rather than paper over:
 *
 *   1. A conversation with no `contactId` cannot be replied to. Roughly three
 *      quarters of ours have none, so this is the common case, not an edge one.
 *   2. GoHighLevel decides which thread the message lands in. A contact with
 *      several threads may get the reply filed somewhere the operator was not
 *      looking.
 *
 * ── Why our own transcript is separate from GHL's thread ──
 * Nothing in `conversation/*.ts` ever calls GHL, so a voice or chat conversation
 * exists ONLY in our Postgres. GHL's thread for the same person contains its own
 * activity records and outbound mail, and essentially none of the actual
 * dialogue. They are two different records of two different things, and merging
 * them into one stream is not possible safely — our `Message` has no id, so a
 * merged view could not dedupe an admin's reply against GHL's echo of it.
 */

/**
 * The channels GHL accepts. `Live_Chat` is deliberately excluded from
 * `SendableChannel` below even though the API takes it — see that type.
 */
export type GhlMessageType = "SMS" | "Email" | "WhatsApp" | "IG" | "FB" | "Custom" | "Live_Chat";

/**
 * What the console may actually send on.
 *
 * `Live_Chat` is excluded on purpose. Our chat widget is our own, over LiveKit —
 * grep finds no GHL webchat anywhere in the codebase — so a `Live_Chat` send
 * would post into a GoHighLevel webchat thread the customer has never opened. It
 * would report success and reach nobody.
 *
 * The practical consequence for the operator, which the UI says out loud: once a
 * web visitor closes the tab, the LiveKit room is gone and there is NO channel
 * back to them except email or SMS. The reply box is a cross-channel follow-up
 * tool, not a way to continue the chat.
 */
export type SendableChannel = "Email" | "SMS";

export interface SendMessageInput {
  channel: SendableChannel;
  contactId: string;
  /** Plain text. Required on every channel. */
  message: string;
  /** Email only; ignored elsewhere. */
  subject?: string;
  /** Email only. Supplied alongside the plain text so both readers are served. */
  html?: string;
  threadId?: string;
  replyToMessageId?: string;
}

export interface SendMessageResult {
  messageId?: string;
  conversationId?: string;
  emailMessageId?: string;
}

export async function sendMessage(
  input: SendMessageInput,
  client: GhlClient = new GhlClient(),
): Promise<SendMessageResult> {
  if (!input.contactId) {
    throw new Error("Cannot send: no contact id. GoHighLevel threads messages by contact.");
  }
  if (!input.message.trim()) throw new Error("Cannot send an empty message.");

  return client.request<SendMessageResult>(paths.sendMessage(), {
    method: "POST",
    body: {
      type: input.channel,
      contactId: input.contactId,
      message: input.message,
      // Subject and html are email-only. Sending them with an SMS is at best
      // ignored and at worst a validation error, so they are omitted by channel
      // rather than always included.
      ...(input.channel === "Email" && input.subject ? { subject: input.subject } : {}),
      /**
       * Email ALWAYS carries html, derived from the text when the caller did not
       * supply it.
       *
       * Learned from a real 422: an email with `message` but no `html` is
       * rejected with `CONVERSATIONS_MSG_NO_CONTENT` — "There is no message or
       * attachments for this message. Skip sending." GHL evidently reads the
       * html body for this channel, so making html optional here silently broke
       * every email send, and nothing but an actual send would have shown it.
       */
      ...(input.channel === "Email" ? { html: input.html ?? toHtml(input.message) } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      // NOTE the name mismatch, which is GHL's not ours: the option is
      // `replyToMessageId`, the wire field is `replyMessageId`.
      ...(input.replyToMessageId ? { replyMessageId: input.replyToMessageId } : {}),
    },
    // One attempt only. GhlClient retries 429/5xx by default, and for a SEND a
    // retried 500 that actually succeeded server-side means the customer gets
    // the message twice. There is no idempotency key on this endpoint, so the
    // safe failure is "told it failed when it worked", not "sent twice".
    maxAttempts: 1,
  });
}

/**
 * Minimal, deliberately. The composer writes plain prose with line breaks, so
 * paragraphs are all we need — and escaping first means a guest whose name
 * contains an ampersand doesn't produce broken markup.
 */
export function toHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#16241f">${paragraphs}</div>`;
}


/**
 * Whether SMS can actually be sent from this sub-account.
 *
 * Not merely a config flag: this location has `saasMode: not_activated`, Twilio
 * rebilling disabled, and no provisioned LC Phone number — the `phone` on the
 * location is the owner's profile field. A `type: "SMS"` send therefore 4xxs.
 *
 * It fails LOUDLY, which is the one good thing about it: `GhlError.retryable`
 * treats 4xx as non-retryable, so it surfaces immediately, unlike email which
 * reports success and silently never arrives.
 */
export function smsAvailability(): { available: boolean; reason?: string } {
  const from = process.env.GHL_SMS_FROM?.trim();
  if (from) return { available: true };
  return {
    available: false,
    reason:
      "No sending number is configured for this sub-account, so GoHighLevel will reject an SMS. " +
      "Provision an LC Phone number (or set GHL_SMS_FROM) to enable this.",
  };
}
