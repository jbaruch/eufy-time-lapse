import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CaptureFailure } from "../adapters/adapter.ts";
import type { CameraAdapter } from "../adapters/adapter.ts";
import { abortableSleep, captureSlot } from "../capture/slot.ts";
import { evaluateProbe, maskSerial, REPORT_SCHEMA_VERSION } from "./report.ts";
import type { CameraLink, ProbeAttempt, ProbeReport } from "./report.ts";
import type { ServiceConfig } from "../service-config.ts";

export const FRAME_POLICY = "last keyframe at the stream's highest resolution, never rescaled; all keyframes kept for review";

/** The service's own capture settings, so a check tests what production will do. */
export function probeCaptureOptions(capture: ServiceConfig["capture"]): Pick<ProbeOptions, "acquisitionTimeoutMs" | "cleanupTimeoutMs" | "targetKeyframes" | "maxTries" | "retryDelayMs" | "slotDeadlineMs"> {
  return {
    acquisitionTimeoutMs: capture.acquisition_timeout_seconds * 1000,
    cleanupTimeoutMs: capture.cleanup_timeout_seconds * 1000,
    targetKeyframes: capture.target_keyframes,
    maxTries: capture.max_attempts,
    retryDelayMs: capture.retry_delay_seconds * 1000,
    slotDeadlineMs: capture.slot_deadline_seconds * 1000,
  };
}

export interface ProbeOptions {
  adapter: CameraAdapter;
  runId: string;
  runDir: string;
  cameraId: string;
  cameraSerial?: string;
  attempts: number;
  intervalMs: number;
  targetKeyframes: number;
  maxTries: number;
  retryDelayMs: number;
  slotDeadlineMs: number;
  acquisitionTimeoutMs: number;
  cleanupTimeoutMs: number;
  minWidth: number;
  minHeight: number;
  link: CameraLink | null;
  operator: string | null;
  signal: AbortSignal;
  log: (message: string) => void;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

async function writeReport(runDir: string, report: ProbeReport): Promise<void> {
  const path = join(runDir, "report.json");
  await writeFile(`${path}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

/**
 * Runs the Phase 1 feasibility test: independent cold captures, spaced apart, with the camera released
 * after each. The report is rewritten after every attempt, so a crash loses at most the attempt in flight.
 */
export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const { adapter } = options;

  await mkdir(options.runDir, { recursive: true });

  const auth = await adapter.authenticate();
  if (auth.status !== "authenticated") {
    throw new CaptureFailure("auth_required", "auth", "Eufy needs a manual login step. Run the login command in a terminal, then rerun the probe.");
  }
  const camera = await adapter.discoverCamera(options.cameraSerial);

  const attempts: ProbeAttempt[] = [];
  const buildVerdict = (): ProbeReport["verdict"] =>
    evaluateProbe({
      attempts,
      requiredAttempts: options.attempts,
      minWidth: options.minWidth,
      minHeight: options.minHeight,
      link: options.link,
      unexpectedConnections: adapter.unexpectedConnectionCount(),
    });

  const report: ProbeReport = {
    schema_version: REPORT_SCHEMA_VERSION,
    run_id: options.runId,
    started_at: now().toISOString(),
    finished_at: null,
    adapter: { name: adapter.name, version: adapter.version },
    camera: {
      id: options.cameraId,
      model: camera.model,
      firmware: camera.firmware,
      serial_masked: maskSerial(camera.key),
      energy_saving: camera.energySaving,
    },
    connection: {
      type: options.link,
      basis: options.link === null ? "unconfirmed" : "owner_confirmed",
      operator: options.operator,
    },
    settings: {
      attempts: options.attempts,
      interval_ms: options.intervalMs,
      target_keyframes: options.targetKeyframes,
      max_tries: options.maxTries,
      retry_delay_ms: options.retryDelayMs,
      slot_deadline_ms: options.slotDeadlineMs,
      acquisition_timeout_ms: options.acquisitionTimeoutMs,
      cleanup_timeout_ms: options.cleanupTimeoutMs,
      min_width: options.minWidth,
      min_height: options.minHeight,
      frame_policy: FRAME_POLICY,
    },
    unexpected_connections: 0,
    attempts,
    verdict: buildVerdict(),
  };
  await writeReport(options.runDir, report);

  for (let index = 0; index < options.attempts; index += 1) {
    if (index > 0) {
      options.log(`waiting ${Math.round(options.intervalMs / 60_000)} min before attempt ${index + 1} of ${options.attempts}`);
      await sleep(options.intervalMs, options.signal);
    }
    if (options.signal.aborted) break;

    // Cloud read only: this doesn't contact the camera.
    const reading = await adapter.discoverCamera(camera.key);
    const readAt = now();
    options.log(`attempt ${index + 1} of ${options.attempts}: connecting`);
    const slot = await captureSlot({
      adapter,
      cameraKey: camera.key,
      slotDir: join(options.runDir, `attempt-${index + 1}`),
      acquisitionTimeoutMs: options.acquisitionTimeoutMs,
      cleanupTimeoutMs: options.cleanupTimeoutMs,
      targetKeyframes: options.targetKeyframes,
      minWidth: options.minWidth,
      minHeight: options.minHeight,
      maxTries: options.maxTries,
      retryDelayMs: options.retryDelayMs,
      slotDeadlineMs: options.slotDeadlineMs,
      signal: options.signal,
      log: options.log,
      sleep,
      now,
    });
    const record = slot.chosen;
    attempts.push({
      ...record,
      other_tries: slot.otherTries,
      first_try_status: slot.firstTryStatus,
      battery: {
        ...reading.battery,
        age_seconds:
          reading.battery.observedAt === null
            ? null
            : Math.round((readAt.getTime() - new Date(reading.battery.observedAt).getTime()) / 1000),
      },
      telemetry: reading.telemetry,
    });
    options.log(
      record.frame === null
        ? `attempt ${index + 1}: failed (${record.failure?.reason ?? "unknown"}): ${record.failure?.message ?? "no detail"}`
        : `attempt ${index + 1}: ${record.status}, ${record.frame.width}x${record.frame.height}, ${slot.otherTries.length + 1} tries, cleanup ${record.cleanup.status}`,
    );

    report.unexpected_connections = adapter.unexpectedConnectionCount();
    report.verdict = buildVerdict();
    await writeReport(options.runDir, report);
  }

  report.unexpected_connections = adapter.unexpectedConnectionCount();
  report.verdict = buildVerdict();
  report.finished_at = now().toISOString();
  await writeReport(options.runDir, report);
  return report;
}
