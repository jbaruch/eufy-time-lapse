import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import type { AuthChallenge, AuthInput, CameraAdapter, AuthState, CameraInfo, CleanupResult, LiveSession, LoginRenewal } from "../../src/adapters/adapter.ts";
import { FRESHNESS_BASIS, TRAFFIC_BASIS } from "../../src/capture/acquire.ts";
import { EXPOSURE_TIME_NOTE } from "../../src/stored-capture.ts";

const run = promisify(execFile);

export async function tempDir(): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "timelapse-test-"));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

/** Builds a short raw elementary stream with a keyframe every 5 frames, like the camera sends. */
export async function rawVideo(dir: string, codec: "h264" | "h265", width: number, height: number): Promise<Buffer> {
  const path = join(dir, `fixture-${codec}-${width}x${height}.bin`);
  const encoder = codec === "h264" ? ["-c:v", "libx264", "-g", "5", "-f", "h264"] : ["-c:v", "libx265", "-x265-params", "keyint=5:min-keyint=5:log-level=error", "-f", "hevc"];
  await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=10`, "-t", "2", "-pix_fmt", "yuv420p", ...encoder, path]);
  return await readFile(path);
}

export function liveSession(video: Buffer, overrides: Partial<LiveSession> = {}): LiveSession {
  const videoStream = new PassThrough();
  const audioStream = new PassThrough();
  videoStream.end(video);
  audioStream.end(Buffer.from([1, 2, 3, 4]));
  return {
    codec: "h265",
    reportedWidth: null,
    reportedHeight: null,
    reportedFps: 15,
    video: videoStream,
    audio: audioStream,
    connectMs: 1200,
    connectRetries: 0,
    coldConnection: true,
    connectionPath: "direct",
    onKeyframe: () => {},
    ...overrides,
  };
}

export const CAMERA: CameraInfo = {
  key: "T86P2FULLSERIAL1234",
  model: "T86P2",
  firmware: "1.2.3",
  energySaving: true,
  battery: { percent: 88, observedAt: "2026-01-02T03:00:00.000Z", note: null },
  telemetry: { cellularRSSI: -85 },
};

/** A complete stored record, as a publish writes it. Manual, until a test says otherwise. */
export function storedMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    capture_id: "id",
    project_id: "construction",
    camera_id: "site-overview",
    kind: "manual",
    slot_id: null,
    attempt_id: "attempt",
    schedule_revision: null,
    scheduled_at_utc: null,
    request_started_at: "2026-05-01T12:59:50.000Z",
    stream_started_at: "2026-05-01T12:59:55.000Z",
    frame_received_at: "2026-05-01T13:00:00.000Z",
    camera_captured_at: null,
    camera_captured_at_note: EXPOSURE_TIME_NOTE,
    site_time_zone: "America/Chicago",
    local_date: "2026-05-01",
    source: "live_p2p",
    capture_session_id: "session",
    freshness_basis: FRESHNESS_BASIS,
    cold_connection: true,
    retained: false,
    adapter: "mock",
    adapter_version: "0.0.0",
    camera_firmware: null,
    connection_type: "cellular",
    connection_path: "relay",
    cellular_operator: null,
    width: 3840,
    height: 2160,
    source_codec: "h265",
    jpeg_bytes: 10,
    sha256: "a".repeat(64),
    quality_status: "ok",
    attempt_count: 1,
    connect_ms: 9000,
    session_ms: 12000,
    cleanup_status: "ok",
    cleanup_detail: null,
    battery_percent: 80,
    battery_observed_at: "2026-05-01T12:50:00.000Z",
    battery_note: null,
    every_minutes: 5,
    media_video_bytes: 450000,
    media_audio_bytes: 0,
    traffic_measurement_basis: TRAFFIC_BASIS,
    ...overrides,
  };
}

export interface MockBehavior {
  open?: (signal: AbortSignal) => Promise<LiveSession>;
  teardown?: () => Promise<CleanupResult>;
  auth?: AuthState[];
  authFailure?: () => Error;
  shutdownFailure?: () => Error;
  camera?: CameraInfo;
  unexpected?: number;
  discoverFailure?: () => Error;
  discoverHang?: Promise<void>;
  loginExpiresAt?: Date;
  renewal?: () => LoginRenewal;
  trusted?: boolean | null;
  trustOutcome?: boolean;
}

export class MockAdapter implements CameraAdapter {
  readonly name = "mock";
  readonly version = "0.0.0";
  teardowns = 0;
  opens = 0;
  shutdowns = 0;
  renewals = 0;
  trustCodes: string[] = [];
  private readonly behavior: MockBehavior;

  constructor(behavior: MockBehavior = {}) {
    this.behavior = behavior;
  }

  /** Whether later discoveries fail, for tests of a cloud that's gone away. */
  setDiscoverFailure(failure: (() => Error) | undefined): void {
    if (failure === undefined) delete this.behavior.discoverFailure;
    else this.behavior.discoverFailure = failure;
  }

  /** The camera a later discovery should report, for tests of a reading that changes. */
  setCamera(camera: CameraInfo): void {
    this.behavior.camera = camera;
  }

  async authenticate(): Promise<AuthState> {
    if (this.behavior.authFailure !== undefined) throw this.behavior.authFailure();
    return this.behavior.auth?.shift() ?? { status: "authenticated" };
  }

  /** When the stored login ends, for tests of renewing it. */
  setLoginExpiry(at: Date): void {
    this.behavior.loginExpiresAt = at;
  }

  setRenewal(renewal: () => LoginRenewal): void {
    this.behavior.renewal = renewal;
  }

  loginExpiresAt(): Date | null {
    return this.behavior.loginExpiresAt ?? null;
  }

  async renewLogin(): Promise<LoginRenewal> {
    this.renewals += 1;
    return this.behavior.renewal?.() ?? { status: "renewed" };
  }

  async isDeviceTrusted(): Promise<boolean | null> {
    return this.behavior.trusted === undefined ? true : this.behavior.trusted;
  }

  async trustDevice(answer: (challenge: AuthChallenge) => Promise<AuthInput>): Promise<boolean> {
    const input = await answer({ status: "tfa_required" });
    if ("verifyCode" in input) this.trustCodes.push(input.verifyCode);
    return this.behavior.trustOutcome ?? true;
  }

  /** Discoveries wait on this, for tests of a call that never answers. */
  setDiscoverHang(hang: Promise<void>): void {
    this.behavior.discoverHang = hang;
  }

  async discoverCamera(): Promise<CameraInfo> {
    if (this.behavior.discoverHang !== undefined) await this.behavior.discoverHang;
    if (this.behavior.discoverFailure !== undefined) throw this.behavior.discoverFailure();
    return this.behavior.camera ?? CAMERA;
  }

  async openLiveSession(_key: string, signal: AbortSignal): Promise<LiveSession> {
    this.opens += 1;
    if (this.behavior.open === undefined) throw new Error("this test did not expect a live session");
    return await this.behavior.open(signal);
  }

  async teardown(): Promise<CleanupResult> {
    this.teardowns += 1;
    return this.behavior.teardown === undefined ? { status: "ok", detail: null } : await this.behavior.teardown();
  }

  unexpectedConnectionCount(): number {
    return this.behavior.unexpected ?? 0;
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
    if (this.behavior.shutdownFailure !== undefined) throw this.behavior.shutdownFailure();
  }
}
