import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import { acquireFrame } from "../src/capture/acquire.ts";
import type { AcquireOptions } from "../src/capture/acquire.ts";
import { liveSession, MockAdapter, rawVideo, tempDir } from "./helpers/fixtures.ts";
import type { MockBehavior } from "./helpers/fixtures.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("acquireFrame", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let h265: Buffer;
  let h264: Buffer;
  let lowRes: Buffer;
  let counter = 0;

  before(async () => {
    dir = await tempDir();
    h265 = await rawVideo(dir.path, "h265", 1920, 1080);
    h264 = await rawVideo(dir.path, "h264", 1280, 720);
    lowRes = await rawVideo(dir.path, "h264", 640, 360);
  });
  after(async () => {
    await dir.remove();
  });

  function attempt(behavior: MockBehavior, options: Partial<AcquireOptions> = {}) {
    counter += 1;
    const adapter = new MockAdapter(behavior);
    const outputDir = join(dir.path, `attempt-${counter}`);
    const result = acquireFrame({
      adapter,
      cameraKey: "serial",
      outputDir,
      acquisitionTimeoutMs: 2_000,
      cleanupTimeoutMs: 200,
      streamMs: 100,
      minWidth: 1280,
      minHeight: 720,
      ...options,
    });
    return { adapter, outputDir, result };
  }

  it("saves a frame at the stream's real resolution and records its hash", async () => {
    const { adapter, outputDir, result } = attempt({ open: async () => liveSession(h265) });
    const record = await result;

    assert.equal(record.status, "captured");
    assert.equal(record.failure, null);
    assert.deepEqual([record.frame?.width, record.frame?.height], [1920, 1080]);
    assert.equal(record.video.actual_codec, "hevc");
    assert.equal(record.freshness.source, "live_p2p");
    assert.equal(record.freshness.retained, false);
    assert.equal(record.freshness.cold_connection, true);
    assert.equal(record.traffic.video_bytes, h265.length);
    assert.equal(record.traffic.audio_bytes, 4);
    assert.ok(record.keyframes.length >= 2, "keeps every keyframe for review");
    assert.equal(adapter.teardowns, 1);
    assert.equal(record.cleanup.status, "ok");

    const frame = await readFile(join(outputDir, "frame.jpg"));
    assert.equal(record.frame?.sha256, createHash("sha256").update(frame).digest("hex"));
    assert.ok(record.timing.frame_saved_at !== null);
  });

  it("trusts the bytes over the codec the camera claims", async () => {
    const { result } = attempt({ open: async () => liveSession(h265, { codec: "h264" }) });
    const record = await result;
    assert.equal(record.status, "captured");
    assert.equal(record.video.reported_codec, "h264");
    assert.equal(record.video.actual_codec, "hevc");
  });

  it("decodes H.264 too", async () => {
    const { result } = attempt({ open: async () => liveSession(h264, { codec: "h264" }) });
    const record = await result;
    assert.equal(record.status, "captured");
    assert.deepEqual([record.frame?.width, record.frame?.height], [1280, 720]);
  });

  it("keeps a below-minimum frame but marks it degraded", async () => {
    const { outputDir, result } = attempt({ open: async () => liveSession(lowRes, { codec: "h264" }) });
    const record = await result;
    assert.equal(record.status, "captured_degraded");
    assert.deepEqual([record.frame?.width, record.frame?.height], [640, 360]);
    assert.equal(await exists(join(outputDir, "frame.jpg")), true);
  });

  it("fails and still releases the camera when no video arrives before the deadline", async () => {
    const silent = (): ReturnType<typeof liveSession> => {
      const session = liveSession(Buffer.alloc(0));
      return { ...session, video: new PassThrough(), audio: new PassThrough() };
    };
    const { adapter, outputDir, result } = attempt({ open: async () => silent() }, { acquisitionTimeoutMs: 50 });
    const record = await result;
    assert.equal(record.status, "failed");
    assert.equal(record.failure?.reason, "capture_timeout");
    assert.equal(record.failure?.phase, "first_media");
    assert.equal(adapter.teardowns, 1);
    assert.equal(await exists(join(outputDir, "frame.jpg")), false);
  });

  it("uses what arrived when the deadline hits mid-stream", async () => {
    const trickle = (): ReturnType<typeof liveSession> => {
      const video = new PassThrough();
      video.write(h265);
      return { ...liveSession(Buffer.alloc(0)), video, audio: new PassThrough() };
    };
    const { result } = attempt({ open: async () => trickle() }, { acquisitionTimeoutMs: 100, streamMs: 60_000 });
    const record = await result;
    assert.equal(record.status, "captured");
  });

  it("never substitutes anything when the video won't decode", async () => {
    const { outputDir, result } = attempt({ open: async () => liveSession(Buffer.alloc(4096, 0x41)) });
    const record = await result;
    assert.equal(record.status, "failed");
    assert.equal(record.failure?.reason, "decode_failed");
    assert.equal(record.frame, null);
    assert.equal(await exists(join(outputDir, "frame.jpg")), false);
    assert.equal(await exists(join(outputDir, "stream.bin")), true, "raw stream stays for diagnosis");
  });

  it("reports a refused connection and still tears down", async () => {
    const { adapter, result } = attempt({
      open: async () => {
        throw new CaptureFailure("camera_unreachable", "connect", "no route");
      },
    });
    const record = await result;
    assert.equal(record.failure?.reason, "camera_unreachable");
    assert.equal(record.failure?.phase, "connect");
    assert.equal(adapter.teardowns, 1);
  });

  it("keeps the frame when teardown rejects, and records the fault", async () => {
    const { outputDir, result } = attempt({
      open: async () => liveSession(h265),
      teardown: async () => {
        throw new Error("stop refused");
      },
    });
    const record = await result;
    assert.equal(record.status, "captured");
    assert.deepEqual(record.cleanup, { status: "error", detail: "stop refused" });
    assert.equal(await exists(join(outputDir, "frame.jpg")), true);
  });

  it("bounds a teardown that hangs", async () => {
    const { result } = attempt({ open: async () => liveSession(h265), teardown: () => new Promise(() => {}) }, { cleanupTimeoutMs: 30 });
    const record = await result;
    assert.equal(record.status, "captured");
    assert.equal(record.cleanup.status, "timeout");
  });

  it("stops on a termination signal and releases the camera", async () => {
    const controller = new AbortController();
    const silent = { ...liveSession(Buffer.alloc(0)), video: new PassThrough(), audio: new PassThrough() };
    const { adapter, result } = attempt({ open: async () => silent }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const record = await result;
    assert.equal(record.failure?.reason, "aborted");
    assert.equal(adapter.teardowns, 1);
  });

  it("propagates an unexpected error after tearing down", async () => {
    const { adapter, result } = attempt({
      open: async () => {
        throw new TypeError("a bug, not a camera problem");
      },
    });
    await assert.rejects(result, TypeError);
    assert.equal(adapter.teardowns, 1);
  });
});
