import type { IndustryConfig } from "./types.js";
import { roofing } from "./roofing.js";
import { hotel } from "./hotel.js";

/**
 * Adding a vertical means adding a file and a line here. If it ever needs more
 * than that, the config boundary has leaked and the fix belongs in types.ts.
 */
export const industries: Record<string, IndustryConfig> = {
  [roofing.id]: roofing,
  [hotel.id]: hotel,
};

export function getIndustry(id: string): IndustryConfig {
  const cfg = industries[id];
  if (!cfg) {
    throw new Error(`Unknown industry "${id}". Available: ${Object.keys(industries).join(", ")}`);
  }
  return cfg;
}
