import type { ConversationStore } from "../conversation/types.js";
import type { IndustryConfig } from "../industries/types.js";
import { composeEmail, type Trigger } from "../email/compose.js";
import { sendEmail } from "../email/send.js";
import { GhlClient } from "../ghl/client.js";
import { normalizeEmail } from "../crm/contacts.js";
import type { LeadStore } from "./store.js";

/**
 * Composes the first follow-up for a captured lead and decides whether to send it.
 *
 * The send decision is tri-state rather than a boolean, because a boolean can't
 * express the state we're actually in: the GHL sending domain isn't verified, so
 * real sends don't reach inboxes (proven — a warm email to a real address was
 * reported `delivered` and never arrived). We still want the copy written and
 * reviewable now.
 *
 *   off      — don't even compose. No LLM spend.
 *   dry_run  — compose and store, never send.  ← the default, deliberately
 *   on       — send, but only to allowlisted recipients unless the allowlist is
 *              empty. That's what lets real delivery be proven to one inbox while
 *              the `from` address is still a shared GHL domain.
 */
export type AutosendMode = "off" | "dry_run" | "on";

export function autosendMode(): AutosendMode {
  const raw = (process.env.LEAD_AUTOSEND ?? "dry_run").trim().toLowerCase();
  if (raw === "on" || raw === "true") return "on";
  if (raw === "off" || raw === "false") return "off";
  return "dry_run";
}

/**
 * Exported so the admin console's manual-send path enforces the SAME rule.
 * A second copy of this would drift, and the thing it guards — which real
 * addresses may receive mail while the sending domain is unverified — is exactly
 * the kind of rule that must not have two answers.
 */
export function allowlisted(email: string): boolean {
  const raw = process.env.LEAD_AUTOSEND_ALLOWLIST?.trim();
  if (!raw) return true; // no allowlist configured means no restriction
  const entries = raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const addr = email.trim().toLowerCase();
  return entries.some((e) => addr === e || addr.endsWith(`@${e}`));
}

export interface FollowUpDeps {
  store: LeadStore;
  conversations: ConversationStore;
  cfg: IndustryConfig;
  client?: GhlClient;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface FollowUpResult {
  status: "sent" | "composed" | "send_disabled" | "skipped_already_contacted" | "skipped" | "failed";
  subject?: string;
  reason?: string;
}

export class LeadFollowUp {
  constructor(private readonly deps: FollowUpDeps) {}

  async send(opts: {
    leadId: string;
    contactId?: string;
    conversationId?: string;
    recipient?: string;
    trigger?: Trigger;
  }): Promise<FollowUpResult> {
    const { store, conversations, cfg, onLog = () => {} } = this.deps;
    const trigger: Trigger = opts.trigger ?? "new_lead";
    const mode = autosendMode();

    if (mode === "off") {
      onLog("follow-up skipped — autosend off", { leadId: opts.leadId });
      return { status: "skipped", reason: "autosend_off" };
    }
    if (!opts.conversationId) {
      return { status: "skipped", reason: "no conversation to compose from" };
    }

    /**
     * The "never two first touches" rule, enforced at send time rather than
     * hoped for. A merged lead belongs to someone who may already have had this
     * exact email from another source.
     */
    if (opts.contactId && (await store.hasEmailForContact(opts.contactId, trigger))) {
      const id = `${opts.leadId}:${trigger}`;
      await store.saveEmail({
        id,
        leadId: opts.leadId,
        contactId: opts.contactId,
        conversationId: opts.conversationId,
        trigger,
        recipient: opts.recipient,
        subject: "(not composed)",
        body: "(not composed)",
        status: "skipped_already_contacted",
        reason: "this contact already had a first-touch email",
      });
      onLog("follow-up suppressed — already contacted", { contactId: opts.contactId });
      return { status: "skipped_already_contacted" };
    }

    const convo = await conversations.get(opts.conversationId);
    if (!convo) return { status: "skipped", reason: "conversation not found" };

    let composed;
    try {
      composed = await composeEmail(cfg, convo, trigger);
    } catch (err) {
      onLog("compose failed", { leadId: opts.leadId, err: String(err) });
      return { status: "failed", reason: `compose failed: ${err}` };
    }

    const recipient = normalizeEmail(opts.recipient ?? convo.contact.email);
    const id = `${opts.leadId}:${trigger}`;

    // Decide before writing, so the stored status is the truth rather than
    // something a later step has to correct.
    let status: FollowUpResult["status"] = "composed";
    let reason: string | undefined;

    if (!recipient) {
      status = "send_disabled";
      reason = "no email address — phone-only lead";
    } else if (mode === "dry_run") {
      status = "send_disabled";
      reason = "autosend is dry_run";
    } else if (!allowlisted(recipient)) {
      status = "send_disabled";
      reason = "recipient not in LEAD_AUTOSEND_ALLOWLIST";
    }

    // Persisted whichever way it goes — that's what makes the copy reviewable
    // while the sending domain is still unverified.
    await store.saveEmail({
      id,
      leadId: opts.leadId,
      contactId: opts.contactId,
      conversationId: opts.conversationId,
      trigger,
      recipient,
      subject: composed.subject,
      body: composed.body,
      status,
      reason,
    });

    if (status !== "composed") {
      onLog("follow-up composed but held", { leadId: opts.leadId, reason });
      return { status, subject: composed.subject, reason };
    }

    if (!opts.contactId) {
      return { status: "send_disabled", subject: composed.subject, reason: "no CRM contact to thread against" };
    }

    try {
      const res = await sendEmail(
        { contactId: opts.contactId, email: composed },
        this.deps.client ?? new GhlClient(),
      );
      await store.markEmailSent(id, res.messageId);
      onLog("follow-up sent", { leadId: opts.leadId, recipient, messageId: res.messageId });
      return { status: "sent", subject: composed.subject };
    } catch (err) {
      onLog("follow-up send failed", { leadId: opts.leadId, err: String(err) });
      return { status: "failed", subject: composed.subject, reason: String(err) };
    }
  }
}
