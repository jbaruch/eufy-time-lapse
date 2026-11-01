import type { ServiceConfig } from "./service-config.ts";

export type SkipReason = "auth_required" | "operator_paused" | "battery_low" | "storage_full" | "session_budget" | "data_budget" | "battery_tier";

export interface PolicyInput {
  batteryPercent: number | null;
  batteryPaused: boolean;
  batteryOverride: boolean;
  operatorPaused: boolean;
  authRequired: boolean;
  diskFreeMb: number;
  sessionUsedMs: number;
  monthBytes: number;
  localMinutes: number;
}

export type PolicyDecision = { action: "capture"; everyMinutes: number } | { action: "skip"; reason: SkipReason; everyMinutes: number };

/** Hysteresis: a pause needs a real reading at the resume level to clear, so an unknown reading never ends one. */
export function nextBatteryPaused(wasPaused: boolean, percent: number | null, config: ServiceConfig["battery"]): boolean {
  if (percent === null) return wasPaused;
  if (percent <= config.pause_at_or_below_percent) return true;
  if (wasPaused) return percent < config.resume_at_or_above_percent;
  return false;
}

export function chooseInterval(percent: number | null, cadence: ServiceConfig["cadence"]): number {
  if (percent === null) return cadence.unknown_battery_every_minutes;
  const tier = cadence.tiers.find((candidate) => percent >= candidate.battery_at_least);
  return (tier ?? cadence.tiers[cadence.tiers.length - 1])?.every_minutes ?? cadence.unknown_battery_every_minutes;
}

export function reservedSessionMs(config: ServiceConfig["capture"]): number {
  return (config.acquisition_timeout_seconds + config.cleanup_timeout_seconds) * config.max_attempts * 1000;
}

/** Whether a slot may wake the camera. Each rule is explicit and recorded, so the capture rate never changes silently. */
export function sessionBudgetSpent(input: Pick<PolicyInput, "sessionUsedMs">, config: ServiceConfig): boolean {
  return input.sessionUsedMs + reservedSessionMs(config.capture) > config.capture.max_session_seconds_per_day * 1000;
}

export function dataBudgetSpent(input: Pick<PolicyInput, "monthBytes">, config: ServiceConfig): boolean {
  const { monthly_budget_mb: budget, pause_fraction: fraction } = config.traffic;
  return budget !== null && input.monthBytes >= budget * 1024 * 1024 * fraction;
}

export function decide(input: PolicyInput, config: ServiceConfig, isActive: (everyMinutes: number) => boolean): PolicyDecision {
  const everyMinutes = chooseInterval(input.batteryPercent, config.cadence);
  const skip = (reason: SkipReason): PolicyDecision => ({ action: "skip", reason, everyMinutes });
  if (input.authRequired) return skip("auth_required");
  if (input.operatorPaused) return skip("operator_paused");
  if (input.batteryPaused && !input.batteryOverride) return skip("battery_low");
  if (input.diskFreeMb <= config.storage.min_free_disk_mb) return skip("storage_full");
  if (!isActive(everyMinutes)) return skip("battery_tier");
  if (sessionBudgetSpent(input, config)) return skip("session_budget");
  if (dataBudgetSpent(input, config)) return skip("data_budget");
  return { action: "capture", everyMinutes };
}
