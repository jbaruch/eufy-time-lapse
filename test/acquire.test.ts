import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import { acquireFrame, chooseKeyframe } from "../src/capture/acquire.ts";
import type { AcquireOptions } from "../src/capture/acquire.ts";
import { liveSession, MockAdapter, rawVideo, tempDir } from "./helpers/fixtures.ts";
import type { MockBehavior } from "./helpers/fixtures.ts";

/** Lets real I/O run until something has happened. Counts event-loop turns rather than time, so it can't race a clock. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("chooseKeyframe", () => {
  const keyframe = (file: string, width: number, height: number) => ({ file, width, height, bytes: 1 });

  it("takes the last keyframe at the highest resolution", () => {
    const chosen = chooseKeyframe([keyframe("a", 1280, 720), keyframe("b", 3840, 2160), keyframe("c", 3840, 2160)]);
    assert.equal(chosen?.file, "c");
  });

  it("ignores a later, smaller keyframe", () => {
    const chosen = chooseKeyframe([keyframe("a", 3840, 2160), keyframe("b", 1280, 720)]);
    assert.equal(chosen?.file, "a");
  });

  it("has nothing to choose from an empty list", () => {
    assert.equal(chooseKeyframe([]), undefined);
  });
});

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
      targetKeyframes: 2,
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

  it("keeps each frame at its own size when the stream steps up mid-session, as the camera does", async () => {
    const { outputDir, result } = attempt({ open: async () => liveSession(Buffer.concat([lowRes, h264]), { codec: "h264" }) });
    const record = await result;

    assert.equal(record.status, "captured");
    const sizes = new Set(record.keyframes.map((keyframe) => `${keyframe.width}x${keyframe.height}`));
    assert.deepEqual([...sizes].sort(), ["1280x720", "640x360"], "no frame was rescaled to the first frame's size");
    assert.deepEqual([record.frame?.width, record.frame?.height], [1280, 720]);
    assert.deepEqual([record.video.actual_width, record.video.actual_height], [1280, 720], "reports the frame, not the stream's first config");

    const saved = await readFile(join(outputDir, "frame.jpg"));
    assert.equal(record.frame?.bytes, saved.length);
  });

  it("doesn't take a late low-resolution frame when the stream steps back down", async () => {
    const { result } = attempt({ open: async () => liveSession(Buffer.concat([h264, lowRes]), { codec: "h264" }) });
    const record = await result;
    assert.equal(record.status, "captured");
    assert.deepEqual([record.frame?.width, record.frame?.height], [1280, 720]);
    assert.deepEqual(record.keyframes.at(-1)?.width, 640, "the fixture really does end low");
  });

  it("marks a frame degraded when the stream never reaches the required size", async () => {
    const { result } = attempt({ open: async () => liveSession(h264, { codec: "h264" }) }, { minWidth: 3840, minHeight: 2160 });
    const record = await result;
    assert.equal(record.status, "captured_degraded");
    assert.deepEqual([record.frame?.width, record.frame?.height], [1280, 720], "kept at its real size, not scaled to fit");
  });

  describe("when to release the camera", () => {
    function liveFeed(video: Buffer) {
      const stream = new PassThrough();
      let notify: ((size: { width: number; height: number }) => void) | undefined;
      const session = {
        ...liveSession(Buffer.alloc(0), { codec: "h264" }),
        video: stream,
        audio: new PassThrough(),
        onKeyframe: (listener: (size: { width: number; height: number }) => void) => {
          notify = listener;
        },
      };
      stream.write(video);
      return {
        session,
        collecting: async () => until(() => notify !== undefined),
        keyframe: (width: number, height: number) => notify?.({ width, height }),
      };
    }

    it("stops as soon as enough keyframes at the required size have arrived", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const feed = liveFeed(h264);
      const { adapter, result } = attempt({ open: async () => feed.session }, { acquisitionTimeoutMs: 60_000 });
      await feed.collecting();
      feed.keyframe(1280, 720);
      feed.keyframe(1280, 720);
      // The short flush after the last keyframe, far from the attempt's deadline.
      t.mock.timers.tick(200);
      const record = await result;
      assert.equal(record.stream_stop, "target_reached");
      assert.equal(record.status, "captured");
      assert.equal(adapter.teardowns, 1);
    });

    it("keeps waiting through keyframes below the required size", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-07-01T13:00:00Z") });
      const feed = liveFeed(lowRes);
      const { result } = attempt({ open: async () => feed.session }, { acquisitionTimeoutMs: 150 });
      await feed.collecting();
      feed.keyframe(640, 360);
      feed.keyframe(640, 360);
      feed.keyframe(640, 360);
      t.mock.timers.tick(149);
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1);
      const record = await result;
      assert.equal(record.stream_stop, "deadline");
      assert.equal(record.status, "captured_degraded");
      assert.equal(record.timing.session_ms, 150, "it held the stream open for the 4K that never came");
    });

    it("needs the full count, not just one good keyframe", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const feed = liveFeed(h264);
      const { result } = attempt({ open: async () => feed.session }, { acquisitionTimeoutMs: 150 });
      await feed.collecting();
      feed.keyframe(1280, 720);
      t.mock.timers.tick(150);
      const record = await result;
      assert.equal(record.stream_stop, "deadline");
      assert.equal(record.status, "captured", "the one good frame still counts when time runs out");
    });

    it("records when the camera ended the stream itself", async () => {
      const { result } = attempt({ open: async () => liveSession(h264, { codec: "h264" }) });
      assert.equal((await result).stream_stop, "stream_ended");
    });
  });

  it("fails and still releases the camera when no video arrives before the deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const silent = (): ReturnType<typeof liveSession> => {
      const session = liveSession(Buffer.alloc(0));
      return { ...session, video: new PassThrough(), audio: new PassThrough() };
    };
    const { adapter, outputDir, result } = attempt({ open: async () => silent() }, { acquisitionTimeoutMs: 50 });
    await until(() => adapter.opens === 1);
    t.mock.timers.tick(50);
    const record = await result;
    assert.equal(record.status, "failed");
    assert.equal(record.failure?.reason, "capture_timeout");
    assert.equal(record.failure?.phase, "first_media");
    assert.equal(adapter.teardowns, 1);
    assert.equal(await exists(join(outputDir, "frame.jpg")), false);
  });

  it("uses what arrived when the deadline hits mid-stream", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const video = new PassThrough();
    const trickle = (): ReturnType<typeof liveSession> => {
      video.write(h265);
      return { ...liveSession(Buffer.alloc(0)), video, audio: new PassThrough() };
    };
    const { result } = attempt({ open: async () => trickle() }, { acquisitionTimeoutMs: 100 });
    await until(() => video.readableLength === 0 && video.listenerCount("data") > 0);
    t.mock.timers.tick(100);
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

  it("bounds a teardown that hangs", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let tearingDown = false;
    const hang = (): Promise<never> => {
      tearingDown = true;
      return new Promise(() => {});
    };
    const { result } = attempt({ open: async () => liveSession(h265), teardown: hang }, { cleanupTimeoutMs: 30 });
    await until(() => tearingDown);
    t.mock.timers.tick(30);
    const record = await result;
    assert.equal(record.status, "captured");
    assert.equal(record.cleanup.status, "timeout");
  });

  it("stops on a termination signal and releases the camera", async () => {
    const controller = new AbortController();
    const silent = { ...liveSession(Buffer.alloc(0)), video: new PassThrough(), audio: new PassThrough() };
    const { adapter, result } = attempt({ open: async () => silent }, { signal: controller.signal });
    await until(() => silent.video.listenerCount("data") > 0);
    controller.abort();
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
