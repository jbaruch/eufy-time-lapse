import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, isActiveForInterval, lastSlotMinutes, localParts, localToUtc, parseClock, planDay } from "../src/schedule.ts";
import type { ScheduleConfig } from "../src/schedule.ts";

const CHICAGO = "America/Chicago";

function config(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return { siteTimeZone: CHICAGO, gridMinutes: 30, windowStart: "08:00", windowEndExclusive: "10:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], ...overrides };
}

describe("local time", () => {
  it("reads the site's clock, whatever the host's zone", () => {
    assert.deepEqual(localParts(new Date("2026-07-01T15:30:00Z"), CHICAGO), { date: "2026-07-01", minutes: 630 });
    assert.deepEqual(localParts(new Date("2026-07-01T15:30:00Z"), "Asia/Tokyo"), { date: "2026-07-02", minutes: 30 });
  });

  it("converts an ordinary local time to one instant", () => {
    assert.deepEqual(localToUtc("2026-07-01", 8 * 60, CHICAGO), [new Date("2026-07-01T13:00:00Z")]);
    assert.deepEqual(localToUtc("2026-01-15", 8 * 60, CHICAGO), [new Date("2026-01-15T14:00:00Z")]);
  });

  it("finds no instant for a time the spring change skips", () => {
    assert.deepEqual(localToUtc("2026-03-08", 2 * 60 + 30, CHICAGO), []);
  });

  it("finds both instants for a time the autumn change repeats, earliest first", () => {
    assert.deepEqual(localToUtc("2026-11-01", 60 + 30, CHICAGO), [new Date("2026-11-01T06:30:00Z"), new Date("2026-11-01T07:30:00Z")]);
  });

  it("adds days across a month end", () => {
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-11-01", -1), "2026-10-31");
  });

  it("parses clock times and rejects nonsense", () => {
    assert.equal(parseClock("00:00"), 0);
    assert.equal(parseClock("24:00"), 1440);
    assert.throws(() => parseClock("8am"), RangeError);
    assert.throws(() => parseClock("25:00"), RangeError);
    assert.throws(() => parseClock("08:75"), RangeError);
  });
});

describe("planDay", () => {
  it("lays out the window at the grid spacing, with the end excluded", () => {
    const slots = planDay("2026-07-01", config());
    assert.deepEqual(slots.map((slot) => slot.localTime), ["08:00", "08:30", "09:00", "09:30"]);
    assert.equal(slots[0]?.scheduledAt.toISOString(), "2026-07-01T13:00:00.000Z");
    assert.ok(slots.every((slot) => !slot.nonexistent));
  });

  it("plans nothing on a day that isn't scheduled", () => {
    // 2026-07-05 is a Sunday.
    assert.deepEqual(planDay("2026-07-05", config({ days: ["mon", "tue", "wed", "thu", "fri"] })), []);
    assert.equal(planDay("2026-07-06", config({ days: ["mon"] })).length, 4);
  });

  it("keeps a skipped local time on the plan, marked, on the spring change", () => {
    const slots = planDay("2026-03-08", config({ windowStart: "01:30", windowEndExclusive: "03:30" }));
    assert.deepEqual(slots.map((slot) => [slot.localTime, slot.nonexistent]), [
      ["01:30", false],
      ["02:00", true],
      ["02:30", true],
      ["03:00", false],
    ]);
  });

  it("runs a repeated local time once, at its first occurrence, on the autumn change", () => {
    const slots = planDay("2026-11-01", config({ windowStart: "00:30", windowEndExclusive: "02:30" }));
    assert.deepEqual(slots.map((slot) => [slot.localTime, slot.scheduledAt.toISOString()]), [
      ["00:30", "2026-11-01T05:30:00.000Z"],
      ["01:00", "2026-11-01T06:00:00.000Z"],
      ["01:30", "2026-11-01T06:30:00.000Z"],
      ["02:00", "2026-11-01T08:00:00.000Z"],
    ]);
    assert.equal(new Set(slots.map((slot) => slot.scheduledAt.toISOString())).size, slots.length);
  });

  it("reaches the end of the day when the window runs to 24:00", () => {
    const slots = planDay("2026-07-01", config({ windowStart: "23:00", windowEndExclusive: "24:00" }));
    assert.deepEqual(slots.map((slot) => slot.localTime), ["23:00", "23:30"]);
  });
});

describe("lastSlotMinutes", () => {
  for (const [name, start, end, grid] of [
    ["a window the grid divides", "07:00", "18:00", 5],
    ["a window the grid doesn't divide", "07:00", "17:58", 5],
    ["a window shorter than the grid", "07:00", "07:03", 5],
    ["a window running to 24:00", "23:00", "24:00", 30],
  ] as const) {
    it(`is the last slot planDay lays out, for ${name}`, () => {
      const planned = planDay("2026-07-01", config({ windowStart: start, windowEndExclusive: end, gridMinutes: grid }));
      assert.equal(lastSlotMinutes(start, end, grid), planned.at(-1)?.localMinutes);
    });
  }
});

describe("isActiveForInterval", () => {
  it("picks evenly spaced slots counted from the window's start", () => {
    const active = (minutes: number, every: number): boolean => isActiveForInterval(minutes, "08:00", every);
    assert.equal(active(480, 5), true);
    assert.equal(active(485, 5), true);
    assert.equal(active(485, 15), false);
    assert.equal(active(495, 15), true);
    assert.equal(active(540, 60), true);
    assert.equal(active(555, 60), false);
  });
});
