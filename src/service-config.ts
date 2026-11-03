import { readFileSync } from "node:fs";
import { ConfigError, isFileSystemError } from "./config.ts";
import { parseClock } from "./schedule.ts";
import type { Weekday } from "./schedule.ts";

export interface CadenceTier {
  /** This tier applies at this battery percentage and above. */
  battery_at_least: number;
  every_minutes: number;
}

/** Where alerts go. The token isn't here: the OneCLI gateway holds it, and these files hold only the way to the gateway. */
export interface TelegramConfig {
  bot_id: string;
  chat_id: string;
  proxy_url_file: string;
  ca_file: string;
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
  };
  traffic: { monthly_budget_mb: number | null; warn_fraction: number; pause_fraction: number };
  storage: { min_free_disk_mb: number; keep_failed_work_days: number; keep_logs_days: number };
  alerts: { telegram: TelegramConfig | null; consecutive_failed_slots: number; reminder_hours: number; first_try_warn_percent: number; first_try_window: number; daily_report: boolean };
  http: { bind: string; port: number };
  framing: { tolerance_pixels: number; alert_after_off_target_slots: number; reset_before_frame: boolean };
  logging: { sdk_debug: boolean };
}

/** The longest one step around a frame can take, getting the camera ready or letting it track again, closing its connection included. */
export const FRAME_STEP_SECONDS = 55;

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
    acquisition_timeout_seconds: 30,
    cleanup_timeout_seconds: 10,
    // Two, so exposure has settled after the step up, and one bad frame can't cost the shot.
    target_keyframes: 2,
    max_attempts: 3,
    retry_delay_seconds: 5,
    slot_deadline_seconds: 285,
    max_session_seconds_per_day: 6000,
  },
  traffic: { monthly_budget_mb: null, warn_fraction: 0.8, pause_fraction: 1 },
  storage: { min_free_disk_mb: 1024, keep_failed_work_days: 3, keep_logs_days: 30 },
  alerts: { telegram: null, consecutive_failed_slots: 3, reminder_hours: 24, first_try_warn_percent: 80, first_try_window: 50, daily_report: true },
  http: { bind: "127.0.0.1", port: 8787 },
  // 32 clears the 10 to 18 pixels a return to a saved position was measured to land off, so a return can't look like a new move.
  // Wide enough for where a go-to lands and for the edit to line up. What needs catching is a camera pointing somewhere else.
  framing: { tolerance_pixels: 64, alert_after_off_target_slots: 2, reset_before_frame: true },
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

/** Ids become directory names under the data directory, so they have to stay one safe path component. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_PERCENT = 100;
const MAX_PORT = 65_535;
const MINUTES_PER_DAY = 1_440;

/** Checks every setting's type and range. A config file comes from a person, so its casts prove nothing until this passes. */
function validate(config: ServiceConfig): void {
  const fail = (message: string): never => {
    throw new ConfigError(`Invalid config: ${message}`);
  };
  const section = (name: keyof ServiceConfig): void => {
    if (!isRecord(config[name])) fail(`${name} must be an object.`);
  };
  const whole = (path: string, value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): void => {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) fail(`${path} must be a whole number from ${min}${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`}, got ${JSON.stringify(value)}.`);
  };
  const positive = (path: string, value: unknown): void => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${path} must be a number above 0, got ${JSON.stringify(value)}.`);
  };
  const percentage = (path: string, value: unknown): void => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_PERCENT) fail(`${path} must be between 0 and ${MAX_PERCENT}, got ${JSON.stringify(value)}.`);
  };
  const fraction = (path: string, value: unknown): void => {
    if (typeof value !== "number" || !(value > 0) || value > 1) fail(`${path} must be above 0 and at most 1, got ${JSON.stringify(value)}.`);
  };
  const id = (path: string, value: unknown): void => {
    if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${path} must start with a letter or digit and hold only letters, digits, dots, dashes and underscores, got ${JSON.stringify(value)}.`);
  };

  for (const name of ["project", "camera", "schedule", "cadence", "battery", "capture", "traffic", "storage", "alerts", "http", "logging"] as const) section(name);

  id("project.id", config.project.id);
  id("camera.id", config.camera.id);
  // A JSON array holding one string would otherwise pass: both checks below coerce it to that string.
  for (const [path, value] of [["project.site_time_zone", config.project.site_time_zone], ["schedule.window_start", config.schedule.window_start], ["schedule.window_end_exclusive", config.schedule.window_end_exclusive]] as const) {
    if (typeof value !== "string") fail(`${path} must be text, got ${JSON.stringify(value)}.`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.project.site_time_zone });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    fail(`project.site_time_zone "${config.project.site_time_zone}" is not an IANA time zone.`);
  }

  const { grid_minutes: grid, days } = config.schedule;
  whole("schedule.grid_minutes", grid, 1, MINUTES_PER_DAY);
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
  if (!Array.isArray(days) || days.length === 0 || days.some((day) => !WEEKDAYS.includes(day))) fail(`schedule.days must list days from ${WEEKDAYS.join(", ")}.`);

  if (!Array.isArray(config.cadence.tiers) || config.cadence.tiers.length === 0) fail("cadence.tiers must not be empty.");
  const onGrid = (path: string, every: unknown): void => {
    if (!Number.isInteger(every) || (every as number) <= 0 || (every as number) % grid !== 0) fail(`${path}: every interval must be a multiple of schedule.grid_minutes (${grid}), got ${JSON.stringify(every)}.`);
  };
  config.cadence.tiers.forEach((tier, index) => {
    if (!isRecord(tier)) fail(`cadence.tiers[${index}] must be an object.`);
    percentage(`cadence.tiers[${index}].battery_at_least`, tier.battery_at_least);
    onGrid(`cadence.tiers[${index}].every_minutes`, tier.every_minutes);
  });
  // Below every tier's floor there'd be no rule for the rate, only whichever tier happened to come last.
  if (!config.cadence.tiers.some((tier) => tier.battery_at_least === 0)) fail("cadence.tiers needs a tier with battery_at_least 0, so every battery level has a rate.");
  onGrid("cadence.unknown_battery_every_minutes", config.cadence.unknown_battery_every_minutes);

  const { warn_below_percent: warn, pause_at_or_below_percent: pause, resume_at_or_above_percent: resume, reading_max_age_hours: maxAge } = config.battery;
  percentage("battery.warn_below_percent", warn);
  percentage("battery.pause_at_or_below_percent", pause);
  percentage("battery.resume_at_or_above_percent", resume);
  positive("battery.reading_max_age_hours", maxAge);
  if (pause >= resume) fail("battery.resume_at_or_above_percent must be above pause_at_or_below_percent, or the service would flap.");

  const { acquisition_timeout_seconds: acquire, cleanup_timeout_seconds: cleanup, retry_delay_seconds: retry, slot_deadline_seconds: deadline, max_attempts: tries, target_keyframes: keyframes, max_session_seconds_per_day: session } = config.capture;
  positive("capture.acquisition_timeout_seconds", acquire);
  positive("capture.cleanup_timeout_seconds", cleanup);
  positive("capture.slot_deadline_seconds", deadline);
  positive("capture.max_session_seconds_per_day", session);
  if (typeof retry !== "number" || !Number.isFinite(retry) || retry < 0) fail(`capture.retry_delay_seconds must be 0 or more, got ${JSON.stringify(retry)}.`);
  whole("capture.target_keyframes", keyframes, 1);
  whole("capture.max_attempts", tries, 1);
  const aroundFrame = config.framing.reset_before_frame ? 2 * FRAME_STEP_SECONDS : 0;
  if ((acquire + cleanup) * tries + retry * (tries - 1) + aroundFrame > deadline) fail("capture.slot_deadline_seconds is too short for max_attempts to finish, with the steps around a frame.");

  const { tolerance_pixels: tolerance, alert_after_off_target_slots: alertAfter, reset_before_frame: resetBeforeFrame } = config.framing;
  positive("framing.tolerance_pixels", tolerance);
  whole("framing.alert_after_off_target_slots", alertAfter, 1);
  if (typeof resetBeforeFrame !== "boolean") fail(`framing.reset_before_frame must be true or false, got ${JSON.stringify(resetBeforeFrame)}.`);

  const { monthly_budget_mb: budget, warn_fraction: warnFraction, pause_fraction: pauseFraction } = config.traffic;
  if (budget !== null) positive("traffic.monthly_budget_mb", budget);
  fraction("traffic.warn_fraction", warnFraction);
  fraction("traffic.pause_fraction", pauseFraction);
  if (warnFraction > pauseFraction) fail("traffic.warn_fraction must not be above pause_fraction, or the pause would come first.");

  if (typeof config.storage.min_free_disk_mb !== "number" || !(config.storage.min_free_disk_mb >= 0)) fail(`storage.min_free_disk_mb must be 0 or more, got ${JSON.stringify(config.storage.min_free_disk_mb)}.`);
  positive("storage.keep_failed_work_days", config.storage.keep_failed_work_days);
  positive("storage.keep_logs_days", config.storage.keep_logs_days);

  const { telegram, consecutive_failed_slots: failedSlots, reminder_hours: reminder, first_try_warn_percent: warnPercent, first_try_window: tryWindow } = config.alerts;
  if (telegram !== null) {
    if (!isRecord(telegram)) fail("alerts.telegram must be an object or null.");
    for (const key of Object.keys(telegram)) {
      if (!["bot_id", "chat_id", "proxy_url_file", "ca_file"].includes(key)) fail(`Unknown setting "alerts.telegram.${key}".`);
    }
    if (typeof telegram.bot_id !== "string" || !/^\d+$/.test(telegram.bot_id)) fail("alerts.telegram.bot_id must be the bot's numeric id, as text. It's the part of the token before the colon, and not secret.");
    if (typeof telegram.chat_id !== "string" || !/^-?\d+$/.test(telegram.chat_id)) fail("alerts.telegram.chat_id must be the chat's numeric id, as text.");
    if (typeof telegram.proxy_url_file !== "string" || telegram.proxy_url_file.length === 0) fail("alerts.telegram.proxy_url_file must be a file path.");
    if (typeof telegram.ca_file !== "string" || telegram.ca_file.length === 0) fail("alerts.telegram.ca_file must be a file path.");
  }
  whole("alerts.consecutive_failed_slots", failedSlots, 1);
  positive("alerts.reminder_hours", reminder);
  percentage("alerts.first_try_warn_percent", warnPercent);
  whole("alerts.first_try_window", tryWindow, 1);
  if (typeof config.alerts.daily_report !== "boolean") fail(`alerts.daily_report must be true or false, got ${JSON.stringify(config.alerts.daily_report)}.`);

  if (typeof config.http.bind !== "string" || config.http.bind.length === 0) fail("http.bind must be an address.");
  whole("http.port", config.http.port, 1, MAX_PORT);
  if (typeof config.logging.sdk_debug !== "boolean") fail(`logging.sdk_debug must be true or false, got ${JSON.stringify(config.logging.sdk_debug)}.`);
}

export function loadServiceConfig(path: string): ServiceConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    if (error.code !== "ENOENT") throw new ConfigError(`Can't read ${path} (${error.code}). Fix the file or its permissions, or remove it to use the defaults.`);
    validate(DEFAULT_SERVICE_CONFIG);
    return DEFAULT_SERVICE_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConfigError(`${path} is not valid JSON: ${error.message}`);
  }
  if (!isRecord(parsed)) throw new ConfigError(`${path} must hold a JSON object of settings. Compare it with config.example.json.`);
  const config = merge(DEFAULT_SERVICE_CONFIG, parsed, "");
  validate(config);
  const tiers = [...config.cadence.tiers].sort((a, b) => b.battery_at_least - a.battery_at_least);
  return { ...config, cadence: { ...config.cadence, tiers } };
}
