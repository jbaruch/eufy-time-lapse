import type { BatteryReading } from "../adapters/adapter.ts";
import type { AttemptRecord } from "../capture/acquire.ts";

/**
 * Probe report schema. Owner and sole writer: src/probe/probe.ts. Readers are humans and the Phase 1
 * sign-off. Bump REPORT_SCHEMA_VERSION on any shape change.
 */
export const REPORT_SCHEMA_VERSION = 4;

export type CameraLink = "cellular" | "wifi";

/** One scheduled capture. Its top-level fields are the try whose frame the slot keeps. */
export interface ProbeAttempt extends AttemptRecord {
  /** Every other try. A failed try still woke the camera, so it stays on the record. */
  other_tries: AttemptRecord[];
  first_try_status: AttemptRecord["status"];
  battery: BatteryReading & { age_seconds: number | null };
  telemetry: Record<string, string | number | boolean>;
}

export interface Criterion {
  passed: boolean;
  detail: string;
}

export interface ProbeVerdict {
  /** pass: Phase 1 can proceed. fail: a criterion failed. incomplete: not all attempts have run. */
  result: "pass" | "fail" | "incomplete";
  criteria: {
    all_attempts_ran: Criterion;
    fresh_live_sessions: Criterion;
    minimum_resolution: Criterion;
    resources_released: Criterion;
    native_lte_confirmed: Criterion;
  };
  next_experiment: string | null;
  /** How many captures needed no retry. Retries rescue a capture, and this keeps the failure rate visible. */
  first_try_captures: number;
}

export interface ProbeReport {
  schema_version: number;
  run_id: string;
  started_at: string;
  finished_at: string | null;
  adapter: { name: string; version: string };
  camera: { id: string; model: string; firmware: string | null; serial_masked: string; energy_saving: boolean };
  connection: { type: CameraLink | null; basis: "owner_confirmed" | "unconfirmed"; operator: string | null };
  settings: {
    attempts: number;
    interval_ms: number;
    target_keyframes: number;
    max_tries: number;
    retry_delay_ms: number;
    slot_deadline_ms: number;
    acquisition_timeout_ms: number;
    cleanup_timeout_ms: number;
    min_width: number;
    min_height: number;
    frame_policy: string;
  };
  unexpected_connections: number;
  attempts: ProbeAttempt[];
  verdict: ProbeVerdict;
}

export function maskSerial(serial: string): string {
  return serial.length <= 4 ? "****" : `${"*".repeat(serial.length - 4)}${serial.slice(-4)}`;
}

function summarize(attempts: ProbeAttempt[], failed: (attempt: ProbeAttempt) => string | null): Criterion {
  const problems = attempts.flatMap((attempt, index) => {
    const problem = failed(attempt);
    return problem === null ? [] : [`attempt ${index + 1}: ${problem}`];
  });
  return attempts.length === 0
    ? { passed: false, detail: "no attempts have run" }
    : { passed: problems.length === 0, detail: problems.length === 0 ? "all attempts" : problems.join("; ") };
}

function chooseNextExperiment(criteria: ProbeVerdict["criteria"], attempts: ProbeAttempt[], unexpected: number): string | null {
  const firstFailure = attempts.find((attempt) => attempt.failure !== null)?.failure;
  if (firstFailure !== undefined && firstFailure !== null) {
    switch (firstFailure.phase) {
      case "auth":
        return "Run the login command, complete any 2FA or captcha, then rerun the probe.";
      case "discovery":
        return "Make the camera visible to this account (share it from the owner account, or set EUFY_CAMERA_SERIAL), then rerun the probe.";
      case "connect":
        return "P2P never connected. Read library.log for the lookup and relay steps, then rerun with a newer SDK build.";
      case "stream_start":
      case "first_media":
        return "P2P connected but no video arrived. Read library.log around the stream start, check the camera's battery and signal in the app, then rerun with a longer acquisition timeout.";
      case "decode":
        return "Video arrived but would not decode. Inspect the attempt's stream.bin with ffprobe and fix the stream handling.";
    }
  }
  if (!criteria.resources_released.passed) {
    return unexpected > 0
      ? "The library opened connections outside an attempt. Find the trigger in library.log before any continuous run: each one wakes the camera."
      : "The camera connection did not close cleanly. Read library.log around teardown and verify the release before any continuous run.";
  }
  if (!criteria.minimum_resolution.passed) {
    return "Frames are below the minimum. Raise Video Streaming Quality in the eufy app, then rerun the probe.";
  }
  if (!criteria.fresh_live_sessions.passed) {
    return "An attempt reused an existing camera connection. Close the app's live view and rerun the probe from a cold camera.";
  }
  if (!criteria.native_lte_confirmed.passed) {
    return "Confirm in the eufy app that the camera is on its built-in SIM, set TIMELAPSE_CAMERA_LINK=cellular, then rerun the probe.";
  }
  return null;
}

export function evaluateProbe(input: {
  attempts: ProbeAttempt[];
  requiredAttempts: number;
  minWidth: number;
  minHeight: number;
  link: CameraLink | null;
  unexpectedConnections: number;
}): ProbeVerdict {
  const { attempts, requiredAttempts, minWidth, minHeight, link, unexpectedConnections } = input;

  const criteria: ProbeVerdict["criteria"] = {
    all_attempts_ran: {
      passed: attempts.length >= requiredAttempts,
      detail: `${attempts.length} of ${requiredAttempts}`,
    },
    fresh_live_sessions: summarize(attempts, (attempt) => {
      if (attempt.frame === null) return attempt.failure?.message ?? "no frame";
      return attempt.freshness.cold_connection === true ? null : "reused an existing camera connection";
    }),
    minimum_resolution: summarize(attempts, (attempt) => {
      if (attempt.frame === null) return "no frame";
      return attempt.frame.width >= minWidth && attempt.frame.height >= minHeight
        ? null
        : `${attempt.frame.width}x${attempt.frame.height} is below ${minWidth}x${minHeight}`;
    }),
    resources_released: (() => {
      const cleanups = summarize(attempts, (attempt) => {
        const faulty = [attempt, ...attempt.other_tries].find((entry) => entry.cleanup.status !== "ok");
        return faulty === undefined ? null : `cleanup ${faulty.cleanup.status}: ${faulty.cleanup.detail ?? "no detail"}`;
      });
      if (unexpectedConnections === 0) return cleanups;
      const problem = `${unexpectedConnections} connection(s) opened outside an attempt`;
      return { passed: false, detail: cleanups.passed ? problem : `${cleanups.detail}; ${problem}` };
    })(),
    native_lte_confirmed: {
      passed: link === "cellular",
      detail: link === null ? "not confirmed: TIMELAPSE_CAMERA_LINK is unset" : `owner confirmed: ${link}`,
    },
  };

  const anyAttemptFailed = attempts.some((attempt) => attempt.frame === null);
  const allPassed = Object.values(criteria).every((criterion) => criterion.passed);
  const result = allPassed ? "pass" : !criteria.all_attempts_ran.passed && !anyAttemptFailed ? "incomplete" : "fail";

  return {
    result,
    criteria,
    next_experiment: result === "fail" ? chooseNextExperiment(criteria, attempts, unexpectedConnections) : null,
    first_try_captures: attempts.filter((attempt) => attempt.first_try_status === "captured").length,
  };
}
