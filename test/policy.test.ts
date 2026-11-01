import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseInterval, decide, nextBatteryPaused, reservedSessionMs } from "../src/policy.ts";
import type { PolicyInput } from "../src/policy.ts";
import { DEFAULT_SERVICE_CONFIG } from "../src/service-config.ts";
import type { ServiceConfig } from "../src/service-config.ts";

const config = DEFAULT_SERVICE_CONFIG;

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return { batteryPercent: 80, batteryPaused: false, batteryOverride: false, operatorPaused: false, authRequired: false, diskFreeMb: 50_000, sessionUsedMs: 0, monthBytes: 0, localMinutes: 480, ...overrides };
}

const always = (): boolean => true;

describe("nextBatteryPaused", () => {
  const battery = config.battery;

  it("pauses at the threshold, not above it", () => {
    assert.equal(nextBatteryPaused(false, 26, battery), false);
    assert.equal(nextBatteryPaused(false, 25, battery), true);
  });

  it("stays paused until the resume level, so it can't flap", () => {
    assert.equal(nextBatteryPaused(true, 30, battery), true);
    assert.equal(nextBatteryPaused(true, 39, battery), true);
    assert.equal(nextBatteryPaused(true, 40, battery), false);
  });

  it("doesn't let an unknown reading start or end a pause", () => {
    assert.equal(nextBatteryPaused(true, null, battery), true);
    assert.equal(nextBatteryPaused(false, null, battery), false);
  });
});

describe("chooseInterval", () => {
  const { cadence } = config;

  it("captures as often as the battery pays for", () => {
    assert.equal(chooseInterval(100, cadence), 5);
    assert.equal(chooseInterval(60, cadence), 5);
    assert.equal(chooseInterval(59, cadence), 15);
    assert.equal(chooseInterval(40, cadence), 15);
    assert.equal(chooseInterval(39, cadence), 60);
    assert.equal(chooseInterval(0, cadence), 60);
  });

  it("is conservative when the battery is unknown", () => {
    assert.equal(chooseInterval(null, cadence), 60);
  });
});

describe("decide", () => {
  it("captures when nothing stands in the way", () => {
    assert.deepEqual(decide(input(), config, always), { action: "capture", everyMinutes: 5 });
  });

  const skips: Array<[string, Partial<PolicyInput>, string]> = [
    ["auth", { authRequired: true }, "auth_required"],
    ["operator pause", { operatorPaused: true }, "operator_paused"],
    ["battery pause", { batteryPaused: true }, "battery_low"],
    ["low disk", { diskFreeMb: 1024 }, "storage_full"],
    ["spent session budget", { sessionUsedMs: 6_000_000 }, "session_budget"],
  ];
  for (const [name, overrides, reason] of skips) {
    it(`skips on ${name}`, () => {
      assert.deepEqual(decide(input(overrides), config, always).action === "skip" && decide(input(overrides), config, always), { action: "skip", reason, everyMinutes: 5 });
    });
  }

  it("lets an operator override a battery pause, but not anything else", () => {
    assert.equal(decide(input({ batteryPaused: true, batteryOverride: true }), config, always).action, "capture");
    const decision = decide(input({ batteryPaused: true, batteryOverride: true, diskFreeMb: 1 }), config, always);
    assert.ok(decision.action === "skip" && decision.reason === "storage_full");
  });

  it("skips a grid slot the current tier doesn't use", () => {
    const seen: number[] = [];
    const decision = decide(input({ batteryPercent: 50 }), config, (every) => {
      seen.push(every);
      return false;
    });
    assert.deepEqual(decision, { action: "skip", reason: "battery_tier", everyMinutes: 15 });
    assert.deepEqual(seen, [15]);
  });

  it("reserves a full slot's worst case before spending the session budget", () => {
    const reserve = reservedSessionMs(config.capture);
    assert.equal(reserve, 120_000);
    const limit = config.capture.max_session_seconds_per_day * 1000;
    assert.equal(decide(input({ sessionUsedMs: limit - reserve }), config, always).action, "capture");
    assert.equal(decide(input({ sessionUsedMs: limit - reserve + 1 }), config, always).action, "skip");
  });

  it("stops at the data budget only when one is set", () => {
    const limited: ServiceConfig = { ...config, traffic: { ...config.traffic, monthly_budget_mb: 100 } };
    const hundredMb = 100 * 1024 * 1024;
    assert.equal(decide(input({ monthBytes: hundredMb - 1 }), limited, always).action, "capture");
    const decision = decide(input({ monthBytes: hundredMb }), limited, always);
    assert.ok(decision.action === "skip" && decision.reason === "data_budget");
    assert.equal(decide(input({ monthBytes: hundredMb * 100 }), config, always).action, "capture");
  });
});
