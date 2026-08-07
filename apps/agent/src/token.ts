/**
 * Mints a join token for manual testing.
 *
 *   pnpm --filter @ghl-lk/agent token [room] [identity]
 *
 * Paste the output into https://agents-playground.livekit.io (Manual connect)
 * to join with a real microphone and exercise the voice path — STT, barge-in,
 * and turn-taking — none of which the terminal chat client can test.
 *
 * Day 4 replaces this with a real endpoint in apps/web. The grants are the same;
 * only the transport differs. Never ship a browser that mints its own token —
 * that requires the API secret client-side, which hands anyone your project.
 */
import { AccessToken } from "livekit-server-sdk";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const room = process.argv[2] ?? `voice-${Date.now()}`;
const identity = process.argv[3] ?? "mic-tester";

const at = new AccessToken(req("LIVEKIT_API_KEY"), req("LIVEKIT_API_SECRET"), {
  identity,
  ttl: "2h",
});
at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });

const token = await at.toJwt();

console.log(`
  room      ${room}
  identity  ${identity}

  url       ${req("LIVEKIT_URL")}

  token
${token}

  Join with a mic:
    1. open https://agents-playground.livekit.io
    2. choose "Manual" connect
    3. paste the url and token above

  Make sure the worker is running first:
    pnpm --filter @ghl-lk/agent dev
`);
