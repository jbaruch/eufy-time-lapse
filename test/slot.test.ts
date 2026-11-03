import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import type { CleanupResult, LiveSession } from "../src/adapters/adapter.ts";
import { captureSlot } from "../src/capture/slot.ts";
import type { SlotOptions } from "../src/capture/slot.ts";
import { liveSession, MockAdapter, rawVideo, tempDir } from "./helpers/fixtures.ts";
import type { MockBehavior } from "./helpers/fixtures.ts";

describe("captureSlot", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let high: Buffer;
  let low: Buffer;
  let run = 0;

  before(async () => {
    dir = await tempDir();
    high = await rawVideo(dir.path, "h264", 1280, 720);
    low = await rawVideo(dir.path, "h264", 640, 360);
  });
  after(async () => {
    await dir.remove();
  });

  const unreachable = async (): Promise<LiveSession> => {
    throw new CaptureFailure("camera_unreachable", "connect", "no route");
  };
  const good = async (): Promise<LiveSession> => liveSession(high, { codec: "h264" });
  const small = async (): Promise<LiveSession> => liveSession(low, { codec: "h264" });

  function slot(script: Array<() => Promise<LiveSession>>, overrides: Partial<SlotOptions> = {}, teardown?: MockBehavior["teardown"]) {
    run += 1;
    const queue = [...script];
    const adapter = new MockAdapter({
      open: async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("this test did not expect another try");
        return await next();
      },
      ...(teardown === undefined ? {} : { teardown }),
    });
    const sleeps: number[] = [];
    const logged: string[] = [];
    const slotDir = join(dir.path, `slot-${run}`);
    const result = captureSlot({
      adapter,
      cameraKey: "serial",
      slotDir,
      acquisitionTimeoutMs: 2_000,
      cleanupTimeoutMs: 100,
      targetKeyframes: 2,
      minWidth: 1280,
      minHeight: 720,
      maxTries: 2,
      retryDelayMs: 30_000,
      slotDeadlineMs: 180_000,
      log: (message) => logged.push(message),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...overrides,
    });
    return { adapter, result, sleeps, logged, slotDir };
  }

  it("takes one try when the first succeeds", async () => {
    const { adapter, result, sleeps } = slot([good]);
    const { chosen, otherTries, firstTryStatus } = await result;
    assert.equal(chosen.status, "captured");
    assert.deepEqual(otherTries, []);
    assert.equal(firstTryStatus, "captured");
    assert.equal(adapter.opens, 1);
    assert.deepEqual(sleeps, []);
  });

  it("survives a camera that hangs up on the first try", async () => {
    const { adapter, result, sleeps, logged } = slot([unreachable, good]);
    const { chosen, otherTries, firstTryStatus } = await result;
    assert.equal(chosen.status, "captured");
    assert.equal(firstTryStatus, "failed", "the failure stays on the record");
    assert.equal(otherTries[0]?.failure?.reason, "camera_unreachable");
    assert.equal(adapter.opens, 2);
    assert.equal(adapter.teardowns, 2, "each try releases the camera");
    assert.deepEqual(sleeps, [30_000]);
    assert.match(logged[0] ?? "", /camera_unreachable/);
  });

  it("retries a stream the camera hung up on, the way most bad connects end", async () => {
    const hungUp = async (): Promise<LiveSession> => {
      throw new CaptureFailure("stream_lost", "first_media", "gone");
    };
    const { adapter, result } = slot([hungUp, good]);
    assert.equal((await result).chosen.status, "captured");
    assert.equal(adapter.opens, 2);
  });

  it("retries a frame below the required size, and keeps the larger one", async () => {
    const { result, slotDir } = slot([small, good]);
    const { chosen, otherTries, firstTryStatus } = await result;
    assert.equal(chosen.status, "captured");
    assert.deepEqual([chosen.frame?.width, chosen.frame?.height], [1280, 720]);
    assert.equal(firstTryStatus, "captured_degraded");
    assert.equal(otherTries[0]?.frame?.width, 640);
    await access(join(slotDir, "frame.jpg"));
    await access(`${slotDir}-retry-1/frame.jpg`);
  });

  it("keeps the degraded frame rather than losing it to a failed retry", async () => {
    const { result } = slot([small, unreachable]);
    const { chosen } = await result;
    assert.equal(chosen.status, "captured_degraded");
    assert.equal(chosen.frame?.width, 640);
  });

  it("reports failure only when every try fails, and stops at the limit", async () => {
    const { adapter, result } = slot([unreachable, unreachable]);
    const { chosen, otherTries } = await result;
    assert.equal(chosen.status, "failed");
    assert.equal(otherTries.length, 1);
    assert.equal(adapter.opens, 2);
  });

  for (const reason of ["auth_required", "stale_source", "aborted"] as const) {
    it(`never retries ${reason}`, async () => {
      const refuse = async (): Promise<LiveSession> => {
        throw new CaptureFailure(reason, "connect", "no");
      };
      const { adapter, result, sleeps } = slot([refuse]);
      assert.equal((await result).chosen.failure?.reason, reason);
      assert.equal(adapter.opens, 1);
      assert.deepEqual(sleeps, []);
    });
  }

  for (const status of ["error", "timeout"] as const) {
    const unclosed = async (): Promise<CleanupResult> => ({ status, detail: "the connection may still be open" });

    it(`doesn't wake the camera again after a failed try whose cleanup reports ${status}`, async () => {
      const { adapter, result, logged } = slot([unreachable, good], {}, unclosed);
      const { chosen, otherTries } = await result;
      assert.equal(adapter.opens, 1);
      assert.equal(chosen.status, "failed");
      assert.equal(otherTries.length, 0);
      assert.ok(logged.some((line) => line.includes("may not have closed") && line.includes(status)), logged.join("; "));
    });

    it(`keeps a degraded frame, and doesn't try to better it, after cleanup reports ${status}`, async () => {
      const { adapter, result } = slot([small, good], {}, unclosed);
      const { chosen } = await result;
      assert.equal(adapter.opens, 1);
      assert.equal(chosen.status, "captured_degraded");
      assert.equal(chosen.cleanup.status, status, "and the fault stays on the record");
    });
  }

  it("doesn't start a try that couldn't finish inside the slot deadline", async () => {
    const { adapter, result, logged } = slot([unreachable], { slotDeadlineMs: 30_000 });
    const { chosen } = await result;
    assert.equal(chosen.status, "failed");
    assert.equal(adapter.opens, 1);
    assert.match(logged[0] ?? "", /slot deadline/);
  });

  it("stops during the retry wait on a termination signal", async () => {
    const controller = new AbortController();
    const { adapter, result } = slot([unreachable], {
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });
    assert.equal((await result).chosen.status, "failed");
    assert.equal(adapter.opens, 1);
  });
});
