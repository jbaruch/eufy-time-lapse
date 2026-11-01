import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError } from "../src/config.ts";
import { DEFAULT_SERVICE_CONFIG, loadServiceConfig } from "../src/service-config.ts";
import { tempDir } from "./helpers/fixtures.ts";

describe("loadServiceConfig", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let run = 0;

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  async function load(content: unknown) {
    run += 1;
    const path = join(dir.path, `config-${run}.json`);
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
    return loadServiceConfig(path);
  }

  it("uses the defaults when there's no file", () => {
    assert.deepEqual(loadServiceConfig(join(dir.path, "missing.json")), DEFAULT_SERVICE_CONFIG);
  });

  it("targets 5-minute frames in the defaults", () => {
    assert.equal(DEFAULT_SERVICE_CONFIG.cadence.tiers[0]?.every_minutes, 5);
  });

  it("overlays only what the file sets", async () => {
    const config = await load({ schedule: { window_start: "07:00" }, battery: { warn_below_percent: 50 } });
    assert.equal(config.schedule.window_start, "07:00");
    assert.equal(config.schedule.window_end_exclusive, "18:00");
    assert.equal(config.battery.warn_below_percent, 50);
    assert.equal(config.battery.pause_at_or_below_percent, 25);
  });

  it("replaces the tier list whole, and sorts it highest first", async () => {
    const config = await load({ cadence: { tiers: [{ battery_at_least: 10, every_minutes: 60 }, { battery_at_least: 80, every_minutes: 10 }] } });
    assert.deepEqual(config.cadence.tiers.map((tier) => tier.battery_at_least), [80, 10]);
  });

  it("rejects a misspelled setting instead of ignoring it", async () => {
    await assert.rejects(load({ schedule: { window_begin: "07:00" } }), (error: ConfigError) => error instanceof ConfigError && /schedule\.window_begin/.test(error.message));
    await assert.rejects(load({ cameras: {} }), /"cameras"/);
  });

  const invalid: Array<[string, unknown, RegExp]> = [
    ["a bad time zone", { project: { site_time_zone: "Mars/Olympus" } }, /IANA/],
    ["a window that ends before it starts", { schedule: { window_start: "18:00", window_end_exclusive: "08:00" } }, /before/],
    ["a malformed time", { schedule: { window_start: "8am" } }, /HH:MM/],
    ["a tier off the grid", { cadence: { tiers: [{ battery_at_least: 0, every_minutes: 7 }] } }, /multiple/],
    ["no tiers", { cadence: { tiers: [] } }, /empty/],
    ["resume at or below pause", { battery: { resume_at_or_above_percent: 25 } }, /flap/],
    ["a slot deadline too short for its retries", { capture: { slot_deadline_seconds: 100 } }, /too short/],
    ["a relay head start of zero", { capture: { relay_after_seconds: 0 } }, /relay_after_seconds/],
    ["a relay head start past the attempt timeout", { capture: { relay_after_seconds: 60 } }, /relay_after_seconds/],
  ];
  for (const [name, content, message] of invalid) {
    it(`rejects ${name}`, async () => {
      await assert.rejects(load(content), message);
    });
  }

  it("explains a file that isn't JSON", async () => {
    await assert.rejects(load("{ nope"), /not valid JSON/);
  });
});
