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
    ["a log retention of zero", { storage: { keep_logs_days: 0 } }, /keep_logs_days/],
    ["a first-try threshold above 100", { alerts: { first_try_warn_percent: 101 } }, /first_try_warn_percent/],
    ["a first-try window of zero", { alerts: { first_try_window: 0 } }, /first_try_window/],
    ["a time zone in an array", { project: { site_time_zone: ["America/Chicago"] } }, /site_time_zone must be text/],
    ["a window start in an array", { schedule: { window_start: ["08:00"] } }, /window_start must be text/],
    ["a window end in an array", { schedule: { window_end_exclusive: ["18:00"] } }, /window_end_exclusive must be text/],
    ["a project id that climbs out of the data directory", { project: { id: "../../escape" } }, /project\.id/],
    ["a project id that names a nested path", { project: { id: "a/b" } }, /project\.id/],
    ["a camera id that is the parent directory", { camera: { id: ".." } }, /camera\.id/],
    ["a fractional try count, which would reserve too little budget", { capture: { max_attempts: 1.5 } }, /max_attempts/],
    ["a try count given as text", { capture: { max_attempts: "3" } }, /max_attempts/],
    ["no keyframes to wait for", { capture: { target_keyframes: 0 } }, /target_keyframes/],
    ["a negative retry delay", { capture: { retry_delay_seconds: -1 } }, /retry_delay_seconds/],
    ["a section that isn't an object", { capture: 5 }, /capture must be an object/],
    ["a grid of zero minutes", { schedule: { grid_minutes: 0 } }, /grid_minutes/],
    ["a day that doesn't exist", { schedule: { days: ["mon", "funday"] } }, /schedule\.days/],
    ["no days at all", { schedule: { days: [] } }, /schedule\.days/],
    ["a tier that isn't an object", { cadence: { tiers: [5] } }, /tiers\[0\]/],
    ["a tier above 100 percent", { cadence: { tiers: [{ battery_at_least: 120, every_minutes: 5 }] } }, /battery_at_least/],
    ["a battery threshold above 100 percent", { battery: { warn_below_percent: 101 } }, /warn_below_percent/],
    ["a reading age of zero", { battery: { reading_max_age_hours: 0 } }, /reading_max_age_hours/],
    ["a data budget of zero", { traffic: { monthly_budget_mb: 0 } }, /monthly_budget_mb/],
    ["a warning above the data pause", { traffic: { warn_fraction: 1, pause_fraction: 0.5 } }, /warn_fraction/],
    ["a fraction above one", { traffic: { pause_fraction: 2 } }, /pause_fraction/],
    ["a negative disk floor", { storage: { min_free_disk_mb: -1 } }, /min_free_disk_mb/],
    ["a port out of range", { http: { port: 70000 } }, /http\.port/],
    ["debug logging given as text", { logging: { sdk_debug: "yes" } }, /sdk_debug/],
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
