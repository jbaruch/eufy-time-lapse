import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dailyReport } from "../src/daily-report.ts";
import type { BatteryRow, SlotState } from "../src/state.ts";

const ZONE = "America/Chicago";

function reading(at: string, percent: number | null, telemetry: Record<string, unknown> = {}, everyMinutes: number | null = 5): BatteryRow {
  return { read_at: at, percent, observed_at: percent === null ? null : at, every_minutes: everyMinutes, telemetry_json: JSON.stringify(telemetry) };
}

/** Readings a slot apart, the way a normal day has them. */
function everySlot(start: string, count: number, percent: number, telemetry: Record<string, unknown>): BatteryRow[] {
  return Array.from({ length: count }, (_, index) => reading(new Date(Date.parse(start) + index * 300_000).toISOString(), percent, telemetry));
}

const SLOTS: Partial<Record<SlotState, number>> = { captured: 130, captured_degraded: 1, missed: 1 };
const BATTERY = [
  reading("2026-11-02T13:00:00.000Z", 95, { charging: false, batteryTemperature: 6 }),
  reading("2026-11-02T18:20:00.000Z", 90, { charging: true, batteryTemperature: 14 }),
  reading("2026-11-02T22:20:00.000Z", 93, { charging: true, batteryTemperature: 12 }),
  reading("2026-11-02T23:55:00.000Z", 92, { charging: false, batteryTemperature: 11 }),
];
const YESTERDAY = reading("2026-11-01T23:55:00.000Z", 97);
// Not charging when the day starts, so whatever charging follows was seen starting.
const MORNING = reading("2026-11-02T13:00:00.000Z", 96, { charging: false });
const report = (overrides: Partial<Parameters<typeof dailyReport>[0]> = {}): string =>
  dailyReport({ date: "2026-11-02", zone: ZONE, slots: SLOTS, retried: 0, missedMinutes: [], gridMinutes: 5, readings: BATTERY, previous: YESTERDAY, offTarget: 0, paused: [], ...overrides });

describe("dailyReport", () => {
  it("names the day", () => {
    assert.match(report(), /^Time-lapse, Mon Nov 2\n/);
  });

  it("counts the day's frames against what was planned", () => {
    assert.match(report(), /Frames: 130 of 132 at 4K, 1 below 4K, 1 missed\./);
  });

  it("leaves out what didn't happen", () => {
    assert.match(report({ slots: { captured: 132 } }), /Frames: 132 of 132 at 4K\.\n/);
  });

  it("counts skipped slots, because a person skipped them or the service did", () => {
    assert.match(report({ slots: { captured: 100, skipped_policy: 32 } }), /Frames: 100 of 132 at 4K, 32 skipped\./);
  });

  it("says so when a day has no slots", () => {
    assert.match(report({ slots: {} }), /Frames: none planned\./);
  });

  it("says how many frames were off target", () => {
    assert.match(report({ offTarget: 2 }), /, 2 off target\./);
  });

  it("says how many slots took a second try, apart from the counts they overlap", () => {
    assert.match(report({ slots: { captured: 132 }, retried: 4 }), /Frames: 132 of 132 at 4K\. 4 took a second try\.\n/);
    assert.match(report({ retried: 1 }), /1 missed\. 1 took a second try\.\n/);
    assert.doesNotMatch(report(), /second try/);
  });

  it("says when slots were missed, with neighbors as one stretch", () => {
    assert.match(report({ missedMinutes: [25, 30, 55, 300, 305, 310, 315, 320] }), /Frames: .*\nMissed: 00:25 to 00:30, 00:55, 05:00 to 05:20\.\n/);
    assert.match(report({ missedMinutes: [480] }), /Missed: 08:00\.\n/);
    assert.doesNotMatch(report(), /Missed:/);
  });

  it("goes by the schedule's grid when it decides what's a neighbor", () => {
    assert.match(report({ gridMinutes: 10, missedMinutes: [480, 490, 505] }), /Missed: 08:00 to 08:10, 08:25\.\n/);
  });

  it("measures the battery against yesterday's last reading, so the night counts", () => {
    assert.match(report(), /Battery: 92%, down 5 since yesterday \(low 90, high 95\)\./);
  });

  it("says up and flat too", () => {
    const today = [reading("2026-11-02T13:00:00.000Z", 80), reading("2026-11-02T23:00:00.000Z", 84)];
    assert.match(report({ readings: today, previous: reading("2026-11-01T23:55:00.000Z", 81) }), /Battery: 84%, up 3 since yesterday/);
    assert.match(report({ readings: today, previous: reading("2026-11-01T23:55:00.000Z", 84) }), /Battery: 84%, unchanged since yesterday/);
  });

  it("goes by the site's date when it says yesterday", () => {
    // Already Nov 2 in UTC, and still the evening of Nov 1 on site.
    assert.match(report({ previous: reading("2026-11-02T03:00:00.000Z", 95) }), /down 3 since yesterday/);
  });

  it("names the day when the last reading is older than yesterday", () => {
    assert.match(report({ previous: reading("2026-10-30T23:55:00.000Z", 95) }), /Battery: 92%, down 3 since Oct 30 \(/);
  });

  it("gives only the battery and its range when there's nothing earlier to compare with", () => {
    assert.match(report({ previous: undefined }), /Battery: 92% \(low 90, high 95\)\./);
  });

  it("says how long it charged, between when, and what it reached, in site time", () => {
    const day = [MORNING, ...everySlot("2026-11-02T18:20:00.000Z", 66, 90, { charging: true }), reading("2026-11-02T23:50:00.000Z", 92, { charging: false })];
    assert.match(report({ readings: day }), /Charging: about 5\.5 hours between 12:20 and 17:50, ended at 92%\./);
  });

  it("gives a short charge in minutes, and shows that it stopped because it was full", () => {
    const afternoon = [MORNING, ...everySlot("2026-11-02T20:15:00.000Z", 12, 95, { charging: true }), reading("2026-11-02T21:15:00.000Z", 100, { charging: false }), reading("2026-11-02T23:55:00.000Z", 98, { charging: false })];
    assert.match(report({ readings: afternoon }), /Charging: about 60 minutes between 14:15 and 15:15, ended at 100%\./);
  });

  it("leaves a break in charging out of the total", () => {
    const broken = [MORNING, reading("2026-11-02T20:00:00.000Z", 80, { charging: true }, 30), reading("2026-11-02T20:30:00.000Z", 81, { charging: false }, 30), reading("2026-11-02T21:00:00.000Z", 81, { charging: true }, 30), reading("2026-11-02T21:30:00.000Z", 82, { charging: false }, 30)];
    assert.match(report({ readings: broken }), /Charging: about 60 minutes between 14:00 and 15:30, ended at 82%\./);
  });

  it("says so when it's still charging at the last reading", () => {
    const evening = [MORNING, reading("2026-11-02T23:25:00.000Z", 80, { charging: true }, 30), reading("2026-11-02T23:55:00.000Z", 81, { charging: true }, 30)];
    assert.match(report({ readings: evening }), /Charging: about 30 minutes between 17:25 and 17:55, still on at the last reading\./);
  });

  it("doesn't pass off a charge it never saw start as a short one", () => {
    // The real morning of Nov 2: charging since sunrise, and the camera first read at 07:00.
    const morning = [reading("2026-11-02T13:00:00.000Z", 90, { charging: true }), reading("2026-11-02T13:05:00.000Z", 100, { charging: false })];
    assert.match(report({ readings: morning }), /Charging: at least 5 minutes, already on at 07:00, ended at 100% by 07:05\./);
  });

  it("says when a charge it never saw start is still going", () => {
    const allDay = [reading("2026-11-02T13:00:00.000Z", 90, { charging: true }, 30), reading("2026-11-02T13:30:00.000Z", 91, { charging: true }, 30)];
    assert.match(report({ readings: allDay }), /Charging: at least 30 minutes, already on at 07:00, still on at the last reading\./);
  });

  it("adds later charging to a charge it never saw start", () => {
    const twice = [reading("2026-11-02T13:00:00.000Z", 90, { charging: true }), reading("2026-11-02T13:05:00.000Z", 100, { charging: false }), reading("2026-11-02T20:15:00.000Z", 95, { charging: true }), reading("2026-11-02T20:20:00.000Z", 96, { charging: false })];
    assert.match(report({ readings: twice }), /Charging: at least 10 minutes, already on at 07:00, ended at 96% by 14:20\./);
  });

  it("doesn't count a long gap in the readings as hours of charging", () => {
    const gap = [MORNING, reading("2026-11-02T16:00:00.000Z", 90, { charging: true }), reading("2026-11-02T23:56:00.000Z", 92, { charging: false })];
    assert.match(report({ readings: gap }), /Charging: about 15 minutes between 10:00 and 17:56, ended at 92%\./);
  });

  it("counts a gap by the pace in force, since a low battery is read less often", () => {
    const slow = [MORNING, reading("2026-11-02T16:00:00.000Z", 40, { charging: true }, 30), reading("2026-11-02T20:00:00.000Z", 42, { charging: false }, 30)];
    assert.match(report({ readings: slow }), /Charging: about 90 minutes between 10:00 and 14:00, ended at 42%\./);
  });

  it("counts a gap by the schedule's grid when a reading has no pace", () => {
    const unknown = [MORNING, reading("2026-11-02T16:00:00.000Z", 40, { charging: true }, null), reading("2026-11-02T20:00:00.000Z", 42, { charging: false }, null)];
    assert.match(report({ readings: unknown, gridMinutes: 10 }), /Charging: about 30 minutes between 10:00 and 14:00, ended at 42%\./);
  });

  it("gives no length for charging only one reading saw", () => {
    assert.match(report({ readings: [reading("2026-11-02T23:55:00.000Z", 80, { charging: true })] }), /Charging: seen at 17:55, still on at the last reading\./);
    const blink = [reading("2026-11-02T23:55:00.000Z", 80, { charging: true }), reading("2026-11-02T23:55:40.000Z", 80, { charging: false })];
    assert.match(report({ readings: blink }), /Charging: seen at 17:55, ended at 80%\./);
  });

  it("doesn't trust the charging flag on a reading with no charge in it", () => {
    const failed = [reading("2026-11-02T13:00:00.000Z", 80, { charging: false }), reading("2026-11-02T23:00:00.000Z", null, { charging: true })];
    assert.match(report({ readings: failed }), /Charging: none seen today\./);
  });

  it("says so when it saw no charging at all, which is what a person needs to hear", () => {
    const dark = [reading("2026-11-02T13:00:00.000Z", 80, { charging: false }), reading("2026-11-02T23:00:00.000Z", 76, { charging: false })];
    assert.match(report({ readings: dark }), /Charging: none seen today\./);
  });

  it("doesn't call a full battery not charging as if that were a problem", () => {
    const full = [reading("2026-11-02T13:00:00.000Z", 100, { charging: false }), reading("2026-11-02T23:00:00.000Z", 100, { charging: false })];
    assert.match(report({ readings: full }), /Charging: none needed, it's full\./);
  });

  it("gives the temperature, since a cold battery won't charge", () => {
    assert.match(report(), /Battery temperature: 11°C\./);
  });

  it("leaves the temperature out when the camera doesn't report one", () => {
    assert.doesNotMatch(report({ readings: [reading("2026-11-02T13:00:00.000Z", 80)] }), /temperature/);
  });

  it("ignores failed readings", () => {
    const withGap = [reading("2026-11-02T13:00:00.000Z", 95), reading("2026-11-02T14:00:00.000Z", null), reading("2026-11-02T23:00:00.000Z", 92)];
    assert.match(report({ readings: withGap }), /Battery: 92%, down 5 since yesterday \(low 92, high 95\)\./);
  });

  it("says so when there was no reading at all, rather than going quiet about it", () => {
    assert.match(report({ readings: [] }), /Battery: no reading today\./);
    assert.match(report({ readings: [reading("2026-11-02T13:00:00.000Z", null)] }), /Battery: no reading today\./);
  });

  it("says why capture is paused", () => {
    assert.match(report({ paused: ["paused by you", "low battery"] }), /Paused: paused by you, low battery\./);
    assert.doesNotMatch(report(), /Paused/);
  });
});
