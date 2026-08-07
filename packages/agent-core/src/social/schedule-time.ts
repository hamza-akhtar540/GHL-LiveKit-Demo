/**
 * Timezone-correct "next occurrence of weekday X at hour H", with no date
 * library. Small enough to hand-roll and get right once, and matches how the
 * rest of this codebase treats time — `todayIn()` in `prompt.ts` uses the same
 * Intl-based approach rather than pulling in a dependency for it.
 */

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Converts a wall-clock time in `timeZone` to the correct UTC instant.
 *
 * The technique: guess the instant assuming the local numbers ARE UTC, then
 * check what wall-clock time that guess actually reads as inside the target
 * zone, and correct by the difference. That difference is the zone's real
 * offset AT THIS SPECIFIC DATE — which is what makes it correct across a DST
 * boundary, unlike a fixed offset table that goes wrong twice a year.
 */
function zonedTimeToUtc(y: number, m: number, d: number, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hour, minute));
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(guess).map((p) => [p.type, p.value]));
  const asIfLocal = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  return new Date(guess.getTime() + (guess.getTime() - asIfLocal));
}

function partsIn(timeZone: string, now: Date): { y: number; m: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(dtf.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    weekday: WEEKDAY_INDEX[parts.weekday ?? "Sun"] ?? 0,
  };
}

/** 0 = Sunday, matching `WeekdayInsight.weekday` from `social/store.ts`. */
export function weekdayIn(timeZone: string, date: Date): number {
  return partsIn(timeZone, date).weekday;
}

/**
 * The next time `targetWeekday` occurs at `hour`:00 in `timeZone`.
 *
 * GHL, like most schedulers, refuses a schedule time that's in the past or too
 * close to now — so "today at 11am" requested at 3pm must roll to next week,
 * not silently schedule something the API will reject.
 */
export function nextOccurrence(
  timeZone: string,
  targetWeekday: number,
  hour: number,
  now = new Date(),
  minLeadMinutes = 30,
): Date {
  const today = partsIn(timeZone, now);
  let daysAhead = (targetWeekday - today.weekday + 7) % 7;

  const candidate = zonedTimeToUtc(today.y, today.m, today.d, hour, 0, timeZone);
  if (daysAhead === 0 && candidate.getTime() - now.getTime() < minLeadMinutes * 60_000) {
    daysAhead = 7;
  }

  // Day-level arithmetic in UTC is safe here — we're counting whole calendar
  // days, not converting a wall-clock instant. The zoned conversion is re-run
  // below for the NEW date, so DST at that future date is what gets applied,
  // not DST today.
  const base = new Date(Date.UTC(today.y, today.m - 1, today.d));
  base.setUTCDate(base.getUTCDate() + daysAhead);
  return zonedTimeToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, 0, timeZone);
}
