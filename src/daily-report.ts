import { addDays, formatClock, localParts } from "./schedule.ts";
import type { BatteryRow, SlotState } from "./state.ts";

export interface DailyReportInput {
  /** The site's local date. */
  date: string;
  zone: string;
  slots: Partial<Record<SlotState, number>>;
  /** How many of the day's slots took a second try, whatever came of them. */
  retried: number;
  /** When the day's missed slots were due, in local minutes, earliest first. */
  missedMinutes: readonly number[];
  gridMinutes: number;
  /** That day's readings, oldest first. */
  readings: readonly BatteryRow[];
  /** The newest known reading from before that day. */
  previous: BatteryRow | undefined;
  offTarget: number;
  paused: readonly string[];
}

function telemetryOf(row: BatteryRow): Record<string, unknown> {
  return JSON.parse(row.telemetry_json) as Record<string, unknown>;
}

/** Neighboring slots read as one stretch, so an outage takes a few words instead of every slot it covered. */
function clockRanges(minutes: readonly number[], gridMinutes: number): string {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const minute of minutes) {
    const last = ranges.at(-1);
    if (last !== undefined && minute - last.to === gridMinutes) last.to = minute;
    else ranges.push({ from: minute, to: minute });
  }
  return ranges.map(({ from, to }) => (from === to ? formatClock(from) : `${formatClock(from)} to ${formatClock(to)}`)).join(", ");
}

function framesLines({ slots, offTarget, retried, missedMinutes, gridMinutes }: DailyReportInput): string[] {
  const planned = Object.values(slots).reduce((sum, count) => sum + count, 0);
  if (planned === 0) return ["Frames: none planned."];
  const parts = [`${slots.captured ?? 0} of ${planned} at 4K`];
  if (slots.captured_degraded) parts.push(`${slots.captured_degraded} below 4K`);
  if (slots.missed) parts.push(`${slots.missed} missed`);
  if (slots.skipped_policy) parts.push(`${slots.skipped_policy} skipped`);
  if (offTarget > 0) parts.push(`${offTarget} off target`);
  // Retries hide a weakening connection from every other number here, so this is the one that moves first.
  const lines = [`Frames: ${parts.join(", ")}.${retried > 0 ? ` ${retried} took a second try.` : ""}`];
  if (missedMinutes.length > 0) lines.push(`Missed: ${clockRanges(missedMinutes, gridMinutes)}.`);
  return lines;
}

/** Against the last reading before today, because no reading covers the night and a day's own change would leave it out. */
function changeSince(percent: number, { previous, date, zone }: DailyReportInput): string {
  if (previous === undefined || previous.percent === null) return "";
  const change = percent - previous.percent;
  const previousDate = localParts(new Date(previous.read_at), zone).date;
  const since = previousDate === addDays(date, -1) ? "yesterday" : new Date(`${previousDate}T12:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `, ${change === 0 ? "unchanged" : `${change > 0 ? "up" : "down"} ${Math.abs(change)}`} since ${since}`;
}

function spokenMinutes(minutes: number): string {
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 30) / 2} hours`;
}

/** Each charging reading counts until the next one, which is as close as readings a slot apart can get. */
function chargingLine(known: ReadonlyArray<BatteryRow & { percent: number }>, zone: string): string {
  const clock = (row: BatteryRow): string => formatClock(localParts(new Date(row.read_at), zone).minutes);
  const isCharging = (row: BatteryRow): boolean => telemetryOf(row).charging === true;
  let chargingMs = 0;
  let first: (typeof known)[number] | undefined;
  let end: (typeof known)[number] | undefined;
  for (const [index, row] of known.entries()) {
    if (!isCharging(row)) continue;
    first ??= row;
    const next = known[index + 1];
    end = next ?? row;
    if (next !== undefined) chargingMs += Date.parse(next.read_at) - Date.parse(row.read_at);
  }
  if (first === undefined || end === undefined) {
    // A full battery reads as not charging, and that's no reason for anyone to go and look at the panel.
    return known.every((row) => row.percent === 100) ? "Charging: none needed, it's full." : "Charging: none seen today.";
  }
  const minutes = Math.round(chargingMs / 60_000);
  const when = minutes < 2 ? `seen at ${clock(first)}` : `about ${spokenMinutes(minutes)} between ${clock(first)} and ${clock(end)}`;
  return `Charging: ${when}, ${isCharging(end) ? "still on at the last reading" : `ended at ${end.percent}%`}.`;
}

function batteryLines(input: DailyReportInput): string[] {
  const known = input.readings.filter((row): row is BatteryRow & { percent: number } => row.percent !== null);
  const last = known.at(-1);
  if (last === undefined) return ["Battery: no reading today."];
  const percents = known.map((row) => row.percent);
  const lines = [`Battery: ${last.percent}%${changeSince(last.percent, input)} (low ${Math.min(...percents)}, high ${Math.max(...percents)}).`, chargingLine(known, input.zone)];
  const temperature = telemetryOf(last).batteryTemperature;
  if (typeof temperature === "number") lines.push(`Battery temperature: ${temperature}°C.`);
  return lines;
}

/** One message at the end of a day: how the frames went, and whether the battery is keeping up. */
export function dailyReport(input: DailyReportInput): string {
  const day = new Date(`${input.date}T12:00:00.000Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).replace(",", "");
  const lines = [`Time-lapse, ${day}`, ...framesLines(input), ...batteryLines(input)];
  if (input.paused.length > 0) lines.push(`Paused: ${input.paused.join(", ")}.`);
  return lines.join("\n");
}
