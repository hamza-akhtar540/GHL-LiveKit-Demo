/**
 * Every business-specific string lives in a config object, so a new vertical is
 * a config, not a fork. If a second vertical takes more than a couple of hours,
 * this boundary has leaked.
 *
 * The shape is deliberately not a funnel. A caller who has to answer five
 * qualifying questions before anyone will tell them the check-out time will hang
 * up. So the config describes what the business *is* and what a caller can
 * *want*, and the agent navigates between them — answering, checking, booking,
 * or changing something, in whatever order the conversation actually goes.
 */

export interface Field {
  /** Maps 1:1 to a CRM custom field key. */
  key: string;
  /** Natural-language prompt — the agent rephrases, it doesn't read this verbatim. */
  ask: string;
  required: boolean;
  /** Optional closed set; free text when omitted. */
  options?: string[];
}

/**
 * A grounded fact. The agent answers business questions from these and nothing
 * else — anything not here is "let me have someone confirm that". This is the
 * whole defence against an agent that invents a pet policy.
 */
export interface Fact {
  /** What this covers. Used by the agent to find it, not read aloud. */
  topic: string;
  answer: string;
}

/** Something that can be reserved. A hotel has several; a roofer has one. */
export interface Resource {
  id: string;
  /** How the agent refers to it: "a table", "a room". */
  label: string;
  durationMin: number;
  /** Booking parameters beyond a time — party size, nights, room type. */
  params: Field[];
  /** Operating window in business-local time, 24h. */
  hours: { open: string; close: string };
  /** 0 = Sunday. Omit for every day. */
  days?: number[];
}

/**
 * A thing a caller can want. The agent picks based on `when`, so these are
 * written as recognisable situations rather than intent labels.
 */
export interface Intent {
  id: string;
  /** When this applies, in plain language. The agent routes on this. */
  when: string;
  /** What a good outcome looks like. */
  goal: string;
  /** Resource id, when this intent ends in a reservation. */
  books?: string;
  /** Collected before the agent commits to anything. */
  collect?: Field[];
}

export interface IndustryConfig {
  id: string;
  business: {
    name: string;
    city: string;
    phone: string;
    /** One or two lines of context the agent can draw on for credibility. */
    blurb: string;
    timezone: string;
  };
  services: string[];
  knowledge: Fact[];
  intents: Intent[];
  resources: Resource[];
  /** Identity and reachability. Required before any booking is confirmed. */
  contact: Field[];
  /** Predicates over collected answers, evaluated top-down; first match wins. */
  scoring: {
    hot: string[];
    cold: string[];
  };
  persona: {
    /** TTS voice id. */
    voice: string;
    tone: string;
  };
}
