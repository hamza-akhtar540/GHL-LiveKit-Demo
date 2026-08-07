import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Conversation, ConversationStore, Message } from "./types.js";

/**
 * One JSON file per conversation, in a directory. Chosen over a database on
 * purpose: no DATABASE_URL to provision, transcripts are readable on disk while
 * tuning, and it swaps for a real store behind the interface when a client
 * needs volume. Not for production concurrency — a demo has one conversation at
 * a time, which is exactly what this handles.
 *
 * Timestamps are passed in by the caller, never generated here. The worker has
 * a real clock; keeping this store clock-free makes it deterministic to test.
 */
export class FileConversationStore implements ConversationStore {
  readonly kind = "file" as const;

  constructor(private readonly dir: string) {}

  private path(id: string): string {
    // Ids come from us (room names, contact ids), but never trust a path.
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return resolve(this.dir, `${safe}.json`);
  }

  async open(
    id: string,
    seed: Pick<Conversation, "industry" | "channel">,
    now = new Date().toISOString(),
  ): Promise<Conversation> {
    const existing = await this.get(id);
    if (existing) return existing;

    const convo: Conversation = {
      id,
      industry: seed.industry,
      channel: seed.channel,
      contact: {},
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.write(convo);
    return convo;
  }

  async append(id: string, message: Message): Promise<void> {
    const convo = await this.get(id);
    if (!convo) throw new Error(`No conversation ${id}; open() it first`);
    convo.messages.push(message);
    convo.updatedAt = message.at;
    await this.write(convo);
  }

  async update(id: string, patch: Partial<Omit<Conversation, "id" | "messages">>): Promise<void> {
    const convo = await this.get(id);
    if (!convo) throw new Error(`No conversation ${id}; open() it first`);
    // Contact fields merge rather than replace — later turns add, don't erase.
    const contact = { ...convo.contact, ...(patch.contact ?? {}) };
    Object.assign(convo, patch, { contact, id: convo.id, messages: convo.messages });
    await this.write(convo);
  }

  async get(id: string): Promise<Conversation | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as Conversation;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async recent(limit = 50): Promise<Conversation[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const all = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map((n) => this.get(n.slice(0, -5))),
    );
    return all
      .filter((c): c is Conversation => c !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  private async write(convo: Conversation): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(convo.id), JSON.stringify(convo, null, 2), "utf8");
  }
}
