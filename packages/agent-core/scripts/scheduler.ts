/**
 * The automation runner as a standalone process.
 *
 *   pnpm --filter @ghl-lk/agent-core scheduler          # dry run — says what it WOULD do
 *   pnpm --filter @ghl-lk/agent-core scheduler --write  # actually does it
 *
 * You normally don't need this: the web server starts the same jobs at boot.
 * This exists for running the jobs on a different machine from the website, or
 * for a dry run.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { startAutomation } = await import("../src/automation/runner.js");
const { getIndustry } = await import("../src/industries/index.js");

const write = process.argv.includes("--write");
const once = process.argv.includes("--once");
const cfg = getIndustry(process.env.INDUSTRY ?? "roofing");

console.log(`\nAutomation ${write ? "RUNNING" : "in DRY RUN (pass --write to act)"} — industry "${cfg.id}"\n`);
const automation = await startAutomation({ cfg, write, once });
for (const j of automation.jobs) {
  console.log(`  ${j.name.padEnd(14)} every ${Math.round(j.everyMs / 60_000)} min${j.note ? `  (${j.note})` : ""}`);
}
console.log();

if (!once) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} — closing`);
      void automation.stop().then(() => process.exit(0));
    });
  }
}
