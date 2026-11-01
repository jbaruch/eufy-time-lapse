import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import { runProbe } from "../src/probe/probe.ts";
import type { ProbeOptions } from "../src/probe/probe.ts";
import type { ProbeReport } from "../src/probe/report.ts";
import { CAMERA, liveSession, MockAdapter, rawVideo, tempDir } from "./helpers/fixtures.ts";
import type { MockBehavior } from "./helpers/fixtures.ts";

describe("runProbe", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let video: Buffer;
  let run = 0;

  before(async () => {
    dir = await tempDir();
    video = await rawVideo(dir.path, "h265", 1280, 720);
  });
  after(async () => {
    await dir.remove();
  });

  function options(behavior: MockBehavior, overrides: Partial<Omit<ProbeOptions, "adapter">> = {}): ProbeOptions & { sleeps: number[]; adapter: MockAdapter } {
    run += 1;
    const sleeps: number[] = [];
    return {
      adapter: new MockAdapter(behavior),
      runId: `run-${run}`,
      runDir: join(dir.path, `run-${run}`),
      cameraId: "site-overview",
      attempts: 3,
      intervalMs: 900_000,
      streamMs: 50,
      acquisitionTimeoutMs: 2_000,
      cleanupTimeoutMs: 100,
      minWidth: 1280,
      minHeight: 720,
      link: "cellular",
      operator: "Test Telecom",
      signal: new AbortController().signal,
      log: () => {},
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      sleeps,
      ...overrides,
    };
  }

  it("runs spaced, independent attempts and passes", async () => {
    const opts = options({ open: async () => liveSession(video) });
    const report = await runProbe(opts);

    assert.equal(report.verdict.result, "pass");
    assert.equal(report.attempts.length, 3);
    assert.equal(opts.adapter.opens, 3, "a new live session per attempt");
    assert.equal(opts.adapter.teardowns, 3, "the camera is released after each attempt");
    assert.deepEqual(opts.sleeps, [900_000, 900_000], "waits between attempts, not after the last");
    assert.equal(report.attempts[0]?.battery.percent, 88);
    assert.equal(report.attempts[0]?.battery.age_seconds, 245);
    assert.equal(report.connection.type, "cellular");
    assert.equal(report.connection.basis, "owner_confirmed");
    assert.equal(report.connection.operator, "Test Telecom");
    assert.notEqual(report.finished_at, null);
  });

  it("writes the same report to disk, without the full serial", async () => {
    const opts = options({ open: async () => liveSession(video) });
    const report = await runProbe(opts);
    const text = await readFile(join(opts.runDir, "report.json"), "utf8");
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(report)));
    assert.equal(text.includes(CAMERA.key), false);
    assert.equal(report.camera.serial_masked.endsWith("1234"), true);
    assert.equal(report.schema_version, 2);
  });

  it("keeps going after a failed attempt and reports the next experiment", async () => {
    let calls = 0;
    const opts = options({
      open: async () => {
        calls += 1;
        if (calls === 2) throw new CaptureFailure("camera_unreachable", "connect", "no route");
        return liveSession(video);
      },
    });
    const report = await runProbe(opts);
    assert.equal(report.attempts.length, 3);
    assert.deepEqual(report.attempts.map((attempt) => attempt.status), ["captured", "failed", "captured"]);
    assert.equal(report.verdict.result, "fail");
    assert.match(report.verdict.next_experiment ?? "", /P2P never connected/);
  });

  it("saves progress after each attempt", async () => {
    const opts = options({ open: async () => liveSession(video) }, { attempts: 2 });
    const seen: number[] = [];
    opts.sleep = async () => {
      const onDisk = JSON.parse(await readFile(join(opts.runDir, "report.json"), "utf8")) as ProbeReport;
      seen.push(onDisk.attempts.length);
    };
    await runProbe(opts);
    assert.deepEqual(seen, [1]);
  });

  it("stops before touching the camera when a manual login is needed", async () => {
    const opts = options({ auth: [{ status: "tfa_required" }] });
    await assert.rejects(runProbe(opts), (error: CaptureFailure) => {
      assert.equal(error.reason, "auth_required");
      assert.match(error.message, /login command/);
      return true;
    });
    assert.equal(opts.adapter.opens, 0);
  });

  it("stops waiting and reports what it has on a termination signal", async () => {
    const controller = new AbortController();
    const opts = options({ open: async () => liveSession(video) }, { signal: controller.signal });
    opts.sleep = async () => {
      controller.abort();
    };
    const report = await runProbe(opts);
    assert.equal(report.attempts.length, 1);
    assert.equal(opts.adapter.opens, 1);
    assert.notEqual(report.verdict.result, "pass");
  });
});
