import { GhlClient } from "../ghl/client.js";
import { paths } from "../ghl/endpoints.js";
import type { LeadScore } from "../scoring.js";
import { normalizePhone, splitName } from "./contacts.js";

/** What happened, in pipeline terms. Maps to a stage in `stageFor`. */
export type OpportunityOutcome = "new" | "qualified" | "booked" | "lost";

/**
 * Who said this, for a transcript a human will read to catch up.
 *
 * The old `role === "agent" ? "Agent" : "Customer"` collapsed everything that
 * was not the agent into "Customer". That was harmless while only the agent and
 * the caller could speak — and became actively misleading the moment an operator
 * could reply from the console, because it put the operator's own words in the
 * guest's mouth on the note a colleague reads to work out what happened.
 */
function speakerLabel(role: string): string {
  if (role === "agent") return "Agent";
  if (role === "admin" || role === "human") return "Our team";
  return "Customer";
}

/**
 * Writes what the agent learned back into the CRM: tags, the lead score, a
 * summary note, and a handoff flag.
 *
 * This is the half of the demo that sells it. A buyer watching the conversation
 * on one side and the CRM filling in on the other is what makes it real —
 * transcript alone reads like a chatbot.
 *
 * Every method is best-effort and never throws at the caller. A CRM write
 * failing must not break a live conversation: the booking is already made, and
 * a missing tag is recoverable where a dropped call is not.
 */
export class CrmSync {
  constructor(
    private readonly client: GhlClient = new GhlClient(),
    private readonly onError: (err: unknown, op: string) => void = () => {},
  ) {}

  private async attempt(op: string, work: () => Promise<unknown>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (err) {
      this.onError(err, op);
      return false;
    }
  }

  /**
   * Create or match a contact. GHL's upsert matches on email/phone, so calling
   * this repeatedly for the same person is safe.
   *
   * `defaultFirstName` exists to prevent a real data-loss bug. The booking path
   * wants `"Guest"` when no name was given. On any other path that default is
   * destructive: an enquiry with a phone but no name would match an existing
   * customer and **rename them to "Guest"**. So callers that may not have a name
   * pass nothing, and `firstName` is omitted entirely.
   */
  async upsertContact(input: {
    fullName?: string;
    email?: string;
    phone?: string;
    fields?: Record<string, string>;
    defaultFirstName?: string;
  }): Promise<string | null> {
    const { firstName, lastName } = splitName(input.fullName, input.defaultFirstName);

    try {
      const res = await this.client.request<{ contact?: { id?: string }; id?: string }>(
        paths.upsertContact(),
        {
          method: "POST",
          body: {
            locationId: this.client.env.locationId,
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
            phone: normalizePhone(input.phone),
            email: input.email?.trim() || undefined,
            ...(input.fields && Object.keys(input.fields).length
              ? {
                  customFields: Object.entries(input.fields)
                    .filter(([, v]) => v != null && v !== "")
                    .map(([key, value]) => ({ key, field_value: value })),
                }
              : {}),
          },
        },
      );
      return res.contact?.id ?? res.id ?? null;
    } catch (err) {
      this.onError(err, "upsertContact");
      return null;
    }
  }

  async addTags(contactId: string, tags: string[]): Promise<boolean> {
    if (!tags.length) return true;
    return this.attempt("addTags", () =>
      this.client.request(paths.addTags(contactId), {
        method: "POST",
        body: { tags },
      }),
    );
  }

  /**
   * Score as a tag rather than a custom field, deliberately: tags exist on every
   * GHL account with no setup, whereas a `lead_score` custom field has to be
   * created by hand first — and right now the account has none, so a field write
   * would silently go nowhere.
   */
  async writeScore(contactId: string, score: LeadScore, reason?: string): Promise<boolean> {
    const ok = await this.addTags(contactId, [`lead-${score}`, "ai-qualified"]);
    if (reason) {
      await this.addNote(contactId, `Scored ${score.toUpperCase()} — matched rule: ${reason}`);
    }
    return ok;
  }

  async addNote(contactId: string, body: string): Promise<boolean> {
    return this.attempt("addNote", () =>
      this.client.request(paths.addNote(contactId), { method: "POST", body: { body } }),
    );
  }

  /**
   * Human handoff, made real. Until now this only wrote to the console, so a
   * caller asking for a person produced nothing anyone would ever see.
   */
  async flagForHuman(
    contactId: string,
    reason: string,
    summary: string,
  ): Promise<boolean> {
    const tagged = await this.addTags(contactId, ["needs-human", "ai-handoff"]);
    await this.addNote(
      contactId,
      `HANDOFF REQUESTED\nWhy: ${reason}\nWhat they need: ${summary}\n\n` +
        `Call them back — they asked for a person and were told someone would ring.`,
    );
    return tagged;
  }

  /**
   * Moves an existing deal. Needed because the common path isn't one-shot:
   * someone enquires today (New Enquiry) and books on Thursday, and the deal
   * has to follow them rather than a second one appearing.
   */
  async moveToStage(opportunityId: string, outcome: OpportunityOutcome): Promise<boolean> {
    const stageId = this.stageFor(outcome);
    if (!stageId) return false;

    /**
     * `pipelineId` is sent alongside the stage, which it previously was not.
     * Both are independently optional on GHL's side, so a stage-only update can
     * leave the record pointing at one pipeline with a stage belonging to
     * another. Only one pipeline exists on this account, which is exactly why
     * the omission was invisible — and why it would have surfaced later, on
     * someone else's data.
     *
     * Signature and the `moveToStage` error label are unchanged: this stays
     * best-effort and non-throwing for the live agent path.
     */
    const pipelineId = process.env.GHL_PIPELINE_ID?.trim();

    return this.attempt("moveToStage", () =>
      this.client.request(paths.opportunity(opportunityId), {
        method: "PUT",
        body: {
          pipelineStageId: stageId,
          ...(pipelineId ? { pipelineId } : {}),
        },
      }),
    );
  }

  /** Saves the transcript so a human picking this up doesn't make them repeat it. */
  async saveTranscript(
    contactId: string,
    messages: { role: string; text: string }[],
  ): Promise<boolean> {
    if (!messages.length) return true;
    const body = [
      "AI CONVERSATION TRANSCRIPT",
      "",
      ...messages.map((m) => `${speakerLabel(m.role)}: ${m.text}`),
    ].join("\n");
    return this.addNote(contactId, body);
  }

  /**
   * Which stage a deal belongs in, given what actually happened.
   *
   * A booked guest sitting in "New Enquiry" is worse than cosmetic — the whole
   * point of the pipeline board is that a human can see at a glance who needs
   * chasing, and a confirmed booking filed under new enquiries either gets
   * chased pointlessly or buries the ones that do need it.
   *
   * Falls back to the New stage when a specific one isn't configured, so a
   * missing env var means "slightly wrong column", never "no deal at all".
   */
  private stageFor(outcome: OpportunityOutcome): string | undefined {
    const stage = {
      booked: process.env.GHL_STAGE_BOOKED,
      qualified: process.env.GHL_STAGE_QUALIFIED,
      lost: process.env.GHL_STAGE_LOST,
      new: process.env.GHL_STAGE_NEW,
    }[outcome];

    return (
      stage ?? process.env.GHL_STAGE_NEW ?? process.env.GHL_PIPELINE_STAGE_NEW ?? undefined
    );
  }

  /**
   * Creates the opportunity and drops it in the stage that matches what
   * happened, so the deal is visible on the pipeline board in the right column.
   */
  async createOpportunity(opts: {
    contactId: string;
    name: string;
    score: LeadScore;
    /** What actually happened. Decides the stage. */
    outcome?: OpportunityOutcome;
    monetaryValue?: number;
  }): Promise<string | null> {
    const pipelineId = process.env.GHL_PIPELINE_ID;
    const stageId = this.stageFor(opts.outcome ?? "new");
    if (!pipelineId || !stageId) return null;

    try {
      const res = await this.client.request<{ opportunity?: { id?: string }; id?: string }>(
        paths.createOpportunity(),
        {
          method: "POST",
          body: {
            locationId: this.client.env.locationId,
            pipelineId,
            pipelineStageId: stageId,
            contactId: opts.contactId,
            name: opts.name,
            status: "open",
            ...(opts.monetaryValue ? { monetaryValue: opts.monetaryValue } : {}),
          },
        },
      );
      return res.opportunity?.id ?? res.id ?? null;
    } catch (err) {
      /**
       * GHL refuses a second open opportunity for the same contact. On a merged
       * lead that's the normal case, not a failure — the person already has a
       * deal on the board, which is exactly what we wanted. Logging it as an
       * error trains people to ignore the error log.
       */
      if (String(err).includes("duplicate opportunity")) return null;
      this.onError(err, "createOpportunity");
      return null;
    }
  }
}
