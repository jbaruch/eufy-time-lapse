import { formatClock, localParts } from "./schedule.ts";
import type { BatteryRow, SlotState } from "./state.ts";

export interface DailyReportInput {
  /** The site's local date. */
  date: string;
  zone: string;
  slots: Partial<Record<SlotState, number>>;
  /** That day's readings, oldest first. */
  readings: readonly BatteryRow[];
  offTarget: number;
  paused: readonly string[];
}

function telemetryOf(row: BatteryRow): Record<string, unknown> {
  return JSON.parse(row.telemetry_json) as Record<string, unknown>;
}

function framesLine({ slots, offTarget }: DailyReportInput): string {
  const planned = Object.values(slots).reduce((sum, count) => sum + count, 0);
  if (planned === 0) return "Frames: none planned.";
  const parts = [`${slots.captured ?? 0} of ${planned} at 4K`];
  if (slots.captured_degraded) parts.push(`${slots.captured_degraded} below 4K`);
  if (slots.missed) parts.push(`${slots.missed} missed`);
  if (slots.skipped_policy) parts.push(`${slots.skipped_policy} skipped`);
  if (offTarget > 0) parts.push(`${offTarget} off target`);
  return `Frames: ${parts.join(", ")}.`;
}

function batteryLines(readings: readonly BatteryRow[], zone: string): string[] {
  const known = readings.filter((row): row is BatteryRow & { percent: number } => row.percent !== null);
  const first = known[0];
  const last = known.at(-1);
  if (first === undefined || last === undefined) return ["Battery: no reading today."];
  const percents = known.map((row) => row.percent);
  const change = last.percent - first.percent;
  const direction = change === 0 ? "unchanged today" : `${change > 0 ? "up" : "down"} ${Math.abs(change)} today`;
  const lines = [`Battery: ${last.percent}%, ${direction} (low ${Math.min(...percents)}, high ${Math.max(...percents)}).`];

  const lastCharging = known.filter((row) => telemetryOf(row).charging === true).at(-1);
  if (lastCharging !== undefined) lines.push(`Charging: last seen ${formatClock(localParts(new Date(lastCharging.read_at), zone).minutes)}.`);
  // A full battery reads as not charging, and that's no reason for anyone to go and look at the panel.
  else lines.push(Math.min(...percents) === 100 ? "Charging: none needed, it's full." : "Charging: none seen today.");

  const temperature = telemetryOf(last).batteryTemperature;
  if (typeof temperature === "number") lines.push(`Battery temperature: ${temperature}°C.`);
  return lines;
}

/** One message at the end of a day: how the frames went, and whether the battery is keeping up. */
export function dailyReport(input: DailyReportInput): string {
  const day = new Date(`${input.date}T12:00:00.000Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).replace(",", "");
  const lines = [`Time-lapse, ${day}`, framesLine(input), ...batteryLines(input.readings, input.zone)];
  if (input.paused.length > 0) lines.push(`Paused: ${input.paused.join(", ")}.`);
  return lines.join("\n");
}
