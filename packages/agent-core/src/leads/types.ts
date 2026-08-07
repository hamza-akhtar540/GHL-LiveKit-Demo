/**
 * One shape for a lead, whatever it came from.
 *
 * The point of normalising early: everything downstream — dedup, tagging, the
 * CRM write, the follow-up sequence — is written once instead of once per
 * source. Adding a new source becomes a parser, not a new pipeline.
 */

export type LeadSource =
  | "web_form"
  | "facebook_lead_ad"
  | "instagram_dm"
  | "facebook_dm"
  | "chat"
  | "voice"
  | "email"
  | "webhook"
  | "manual";

export interface Lead {
  source: LeadSource;
  /**
   * The source's own id for this submission, when it has one — a Facebook
   * leadgen id, a form submission id. This is what makes redelivery safe: the
   * same id arriving twice is the same lead, not a second one.
   */
  externalId?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  /** Free text they wrote — the message, the enquiry, the form's notes field. */
  message?: string;
  /**
   * Everything else the source gave us, flattened to strings. Custom form
   * fields, ad questions, UTM parameters. Kept rather than discarded because
   * the qualification answers often arrive here.
   */
  fields: Record<string, string>;
  /** Campaign / ad / page, for attribution. */
  attribution?: {
    campaign?: string;
    adId?: string;
    formId?: string;
    pageUrl?: string;
    referrer?: string;
    utm?: Record<string, string>;
  };
  /** ISO. When the lead was actually created at the source, not when we saw it. */
  capturedAt: string;
}

export type IngestStatus =
  | "created" // new contact in the CRM
  | "merged" // matched an existing contact, tags and fields added
  | "duplicate" // we have already processed this exact submission
  | "rejected"; // nothing usable — no email, no phone

export interface IngestResult {
  status: IngestStatus;
  /**
   * The submission id we claimed under. Returned rather than left for callers to
   * re-derive: for sources without their own id it's a content hash, and a caller
   * guessing `source:externalId` would silently key follow-ups to the wrong row.
   */
  leadId: string;
  contactId?: string;
  /** Our conversation id, so a follow-up can be composed from it. */
  conversationId?: string;
  tags: string[];
  reason?: string;
}
