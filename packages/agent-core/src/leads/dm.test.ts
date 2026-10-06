import { describe, expect, it } from "vitest";
import { LeadIngestor } from "./ingest.js";
import { MemoryLeadStore } from "./store.js";
import { parseGhlWebhook } from "./parsers.js";
import { verifyGhlSecret } from "./http.js";
import { hotel } from "../industries/hotel.js";

const dm = (over: Record<string, unknown> = {}) => ({
  channel: "Instagram DM",
  contact_id: "ghl-contact-1",
  full_name: "Sara Khan",
  message: { body: "Do you have a suite on the 26th?", type: "IG" },
  ...over,
});

describe("parseGhlWebhook — social DMs", () => {
  it("maps the channel to the right source", () => {
    expect(parseGhlWebhook(dm()).source).toBe("instagram_dm");
    expect(parseGhlWebhook(dm({ channel: "Facebook Messenger" })).source).toBe("facebook_dm");
    expect(parseGhlWebhook(dm({ channel: "FB" })).source).toBe("facebook_dm");
  });

  it("keeps the DM text when GHL sends message as an object", () => {
    expect(parseGhlWebhook(dm()).message).toBe("Do you have a suite on the 26th?");
  });

  it("is one lead per person, whatever the message id", () => {
    const a = parseGhlWebhook(dm({ messageId: "m1" }));
    const b = parseGhlWebhook(dm({ messageId: "m2" }));
    expect(a.externalId).toBe("dm:ghl-contact-1");
    expect(b.externalId).toBe(a.externalId);
  });

  it("does not mistake a Facebook Messenger DM for a lead-ad form", () => {
    expect(parseGhlWebhook(dm({ channel: "Facebook Messenger" })).source).not.toBe("facebook_lead_ad");
  });

  it("still treats a plain form as a web form and a Facebook form as a lead ad", () => {
    expect(parseGhlWebhook({ email: "a@b.com", name: "A" }).source).toBe("web_form");
    expect(parseGhlWebhook({ email: "a@b.com", source: "facebook lead form" }).source).toBe("facebook_lead_ad");
  });
});

describe("ingesting a DM with no email or phone", () => {
  const ingestor = () => new LeadIngestor({ store: new MemoryLeadStore(), cfg: hotel });

  it("keeps it, identified by the GHL contact", async () => {
    const r = await ingestor().ingest(parseGhlWebhook(dm()));
    expect(r.status).toBe("created");
    expect(r.contactId).toBe("ghl-contact-1");
  });

  it("treats a second DM from the same person as a duplicate, not a new lead", async () => {
    const ing = ingestor();
    await ing.ingest(parseGhlWebhook(dm({ messageId: "m1" })));
    expect((await ing.ingest(parseGhlWebhook(dm({ messageId: "m2" })))).status).toBe("duplicate");
  });

  it("still rejects a lead with no email, phone or contact id", async () => {
    const r = await ingestor().ingest(parseGhlWebhook({ channel: "Instagram DM", message: "hi" }));
    expect(r.status).toBe("rejected");
  });
});

describe("verifyGhlSecret", () => {
  it("is open when unset, and strict when set", () => {
    delete process.env.GHL_WEBHOOK_SECRET;
    expect(verifyGhlSecret(undefined)).toBe(true);
    process.env.GHL_WEBHOOK_SECRET = "s3cret";
    expect(verifyGhlSecret("s3cret")).toBe(true);
    expect(verifyGhlSecret(undefined, "s3cret")).toBe(true);
    expect(verifyGhlSecret("wrong!")).toBe(false);
    expect(verifyGhlSecret(undefined)).toBe(false);
    delete process.env.GHL_WEBHOOK_SECRET;
  });
});
