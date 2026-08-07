/**
 * Terminal chat client (T3.5). Joins a real LiveKit room as a participant and
 * talks to the worker over the `lk.chat` topic — the same path the browser widget
 * will use on day 4.
 *
 * This exists so prompt tuning happens in a fast loop. Testing the persona in a
 * browser means a page reload per edit; here it's one keystroke.
 *
 *   pnpm --filter @ghl-lk/agent chat
 */
import { Room, RoomEvent } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const roomName = process.argv[2] ?? `cli-${Date.now()}`;
const IDENTITY = "cli-tester";

async function mintToken(identity: string): Promise<string> {
  const at = new AccessToken(req("LIVEKIT_API_KEY"), req("LIVEKIT_API_SECRET"), { identity });
  at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

async function main() {
  const room = new Room();

  // The agent's replies come back as text streams. `lk.transcription` carries
  // both its spoken transcript and its chat text — same stream either way, which
  // is the point of running one session for both modalities.
  // One utterance arrives as several text streams, paced to speech playback
  // (`syncTranscription` is on by default so voice captions line up with audio).
  // That's right for the voice demo but means text trickles in at talking speed
  // here, so buffer until the utterance actually stops rather than printing
  // each fragment. Roughly one speech gap; too low and sentences split.
  const UTTERANCE_SETTLE_MS = 1_500;
  let buffer = "";
  let flushTimer: NodeJS.Timeout | undefined;

  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    if (!text) return;
    process.stdout.write(`\n\x1b[36magent\x1b[0m  ${text}\n\n`);
    if (stdin.isTTY) stdout.write("\x1b[32myou\x1b[0m    ");
  };

  room.registerTextStreamHandler("lk.transcription", async (reader, info) => {
    // Skip anything we sent ourselves. Once a mic is attached our own speech
    // comes back here as STT, and echoing it would double every line. Note the
    // agent's spoken transcript also carries `lk.transcribed_track_id`, so that
    // attribute does NOT distinguish speaker — the participant identity does.
    if (info.identity === IDENTITY) return;
    buffer += await reader.readAll();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, UTTERANCE_SETTLE_MS);
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log("\ndisconnected.");
    process.exit(0);
  });

  await room.connect(req("LIVEKIT_URL"), await mintToken(IDENTITY), {
    autoSubscribe: true,
    dynacast: true,
  });

  console.log(`joined room \x1b[1m${roomName}\x1b[0m — waiting for the agent to pick up.`);
  console.log(`type a message and hit enter. ctrl-c to quit.\n`);

  // Async-iterate rather than question() so a piped stdin (smoke tests, CI)
  // behaves the same as an interactive terminal.
  const interactive = stdin.isTTY;
  const rl = createInterface({ input: stdin, output: stdout });
  if (interactive) stdout.write("\x1b[32myou\x1b[0m    ");

  for await (const line of rl) {
    if (line.trim()) {
      await room.localParticipant!.sendText(line, { topic: "lk.chat" });
    }
    // The next `you` prompt is written by flush() when the agent finishes
    // replying, so the two never race to the same line.
  }

  // Piped input ends the moment the last line is read; the reply is still in
  // flight. Hold the connection open so it can land.
  if (!interactive) {
    await new Promise((r) => setTimeout(r, 30_000));
    await room.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
