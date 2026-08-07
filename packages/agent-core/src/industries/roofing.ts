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
    timezone: "America/Chicago",
  },
  services: [
    "Roof replacement",
    "Storm & hail damage repair",
    "Leak repair",
    "Free roof inspection",
    "Gutter replacement",
  ],

  knowledge: [
    { topic: "cost of an inspection", answer: "Inspections are free, with no obligation. We'll give you a written assessment either way." },
    { topic: "how long a roof replacement takes", answer: "Most residential replacements are one to two days. Bad weather can push it." },
    { topic: "insurance claims", answer: "We work directly with your insurer and can meet the adjuster at the property. We do not waive deductibles — anyone offering that is committing fraud." },
    { topic: "warranty", answer: "Workmanship is warranted for 10 years. Materials carry the manufacturer's warranty, typically 25 to 50 years depending on the shingle." },
    { topic: "licensing and insurance", answer: "Fully licensed and insured in Texas, and GAF Master Elite certified — that's the top 2% of contractors nationally." },
    { topic: "service area", answer: "Austin and the surrounding metro, roughly 40 miles out. Further than that we'll refer you to someone local." },
    { topic: "emergency tarping", answer: "We can usually tarp an active leak same day to stop the water while a proper repair gets scheduled." },
    { topic: "financing", answer: "Financing is available on replacements. The exact terms come from the estimator, not over the phone." },
    { topic: "how pricing works", answer: "Every roof is priced after an inspection — square footage, pitch, material and damage all change it. Nobody can quote a real number over the phone." },
  ],

  intents: [
    {
      id: "general_enquiry",
      when: "They're asking about the company, the process, warranties, insurance or cost, and haven't asked for an inspection.",
      goal: "Answer it straight. Offer the free inspection only where it genuinely follows — most pricing questions do, since a real number needs a look at the roof.",
    },
    {
      id: "book_inspection",
      when: "They have a roof problem or want it looked at.",
      goal: "Work out what's wrong and how urgent, then get a free inspection on the calendar.",
      books: "inspection",
      collect: [
        { key: "service_type", ask: "What's going on with the roof?", required: true, options: ["replacement", "storm_damage", "leak", "inspection", "gutters"] },
        { key: "property_type", ask: "Is this a home or a commercial building?", required: true, options: ["residential", "commercial"] },
        { key: "urgency", ask: "Is there active leaking or recent storm damage?", required: true, options: ["active_leak", "recent_storm", "no_active_damage"] },
        { key: "timeline", ask: "When are you hoping to get this taken care of?", required: true, options: ["asap", "within_2_weeks", "1_3_months", "just_researching"] },
        { key: "insurance_claim", ask: "Are you planning to file an insurance claim?", required: false, options: ["yes", "no", "unsure"] },
      ],
    },
    {
      id: "emergency",
      when: "Water is coming in right now, or a storm just took part of the roof off.",
      goal: "Treat it as urgent. Mention same-day tarping, get the soonest slot, and take the address and number before anything else.",
      books: "inspection",
    },
    {
      id: "modify_or_cancel",
      when: "They already have an inspection booked and want to change, confirm or cancel it.",
      goal: "Look it up by reference, read it back, then do what they asked.",
    },
  ],

  resources: [
    {
      id: "inspection",
      label: "a free roof inspection",
      durationMin: 60,
      params: [],
      hours: { open: "08:00", close: "17:00" },
      days: [1, 2, 3, 4, 5],
    },
  ],

  contact: [
    { key: "full_name", ask: "Who am I speaking with?", required: true },
    { key: "phone", ask: "What's the best number to confirm on?", required: true },
    { key: "address", ask: "What's the property address?", required: true },
    { key: "email", ask: "And an email for the written confirmation?", required: false },
  ],

  scoring: {
    // Active damage or a filed claim means a real job with a real deadline.
    hot: ["urgency=active_leak", "urgency=recent_storm", "timeline=asap", "insurance_claim=yes"],
    cold: ["timeline=just_researching", "intent=general_enquiry"],
  },

  persona: {
    voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
    tone:
      "Direct and practical, like a good foreman. Short sentences. No corporate filler, " +
      "no over-apologising. Confident about scheduling — assume they want it handled.",
  },
};
