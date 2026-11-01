import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dailyReport } from "../src/daily-report.ts";
import type { BatteryRow, SlotState } from "../src/state.ts";

const ZONE = "America/Chicago";

function reading(at: string, percent: number | null, telemetry: Record<string, unknown> = {}): BatteryRow {
  return { read_at: at, percent, observed_at: percent === null ? null : at, every_minutes: 5, telemetry_json: JSON.stringify(telemetry) };
}

const SLOTS: Partial<Record<SlotState, number>> = { captured: 130, captured_degraded: 1, missed: 1 };
const BATTERY = [
  reading("2026-11-02T13:00:00.000Z", 95, { charging: false, batteryTemperature: 6 }),
  reading("2026-11-02T18:20:00.000Z", 90, { charging: true, batteryTemperature: 14 }),
  reading("2026-11-02T22:20:00.000Z", 93, { charging: true, batteryTemperature: 12 }),
  reading("2026-11-02T23:55:00.000Z", 92, { charging: false, batteryTemperature: 11 }),
];
const report = (overrides: Partial<Parameters<typeof dailyReport>[0]> = {}): string => dailyReport({ date: "2026-11-02", zone: ZONE, slots: SLOTS, readings: BATTERY, offTarget: 0, paused: [], ...overrides });

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

  it("gives the battery, its change over the day, and the range", () => {
    assert.match(report(), /Battery: 92%, down 3 today \(low 90, high 95\)\./);
  });

  it("says up and flat too", () => {
    const rising = [reading("2026-11-02T13:00:00.000Z", 80), reading("2026-11-02T23:00:00.000Z", 84)];
    assert.match(report({ readings: rising }), /Battery: 84%, up 4 today/);
    const flat = [reading("2026-11-02T13:00:00.000Z", 80), reading("2026-11-02T23:00:00.000Z", 80)];
    assert.match(report({ readings: flat }), /Battery: 80%, unchanged today/);
  });

  it("says when it last saw charging, in site time", () => {
    assert.match(report(), /Charging: last seen 16:20\./);
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
    assert.match(report({ readings: withGap }), /Battery: 92%, down 3 today \(low 92, high 95\)\./);
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
