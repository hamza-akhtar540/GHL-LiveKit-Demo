import { GhlClient } from "../ghl/client.js";
import { sendMessage, toHtml } from "../conversation/send.js";
import type { ComposedEmail } from "./compose.js";

/**
 * Sends through GoHighLevel's conversations API rather than our own SMTP.
 *
 * Deliberate: GHL already owns the sending domain's SPF/DKIM/DMARC, the
 * unsubscribe footer, and the reply threading. Sending ourselves would mean
 * duplicating all of that and — worse — replies would land somewhere the CRM
 * can't see, which breaks the whole "reply with full context" story. The email
 * has to live in the same thread the CRM knows about.
 */

export interface SendResult {
  messageId?: string;
  conversationId?: string;
  emailMessageId?: string;
}

export interface SendOptions {
  /** GHL contact id. The conversation is threaded against this contact. */
  contactId: string;
  email: ComposedEmail;
  /** Reply into an existing thread instead of starting a new one. */
  threadId?: string;
  /** GHL message id being replied to — keeps Gmail threading intact. */
  replyToMessageId?: string;
}

/**
 * Signature deliberately unchanged — `leads/follow-up.ts`, `scripts/
 * email-send-test.ts` and the package index all call this exact shape.
 *
 * The body is now an adapter over `conversation/send.ts`, so the one POST to
 * `/conversations/messages` lives in one place. Two copies of a send is exactly
 * the drift that produced the `firstName || "Guest"` bug elsewhere in this repo.
 */
export async function sendEmail(
  { contactId, email, threadId, replyToMessageId }: SendOptions,
  client: GhlClient = new GhlClient(),
): Promise<SendResult> {
  return sendMessage(
    {
      channel: "Email",
      contactId,
      subject: email.subject,
      // Plain text and HTML both supplied. Text-only lands in spam more often,
      // and HTML-only breaks for anyone reading in plain text.
      message: email.body,
      html: toHtml(email.body),
      threadId,
      replyToMessageId,
    },
    client,
  );
}
