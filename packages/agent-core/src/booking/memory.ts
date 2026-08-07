import type {
  AvailabilityQuery,
  Booking,
  BookingRequest,
  BookingStore,
  Slot,
} from "./types.js";
import type { Resource } from "../industries/types.js";

/**
 * In-memory availability. Exists so the whole conversation — enquiry, check,
 * book, change — can be exercised and tuned before any CRM is connected.
 *
 * It is not a stub that returns fixed strings: it holds real state, so double
 * booking the same slot fails the way it would in production. That matters,
 * because "the slot you wanted just went" is a conversation path that needs
 * tuning too, and it is the one nobody remembers to test.
 */

const PART_OF_DAY: Record<string, [number, number]> = {
  morning: [0, 12],
  afternoon: [12, 17],
  evening: [17, 24],
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Confirmation codes get read aloud, so no 0/O or 1/I/L. */
const CODE_ALPHABET = "23456789ACDEFGHJKMNPQRTUVWXYZ";

function makeCode(seed: number): string {
  let out = "";
  let n = seed;
  for (let i = 0; i < 6; i++) {
    out += CODE_ALPHABET[n % CODE_ALPHABET.length];
    n = Math.floor(n / CODE_ALPHABET.length) + 7919 * (i + 1);
  }
  return out;
}

export class MemoryBookingStore implements BookingStore {
  readonly kind = "memory" as const;

  private readonly bookings = new Map<string, Booking>();
  private readonly resources: Map<string, Resource>;
  private seq = 0;

  constructor(resources: Resource[]) {
    this.resources = new Map(resources.map((r) => [r.id, r]));
  }

  async findSlots(query: AvailabilityQuery): Promise<Slot[]> {
    const resource = this.resources.get(query.resourceId);
    if (!resource) return [];

    const day = new Date(`${query.date}T00:00:00`);
    if (Number.isNaN(day.getTime())) return [];
    if (resource.days && !resource.days.includes(day.getDay())) return [];

    const [openH = 9] = resource.hours.open.split(":").map(Number);
    const [closeH = 17] = resource.hours.close.split(":").map(Number);
    const [fromH, toH] = query.partOfDay ? (PART_OF_DAY[query.partOfDay] ?? [0, 24]) : [0, 24];

    const stepMin = resource.durationMin;
    const slots: Slot[] = [];

    for (let m = openH * 60; m + stepMin <= closeH * 60; m += stepMin) {
      const h = Math.floor(m / 60);
      if (h < fromH || h >= toH) continue;

      const start = `${query.date}T${pad(h)}:${pad(m % 60)}:00`;
      if (this.isTaken(resource.id, start)) continue;

      const endMin = m + stepMin;
      slots.push({
        start,
        end: `${query.date}T${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}:00`,
        label: new Date(start).toLocaleString("en-US", {
          weekday: "long",
          hour: "numeric",
          minute: m % 60 ? "2-digit" : undefined,
        }),
      });
    }

    // Two or three concrete options is a conversation. Ten is a menu, and a
    // menu read aloud is unbearable. `limit` exists for the admin console, which
    // needs a whole day's availability rather than a spoken shortlist — kept in
    // step with the GHL store deliberately, so the two implementations don't
    // answer the same query differently.
    return slots.slice(0, query.limit ?? 3);
  }

  async create(request: BookingRequest): Promise<Booking> {
    const resource = this.resources.get(request.resourceId);
    if (!resource) throw new Error(`Unknown resource ${request.resourceId}`);
    if (this.isTaken(request.resourceId, request.start)) {
      throw new Error("That time was taken while we were talking.");
    }

    const end = new Date(new Date(request.start).getTime() + resource.durationMin * 60_000);
    const booking: Booking = {
      ...request,
      code: makeCode(++this.seq * 104_729),
      status: "confirmed",
      end: end.toISOString(),
    };
    this.bookings.set(booking.code, booking);
    return booking;
  }

  async find(code: string): Promise<Booking | null> {
    return this.bookings.get(code.trim().toUpperCase()) ?? null;
  }

  async cancel(code: string): Promise<Booking | null> {
    const booking = await this.find(code);
    if (!booking) return null;
    const cancelled: Booking = { ...booking, status: "cancelled" };
    this.bookings.set(cancelled.code, cancelled);
    return cancelled;
  }

  private isTaken(resourceId: string, start: string): boolean {
    for (const b of this.bookings.values()) {
      if (b.status === "confirmed" && b.resourceId === resourceId && b.start === start) return true;
    }
    return false;
  }
}
