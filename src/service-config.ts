import { readFileSync } from "node:fs";
import { ConfigError } from "./config.ts";
import { parseClock } from "./schedule.ts";
import type { Weekday } from "./schedule.ts";

export interface CadenceTier {
  /** This tier applies at this battery percentage and above. */
  battery_at_least: number;
  every_minutes: number;
}

export interface ServiceConfig {
  project: { id: string; site_time_zone: string };
  camera: { id: string };
  schedule: { grid_minutes: number; window_start: string; window_end_exclusive: string; days: Weekday[] };
  cadence: { tiers: CadenceTier[]; unknown_battery_every_minutes: number };
  battery: { warn_below_percent: number; pause_at_or_below_percent: number; resume_at_or_above_percent: number; reading_max_age_hours: number };
  capture: {
    acquisition_timeout_seconds: number;
    cleanup_timeout_seconds: number;
    target_keyframes: number;
    max_attempts: number;
    retry_delay_seconds: number;
    slot_deadline_seconds: number;
    max_session_seconds_per_day: number;
    /** Seconds of hole punching before the relay starts. null keeps the SDK's own wait of about 25 s. */
    relay_after_seconds: number | null;
  };
  traffic: { monthly_budget_mb: number | null; warn_fraction: number; pause_fraction: number };
  storage: { min_free_disk_mb: number; keep_failed_work_days: number };
  alerts: { webhook_url_file: string | null; consecutive_failed_slots: number; reminder_hours: number };
  http: { bind: string; port: number };
  logging: { sdk_debug: boolean };
}

/** Starting values only. The tiers and the session cap are set by calibration on real solar power. */
export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  project: { id: "construction", site_time_zone: "America/Chicago" },
  camera: { id: "site-overview" },
  schedule: { grid_minutes: 5, window_start: "08:00", window_end_exclusive: "18:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  cadence: {
    tiers: [
      { battery_at_least: 60, every_minutes: 5 },
      { battery_at_least: 40, every_minutes: 15 },
      { battery_at_least: 0, every_minutes: 60 },
    ],
    unknown_battery_every_minutes: 60,
  },
  battery: { warn_below_percent: 35, pause_at_or_below_percent: 25, resume_at_or_above_percent: 40, reading_max_age_hours: 6 },
  capture: {
    acquisition_timeout_seconds: 60,
    cleanup_timeout_seconds: 10,
    target_keyframes: 2,
    max_attempts: 2,
    retry_delay_seconds: 30,
    slot_deadline_seconds: 180,
    max_session_seconds_per_day: 6000,
    relay_after_seconds: null,
  },
  traffic: { monthly_budget_mb: null, warn_fraction: 0.8, pause_fraction: 1 },
  storage: { min_free_disk_mb: 1024, keep_failed_work_days: 3 },
  alerts: { webhook_url_file: null, consecutive_failed_slots: 3, reminder_hours: 24 },
  http: { bind: "127.0.0.1", port: 8787 },
  logging: { sdk_debug: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Overlays `override` on `base`, section by section. An unknown key is a typo that would otherwise be silently ignored. */
function merge<T>(base: T, override: unknown, path: string): T {
  if (!isRecord(base) || !isRecord(override)) return override as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in base)) throw new ConfigError(`Unknown setting "${path}${key}". Compare your config with config.example.json.`);
    result[key] = merge(base[key], value, `${path}${key}.`);
  }
  return result as T;
}

function validate(config: ServiceConfig): void {
  const fail = (message: string): never => {
    throw new ConfigError(`Invalid config: ${message}`);
  };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.project.site_time_zone });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    fail(`project.site_time_zone "${config.project.site_time_zone}" is not an IANA time zone.`);
  }
  let start = 0;
  let end = 0;
  try {
    start = parseClock(config.schedule.window_start);
    end = parseClock(config.schedule.window_end_exclusive);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    fail(`schedule window: ${error.message}.`);
  }
  if (start >= end) fail("schedule.window_start must be before window_end_exclusive.");
  const { grid_minutes: grid } = config.schedule;
  if (!Number.isInteger(grid) || grid <= 0) fail("schedule.grid_minutes must be a positive whole number.");
  if (config.cadence.tiers.length === 0) fail("cadence.tiers must not be empty.");
  const intervals = [...config.cadence.tiers.map((tier) => tier.every_minutes), config.cadence.unknown_battery_every_minutes];
  for (const every of intervals) {
    if (!Number.isInteger(every) || every <= 0 || every % grid !== 0) fail(`every interval must be a multiple of schedule.grid_minutes (${grid}), got ${every}.`);
  }
  const { pause_at_or_below_percent: pause, resume_at_or_above_percent: resume } = config.battery;
  if (pause >= resume) fail("battery.resume_at_or_above_percent must be above pause_at_or_below_percent, or the service would flap.");
  const { acquisition_timeout_seconds: acquire, cleanup_timeout_seconds: cleanup, retry_delay_seconds: retry, slot_deadline_seconds: deadline, max_attempts: tries } = config.capture;
  if (tries < 1) fail("capture.max_attempts must be at least 1.");
  if ((acquire + cleanup) * tries + retry * (tries - 1) > deadline) fail("capture.slot_deadline_seconds is too short for max_attempts to finish.");
  const { relay_after_seconds: relayAfter } = config.capture;
  if (relayAfter !== null && (!(relayAfter > 0) || relayAfter >= acquire)) fail(`capture.relay_after_seconds must be null, or above 0 and below acquisition_timeout_seconds (${acquire}), got ${relayAfter}.`);
}

export function loadServiceConfig(path: string): ServiceConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    validate(DEFAULT_SERVICE_CONFIG);
    return DEFAULT_SERVICE_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const config = merge(DEFAULT_SERVICE_CONFIG, parsed, "");
  validate(config);
  const tiers = [...config.cadence.tiers].sort((a, b) => b.battery_at_least - a.battery_at_least);
  return { ...config, cadence: { ...config.cadence, tiers } };
}
