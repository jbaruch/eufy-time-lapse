import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import type { CameraAdapter, AuthState, CameraInfo, CleanupResult, LiveSession } from "../../src/adapters/adapter.ts";

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

export interface MockBehavior {
  open?: (signal: AbortSignal) => Promise<LiveSession>;
  teardown?: () => Promise<CleanupResult>;
  auth?: AuthState[];
  camera?: CameraInfo;
  unexpected?: number;
}

export class MockAdapter implements CameraAdapter {
  readonly name = "mock";
  readonly version = "0.0.0";
  teardowns = 0;
  opens = 0;
  private readonly behavior: MockBehavior;

  constructor(behavior: MockBehavior = {}) {
    this.behavior = behavior;
  }

  async authenticate(): Promise<AuthState> {
    return this.behavior.auth?.shift() ?? { status: "authenticated" };
  }

  async discoverCamera(): Promise<CameraInfo> {
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

  async shutdown(): Promise<void> {}
}
