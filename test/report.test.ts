import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateProbe, maskSerial } from "../src/probe/report.ts";
import type { CameraLink, ProbeAttempt } from "../src/probe/report.ts";

function captured(overrides: Partial<ProbeAttempt> = {}): ProbeAttempt {
  return {
    attempt_id: "attempt-1",
    capture_session_id: "session",
    status: "captured",
    failure: null,
    timing: {
      request_started_at: "2026-01-01T00:00:00.000Z",
      stream_started_at: "2026-01-01T00:00:05.000Z",
      first_media_at: "2026-01-01T00:00:06.000Z",
      frame_saved_at: "2026-01-01T00:00:20.000Z",
      connect_ms: 5000,
      session_ms: 19000,
    },
    video: { reported_codec: "h265", reported_width: 1920, reported_height: 1080, reported_fps: 15, actual_codec: "hevc", actual_width: 1920, actual_height: 1080 },
    freshness: { source: "live_p2p", retained: false, basis: "test", cold_connection: true },
    traffic: { video_bytes: 1000, audio_bytes: 10, basis: "test" },
    cleanup: { status: "ok", detail: null },
    connect_retries: 0,
    connection_path: "relay",
    stream_stop: "target_reached",
    audio_error: null,
    frame: { file: "frame.jpg", width: 1920, height: 1080, bytes: 500, sha256: "abc" },
    keyframes: [],
    keyframe_errors: [],
    other_tries: [],
    first_try_status: "captured",
    battery: { percent: 80, observedAt: null, note: "none", age_seconds: null },
    telemetry: {},
    ...overrides,
  };
}

function failed(phase: NonNullable<ProbeAttempt["failure"]>["phase"]): ProbeAttempt {
  return captured({ status: "failed", frame: null, failure: { reason: "camera_unreachable", phase, message: "it failed" } });
}

function verdict(attempts: ProbeAttempt[], overrides: { link?: CameraLink | null; unexpected?: number; required?: number } = {}) {
  return evaluateProbe({
    attempts,
    requiredAttempts: overrides.required ?? 3,
    minWidth: 1280,
    minHeight: 720,
    link: overrides.link === undefined ? "cellular" : overrides.link,
    unexpectedConnections: overrides.unexpected ?? 0,
  });
}

describe("evaluateProbe", () => {
  it("passes when every criterion holds", () => {
    const result = verdict([captured(), captured(), captured()]);
    assert.equal(result.result, "pass");
    assert.equal(result.next_experiment, null);
  });

  it("is incomplete while attempts remain and nothing has failed", () => {
    assert.equal(verdict([captured()]).result, "incomplete");
  });

  it("fails as soon as an attempt fails, without waiting for the rest", () => {
    assert.equal(verdict([failed("connect")]).result, "fail");
  });

  it("does not pass on a Wi-Fi link, or an unconfirmed one", () => {
    for (const link of ["wifi", null] as const) {
      const result = verdict([captured(), captured(), captured()], { link });
      assert.equal(result.result, "fail");
      assert.equal(result.criteria.native_lte_confirmed.passed, false);
      assert.match(result.next_experiment ?? "", /built-in SIM/);
    }
  });

  it("does not pass on a session that reused an open connection", () => {
    const warm = captured({ freshness: { source: "live_p2p", retained: false, basis: "test", cold_connection: false } });
    const result = verdict([captured(), warm, captured()]);
    assert.equal(result.result, "fail");
    assert.match(result.criteria.fresh_live_sessions.detail, /attempt 2/);
  });

  it("does not pass below the minimum resolution", () => {
    const small = captured({ status: "captured_degraded", frame: { file: "frame.jpg", width: 640, height: 360, bytes: 1, sha256: "x" } });
    const result = verdict([captured(), captured(), small]);
    assert.equal(result.result, "fail");
    assert.match(result.criteria.minimum_resolution.detail, /640x360/);
    assert.match(result.next_experiment ?? "", /Video Streaming Quality/);
  });

  it("does not pass when a connection failed to close", () => {
    const leaky = captured({ cleanup: { status: "timeout", detail: "still open" } });
    const result = verdict([captured(), captured(), leaky]);
    assert.equal(result.result, "fail");
    assert.match(result.criteria.resources_released.detail, /still open/);
  });

  it("does not pass when an earlier try failed to release the camera, even if the retry captured", () => {
    const leakyTry = captured({ status: "failed", frame: null, cleanup: { status: "timeout", detail: "still open" } });
    const rescued = captured({ other_tries: [leakyTry], first_try_status: "failed" });
    const result = verdict([captured(), rescued, captured()]);
    assert.equal(result.result, "fail");
    assert.match(result.criteria.resources_released.detail, /attempt 2: cleanup timeout/);
  });

  it("passes a capture a retry rescued, and still counts it against the first try", () => {
    const failedTry = captured({ status: "failed", frame: null, failure: { reason: "capture_timeout", phase: "first_media", message: "hung up" } });
    const rescued = captured({ other_tries: [failedTry], first_try_status: "failed" });
    const result = verdict([captured(), rescued, captured()]);
    assert.equal(result.result, "pass");
    assert.equal(result.first_try_captures, 2);
  });

  it("does not pass when the library woke the camera outside an attempt", () => {
    const result = verdict([captured(), captured(), captured()], { unexpected: 2 });
    assert.equal(result.result, "fail");
    assert.match(result.criteria.resources_released.detail, /2 connection/);
    assert.match(result.next_experiment ?? "", /outside an attempt/);
  });

  it("names a next experiment for each way an attempt can fail", () => {
    const expectations = [
      ["auth", /login command/],
      ["discovery", /visible to this account/],
      ["connect", /newer SDK/],
      ["stream_start", /no video arrived/],
      ["first_media", /no video arrived/],
      ["decode", /stream\.bin/],
    ] as const;
    for (const [phase, expected] of expectations) {
      assert.match(verdict([failed(phase)]).next_experiment ?? "", expected, phase);
    }
  });

  it("doesn't suggest a longer timeout for a stream the camera ended itself", () => {
    const lost = captured({ status: "failed", frame: null, failure: { reason: "stream_lost", phase: "first_media", message: "the stream ended with no video" } });
    const advice = verdict([lost]).next_experiment ?? "";
    assert.match(advice, /ended the stream before any video/);
    assert.doesNotMatch(advice, /longer acquisition timeout/);
  });
});

describe("maskSerial", () => {
  it("keeps only the last four characters", () => {
    assert.equal(maskSerial("T86P2ABCDEF1234"), "***********1234");
  });

  it("hides short values entirely", () => {
    assert.equal(maskSerial("1234"), "****");
  });
});
