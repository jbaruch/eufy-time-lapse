import { localParts } from "./schedule.ts";
import type { ServiceConfig } from "./service-config.ts";
import type { AttemptRow, State } from "./state.ts";

export interface StatusReport {
  now: string;
  /** The commit this build came from, so an operator can tell what's actually running. */
  revision: string;
  last_success: { capture_id: string; at: string; age_seconds: number; width: number; height: number } | null;
  next_slot: { at: string; local_time: string } | null;
  completeness_24h: Completeness;
  consecutive_failures: number;
  pause_reasons: string[];
  battery: { percent: number | null; read_at: string | null; observed_at: string | null; observed_age_seconds: number | null; every_minutes: number | null; charging: boolean | null; temperature_c: number | null };
  budgets: { session_seconds_today: number; session_seconds_limit: number; media_mb_this_month: number; media_mb_limit: number | null };
  disk_free_mb: number;
  reliability_24h: Reliability;
  active_alerts: string[];
  framing: { position_saved: boolean; last_check: { status: string; at: string; dx: number | null; dy: number | null; offset_dx: number | null; offset_dy: number | null; detail: string } | null; off_target_slots_in_a_row: number };
}

export interface Completeness {
  /** Every grid slot whose time has passed. Slots a policy skipped stay in the count, shown by reason. */
  scheduled: number;
  captured_at_target_quality: number;
  captured_degraded: number;
  missed: number;
  skipped_by_reason: Record<string, number>;
  missed_by_reason: Record<string, number>;
  /** Of the slots that tried: accepted frames over captures plus misses. */
  capture_success_percent: number | null;
}

export interface Reliability {
  tries: number;
  by_path: Record<string, { tries: number; at_target: number; degraded: number; failed: number; average_connect_ms: number | null; average_session_ms: number | null }>;
  failures_by_reason: Record<string, number>;
  first_try_success_percent: number | null;
}

function completeness(state: State, since: string, until: string): Completeness {
  const result: Completeness = { scheduled: 0, captured_at_target_quality: 0, captured_degraded: 0, missed: 0, skipped_by_reason: {}, missed_by_reason: {}, capture_success_percent: null };
  for (const row of state.slotCountsSince(since, until)) {
    if (row.state === "pending" || row.state === "running") continue;
    result.scheduled += row.count;
    const reason = row.reason ?? "unknown";
    if (row.state === "captured") result.captured_at_target_quality += row.count;
    else if (row.state === "captured_degraded") result.captured_degraded += row.count;
    else if (row.state === "missed") {
      result.missed += row.count;
      result.missed_by_reason[reason] = (result.missed_by_reason[reason] ?? 0) + row.count;
    } else result.skipped_by_reason[reason] = (result.skipped_by_reason[reason] ?? 0) + row.count;
  }
  const tried = result.captured_at_target_quality + result.captured_degraded + result.missed;
  if (tried > 0) result.capture_success_percent = Math.round((result.captured_at_target_quality / tried) * 1000) / 10;
  return result;
}

export function summarizeAttempts(attempts: AttemptRow[]): Reliability {
  const finished = attempts.filter((attempt) => attempt.status !== "running");
  const byPath: Reliability["by_path"] = {};
  const failures: Record<string, number> = {};
  const totals: Record<string, { connect: number; connects: number; session: number; sessions: number }> = {};
  for (const attempt of finished) {
    const path = attempt.connection_path ?? "not_connected";
    const entry = (byPath[path] ??= { tries: 0, at_target: 0, degraded: 0, failed: 0, average_connect_ms: null, average_session_ms: null });
    const total = (totals[path] ??= { connect: 0, connects: 0, session: 0, sessions: 0 });
    entry.tries += 1;
    if (attempt.status === "captured") entry.at_target += 1;
    else if (attempt.status === "captured_degraded") entry.degraded += 1;
    else {
      entry.failed += 1;
      const reason = attempt.reason ?? "unknown";
      failures[reason] = (failures[reason] ?? 0) + 1;
    }
    if (attempt.connect_ms !== null) {
      total.connect += attempt.connect_ms;
      total.connects += 1;
    }
    if (attempt.session_ms !== null) {
      total.session += attempt.session_ms;
      total.sessions += 1;
    }
    entry.average_connect_ms = total.connects > 0 ? Math.round(total.connect / total.connects) : null;
    entry.average_session_ms = total.sessions > 0 ? Math.round(total.session / total.sessions) : null;
  }
  // Scheduled slots' first tries only, the same as the drift alert, so the two can't disagree. A reservation was never a try.
  const firstTries = finished.filter((attempt) => attempt.slot_id !== null && !attempt.attempt_id.includes("-retry-") && !attempt.attempt_id.startsWith("reservation-"));
  const firstTrySuccesses = firstTries.filter((attempt) => attempt.status === "captured").length;
  return {
    tries: finished.length,
    by_path: byPath,
    failures_by_reason: failures,
    first_try_success_percent: firstTries.length > 0 ? Math.round((firstTrySuccesses / firstTries.length) * 1000) / 10 : null,
  };
}

export function buildStatus(state: State, config: ServiceConfig, now: Date, diskFreeMb: number, revision = "unknown"): StatusReport {
  const lastFraming = state.latestFramingCheck();
  const zone = config.project.site_time_zone;
  const local = localParts(now, zone);
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const latest = state.latestCapture();
  const next = state.nextPending(now);
  const battery = state.latestBattery();
  // A failed read leaves this row empty, but the last real reading is still what the rate is running on.
  const reading = battery?.percent === null || battery?.observed_at === null ? (state.lastKnownBattery() ?? battery) : battery;
  const telemetry = reading === undefined ? undefined : (JSON.parse(reading.telemetry_json) as Record<string, unknown>);

  let consecutive = 0;
  for (const slot of state.recentOutcomes(500)) {
    if (slot.state !== "missed") break;
    consecutive += 1;
  }

  const pauses: string[] = [];
  if (state.getFlag("operator_paused") !== undefined) pauses.push("operator_paused");
  if (state.getFlag("battery_paused") !== undefined && state.getFlag("battery_override") === undefined) pauses.push("battery_low");
  if (state.getFlag("auth_required") !== undefined) pauses.push("auth_required");

  return {
    now: now.toISOString(),
    revision,
    last_success:
      latest === undefined
        ? null
        : { capture_id: latest.capture_id, at: latest.frame_received_at, age_seconds: Math.round((now.getTime() - Date.parse(latest.frame_received_at)) / 1000), width: latest.width, height: latest.height },
    next_slot: next === undefined ? null : { at: next.scheduled_at_utc, local_time: `${next.local_date} ${next.local_time}` },
    completeness_24h: completeness(state, dayAgo, now.toISOString()),
    consecutive_failures: consecutive,
    pause_reasons: pauses,
    battery: {
      percent: reading?.percent ?? null,
      read_at: battery?.read_at ?? null,
      observed_at: reading?.observed_at ?? null,
      observed_age_seconds: reading?.observed_at ? Math.round((now.getTime() - Date.parse(reading.observed_at)) / 1000) : null,
      every_minutes: battery?.every_minutes ?? null,
      charging: typeof telemetry?.charging === "boolean" ? telemetry.charging : null,
      temperature_c: typeof telemetry?.batteryTemperature === "number" ? telemetry.batteryTemperature : null,
    },
    budgets: {
      session_seconds_today: Math.round(state.sessionUsedMs(local.date) / 1000),
      session_seconds_limit: config.capture.max_session_seconds_per_day,
      media_mb_this_month: Math.round((state.monthBytes(local.date.slice(0, 7)) / (1024 * 1024)) * 10) / 10,
      media_mb_limit: config.traffic.monthly_budget_mb,
    },
    disk_free_mb: diskFreeMb,
    reliability_24h: summarizeAttempts(state.attemptsSince(dayAgo)),
    active_alerts: state.listAlerts().map((alert) => alert.key),
    framing: {
      position_saved: state.getFlag("framing_position_id") !== undefined,
      last_check: lastFraming === undefined ? null : { status: lastFraming.status, at: lastFraming.checked_at, dx: lastFraming.dx, dy: lastFraming.dy, offset_dx: lastFraming.offset_dx, offset_dy: lastFraming.offset_dy, detail: lastFraming.detail },
      off_target_slots_in_a_row: state.offTargetSlotsInARow(),
    },
  };
}

export interface CalibrationHour {
  hour_utc: string;
  local_time: string;
  battery_first: number | null;
  battery_last: number | null;
  charging_seen: boolean;
  solar_intensity_max: number | null;
  every_minutes: number | null;
  tries: number;
  captured: number;
  session_seconds: number;
  media_mb: number;
}

/** What calibration needs: battery against capture load and solar input, hour by hour. Figures are measured, never modeled. */
export function buildCalibration(state: State, config: ServiceConfig, since: Date): { since: string; hours: CalibrationHour[]; tiers_in_force: ServiceConfig["cadence"]["tiers"] } {
  const hours = new Map<string, CalibrationHour>();
  const hourOf = (iso: string): CalibrationHour => {
    const key = `${iso.slice(0, 13)}:00Z`;
    let hour = hours.get(key);
    if (hour === undefined) {
      const local = localParts(new Date(`${iso.slice(0, 13)}:00:00Z`), config.project.site_time_zone);
      hour = {
        hour_utc: key,
        local_time: `${local.date} ${String(Math.floor(local.minutes / 60)).padStart(2, "0")}:${String(local.minutes % 60).padStart(2, "0")}`,
        battery_first: null,
        battery_last: null,
        charging_seen: false,
        solar_intensity_max: null,
        every_minutes: null,
        tries: 0,
        captured: 0,
        session_seconds: 0,
        media_mb: 0,
      };
      hours.set(key, hour);
    }
    return hour;
  };

  for (const reading of state.batterySince(since.toISOString())) {
    const hour = hourOf(reading.read_at);
    if (reading.percent !== null) {
      hour.battery_first ??= reading.percent;
      hour.battery_last = reading.percent;
    }
    hour.every_minutes = reading.every_minutes;
    const telemetry = JSON.parse(reading.telemetry_json) as Record<string, unknown>;
    if (telemetry.charging === true) hour.charging_seen = true;
    if (typeof telemetry.solarIntensity === "number") hour.solar_intensity_max = Math.max(hour.solar_intensity_max ?? 0, telemetry.solarIntensity);
  }
  for (const attempt of state.attemptsSince(since.toISOString())) {
    const hour = hourOf(attempt.started_at);
    hour.tries += 1;
    if (attempt.status === "captured") hour.captured += 1;
    hour.session_seconds += Math.round((attempt.session_ms ?? attempt.reserved_ms) / 1000);
    hour.media_mb = Math.round((hour.media_mb + (attempt.video_bytes + attempt.audio_bytes) / (1024 * 1024)) * 10) / 10;
  }
  return { since: since.toISOString(), hours: [...hours.values()].sort((a, b) => a.hour_utc.localeCompare(b.hour_utc)), tiers_in_force: config.cadence.tiers };
}
