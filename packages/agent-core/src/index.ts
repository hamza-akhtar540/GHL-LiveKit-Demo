export * from "./ghl/index.js";
export { ghlEnv, calendarIdFor } from "./env.js";
export type { GhlEnv } from "./env.js";

export type { IndustryConfig, Field, Fact, Intent, Resource } from "./industries/types.js";
export { roofing } from "./industries/roofing.js";
export { hotel } from "./industries/hotel.js";
export { industries, getIndustry } from "./industries/index.js";

export { buildInstructions, todayIn } from "./prompt.js";
export type { PromptOptions } from "./prompt.js";

export { createTools } from "./tools.js";
export type { ToolDef, ToolEvents } from "./tools.js";

export { MemoryBookingStore } from "./booking/memory.js";
export { GhlBookingStore } from "./booking/ghl.js";
export { BookingIndex } from "./booking/index-store.js";
export { bookings, conversations } from "./conversation/schema.js";
export type { BookingStore, Booking, BookingRequest, Slot, AvailabilityQuery } from "./booking/types.js";

export { FileConversationStore } from "./conversation/file-store.js";
export { PgConversationStore } from "./conversation/pg-store.js";
export { ConversationRecorder } from "./conversation/recorder.js";
export { FallbackConversationStore } from "./conversation/fallback-store.js";
export type {
  Conversation,
  ConversationStore,
  Message,
  ConversationOutcome,
  Channel,
  Role,
} from "./conversation/types.js";

export { composeEmail } from "./email/compose.js";
export type { Trigger, ComposedEmail } from "./email/compose.js";

export { sendEmail } from "./email/send.js";
export type { SendOptions, SendResult } from "./email/send.js";

export { scoreLead, scoreWithBooking } from "./scoring.js";
export type { LeadScore, ScoreResult } from "./scoring.js";
export { CrmSync } from "./crm/sync.js";
export type { OpportunityOutcome } from "./crm/sync.js";

export { keytermsFor } from "./speech.js";

export { normalizePhone, splitName, slug, normalizeEmail, phoneDigits } from "./crm/contacts.js";

export type { Lead, LeadSource, IngestStatus, IngestResult } from "./leads/types.js";
export { submissionIdFor, identityKeysFor, isContactable } from "./leads/identity.js";
export {
  parseWebForm,
  parseMetaLeadgen,
  enrichMetaLead,
  parseGhlWebhook,
  parseConversation,
  parseGenericWebhook,
} from "./leads/parsers.js";
export { tagsFor } from "./leads/tags.js";
export { PgLeadStore, MemoryLeadStore } from "./leads/store.js";
export type { LeadStore, LeadEventRow, IdentityRow } from "./leads/store.js";
export { LeadIngestor } from "./leads/ingest.js";
export { leadEvents, leadIdentities, leadEmails } from "./leads/schema.js";
export { LeadFollowUp, autosendMode } from "./leads/follow-up.js";
export type { AutosendMode, FollowUpResult } from "./leads/follow-up.js";
export { handleLeadRequest, isLeadPath, verifyMetaSignature } from "./leads/http.js";
export type { LeadHttpRequest, LeadHttpResponse } from "./leads/http.js";

export { SocialClient } from "./social/client.js";
export type { SocialAccount, SocialStatistics, PostStatus } from "./social/client.js";
export { findPostIdeas, generatePost } from "./social/content.js";
export type { Platform, PostIdea, GeneratedPost } from "./social/content.js";
export { SocialStore } from "./social/store.js";
export type { RecordedPost, WeekdayInsight } from "./social/store.js";
export { SocialPublisher } from "./social/publisher.js";
export type { PublishResult } from "./social/publisher.js";
export { socialPosts, socialStats } from "./social/schema.js";

export { AdminData } from "./admin/data.js";
export { AdminWriter, AdminWriteError, WRITE_RISK } from "./admin/writer.js";
export type { WriteRisk, AdminWriterDeps } from "./admin/writer.js";
export { LiveSessions } from "./admin/live-sessions.js";
export type { LiveRoom, LiveParticipant } from "./admin/live-sessions.js";
export { nextOccurrence, weekdayIn } from "./social/schedule-time.js";

export { startAutomation, automationEnabled } from "./automation/runner.js";
export type { Automation, AutomationOptions } from "./automation/runner.js";
export { runAbandonedFollowUps, dueTrigger } from "./automation/abandoned.js";
export { syncSocialDms } from "./social/dm-sync.js";
export { validateContactForm, CONTACT_FIELDS } from "./contact-form.js";
export type { ContactField, ContactCheck } from "./contact-form.js";
