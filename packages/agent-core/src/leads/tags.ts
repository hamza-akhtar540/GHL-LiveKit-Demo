import { slug } from "../crm/contacts.js";
import type { Lead } from "./types.js";

/**
 * Tags are the attribution. GHL workflows and reporting trigger off these exact
 * strings, so renaming one later orphans whatever was keyed to it — treat them as
 * a published interface, not labels.
 *
 * Always additive: a person who arrives from a Facebook ad and later fills in a
 * web form ends up carrying both source tags, which is the whole point of merging
 * rather than duplicating.
 */

/** Readable names for the tag, since `facebook_lead_ad` reads badly in a UI. */
const SOURCE_LABEL: Record<Lead["source"], string> = {
  web_form: "web-form",
  facebook_lead_ad: "facebook-lead-ad",
  instagram_dm: "instagram-dm",
  facebook_dm: "facebook-dm",
  chat: "chat",
  voice: "voice",
  email: "email",
  webhook: "webhook",
  manual: "manual",
};

export function tagsFor(lead: Lead): string[] {
  const tags = new Set<string>();

  tags.add(`lead-source-${SOURCE_LABEL[lead.source]}`);
  // One tag across every source, so "everything the agent brought in" is a
  // single filter rather than an OR of nine.
  tags.add("ai-captured");

  const a = lead.attribution;
  if (a?.campaign) tags.add(`campaign-${slug(a.campaign)}`);
  if (a?.formId) tags.add(`form-${slug(a.formId)}`);
  if (a?.adId) tags.add(`ad-${slug(a.adId)}`);
  if (a?.utm?.utm_source) tags.add(`utm-${slug(a.utm.utm_source)}`);

  // Empty and over-long tags are silently dropped by GHL, which is worse than
  // rejecting them here where it's visible.
  return [...tags].filter((t) => t.length > 3 && t.length <= 50);
}
