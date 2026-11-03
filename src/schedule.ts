export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface ScheduleConfig {
  siteTimeZone: string;
  /** Spacing of the slot grid. Every tier's interval is a multiple of this. */
  gridMinutes: number;
  windowStart: string;
  windowEndExclusive: string;
  days: readonly Weekday[];
}

export interface PlannedSlot {
  scheduledAt: Date;
  localDate: string;
  localTime: string;
  localMinutes: number;
  /** The clocks skipped this local time, so it never happens. */
  nonexistent: boolean;
}

export function parseClock(text: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (match === null) throw new RangeError(`"${text}" is not an HH:MM time`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes > 24 * 60 || Number(match[2]) > 59) throw new RangeError(`"${text}" is not a time of day`);
  return minutes;
}

export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function wallClockMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
}

function offsetMs(instant: Date, timeZone: string): number {
  return wallClockMs(instant, timeZone) - Math.floor(instant.getTime() / 1000) * 1000;
}

export function localParts(instant: Date, timeZone: string): { date: string; minutes: number } {
  const wall = new Date(wallClockMs(instant, timeZone));
  return { date: wall.toISOString().slice(0, 10), minutes: wall.getUTCHours() * 60 + wall.getUTCMinutes() };
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] as Weekday;
}

/** Every instant that local wall time occurs: none if the clocks skip it, two if they repeat it. */
export function localToUtc(date: string, minutes: number, timeZone: string): Date[] {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  const offsets = new Set([offsetMs(new Date(wall - 86_400_000), timeZone), offsetMs(new Date(wall + 86_400_000), timeZone)]);
  const instants = new Set<number>();
  for (const offset of offsets) {
    const candidate = wall - offset;
    if (wallClockMs(new Date(candidate), timeZone) === wall) instants.add(candidate);
  }
  return [...instants].sort((a, b) => a - b).map((ms) => new Date(ms));
}

/**
 * The slot grid for one site-local date. A skipped local time stays on the plan, to be recorded as skipped
 * with a reason. A repeated one runs once, at its first occurrence. The host's time zone plays no part.
 */
export function planDay(date: string, config: ScheduleConfig): PlannedSlot[] {
  if (!config.days.includes(weekdayOf(date))) return [];
  const slots: PlannedSlot[] = [];
  const end = parseClock(config.windowEndExclusive);
  for (let minutes = parseClock(config.windowStart); minutes < end; minutes += config.gridMinutes) {
    const [first] = localToUtc(date, minutes, config.siteTimeZone);
    const wall = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
    slots.push({
      scheduledAt: first ?? new Date(wall - offsetMs(new Date(wall - 86_400_000), config.siteTimeZone)),
      localDate: date,
      localTime: formatClock(minutes),
      localMinutes: minutes,
      nonexistent: first === undefined,
    });
  }
  return slots;
}

/** The window's last grid slot, in minutes of the day. The grid counts from the window's start, so the end needn't fall on it. */
export function lastSlotMinutes(windowStart: string, windowEndExclusive: string, gridMinutes: number): number {
  const start = parseClock(windowStart);
  return start + Math.floor((parseClock(windowEndExclusive) - start - 1) / gridMinutes) * gridMinutes;
}

/** Whether a grid slot is one of those a tier captures. Counted from the window's start, so frames stay evenly spaced. */
export function isActiveForInterval(localMinutes: number, windowStart: string, everyMinutes: number): boolean {
  return (localMinutes - parseClock(windowStart)) % everyMinutes === 0;
}
