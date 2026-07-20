/**
 * The whole point of this file: every industry-specific string lives in a
 * config object, so a second vertical is a config, not a fork. If day 9's
 * hvac.ts takes more than a couple of hours, this boundary has leaked.
 */

export interface QualifyStep {
  /** Maps 1:1 to a GHL custom field key. */
  key: string;
  /** Natural-language prompt — the agent rephrases, it doesn't read this verbatim. */
  ask: string;
  required: boolean;
  /** Optional closed set; free text when omitted. */
  options?: string[];
}

export interface IndustryConfig {
  id: string;
  business: {
    name: string;
    city: string;
    phone: string;
    /** One or two lines of context the agent can draw on for credibility. */
    blurb: string;
  };
  services: string[];
  qualify: QualifyStep[];
  /** Predicates over collected answers, evaluated top-down; first match wins. */
  scoring: {
    hot: string[];
    cold: string[];
  };
  persona: {
    /** TTS voice id, set on day 5. */
    voice: string;
    tone: string;
  };
  calendar: {
    appointmentType: string;
    durationMin: number;
  };
}
