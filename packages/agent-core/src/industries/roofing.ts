import type { IndustryConfig } from "./types.js";

export const roofing: IndustryConfig = {
  id: "roofing",
  business: {
    name: "Summit Peak Roofing",
    city: "Austin, TX",
    phone: "(512) 555-0142",
    blurb:
      "Family-owned since 2009. Licensed and insured, GAF Master Elite certified. " +
      "Free inspections, and we work directly with insurance on storm claims.",
  },
  services: [
    "Roof replacement",
    "Storm & hail damage repair",
    "Leak repair",
    "Free roof inspection",
    "Gutter replacement",
  ],
  qualify: [
    {
      key: "service_type",
      ask: "What's going on with the roof?",
      required: true,
      options: ["replacement", "storm_damage", "leak", "inspection", "gutters"],
    },
    {
      key: "property_type",
      ask: "Is this a home or a commercial building?",
      required: true,
      options: ["residential", "commercial"],
    },
    {
      key: "urgency",
      ask: "Is there active leaking or recent storm damage?",
      required: true,
      options: ["active_leak", "recent_storm", "no_active_damage"],
    },
    {
      key: "timeline",
      ask: "When are you hoping to get this taken care of?",
      required: true,
      options: ["asap", "within_2_weeks", "1_3_months", "just_researching"],
    },
    {
      key: "insurance_claim",
      ask: "Are you planning to file an insurance claim on this?",
      required: false,
      options: ["yes", "no", "unsure"],
    },
  ],
  scoring: {
    // Active damage or a filed claim means a real job with a real deadline.
    hot: ["urgency=active_leak", "urgency=recent_storm", "timeline=asap", "insurance_claim=yes"],
    cold: ["timeline=just_researching"],
  },
  persona: {
    voice: "cartesia:friendly-male", // resolved to a real voice id on day 5
    tone:
      "Direct and practical, like a good foreman. Short sentences. No corporate filler, " +
      "no over-apologising. Confident about scheduling — assume they want it handled.",
  },
  calendar: {
    appointmentType: "Free Roof Inspection",
    durationMin: 60,
  },
};
