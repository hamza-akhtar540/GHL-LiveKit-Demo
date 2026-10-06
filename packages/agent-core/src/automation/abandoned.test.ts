import { describe, expect, it } from "vitest";
import type { Conversation } from "../conversation/types.js";
import { dueTrigger, runAbandonedFollowUps } from "./abandoned.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-07-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function convo(over: Partial<Conversation> & { id: string; ageMs: number }): Conversation {
  const { ageMs, ...rest } = over;
  return {
    industry: "hotel",
    channel: "chat",
    contactId: "c1",
    contact: { email: "daniel@example.com", full_name: "Daniel" },
    messages: [{ role: "caller", text: "do you have a suite?", at: ago(ageMs) }],
    outcome: "abandoned",
    createdAt: ago(ageMs + HOUR),
    updatedAt: ago(ageMs),
    ...rest,
  } as Conversation;
}

function run(list: Conversation[], existingEmails: string[] = []) {
  const sent: { leadId: string; trigger: string }[] = [];
  return {
    sent,
    result: runAbandonedFollowUps({
      conversations: { recent: async () => list } as never,
      store: { getEmail: async (id: string) => (existingEmails.includes(id) ? ({} as never) : null) } as never,
      followUp: {
        send: async (o: { leadId: string; trigger: string }) => {
          sent.push({ leadId: o.leadId, trigger: o.trigger });
          return { status: "sent" };
        },
      } as never,
      now: () => NOW,
    }),
  };
}

describe("dueTrigger", () => {
  it.each([
    [30 * 60_000, undefined],
    [2 * HOUR, "abandoned_1h"],
    [30 * HOUR, "abandoned_24h"],
    [80 * HOUR, "abandoned_3d"],
    [8 * 24 * HOUR, undefined],
  ])("age %i ms → %s", (age, expected) => {
    expect(dueTrigger(convo({ id: "x", ageMs: age }), NOW)).toBe(expected);
  });
});

describe("runAbandonedFollowUps", () => {
  it("sends the rung that is due, from the chat's own lead id", async () => {
    const { sent, result } = run([convo({ id: "a", ageMs: 2 * HOUR })]);
    await result;
    expect(sent).toEqual([{ leadId: "chat:a", trigger: "abandoned_1h" }]);
  });

  it("jumps to the highest due rung instead of sending every missed one", async () => {
    const { sent, result } = run([convo({ id: "a", ageMs: 80 * HOUR })]);
    await result;
    expect(sent.map((s) => s.trigger)).toEqual(["abandoned_3d"]);
  });

  it("does not compose again when a row for that rung already exists", async () => {
    const { sent, result } = run([convo({ id: "a", ageMs: 2 * HOUR })], ["chat:a:abandoned_1h"]);
    await result;
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["booked", { outcome: "booked" as const }],
    ["handed off to a human", { outcome: "handed_off" as const }],
    ["has a booking code", { bookingCode: "BK-1" }],
    ["no email", { contact: { full_name: "Daniel" } }],
    ["no CRM contact yet", { contactId: undefined }],
    ["caller never spoke", { messages: [{ role: "agent" as const, text: "hi", at: ago(2 * HOUR) }] }],
  ])("skips a conversation that is %s", async (_label, over) => {
    const { sent, result } = run([convo({ id: "a", ageMs: 2 * HOUR, ...over })]);
    await result;
    expect(sent).toHaveLength(0);
  });

  it("skips someone who came back in a newer conversation", async () => {
    const { sent, result } = run([
      convo({ id: "old", ageMs: 5 * HOUR }),
      convo({ id: "new", ageMs: 10 * 60_000 }),
    ]);
    await result;
    expect(sent).toHaveLength(0);
  });

  it("skips someone who has booked in any conversation", async () => {
    const { sent, result } = run([
      convo({ id: "old", ageMs: 5 * HOUR }),
      convo({ id: "booked", ageMs: 4 * HOUR, outcome: "booked", bookingCode: "BK-9", contact: { email: "daniel@example.com" } }),
    ]);
    await result;
    expect(sent).toHaveLength(0);
  });
});
