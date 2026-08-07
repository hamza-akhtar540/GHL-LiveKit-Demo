/**
 * Social posting and analytics.
 *
 *   pnpm --filter @ghl-lk/agent-core social draft     # generate + save as drafts
 *   pnpm --filter @ghl-lk/agent-core social schedule  # generate + schedule for the best time
 *   pnpm --filter @ghl-lk/agent-core social collect   # snapshot today's analytics
 *   pnpm --filter @ghl-lk/agent-core social insights  # best day to post
 *   pnpm --filter @ghl-lk/agent-core social accounts  # what's connected
 *   pnpm --filter @ghl-lk/agent-core social publish --yes   # go live immediately
 *
 * `draft` is the default. `publish` posts to real accounts immediately and
 * cannot be undone for anyone who already saw it, so it needs --yes. `schedule`
 * is real too — the post WILL go live at the chosen time — but a scheduled post
 * can still be cancelled from GHL's Social Planner before it fires, which
 * `publish` cannot, so it doesn't require --yes.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const { SocialPublisher } = await import("../src/social/publisher.js");
const { SocialClient } = await import("../src/social/client.js");
const { SocialStore } = await import("../src/social/store.js");
const { PgConversationStore } = await import("../src/conversation/pg-store.js");
const { getIndustry } = await import("../src/industries/index.js");

const command = process.argv[2] ?? "draft";
const cfg = getIndustry(process.env.INDUSTRY ?? "roofing");

const client = new SocialClient();

if (command === "accounts") {
  const accounts = await client.accounts();
  console.log(`\n${accounts.length} connected account(s):\n`);
  for (const a of accounts) {
    const expires = a.expire ? new Date(a.expire).toISOString().slice(0, 10) : "?";
    console.log(
      `  ${a.platform.padEnd(10)} ${a.name.padEnd(22)} stats=${a.hasStatisticsPermissions ? "yes" : "no "}  expires ${expires}`,
    );
  }
  console.log();
  process.exit(0);
}

const store = new SocialStore();
const conversations = new PgConversationStore();
const publisher = new SocialPublisher({
  cfg,
  conversations,
  store,
  client,
  onLog: (msg, data) => console.log(`  · ${msg}`, data ? JSON.stringify(data) : ""),
});

if (command === "collect") {
  const out = await publisher.collectStats();
  console.log(`\nsnapshotted ${out.length} account(s)`);
  for (const o of out) console.log(`  ${o.platform.padEnd(10)} ${o.days} day(s)`);
} else if (command === "insights") {
  const { ready, days, ranking } = await publisher.bestDays();
  console.log(`\n${days} day(s) of data collected\n`);

  if (!ranking.length) {
    console.log("  Nothing yet. Run `social collect` after posting for a while.\n");
  } else {
    for (const r of ranking) {
      console.log(
        `  ${r.name.padEnd(10)} score ${String(r.score).padStart(6)}   ` +
          `impressions ${r.avgImpressions}  likes ${r.avgLikes}  comments ${r.avgComments}  (${r.days}d)`,
      );
    }
  }

  console.log(
    ready
      ? `\n  Best day: ${ranking[0]?.name}. Enough data to act on.\n`
      : `\n  NOT ENOUGH DATA to call a best day yet — need ~20 days, have ${days}.\n` +
        `  The ranking above is real but it is noise at this sample size.\n`,
  );
} else if (command === "schedule") {
  const { results, scheduledForDisplay, usedLearnedData, dataDays } = await publisher.scheduleAtBestTime();

  console.log(`\nScheduled for ${scheduledForDisplay}`);
  console.log(
    usedLearnedData
      ? `Chosen from ${dataDays} days of collected engagement data.`
      : `NOT based on learned data — only ${dataDays} day(s) collected so far (need ~20). ` +
        `Defaulted to tomorrow rather than guess. Run \`social collect\` regularly to build up real data.\n`,
  );

  for (const r of results) {
    console.log("─".repeat(72));
    console.log(`${r.platform.toUpperCase()}  ·  ${r.topic}  ·  asked by ${r.askedBy} caller(s)  ·  ${r.status}`);
    if (r.error) console.log(`  ERROR: ${r.error.slice(0, 200)}`);
    if (r.text) console.log(`\n${r.text}\n`);
  }
  console.log("These will post automatically. Cancel from GHL → Social Planner if needed.\n");
} else {
  const live = command === "publish" && process.argv.includes("--yes");
  if (command === "publish" && !live) {
    console.log("\nRefusing to publish without --yes. This posts to real accounts.\n");
    process.exit(1);
  }

  const results = await publisher.publish({ status: live ? "published" : "draft" });
  console.log(`\n${live ? "PUBLISHED" : "Drafted"} ${results.length} post(s):\n`);

  for (const r of results) {
    console.log("─".repeat(72));
    console.log(`${r.platform.toUpperCase()}  ·  ${r.topic}  ·  asked by ${r.askedBy} caller(s)  ·  ${r.status}`);
    if (r.error) console.log(`  ERROR: ${r.error.slice(0, 200)}`);
    if (r.text) console.log(`\n${r.text}\n`);
  }
  if (!live) console.log("Drafts are in GHL under Marketing → Social Planner.\n");
}

await store.close();
await conversations.close();
