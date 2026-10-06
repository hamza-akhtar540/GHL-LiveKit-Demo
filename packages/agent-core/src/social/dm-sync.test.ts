import { describe, expect, it } from "vitest";
import type { Conversation, ConversationStore, Message } from "../conversation/types.js";
import { LeadIngestor } from "../leads/ingest.js";
import { MemoryLeadStore } from "../leads/store.js";
import { hotel } from "../industries/hotel.js";
import { syncSocialDms } from "./dm-sync.js";

/** Just enough of a store: keyed rows, append, update, get. */
function memoryConversations(): ConversationStore {
  const rows = new Map<string, Conversation>();
  return {
    kind: "memory",
    async open(id, seed) {
      if (!rows.has(id)) {
        const now = new Date().toISOString();
        rows.set(id, { id, ...seed, contact: {}, messages: [], createdAt: now, updatedAt: now });
      }
      return rows.get(id)!;
    },
    async append(id, m: Message) {
      rows.get(id)!.messages.push(m);
    },
    async update(id, patch) {
      Object.assign(rows.get(id)!, patch, { contact: { ...rows.get(id)!.contact, ...(patch.contact ?? {}) } });
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async recent() {
      return [...rows.values()];
    },
  };
}

/** A fake GHL: one Instagram thread and one Facebook thread. */
function fakeGhl(state: { ig: { id: string; body: string; dir: string; at: string }[] }) {
  const calls: string[] = [];
  const convo = (type: string) => ({
    id: type === "TYPE_INSTAGRAM" ? "conv-ig" : "conv-fb",
    contactId: type === "TYPE_INSTAGRAM" ? "contact-ig" : "contact-fb",
    fullName: type === "TYPE_INSTAGRAM" ? "Sara Khan" : undefined,
    lastMessageDate: Math.max(
      ...(type === "TYPE_INSTAGRAM" ? state.ig : [{ at: "2026-10-01T10:00:00Z" }]).map((m) => new Date(m.at).getTime()),
    ),
  });
  return {
    calls,
    env: { locationId: "loc" },
    async get(path: string, query: Record<string, unknown> = {}) {
      calls.push(path);
      if (path === "/conversations/search") {
        return { conversations: query.lastMessageType === "TYPE_INSTAGRAM" || query.lastMessageType === "TYPE_FACEBOOK" ? [convo(String(query.lastMessageType))] : [] };
      }
      if (path === "/conversations/conv-ig/messages") {
        return { messages: { messages: state.ig.map((m) => ({ id: m.id, body: m.body, direction: m.dir, dateAdded: m.at, messageType: "TYPE_INSTAGRAM" })) } };
      }
      if (path === "/conversations/conv-fb/messages") {
        return { messages: { messages: [
          { id: "f1", body: "Is parking free?", direction: "inbound", dateAdded: "2026-10-01T10:00:00Z", messageType: "TYPE_FACEBOOK" },
          { id: "f2", body: "appointment created", direction: "outbound", dateAdded: "2026-10-01T10:01:00Z", messageType: "TYPE_ACTIVITY_APPOINTMENT" },
        ] } };
      }
      if (path.startsWith("/contacts/")) return { contact: { firstName: "Fiona", lastName: "Bell", source: "facebook", tags: ["vip"] } };
      throw new Error(`unexpected ${path}`);
    },
  };
}

const setup = () => {
  const conversations = memoryConversations();
  const leads = new MemoryLeadStore();
  const ingestor = new LeadIngestor({ store: leads, conversations, cfg: hotel });
  return { conversations, leads, ingestor };
};

const IG0 = [{ id: "m1", body: "Hi, any suite on the 26th?", dir: "inbound", at: "2026-10-05T10:00:00Z" }];

describe("syncSocialDms", () => {
  it("stores the thread and creates one lead per person", async () => {
    const s = setup();
    const state = { ig: [...IG0, { id: "m2", body: "Yes! Two nights?", dir: "outbound", at: "2026-10-05T10:01:00Z" }] };
    const r = await syncSocialDms({ ...s, ghl: fakeGhl(state) as never, industry: "hotel" });

    expect(r.newLeads).toBe(2);
    const ig = await s.conversations.get("ghl-conv-ig");
    expect(ig?.channel).toBe("instagram");
    expect(ig?.contact.full_name).toBe("Sara Khan");
    // Inbound is the person; outbound is staff, never the AI agent.
    expect(ig?.messages.map((m) => m.role)).toEqual(["caller", "admin"]);

    const rows = await s.leads.recent();
    expect(rows.map((x) => x.source).sort()).toEqual(["facebook_dm", "instagram_dm"]);
  });

  it("takes the person's details from the contact record when the search row lacks them", async () => {
    const s = setup();
    await syncSocialDms({ ...s, ghl: fakeGhl({ ig: IG0 }) as never, industry: "hotel" });
    expect((await s.conversations.get("ghl-conv-fb"))?.contact.full_name).toBe("Fiona Bell");
  });

  it("drops system activity records from the transcript", async () => {
    const s = setup();
    await syncSocialDms({ ...s, ghl: fakeGhl({ ig: IG0 }) as never, industry: "hotel" });
    expect((await s.conversations.get("ghl-conv-fb"))?.messages.map((m) => m.text)).toEqual(["Is parking free?"]);
  });

  it("adds only new messages on the next run, and no second lead", async () => {
    const s = setup();
    const state = { ig: [...IG0] };
    await syncSocialDms({ ...s, ghl: fakeGhl(state) as never, industry: "hotel" });

    state.ig.push({ id: "m3", body: "It's for Friday and Saturday", dir: "inbound", at: "2026-10-05T11:00:00Z" });
    const r = await syncSocialDms({ ...s, ghl: fakeGhl(state) as never, industry: "hotel" });

    expect(r.newMessages).toBe(1);
    expect(r.newLeads).toBe(0);
    expect((await s.conversations.get("ghl-conv-ig"))?.messages).toHaveLength(2);
    expect((await s.leads.recent()).filter((x) => x.source === "instagram_dm")).toHaveLength(1);
  });

  it("does not refetch a thread that has not changed", async () => {
    const s = setup();
    const state = { ig: [...IG0] };
    await syncSocialDms({ ...s, ghl: fakeGhl(state) as never, industry: "hotel" });
    const second = fakeGhl(state);
    const r = await syncSocialDms({ ...s, ghl: second as never, industry: "hotel" });
    expect(r.synced).toBe(0);
    expect(second.calls.some((c) => c.endsWith("/messages"))).toBe(false);
  });
});
