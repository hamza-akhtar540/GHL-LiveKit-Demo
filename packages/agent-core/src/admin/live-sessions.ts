import { RoomServiceClient } from "livekit-server-sdk";
import { TrackType } from "@livekit/protocol";

/**
 * Active LiveKit rooms — genuinely realtime, not polled off our own database.
 *
 * This is the one part of the dashboard that doesn't go through Postgres or
 * GHL: it asks LiveKit's server API directly which rooms exist right now and
 * who is in them. A room with two participants (a `visitor-*` identity and the
 * agent) is a live call in progress — this is "agent and client realtime" made
 * literal rather than inferred from a transcript.
 */
export interface LiveParticipant {
  identity: string;
  name?: string;
  joinedAt?: string;
  /** Whether they've published a microphone — the thing that decides if they're speaking. */
  hasAudio: boolean;
}

export interface LiveRoom {
  name: string;
  numParticipants: number;
  createdAt?: string;
  participants: LiveParticipant[];
}

export class LiveSessions {
  private readonly client: RoomServiceClient;

  constructor(
    url = process.env.LIVEKIT_URL,
    apiKey = process.env.LIVEKIT_API_KEY,
    apiSecret = process.env.LIVEKIT_API_SECRET,
  ) {
    if (!url || !apiKey || !apiSecret) {
      throw new Error("LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET not set — needed for LiveSessions");
    }
    // The server SDK wants http(s), not the ws(s) URL clients connect with.
    const httpUrl = url.replace(/^ws/, "http");
    this.client = new RoomServiceClient(httpUrl, apiKey, apiSecret);
  }

  async list(): Promise<LiveRoom[]> {
    const rooms = await this.client.listRooms();

    return Promise.all(
      rooms.map(async (room) => {
        // A room's participant list is a second call; fetched per-room rather
        // than assumed from `numParticipants` because we need identities, not
        // just a count.
        let participants: LiveParticipant[] = [];
        try {
          const raw = await this.client.listParticipants(room.name);
          participants = raw.map((p) => ({
            identity: p.identity,
            name: p.name || undefined,
            // `joinedAtMs` over `joinedAt` (seconds) — no precision lost converting.
            joinedAt: p.joinedAtMs ? new Date(Number(p.joinedAtMs)).toISOString() : undefined,
            // TrackType.AUDIO === 0. Muted still counts as "has a mic" — it's
            // published, just silenced, which is different from never joining audio.
            hasAudio: p.tracks.some((t) => t.type === TrackType.AUDIO),
          }));
        } catch {
          // The room can disappear between listRooms() and here if a call just
          // ended — an empty participant list is the correct answer, not an error.
        }

        return {
          name: room.name,
          numParticipants: room.numParticipants,
          createdAt: room.creationTimeMs ? new Date(Number(room.creationTimeMs)).toISOString() : undefined,
          participants,
        };
      }),
    );
  }
}
