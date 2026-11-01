import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import type { AuthState, CameraInfo, LiveSession } from "../src/adapters/adapter.ts";
import { DEFAULT_SERVICE_CONFIG } from "../src/service-config.ts";
import type { ServiceConfig } from "../src/service-config.ts";
import { CameraLockHeldError, withCameraLock } from "../src/lock.ts";
import { CaptureService, scheduleRevision } from "../src/service.ts";
import { parseCaptureMetadata } from "../src/stored-capture.ts";
import type { CaptureMetadata } from "../src/stored-capture.ts";
import { State } from "../src/state.ts";
import type { AttemptRow, SlotState } from "../src/state.ts";
import { buildCalibration, buildStatus } from "../src/status.ts";
import { CAMERA, liveSession, MockAdapter, rawVideo, tempDir } from "./helpers/fixtures.ts";
import type { MockBehavior } from "./helpers/fixtures.ts";

const SLOT_0800 = "construction/site-overview/2026-07-01T13:00:00.000Z";
const AT_0800 = Date.parse("2026-07-01T13:00:00Z");
const MINUTE = 60_000;

function serviceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return { ...DEFAULT_SERVICE_CONFIG, ...overrides };
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

describe("CaptureService", () => {
  let root: { path: string; remove: () => Promise<void> };
  let video: Buffer;
  let run = 0;

  before(async () => {
    root = await tempDir();
    video = await rawVideo(root.path, "h264", 1280, 720);
  });
  after(async () => {
    await root.remove();
  });

  const fresh = async (): Promise<LiveSession> => liveSession(video, { codec: "h264" });
  const hangUp = async (): Promise<LiveSession> => {
    throw new CaptureFailure("capture_timeout", "first_media", "the camera hung up");
  };
  const reading = (percent: number | null, observedAt: string | null = new Date(AT_0800).toISOString()): CameraInfo => ({ ...CAMERA, battery: { percent, observedAt, note: null } });

  interface Harness {
    service: CaptureService;
    state: State;
    adapter: MockAdapter;
    created: { count: number };
    notices: string[];
    dataDir: string;
    clock: { ms: number };
    disk: { mb: number };
    signal: AbortSignal;
    restart: () => { service: CaptureService; state: State };
  }

  async function harness(options: { sleep?: () => Promise<void>; open?: (signal: AbortSignal) => Promise<LiveSession>; teardown?: MockBehavior["teardown"]; authFailure?: MockBehavior["authFailure"]; shutdownFailure?: MockBehavior["shutdownFailure"]; camera?: CameraInfo; auth?: AuthState[]; config?: ServiceConfig; startMs?: number } = {}): Promise<Harness> {
    run += 1;
    const dataDir = join(root.path, `data-${run}`);
    await mkdir(dataDir, { recursive: true });
    const clock = { ms: options.startMs ?? AT_0800 };
    const now = (): Date => new Date(clock.ms);
    const disk = { mb: 50_000 };
    const notices: string[] = [];
    const adapter = new MockAdapter({ open: options.open ?? fresh, camera: options.camera ?? reading(80), ...(options.teardown ? { teardown: options.teardown } : {}), ...(options.authFailure ? { authFailure: options.authFailure } : {}), ...(options.shutdownFailure ? { shutdownFailure: options.shutdownFailure } : {}), ...(options.auth ? { auth: options.auth } : {}) });
    const created = { count: 0 };
    const build = (state: State): CaptureService =>
      new CaptureService({
        config: options.config ?? serviceConfig(),
        state,
        createAdapter: () => {
          created.count += 1;
          return adapter;
        },
        dataDir,
        minWidth: 1280,
        minHeight: 720,
        link: "cellular",
        operator: "Test Telecom",
        log: () => {},
        notify: async (text) => {
          notices.push(text);
        },
        now,
        sleep: options.sleep ?? (async () => {}),
        diskFreeMb: async () => disk.mb,
      });
    const state = new State(join(dataDir, "state.sqlite"), now);
    return {
      service: build(state),
      state,
      adapter,
      created,
      notices,
      dataDir,
      clock,
      disk,
      signal: new AbortController().signal,
      restart: () => {
        const reopened = new State(join(dataDir, "state.sqlite"), now);
        return { service: build(reopened), state: reopened };
      },
    };
  }

  /** Runs everything due at each of the given minutes after 08:00. */
  async function runAt(h: Harness, minutes: number[]): Promise<void> {
    for (const minute of minutes) {
      h.clock.ms = AT_0800 + minute * MINUTE;
      while ((await h.service.tick(h.signal)) === 0);
    }
  }

  describe("capturing a slot", () => {
    it("stores the frame and an immutable metadata record, then frees the work area", async () => {
      const h = await harness();
      await runAt(h, [0]);

      const slot = h.state.getSlot(SLOT_0800);
      assert.equal(slot?.state, "captured");
      const capture = h.state.allCaptures()[0];
      assert.equal(capture?.slot_id, SLOT_0800);
      assert.equal(capture?.width, 1280);
      assert.match(capture?.relative_dir ?? "", /^spool\/construction\/site-overview\/2026\/07\/01\//);

      const frame = await readFile(join(h.dataDir, capture?.relative_dir ?? "", "frame.jpg"));
      assert.equal(capture?.sha256, createHash("sha256").update(frame).digest("hex"));

      const text = await readFile(join(h.dataDir, capture?.relative_dir ?? "", "metadata.json"), "utf8");
      const metadata = JSON.parse(text) as CaptureMetadata;
      assert.equal(metadata.source, "live_p2p");
      assert.equal(metadata.retained, false);
      assert.equal(metadata.camera_captured_at, null, "reception time is never passed off as exposure time");
      assert.ok(metadata.camera_captured_at_note.length > 0);
      assert.equal(metadata.slot_id, SLOT_0800);
      assert.equal(metadata.quality_status, "ok");
      assert.equal(metadata.connection_type, "cellular");
      assert.equal(metadata.cleanup_status, "ok");
      assert.equal(metadata.schedule_revision, scheduleRevision(serviceConfig()));
      assert.equal(text.includes(CAMERA.key), false, "the full serial stays out of the record");

      assert.deepEqual(await readdir(join(h.dataDir, "work")), [], "a successful capture leaves no work files");
      h.state.close();
    });

    it("does nothing before a slot is due, and never contacts the camera", async () => {
      const h = await harness({ startMs: AT_0800 - 30 * MINUTE });
      const wait = await h.service.tick(h.signal);
      assert.ok(wait > 0 && wait <= MINUTE);
      assert.equal(h.adapter.opens, 0);
      assert.equal(h.created.count, 0);
      h.state.close();
    });

    it("accepts at most one frame per slot", async () => {
      const h = await harness();
      await runAt(h, [0, 1, 2]);
      assert.equal(h.adapter.opens, 1);
      assert.equal(h.state.allCaptures().length, 1);
      h.state.close();
    });

    it("captures on the 5-minute grid when the battery is healthy", async () => {
      const h = await harness();
      await runAt(h, [0, 5, 10, 15]);
      assert.equal(h.adapter.opens, 4);
      h.state.close();
    });

    it("keeps an undersized frame, marked degraded, after trying up to its limit for a better one", async () => {
      const small = await rawVideo(root.path, "h264", 640, 360);
      const h = await harness({ open: async () => liveSession(small, { codec: "h264" }) });
      await runAt(h, [0]);
      assert.equal(h.state.getSlot(SLOT_0800)?.state, "captured_degraded");
      assert.equal(h.adapter.opens, DEFAULT_SERVICE_CONFIG.capture.max_attempts);
      assert.equal(h.state.allCaptures()[0]?.quality_status, "degraded");
      h.state.close();
    });
  });

  describe("when the camera misbehaves", () => {
    it("survives a hang-up with a retry, and accounts for both tries", async () => {
      const script = [hangUp, fresh];
      const h = await harness({ open: async () => (script.shift() as () => Promise<LiveSession>)() });
      await runAt(h, [0]);
      assert.equal(h.state.getSlot(SLOT_0800)?.state, "captured");
      const attempts = h.state.attemptsSince("2000-01-01");
      assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), ["captured", "failed"]);
      h.state.close();
    });

    it("leaves no raw video behind when a retry's frame is the one kept", async () => {
      const script = [hangUp, fresh];
      const h = await harness({ open: async () => (script.shift() as () => Promise<LiveSession>)() });
      await runAt(h, [0]);
      assert.equal(h.state.getSlot(SLOT_0800)?.state, "captured");
      assert.deepEqual(await readdir(join(h.dataDir, "work")), []);
      h.state.close();
    });

    it("records a miss with its reason, keeps the evidence, and carries on with the next slot", async () => {
      const script = [hangUp, hangUp, hangUp, fresh];
      const h = await harness({ open: async () => (script.shift() as () => Promise<LiveSession>)() });
      await runAt(h, [0]);
      const slot = h.state.getSlot(SLOT_0800);
      assert.equal(slot?.state, "missed");
      assert.equal(slot?.reason, "capture_timeout");
      assert.ok((await readdir(join(h.dataDir, "work"))).length > 0, "failed tries stay for diagnosis");
      await runAt(h, [5]);
      assert.equal(h.state.allCaptures().length, 1);
      h.state.close();
    });

    it("alerts once after three straight misses, then once on recovery", async () => {
      let healthy = false;
      const h = await harness({ open: async () => (healthy ? await fresh() : await hangUp()) });
      await runAt(h, [0, 5]);
      assert.equal(h.notices.length, 0);
      await runAt(h, [10, 15]);
      assert.equal(h.notices.filter((notice) => notice.includes("in a row")).length, 1);
      healthy = true;
      await runAt(h, [20]);
      assert.equal(h.notices.filter((notice) => notice.includes("recovered")).length, 1);
      h.state.close();
    });

    it("skips rather than fights when another process holds the camera", async () => {
      const h = await harness();
      await withCameraLock(join(h.dataDir, "camera-lock.sqlite"), async () => runAt(h, [0]), { now: () => h.clock.ms });
      assert.equal(h.adapter.opens, 0);
      assert.deepEqual([h.state.getSlot(SLOT_0800)?.state, h.state.getSlot(SLOT_0800)?.reason], ["skipped_policy", "camera_busy"]);
      assert.equal(h.state.sessionUsedMs("2026-07-01"), 0, "a capture that never ran costs nothing");
      h.state.close();
    });
  });

  describe("after an outage or a crash", () => {
    it("marks past slots missed and never takes a burst of frames to make up for them", async () => {
      const h = await harness();
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 1);
      await runAt(h, [60]);
      assert.equal(h.adapter.opens, 2, "only the slot that's due now runs");
      const missed = h.state.slotCountsSince("2026-07-01T00:00:00Z", "2026-07-01T23:59:59Z").find((row) => row.state === "missed");
      assert.equal(missed?.reason, "deadline_passed");
      assert.equal(missed?.count, 11);
      h.state.close();
    });

    it("doesn't count slots from before the service first started as missed", async () => {
      const h = await harness({ startMs: AT_0800 + 120 * MINUTE });
      await h.service.tick(h.signal);
      const counts = h.state.slotCountsSince("2026-07-01T00:00:00Z", "2026-07-01T23:59:59Z");
      assert.equal(counts.find((row) => row.state === "missed"), undefined);
      assert.equal(h.state.getSlot(SLOT_0800), undefined);
      h.state.close();
    });

    it("does count downtime after that as missed, across a restart", async () => {
      const h = await harness();
      await runAt(h, [0]);
      h.state.close();
      h.clock.ms = AT_0800 + 60 * MINUTE;
      const { service, state } = h.restart();
      while ((await service.tick(h.signal)) === 0);
      assert.equal(state.slotCountsSince("2026-07-01T00:00:00Z", "2026-07-01T23:59:59Z").find((row) => row.state === "missed")?.count, 11);
      state.close();
    });

    it("marks a slot interrupted mid-capture as unknown, and doesn't retake it", async () => {
      const h = await harness();
      await h.service.tick(h.signal);
      h.state.setSlot(SLOT_0800, "running");
      h.state.close();

      const { service, state } = h.restart();
      await service.reconcile();
      assert.deepEqual([state.getSlot(SLOT_0800)?.state, state.getSlot(SLOT_0800)?.reason], ["missed", "unknown_after_crash"]);
      state.close();
    });

    it("adopts a frame published just before a crash, rather than recapturing the slot", async () => {
      const h = await harness();
      await runAt(h, [0]);
      const capture = h.state.allCaptures()[0];
      assert.ok(capture !== undefined);
      h.state.close();

      // The crash: the frame reached the spool, but the database never heard about it.
      const dbPath = join(h.dataDir, "state.sqlite");
      const rewound = new State(dbPath, () => new Date(h.clock.ms));
      rewound.setSlot(SLOT_0800, "running");
      rewound.close();
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(dbPath);
      raw.exec("DELETE FROM captures");
      raw.close();

      const { service, state } = h.restart();
      await service.reconcile();
      assert.equal(state.allCaptures()[0]?.capture_id, capture.capture_id);
      assert.equal(state.getSlot(SLOT_0800)?.state, "captured");
      const opensBefore = h.adapter.opens;
      while ((await service.tick(h.signal)) === 0);
      assert.equal(h.adapter.opens, opensBefore, "the saved slot isn't captured again");
      state.close();
    });

    it("charges an interrupted capture its full reservation, so a restart can't reset the budget", async () => {
      const h = await harness();
      await h.service.reconcile();
      h.state.insertAttempt({ attempt_id: "reservation-x", slot_id: SLOT_0800, started_at: new Date(AT_0800).toISOString(), status: "running", reason: null, phase: null, connection_path: null, connect_ms: null, session_ms: null, reserved_ms: 140_000, video_bytes: 0, audio_bytes: 0, cleanup_status: null, stream_stop: null, width: null, height: null, budget_day: "2026-07-01", budget_month: "2026-07" });
      h.state.close();
      const { state } = h.restart();
      assert.equal(state.sessionUsedMs("2026-07-01"), 140_000);
      state.close();
    });

    it("removes a half-written spool directory left by a crash", async () => {
      const h = await harness();
      const leftover = join(h.dataDir, "spool-tmp", "half-done");
      await mkdir(leftover, { recursive: true });
      await h.service.reconcile();
      assert.equal(await exists(leftover), false);
      h.state.close();
    });
  });

  describe("battery policy", () => {
    it("drops to 15-minute frames in the middle tier, and records the skipped slots", async () => {
      const h = await harness({ camera: reading(50) });
      await runAt(h, [0, 5, 10, 15]);
      assert.equal(h.adapter.opens, 2);
      const skipped = h.state.slotCountsSince("2026-07-01T00:00:00Z", "2026-07-01T23:59:59Z").find((row) => row.reason === "battery_tier");
      assert.equal(skipped?.count, 2);
      h.state.close();
    });

    it("falls back to the conservative interval when the battery is unknown", async () => {
      const h = await harness({ camera: reading(null) });
      await runAt(h, [0, 5, 60]);
      assert.equal(h.adapter.opens, 2);
      h.state.close();
    });

    it("doesn't call a low battery recovered just because the next reading is unknown", async () => {
      let camera = reading(30);
      const h = await harness({ camera });
      await runAt(h, [0]);
      assert.ok(h.notices.some((notice) => notice.includes("battery is at 30%")));
      camera = reading(30, null);
      h.adapter.setCamera(camera);
      await runAt(h, [60]);
      assert.equal(h.notices.some((notice) => notice.includes("recovered") && notice.includes("battery")), false, h.notices.join("; "));
      assert.notEqual(h.state.getAlert("battery_warning"), undefined);
      h.state.close();
    });

    it("treats a reading of unknown age as unknown, however good it looks", async () => {
      const h = await harness({ camera: reading(100, null) });
      await runAt(h, [5]);
      assert.equal(h.adapter.opens, 0, "the fastest tier would have run this slot");
      assert.equal(h.state.getSlot("construction/site-overview/2026-07-01T13:05:00.000Z")?.reason, "battery_tier");
      h.state.close();
    });

    it("doesn't let a reading of unknown age clear a low-battery pause", async () => {
      const h = await harness({ camera: reading(90, null) });
      h.state.setFlag("battery_paused", "20");
      await runAt(h, [0]);
      assert.equal(h.state.getSlot(SLOT_0800)?.reason, "battery_low");
      assert.equal(h.state.getFlag("battery_paused"), "20");
      h.state.close();
    });

    it("treats a reading older than the limit as unknown", async () => {
      const h = await harness({ camera: reading(90, new Date(AT_0800 - 7 * 60 * MINUTE).toISOString()) });
      await runAt(h, [5]);
      assert.equal(h.adapter.opens, 0, "at 08:05, a stale reading means the hourly tier");
      await runAt(h, [60]);
      assert.equal(h.adapter.opens, 1);
      h.state.close();
    });

    it("pauses at the threshold, alerts, and stays paused until the resume level", async () => {
      const camera = reading(25);
      const h = await harness({ camera });
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 0);
      assert.equal(h.state.getSlot(SLOT_0800)?.reason, "battery_low");
      assert.equal(h.notices.filter((notice) => notice.includes("low battery")).length, 1);

      camera.battery.percent = 39;
      await runAt(h, [60]);
      assert.equal(h.adapter.opens, 0, "39% isn't enough to resume");

      camera.battery.percent = 40;
      await runAt(h, [120]);
      assert.equal(h.adapter.opens, 1);
      assert.equal(h.state.getFlag("battery_paused"), undefined);
      assert.ok(h.notices.some((notice) => notice.includes("recovered")));
      h.state.close();
    });

    it("warns before it pauses", async () => {
      const h = await harness({ camera: reading(30) });
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 1);
      assert.ok(h.notices.some((notice) => notice.includes("battery is at 30%")));
      h.state.close();
    });

    it("honors an operator's battery override, and logs each reading for calibration", async () => {
      const h = await harness({ camera: reading(20) });
      h.state.setFlag("battery_paused", "20");
      h.state.setFlag("battery_override", "2026-07-01T12:00:00Z");
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 1);
      assert.equal(h.state.latestBattery()?.percent, 20);
      h.state.close();
    });
  });

  describe("what a long run leaves behind", () => {
    async function aged(path: string, days: number, now: number): Promise<void> {
      await writeFile(path, "old");
      const when = new Date(now - days * 86_400_000);
      await utimes(path, when, when);
    }

    it("expires old logs and failed work, keeps recent ones, and leaves frames alone", async () => {
      const h = await harness();
      await runAt(h, [0]);
      const logs = join(h.dataDir, "logs");
      await mkdir(logs, { recursive: true });
      await aged(join(logs, "service-old.log"), 31, AT_0800);
      await aged(join(logs, "service-recent.log"), 29, AT_0800);
      const work = join(h.dataDir, "work");
      await mkdir(work, { recursive: true });
      await aged(join(work, "old-try"), 4, AT_0800);
      await aged(join(work, "recent-try"), 2, AT_0800);
      const frames = h.state.allCaptures().length;
      const { service, state } = h.restart();
      await service.reconcile();
      assert.deepEqual((await readdir(logs)).sort(), ["service-recent.log"]);
      const left = await readdir(work);
      assert.ok(left.includes("recent-try"));
      assert.equal(left.includes("old-try"), false);
      assert.equal(state.allCaptures().length, frames);
      state.close();
    });
  });

  describe("alerts that overlap", () => {
    function firstAndLastNotices(notices: string[], about: string): string[] {
      return notices.filter((notice) => notice.includes(about));
    }

    it("doesn't call a spent budget recovered on a slot the battery tier skipped, and raises it once", async () => {
      // The 15-minute tier: 08:00 and 08:15 are active, the slots between are skipped.
      const config = serviceConfig({ capture: { ...DEFAULT_SERVICE_CONFIG.capture, max_session_seconds_per_day: 1 } });
      const h = await harness({ config, camera: reading(50, new Date(AT_0800).toISOString()) });
      await runAt(h, [0, 5, 10, 15, 20, 25, 30]);
      assert.equal(h.adapter.opens, 0);
      assert.equal(h.state.getSlot("construction/site-overview/2026-07-01T13:05:00.000Z")?.reason, "battery_tier");
      assert.equal(h.state.getSlot("construction/site-overview/2026-07-01T13:15:00.000Z")?.reason, "session_budget");
      const notices = firstAndLastNotices(h.notices, "camera-contact budget");
      assert.deepEqual(notices.length, 1, notices.join("; "));
      assert.equal(notices.some((notice) => notice.includes("recovered")), false);
      h.state.close();
    });

    it("doesn't call a low-battery pause over while a login outranks it", async () => {
      const h = await harness({ camera: reading(20, new Date(AT_0800).toISOString()) });
      await runAt(h, [0]);
      assert.equal(firstAndLastNotices(h.notices, "low battery").length, 1);
      h.state.setFlag("auth_required", "a code is needed");
      await runAt(h, [5]);
      assert.equal(h.notices.some((notice) => notice.includes("recovered") && notice.includes("low battery")), false, h.notices.join("; "));
      h.state.close();
    });
  });

  describe("a battery override", () => {
    const fresh20 = (): CameraInfo => reading(20, new Date(AT_0800).toISOString());

    it("doesn't survive to cancel a later pause", async () => {
      const h = await harness({ camera: fresh20() });
      h.state.setFlag("battery_override", "2026-06-01T00:00:00Z");
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 0, "the pause is enforced");
      assert.equal(h.state.getSlot(SLOT_0800)?.reason, "battery_low");
      assert.equal(h.state.getFlag("battery_override"), undefined);
      assert.ok(h.notices.some((notice) => notice.includes("low battery")));
      h.state.close();
    });

    it("still covers the pause it was given for", async () => {
      const h = await harness({ camera: fresh20() });
      await runAt(h, [0]);
      h.state.setFlag("battery_override", "2026-07-01T13:01:00Z");
      // At this charge, the tier runs one slot an hour.
      await runAt(h, [60]);
      assert.equal(h.adapter.opens, 1);
      assert.equal(h.state.getFlag("battery_override"), "2026-07-01T13:01:00Z");
      h.state.close();
    });
  });

  describe("a slot's deadline", () => {
    it("counts from the scheduled time, so a late slot that can't finish doesn't touch the camera", async () => {
      const h = await harness();
      h.state.setFlag("first_started_at", new Date(AT_0800 - MINUTE).toISOString());
      h.clock.ms = AT_0800 + 150_000;
      await h.service.tick(h.signal);
      assert.equal(h.adapter.opens, 0);
      assert.deepEqual([h.state.getSlot(SLOT_0800)?.state, h.state.getSlot(SLOT_0800)?.reason], ["missed", "deadline_passed"]);
      assert.deepEqual(h.state.attemptsSince("2000-01-01"), [], "and charges nothing");
      h.state.close();
    });

    it("gives a late slot only the retries that fit", async () => {
      let h: Awaited<ReturnType<typeof harness>> | undefined;
      const slow = async (): Promise<LiveSession> => {
        if (h !== undefined) h.clock.ms += 40_000;
        return await hangUp();
      };
      h = await harness({ open: slow });
      h.state.setFlag("first_started_at", new Date(AT_0800 - MINUTE).toISOString());
      h.clock.ms = AT_0800 + 100_000;
      await h.service.tick(h.signal);
      assert.equal(h.adapter.opens, 1, "another try needs 45 s, and 40 s are left");
      h.state.close();
    });
  });

  describe("camera-contact accounting", () => {
    it("keeps the reservation charged when a capture dies unexpectedly", async () => {
      const h = await harness({
        open: async () => {
          throw new TypeError("a bug, not a camera problem");
        },
      });
      await assert.rejects(h.service.tick(h.signal), TypeError);
      assert.equal(h.state.sessionUsedMs("2026-07-01"), 120_000);
      h.state.close();
    });

    it("gives the reservation back when the lock proves no try began", async () => {
      const h = await harness();
      await withCameraLock(join(h.dataDir, "camera-lock.sqlite"), async () => h.service.tick(h.signal), { now: () => h.clock.ms });
      assert.equal(h.adapter.opens, 0);
      assert.equal(h.state.getSlot(SLOT_0800)?.reason, "camera_busy");
      assert.equal(h.state.sessionUsedMs("2026-07-01"), 0);
      h.state.close();
    });

    it("swaps a reservation for its tries in one step", () => {
      const state = new State(join(root.path, "settle.sqlite"));
      const row = (attempt_id: string, session_ms: number | null): AttemptRow => ({ attempt_id, slot_id: "slot", started_at: "2026-07-01T13:00:00.000Z", status: session_ms === null ? "running" : "captured", reason: null, phase: null, connection_path: null, connect_ms: null, session_ms, reserved_ms: 120_000, video_bytes: 0, audio_bytes: 0, cleanup_status: null, stream_stop: null, width: null, height: null, budget_day: "2026-07-01", budget_month: "2026-07" });
      state.insertAttempt(row("reservation", null));
      assert.equal(state.sessionUsedMs("2026-07-01"), 120_000);
      state.settleReservation("reservation", [row("first", 9_000), row("first-retry-1", 10_000)]);
      assert.equal(state.sessionUsedMs("2026-07-01"), 19_000);
      // A failure inside the swap leaves the reservation standing.
      state.insertAttempt(row("reservation-2", null));
      assert.throws(() => state.settleReservation("reservation-2", [row("next", 1), { ...row("bad", 1), status: null as unknown as string }]));
      assert.equal(state.sessionUsedMs("2026-07-01"), 139_000);
      state.close();
    });

    it("stops the capture and keeps the charge when the camera lock is lost", async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      let dataDir = "";
      const h = await harness({
        open: async (signal) => {
          await rm(join(dataDir, "camera-lock.sqlite"));
          t.mock.timers.tick(5_000);
          while (!signal.aborted) await new Promise((resolve) => setImmediate(resolve));
          throw new CaptureFailure("aborted", "connect", "stopped");
        },
      });
      dataDir = h.dataDir;
      await h.service.tick(h.signal);
      assert.deepEqual([h.state.getSlot(SLOT_0800)?.state, h.state.getSlot(SLOT_0800)?.reason], ["missed", "lock_lost"]);
      assert.equal(h.state.sessionUsedMs("2026-07-01"), 120_000);
      h.state.close();
    });
  });

  describe("the camera client's lifetime", () => {
    it("shuts down every client that failed to start, so a long outage doesn't leak one per slot", async () => {
      const h = await harness({ authFailure: () => new CaptureFailure("camera_unreachable", "auth", "Eufy's cloud can't be reached") });
      await runAt(h, [0, 5, 10]);
      assert.equal(h.created.count, 3);
      assert.equal(h.adapter.shutdowns, 3);
      assert.equal(h.state.getSlot(SLOT_0800)?.reason, "camera_unreachable");
      h.state.close();
    });

    it("shuts down a client that wants a login, and stops making new ones", async () => {
      const h = await harness({ auth: [{ status: "tfa_required" }] });
      await runAt(h, [0, 5]);
      assert.equal(h.created.count, 1);
      assert.equal(h.adapter.shutdowns, 1);
      h.state.close();
    });

    it("records the client that took a frame in its metadata, even when that client is retired right after", async () => {
      const h = await harness({ teardown: async () => ({ status: "timeout", detail: "still running" }) });
      await runAt(h, [0]);
      const [capture] = h.state.allCaptures();
      const metadata = JSON.parse(await readFile(join(h.dataDir, capture?.relative_dir ?? "", "metadata.json"), "utf8")) as { adapter: string; adapter_version: string };
      assert.deepEqual([metadata.adapter, metadata.adapter_version], ["mock", "0.0.0"]);
      assert.equal(h.adapter.shutdowns, 1, "and it was retired");
      h.state.close();
    });

    it("retires a client whose teardown timed out, stops retrying on it, and starts fresh for the next slot", async () => {
      let hung = true;
      const h = await harness({ teardown: async () => (hung ? { status: "timeout", detail: "still running" } : { status: "ok", detail: null }), open: async () => await hangUp() });
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 1, "no second try on a connection that may be cut off");
      assert.equal(h.created.count, 1);
      assert.equal(h.adapter.shutdowns, 1);
      hung = false;
      await runAt(h, [5]);
      assert.equal(h.created.count, 2, "the next slot gets a new client");
      h.state.close();
    });
  });

  describe("a manual capture", () => {
    it("spends the same budget, and is charged like any capture", async () => {
      const h = await harness();
      const result = await h.service.captureManual(h.signal);
      assert.equal(result instanceof CaptureFailure, false);
      assert.deepEqual(h.state.attemptsSince("2000-01-01").map((attempt) => [attempt.status, attempt.slot_id]), [["captured", null]]);
      h.state.close();
    });

    it("fails the command when the camera connection didn't close, though the frame is kept and says where", async () => {
      const h = await harness({ teardown: async () => ({ status: "timeout", detail: "still running" }) });
      const result = await h.service.captureManual(h.signal);
      assert.ok(result instanceof CaptureFailure && result.reason === "cleanup_timeout", String(result));
      assert.equal(h.state.allCaptures().length, 1);
      assert.ok(result.message.includes(h.state.allCaptures()[0]?.capture_id ?? "?"));
      h.state.close();
    });

    it("refuses when the budget is spent, without touching the camera", async () => {
      const config = serviceConfig({ capture: { ...DEFAULT_SERVICE_CONFIG.capture, max_session_seconds_per_day: 1 } });
      const h = await harness({ config });
      const result = await h.service.captureManual(h.signal);
      assert.ok(result instanceof CaptureFailure && result.reason === "budget_spent");
      assert.equal(h.adapter.opens, 0);
      h.state.close();
    });

    it("keeps its reservation charged when it dies unexpectedly", async () => {
      const h = await harness({
        open: async () => {
          throw new TypeError("a bug");
        },
      });
      await assert.rejects(h.service.captureManual(h.signal), TypeError);
      assert.equal(h.state.sessionUsedMs("2026-07-01"), 40_000);
      h.state.close();
    });

    it("gives its reservation back when the lock proves no try began", async () => {
      const h = await harness();
      await withCameraLock(join(h.dataDir, "camera-lock.sqlite"), async () => assert.rejects(h.service.captureManual(h.signal), CameraLockHeldError), { now: () => h.clock.ms });
      assert.equal(h.state.sessionUsedMs("2026-07-01"), 0);
      h.state.close();
    });
  });

  describe("a schedule change", () => {
    it("retires what the old plan left pending, and keeps what already happened", () => {
      const state = new State(join(root.path, "plan.sqlite"));
      const planned = (minute: number) => ({ scheduledAt: new Date(AT_0800 + minute * MINUTE), localDate: "2026-07-01", localTime: `08:${String(minute).padStart(2, "0")}`, localMinutes: 480 + minute, nonexistent: false });
      state.materialize([planned(0), planned(1), planned(2)], "p/c", "old");
      const [done] = [`p/c/${planned(0).scheduledAt.toISOString()}`];
      state.setSlot(done, "captured");
      state.materialize([planned(0), planned(5)], "p/c", "new");
      assert.equal(state.getSlot(`p/c/${planned(1).scheduledAt.toISOString()}`), undefined, "not in the new plan");
      assert.equal(state.getSlot(done)?.state, "captured");
      assert.equal(state.getSlot(`p/c/${planned(5).scheduledAt.toISOString()}`)?.state, "pending");
      state.close();
    });
  });

  describe("crash recovery over the whole spool", () => {
    const FRAME = Buffer.from("not really a jpeg, but it has bytes");
    const HASH = createHash("sha256").update(FRAME).digest("hex");
    const SCHEDULED_AT = "2026-05-01T13:00:00.000Z";
    const STORED_SLOT = `construction/site-overview/${SCHEDULED_AT}`;
    const STORED_REVISION = "revision-one";
    const metadataFor = (captureId: string, overrides: Record<string, unknown> = {}) => ({ schema_version: 1, capture_id: captureId, project_id: "construction", camera_id: "site-overview", slot_id: null, schedule_revision: null, scheduled_at_utc: null, kind: "manual", local_date: "2026-05-01", frame_received_at: "2026-05-01T13:00:00.000Z", width: 3840, height: 2160, jpeg_bytes: FRAME.length, sha256: HASH, quality_status: "ok", ...overrides });

    const scheduledFor = (captureId: string, overrides: Record<string, unknown> = {}) => metadataFor(captureId, { kind: "scheduled", slot_id: STORED_SLOT, schedule_revision: STORED_REVISION, scheduled_at_utc: SCHEDULED_AT, frame_received_at: "2026-05-01T13:00:12.000Z", ...overrides });

    async function spooled(h: { dataDir: string }, captureId: string, metadata: string, frame: Buffer | null = FRAME): Promise<void> {
      const directory = join(h.dataDir, "spool", "construction", "site-overview", "2026", "05", "01", captureId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "metadata.json"), metadata);
      if (frame !== null) await writeFile(join(directory, "frame.jpg"), frame);
    }

    it("adopts a frame published two months before the restart", async () => {
      const h = await harness();
      await spooled(h, "from-may", JSON.stringify(metadataFor("from-may")));
      await h.service.reconcile();
      assert.equal(h.state.hasCapture("from-may"), true);
      h.state.close();
    });

    const refused: Array<[string, (h: { dataDir: string }) => Promise<void>]> = [
      ["a newer schema", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad", { schema_version: 2 })))],
      ["metadata that isn't JSON", async (h) => spooled(h, "bad", "{ nope")],
      ["a capture id that isn't its directory's", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("elsewhere")))],
      ["a date that isn't its directory's", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad", { local_date: "2026-05-02" })))],
      ["metadata copied from another project", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad", { project_id: "other-site" })))],
      ["metadata copied from another camera", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad", { camera_id: "other-camera" })))],
      ["a manual frame claiming a slot", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad", { slot_id: STORED_SLOT })))],
      ["a manual frame with a scheduled time", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad", { scheduled_at_utc: SCHEDULED_AT })))],
      ["a manual frame with a schedule revision", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad", { schedule_revision: STORED_REVISION })))],
      ["a scheduled frame with no schedule revision", async (h) => spooled(h, "bad", JSON.stringify(scheduledFor("bad", { schedule_revision: null })))],
      ["a scheduled frame with no slot", async (h) => spooled(h, "bad", JSON.stringify(scheduledFor("bad", { slot_id: null })))],
      ["a scheduled frame with no time", async (h) => spooled(h, "bad", JSON.stringify(scheduledFor("bad", { scheduled_at_utc: null })))],
      ["a slot for a different time", async (h) => spooled(h, "bad", JSON.stringify(scheduledFor("bad", { slot_id: "construction/site-overview/2026-05-01T14:00:00.000Z" })))],
      ["a slot belonging to another camera", async (h) => spooled(h, "bad", JSON.stringify(scheduledFor("bad", { slot_id: `construction/other-camera/${SCHEDULED_AT}` })))],
      ["a frame received before its slot's time", async (h) => spooled(h, "bad", JSON.stringify(scheduledFor("bad", { frame_received_at: "2026-05-01T12:59:00.000Z" })))],
      ["a frame received after the present", async (h) => spooled(h, "bad", JSON.stringify(scheduledFor("bad", { frame_received_at: "2026-08-01T00:00:00.000Z" })))],
      ["no frame", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad")), null)],
      ["a frame linked in from elsewhere", async (h) => {
        await spooled(h, "bad", JSON.stringify(metadataFor("bad")), null);
        const away = join(h.dataDir, "..", `away-${run}.jpg`);
        await writeFile(away, FRAME);
        await symlink(away, join(h.dataDir, "spool", "construction", "site-overview", "2026", "05", "01", "bad", "frame.jpg"));
      }],
      ["a directory in place of its metadata", async (h) => { await mkdir(join(h.dataDir, "spool", "construction", "site-overview", "2026", "05", "01", "bad", "metadata.json"), { recursive: true }); }],
      ["a frame of the wrong size", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad")), Buffer.from("short"))],
      ["a frame with the wrong hash", async (h) => spooled(h, "bad", JSON.stringify(metadataFor("bad")), Buffer.alloc(FRAME.length, 1))],
    ];
    for (const [name, arrange] of refused) {
      it(`leaves a capture with ${name} alone, alerts about it, and carries on`, async () => {
        const h = await harness();
        await arrange(h);
        await spooled(h, "good", JSON.stringify(metadataFor("good")));
        await h.service.reconcile();
        assert.equal(h.state.hasCapture("bad"), false);
        assert.equal(h.state.hasCapture("good"), true);
        assert.ok(h.notices.some((notice) => notice.includes("1 frame(s) in the spool have unreadable metadata")), h.notices.join("; "));
        h.state.close();
      });
    }

    it("adopts a scheduled frame when the database lost its slot, and keeps the claim", async () => {
      const h = await harness();
      await spooled(h, "from-lost-db", JSON.stringify(scheduledFor("from-lost-db")));
      await h.service.reconcile();
      assert.equal(h.state.allCaptures()[0]?.slot_id, STORED_SLOT);
      assert.equal(h.notices.some((notice) => notice.includes("unreadable metadata")), false, h.notices.join("; "));
      h.state.close();
    });

    /** The slot a stored frame claims, as a row in the given state. */
    function storedSlot(h: { state: State }, state: SlotState, revision = STORED_REVISION): void {
      h.state.materialize([{ scheduledAt: new Date(SCHEDULED_AT), localDate: "2026-05-01", localTime: "08:00", localMinutes: 480, nonexistent: false }], "construction/site-overview", revision);
      h.state.setSlot(STORED_SLOT, state);
    }

    it("adopts a frame whose slot is running, as the writer leaves it when it dies, and finishes the slot", async () => {
      const h = await harness();
      storedSlot(h, "running");
      await spooled(h, "orphan", JSON.stringify(scheduledFor("orphan")));
      await h.service.reconcile();
      assert.equal(h.state.hasCapture("orphan"), true);
      assert.equal(h.state.getSlot(STORED_SLOT)?.state, "captured");
      h.state.close();
    });

    for (const slotState of ["pending", "missed", "skipped_policy", "captured", "captured_degraded"] as const) {
      it(`leaves a frame claiming a ${slotState} slot alone, alerts about it, and leaves the slot as it was`, async () => {
        const h = await harness();
        storedSlot(h, slotState);
        await spooled(h, "bad", JSON.stringify(scheduledFor("bad")));
        await h.service.reconcile();
        assert.equal(h.state.hasCapture("bad"), false);
        assert.equal(h.state.getSlot(STORED_SLOT)?.state, slotState);
        assert.ok(h.notices.some((notice) => notice.includes("1 frame(s) in the spool have unreadable metadata")), h.notices.join("; "));
        h.state.close();
      });
    }

    it("leaves a frame from another schedule revision alone, even on a running slot", async () => {
      const h = await harness();
      storedSlot(h, "running", "a-later-revision");
      await spooled(h, "bad", JSON.stringify(scheduledFor("bad")));
      await h.service.reconcile();
      assert.equal(h.state.hasCapture("bad"), false);
      h.state.close();
    });

    it("adopts one of two frames claiming a slot, alerts about the other, and starts", async () => {
      const h = await harness();
      await spooled(h, "first", JSON.stringify(scheduledFor("first")));
      await spooled(h, "second", JSON.stringify(scheduledFor("second")));
      await h.service.reconcile();
      assert.equal(h.state.allCaptures().length, 1);
      assert.ok(h.notices.some((notice) => notice.includes("1 frame(s) in the spool have unreadable metadata")), h.notices.join("; "));
      h.state.close();
    });

    it("doesn't let a frame take a slot that another frame holds", async () => {
      const h = await harness();
      await runAt(h, [0]);
      const holder = h.state.getSlot(SLOT_0800)?.capture_id;
      const scheduledAt = new Date(AT_0800).toISOString();
      await spooled(h, "intruder", JSON.stringify(scheduledFor("intruder", { slot_id: SLOT_0800, scheduled_at_utc: scheduledAt, frame_received_at: scheduledAt })));
      await h.service.reconcile();
      assert.equal(h.state.hasCapture("intruder"), false);
      assert.equal(h.state.getSlot(SLOT_0800)?.capture_id, holder);
      h.state.close();
    });

    it("doesn't let a frame take a slot linked to another capture, even with that capture's row gone", async () => {
      const h = await harness();
      await runAt(h, [0]);
      const raw = new DatabaseSync(join(h.dataDir, "state.sqlite"));
      raw.prepare("DELETE FROM captures WHERE slot_id = ?").run(SLOT_0800);
      raw.close();
      const scheduledAt = new Date(AT_0800).toISOString();
      await spooled(h, "intruder", JSON.stringify(scheduledFor("intruder", { slot_id: SLOT_0800, scheduled_at_utc: scheduledAt, frame_received_at: scheduledAt })));
      await h.service.reconcile();
      assert.equal(h.state.hasCapture("intruder"), false);
      h.state.close();
    });

    it("rebuilds a lost slot row from the frame, so the camera isn't sent after it again", async () => {
      const h = await harness();
      await runAt(h, [0]);
      const [capture] = h.state.allCaptures();
      assert.ok(capture !== undefined);
      const raw = new DatabaseSync(join(h.dataDir, "state.sqlite"));
      raw.prepare("DELETE FROM captures WHERE capture_id = ?").run(capture.capture_id);
      raw.prepare("DELETE FROM slots WHERE slot_id = ?").run(SLOT_0800);
      raw.close();
      await h.service.reconcile();
      assert.equal(h.state.hasCapture(capture.capture_id), true);
      const slot = h.state.getSlot(SLOT_0800);
      assert.deepEqual([slot?.state, slot?.capture_id, slot?.local_date, slot?.local_time, slot?.local_minutes], ["captured", capture.capture_id, "2026-07-01", "08:00", 480]);
      const opens = h.adapter.opens;
      await h.service.tick(h.signal);
      assert.equal(h.adapter.opens, opens);
      h.state.close();
    });

    it("doesn't send the camera after a slot whose row was lost while its frame's row survived", async () => {
      const h = await harness();
      await runAt(h, [0]);
      const raw = new DatabaseSync(join(h.dataDir, "state.sqlite"));
      raw.prepare("DELETE FROM slots WHERE slot_id = ?").run(SLOT_0800);
      raw.close();
      await h.service.reconcile();
      const opens = h.adapter.opens;
      await h.service.tick(h.signal);
      assert.equal(h.state.getSlot(SLOT_0800)?.state, "pending", "planned again, and not due");
      assert.equal(h.adapter.opens, opens);
      h.state.close();
    });

    it("repairs a slot when the crash came after saving its frame's row", async () => {
      const h = await harness();
      await runAt(h, [0]);
      const captureId = h.state.getSlot(SLOT_0800)?.capture_id;
      new DatabaseSync(join(h.dataDir, "state.sqlite")).prepare("UPDATE slots SET state = 'running', capture_id = NULL WHERE slot_id = ?").run(SLOT_0800);
      h.state.close();
      const { service, state } = h.restart();
      await service.reconcile();
      assert.equal(state.getSlot(SLOT_0800)?.state, "captured");
      assert.equal(state.getSlot(SLOT_0800)?.capture_id, captureId);
      state.close();
    });
  });

  describe("a frame's row whose slot doesn't name it back", () => {
    /** A saved frame, with its slot then changed behind its back. */
    async function withSlot(state: SlotState, captureId: string | null): Promise<Awaited<ReturnType<typeof harness>>> {
      const h = await harness();
      await runAt(h, [0]);
      const raw = new DatabaseSync(join(h.dataDir, "state.sqlite"));
      raw.prepare("UPDATE slots SET state = ?, capture_id = ? WHERE slot_id = ?").run(state, captureId, SLOT_0800);
      raw.close();
      return h;
    }

    for (const slotState of ["pending", "missed", "skipped_policy", "captured"] as const) {
      it(`leaves a ${slotState} slot as it is, and alerts`, async () => {
        const h = await withSlot(slotState, null);
        await h.service.reconcile();
        const slot = h.state.getSlot(SLOT_0800);
        assert.deepEqual([slot?.state, slot?.capture_id], [slotState, null]);
        assert.ok(h.notices.some((notice) => notice.includes("disagree about each other")), h.notices.join("; "));
        h.state.close();
      });
    }

    it("doesn't overwrite a link to a different capture, and alerts", async () => {
      const h = await withSlot("captured", "some-other-capture");
      await h.service.reconcile();
      assert.equal(h.state.getSlot(SLOT_0800)?.capture_id, "some-other-capture");
      assert.ok(h.notices.some((notice) => notice.includes("disagree about each other")), h.notices.join("; "));
      h.state.close();
    });

    it("doesn't finish a running slot when the stored frame no longer matches, and alerts", async () => {
      const h = await withSlot("running", null);
      const [capture] = h.state.allCaptures();
      assert.ok(capture !== undefined);
      await writeFile(join(h.dataDir, capture.relative_dir, "frame.jpg"), "damaged");
      await h.service.reconcile();
      assert.equal(h.state.getSlot(SLOT_0800)?.capture_id, null);
      assert.ok(h.notices.some((notice) => notice.includes("disagree about each other")), h.notices.join("; "));
      h.state.close();
    });

    it("clears the alert once they agree again", async () => {
      const h = await withSlot("missed", null);
      await h.service.reconcile();
      const [capture] = h.state.allCaptures();
      h.state.setSlot(SLOT_0800, "captured", { captureId: capture?.capture_id ?? null });
      await h.service.reconcile();
      assert.ok(h.notices.some((notice) => notice.includes("recovered") && notice.includes("disagree about each other")), h.notices.join("; "));
      h.state.close();
    });
  });

  describe("the audit of stored frames", () => {
    const DAMAGE = "no longer match their records";

    async function saved(): Promise<{ h: Awaited<ReturnType<typeof harness>>; directory: string }> {
      const h = await harness();
      await runAt(h, [0]);
      const [capture] = h.state.allCaptures();
      assert.ok(capture !== undefined);
      return { h, directory: join(h.dataDir, capture.relative_dir) };
    }

    async function editMetadata(directory: string, change: Record<string, unknown>): Promise<void> {
      const path = join(directory, "metadata.json");
      await writeFile(path, JSON.stringify({ ...(JSON.parse(await readFile(path, "utf8")) as object), ...change }));
    }

    it("says nothing when every frame matches", async () => {
      const { h } = await saved();
      await h.service.auditStoredFrames(h.signal);
      assert.equal(h.notices.some((notice) => notice.includes(DAMAGE)), false, h.notices.join("; "));
      h.state.close();
    });

    const damage: Array<[string, (directory: string) => Promise<void>]> = [
      ["a frame directory that's gone", async (directory) => rm(directory, { recursive: true })],
      ["a frame file that's gone", async (directory) => rm(join(directory, "frame.jpg"))],
      ["metadata that's gone", async (directory) => rm(join(directory, "metadata.json"))],
      ["a frame with different bytes", async (directory) => writeFile(join(directory, "frame.jpg"), "damaged")],
      ["metadata from another project", async (directory) => editMetadata(directory, { project_id: "other-site" })],
      ["metadata from another camera", async (directory) => editMetadata(directory, { camera_id: "other-camera" })],
      ["metadata naming another slot", async (directory) => editMetadata(directory, { slot_id: "construction/site-overview/2026-07-01T14:00:00.000Z" })],
      ["metadata with another receive time", async (directory) => editMetadata(directory, { frame_received_at: "2026-07-01T13:00:09.000Z" })],
      ["metadata that isn't JSON", async (directory) => writeFile(join(directory, "metadata.json"), "{ nope")],
      ["a frame that can't be read", async (directory) => { await rm(join(directory, "frame.jpg")); await mkdir(join(directory, "frame.jpg")); }],
      ["a frame linked in from elsewhere", async (directory) => { const away = `${directory}-away.jpg`; await rename(join(directory, "frame.jpg"), away); await symlink(away, join(directory, "frame.jpg")); }],
    ];
    for (const [name, arrange] of damage) {
      it(`alerts about ${name}, and keeps the row`, async () => {
        const { h, directory } = await saved();
        await arrange(directory);
        await h.service.auditStoredFrames(h.signal);
        assert.ok(h.notices.some((notice) => notice.includes(`1 stored frame(s) ${DAMAGE}`)), h.notices.join("; "));
        assert.equal(h.state.allCaptures().length, 1);
        h.state.close();
      });
    }

    it("alerts about a row recording a location that isn't the capture's own", async () => {
      const { h, directory } = await saved();
      const [capture] = h.state.allCaptures();
      assert.ok(capture !== undefined);
      await cp(directory, join(h.dataDir, "copies", capture.capture_id), { recursive: true });
      const raw = new DatabaseSync(join(h.dataDir, "state.sqlite"));
      raw.prepare("UPDATE captures SET relative_dir = ? WHERE capture_id = ?").run(join("copies", capture.capture_id), capture.capture_id);
      raw.close();
      await h.service.auditStoredFrames(h.signal);
      assert.ok(h.notices.some((notice) => notice.includes(`1 stored frame(s) ${DAMAGE}`)), h.notices.join("; "));
      h.state.close();
    });

    it("leaves what it found in place", async () => {
      const { h, directory } = await saved();
      await writeFile(join(directory, "frame.jpg"), "damaged");
      await h.service.auditStoredFrames(h.signal);
      assert.equal(await readFile(join(directory, "frame.jpg"), "utf8"), "damaged");
      h.state.close();
    });

    it("says when the damage is gone", async () => {
      const { h, directory } = await saved();
      const frame = await readFile(join(directory, "frame.jpg"));
      await writeFile(join(directory, "frame.jpg"), "damaged");
      await h.service.auditStoredFrames(h.signal);
      await writeFile(join(directory, "frame.jpg"), frame);
      await h.service.auditStoredFrames(h.signal);
      assert.ok(h.notices.some((notice) => notice.includes("recovered") && notice.includes(DAMAGE)), h.notices.join("; "));
      h.state.close();
    });

    it("stops when the service does, and judges nothing from half a pass", async () => {
      const { h, directory } = await saved();
      await rm(directory, { recursive: true });
      const controller = new AbortController();
      controller.abort("terminated");
      await h.service.auditStoredFrames(controller.signal);
      assert.equal(h.notices.some((notice) => notice.includes(DAMAGE)), false, h.notices.join("; "));
      h.state.close();
    });

    it("runs while the service does, without holding up its loop", async () => {
      const controller = new AbortController();
      let spins = 0;
      const h = await harness({
        sleep: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          spins += 1;
          if (spins > 10_000 || h.notices.some((notice) => notice.includes(DAMAGE))) controller.abort("terminated");
        },
      });
      await runAt(h, [0]);
      const [capture] = h.state.allCaptures();
      assert.ok(capture !== undefined);
      await rm(join(h.dataDir, capture.relative_dir), { recursive: true });
      await h.service.run(controller.signal);
      assert.ok(h.notices.some((notice) => notice.includes(DAMAGE)), h.notices.join("; "));
      h.state.close();
    });
  });

  describe("an outage longer than the plan reaches", () => {
    const AFTER_THE_OUTAGE = AT_0800 + 4 * 1440 * MINUTE;

    it("records every slot it slept through as missed", async () => {
      const h = await harness();
      await runAt(h, [0]);
      h.state.close();
      const { service, state } = h.restart();
      h.clock.ms = AFTER_THE_OUTAGE;
      await service.reconcile();
      await service.tick(h.signal);
      for (const day of ["2026-07-02", "2026-07-03"]) {
        const slot = state.getSlot(`construction/site-overview/${day}T13:00:00.000Z`);
        assert.deepEqual([slot?.state, slot?.reason], ["missed", "deadline_passed"], day);
      }
      state.close();
    });

    it("doesn't plan days before the first start", async () => {
      const h = await harness({ startMs: AFTER_THE_OUTAGE });
      await h.service.reconcile();
      await h.service.tick(h.signal);
      assert.equal(h.state.getSlot(SLOT_0800), undefined);
      h.state.close();
    });

    it("doesn't touch the camera for the days it missed", async () => {
      const h = await harness();
      await runAt(h, [0]);
      const opens = h.adapter.opens;
      h.clock.ms = AFTER_THE_OUTAGE + 720 * MINUTE;
      await h.service.tick(h.signal);
      assert.equal(h.adapter.opens, opens);
      h.state.close();
    });
  });

  describe("configuration changes across a restart", () => {
    it("clears a data warning once there's no budget to warn about", async () => {
      const budgeted = serviceConfig({ traffic: { ...DEFAULT_SERVICE_CONFIG.traffic, monthly_budget_mb: 1 } });
      const first = await harness({ config: budgeted });
      await runAt(first, [0]);
      first.state.upsertAlert("data_warning", "data use is high", new Date(AT_0800).toISOString(), new Date(AT_0800).toISOString());
      const unbudgeted = serviceConfig({ traffic: { ...DEFAULT_SERVICE_CONFIG.traffic, monthly_budget_mb: null } });
      const second = await harness({ config: unbudgeted });
      second.state.upsertAlert("data_warning", "data use is high", new Date(AT_0800).toISOString(), new Date(AT_0800).toISOString());
      await runAt(second, [0]);
      assert.equal(second.state.getAlert("data_warning"), undefined);
      assert.ok(second.notices.some((notice) => notice.includes("recovered") && notice.includes("data use")), second.notices.join("; "));
      first.state.close();
      second.state.close();
    });
  });

  describe("failures on background work", () => {
    it("reports one that arrives during shutdown, when no next tick would raise it", async () => {
      const controller = new AbortController();
      const h = await harness({ teardown: async () => ({ status: "timeout", detail: "still running" }), shutdownFailure: () => new RangeError("a bug") });
      await h.service.tick(h.signal);
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      await assert.rejects(h.service.run(controller.signal), RangeError);
      h.state.close();
    });

    it("takes an abandoned client's unexpected shutdown failure down the crash path, alert included", async () => {
      const h = await harness({ teardown: async () => ({ status: "timeout", detail: "still running" }), shutdownFailure: () => new RangeError("a bug") });
      await h.service.tick(h.signal);
      assert.equal(h.adapter.shutdowns, 1);
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(h.service.run(h.signal), RangeError);
      assert.ok(h.notices.some((notice) => notice.includes("RangeError")), h.notices.join("; "));
      h.state.close();
    });
  });

  describe("parseCaptureMetadata", () => {
    const good = { schema_version: 1, capture_id: "id", project_id: "construction", camera_id: "site-overview", slot_id: "slot", schedule_revision: "revision-one", scheduled_at_utc: "2026-05-01T13:00:00.000Z", kind: "scheduled", local_date: "2026-05-01", frame_received_at: "2026-05-01T13:00:00.000Z", width: 3840, height: 2160, jpeg_bytes: 10, sha256: "a".repeat(64), quality_status: "ok" };

    it("accepts what this build wrote", () => {
      assert.equal(parseCaptureMetadata(JSON.stringify(good))?.capture_id, "id");
    });

    const bad: Array<[string, string]> = [
      ["another schema version", JSON.stringify({ ...good, schema_version: 2 })],
      ["no schema version", JSON.stringify({ ...good, schema_version: undefined })],
      ["a width that isn't a number", JSON.stringify({ ...good, width: "3840" })],
      ["an unknown quality", JSON.stringify({ ...good, quality_status: "great" })],
      ["a slot id of the wrong type", JSON.stringify({ ...good, slot_id: 5 })],
      ["an empty capture id", JSON.stringify({ ...good, capture_id: "" })],
      ["no schedule revision", JSON.stringify({ ...good, schedule_revision: undefined })],
      ["a schedule revision of the wrong type", JSON.stringify({ ...good, schedule_revision: 5 })],
      ["no scheduled time", JSON.stringify({ ...good, scheduled_at_utc: undefined })],
      ["a scheduled time that isn't a time", JSON.stringify({ ...good, scheduled_at_utc: "soon" })],
      ["no project id", JSON.stringify({ ...good, project_id: undefined })],
      ["a camera id of the wrong type", JSON.stringify({ ...good, camera_id: 5 })],
      ["a date in another format", JSON.stringify({ ...good, local_date: "May 1" })],
      ["a receive time that isn't a time", JSON.stringify({ ...good, frame_received_at: "soon" })],
      ["a hash that isn't SHA-256", JSON.stringify({ ...good, sha256: "abc" })],
      ["a fractional width", JSON.stringify({ ...good, width: 3840.5 })],
      ["a frame of no bytes", JSON.stringify({ ...good, jpeg_bytes: 0 })],
      ["JSON that isn't an object", "[1]"],
      ["null", "null"],
      ["text that isn't JSON", "{ nope"],
    ];
    for (const [name, text] of bad) {
      it(`refuses ${name}`, () => {
        assert.equal(parseCaptureMetadata(text), null);
      });
    }
  });

  describe("an unexpected crash", () => {
    it("says so before dying, and says when it's over", async () => {
      let healthy = false;
      const h = await harness({
        open: async () => {
          if (healthy) return await fresh();
          throw new TypeError("a bug");
        },
      });
      await assert.rejects(h.service.run(h.signal), TypeError);
      assert.ok(h.notices.some((notice) => notice.includes("TypeError") && notice.includes("restarts by itself")), h.notices.join("; "));
      assert.equal(h.notices.join().includes("a bug"), false, "no error text, which could quote anything, in a notification");
      healthy = true;
      h.clock.ms = AT_0800 + 5 * MINUTE;
      await h.service.tick(h.signal);
      assert.ok(h.notices.some((notice) => notice.includes("recovered") && notice.includes("restarts by itself")), h.notices.join("; "));
      h.state.close();
    });
  });

  describe("first-try drift", () => {
    const small = { alerts: { ...DEFAULT_SERVICE_CONFIG.alerts, first_try_window: 4 } };

    it("warns when too many slots needed a retry, even though every slot got its frame, then says when it recovers", async () => {
      let healthy = false;
      let fail = true;
      const h = await harness({
        config: serviceConfig(small),
        open: async () => {
          if (healthy) return await fresh();
          fail = !fail;
          return fail ? await fresh() : await hangUp();
        },
      });
      await runAt(h, [0, 5, 10, 15]);
      assert.equal(h.state.allCaptures().length, 4, "retries got every frame");
      assert.ok(h.notices.some((notice) => notice.includes("first try")), h.notices.join("; "));
      healthy = true;
      await runAt(h, [20, 25, 30, 35]);
      assert.ok(h.notices.some((notice) => notice.includes("recovered") && notice.includes("first try")), h.notices.join("; "));
      h.state.close();
    });

    it("says nothing before it has a full window to judge", async () => {
      const script = [hangUp, fresh];
      const h = await harness({ config: serviceConfig(small), open: async () => (script.shift() as () => Promise<LiveSession>)() });
      await runAt(h, [0]);
      assert.equal(h.notices.some((notice) => notice.includes("first try")), false);
      h.state.close();
    });

    it("judges only scheduled slots, so a manual capture can't move it", () => {
      const state = new State(join(root.path, "first-tries.sqlite"));
      const row = (attempt_id: string, slot_id: string | null): AttemptRow => ({ attempt_id, slot_id, started_at: "2026-07-01T13:00:00.000Z", status: "failed", reason: null, phase: null, connection_path: null, connect_ms: null, session_ms: 1, reserved_ms: 1, video_bytes: 0, audio_bytes: 0, cleanup_status: null, stream_stop: null, width: null, height: null, budget_day: "2026-07-01", budget_month: "2026-07" });
      state.insertAttempt(row("slot-try", "slot"));
      state.insertAttempt(row("slot-try-retry-1", "slot"));
      state.insertAttempt(row("manual-try", null));
      assert.deepEqual(state.recentFirstTries(10).map((attempt) => attempt.attempt_id), ["slot-try"]);
      state.close();
    });
  });

  describe("other limits", () => {
    it("pauses for an operator without touching the camera", async () => {
      const h = await harness();
      h.state.setFlag("operator_paused", "now");
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 0);
      assert.equal(h.state.getSlot(SLOT_0800)?.reason, "operator_paused");
      h.state.close();
    });

    it("stops capturing before the disk fills, and says so", async () => {
      const h = await harness();
      h.disk.mb = 1000;
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 0);
      assert.equal(h.state.getSlot(SLOT_0800)?.reason, "storage_full");
      assert.ok(h.notices.some((notice) => notice.includes("disk")));
      h.state.close();
    });

    it("stops when the day's camera-contact budget is spent, and that survives a restart", async () => {
      const config = serviceConfig({ capture: { ...DEFAULT_SERVICE_CONFIG.capture, max_session_seconds_per_day: 120 } });
      const h = await harness({ config });
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 1);
      // The test clock is frozen during a capture, so the time it took has to be charged by hand.
      h.state.insertAttempt({ attempt_id: "earlier", slot_id: SLOT_0800, started_at: new Date(AT_0800).toISOString(), status: "captured", reason: null, phase: null, connection_path: "relay", connect_ms: 1, session_ms: 1000, reserved_ms: 1000, video_bytes: 0, audio_bytes: 0, cleanup_status: "ok", stream_stop: "target_reached", width: 1, height: 1, budget_day: "2026-07-01", budget_month: "2026-07" });
      await runAt(h, [5]);
      assert.equal(h.adapter.opens, 1, "the next slot's reservation no longer fits");
      assert.equal(h.state.getSlot("construction/site-overview/2026-07-01T13:05:00.000Z")?.reason, "session_budget");
      assert.ok(h.notices.some((notice) => notice.includes("camera-contact budget")));
      h.state.close();
      const { state } = h.restart();
      assert.equal(state.sessionUsedMs("2026-07-01"), 1000, "a restart doesn't reset it");
      state.close();
    });
  });

  describe("authentication", () => {
    it("pauses and alerts when Eufy wants a person, makes no login loop, and resumes after a login", async () => {
      const h = await harness({ auth: [{ status: "tfa_required" }] });
      await runAt(h, [0]);
      assert.equal(h.adapter.opens, 0);
      assert.equal(h.state.getSlot(SLOT_0800)?.reason, "auth_required");
      assert.ok(h.state.getFlag("auth_required")?.includes("login"));
      assert.ok(h.notices.some((notice) => notice.includes("manual login")));

      await runAt(h, [5, 10]);
      assert.equal(h.created.count, 1, "no new login attempts while waiting for the operator");

      // What the login command does.
      h.state.setFlag("auth_required", null);
      await runAt(h, [15]);
      assert.equal(h.created.count, 2);
      assert.equal(h.adapter.opens, 1);
      assert.ok(h.notices.some((notice) => notice.includes("recovered")));
      h.state.close();
    });
  });

  describe("across daylight saving", () => {
    it("captures a repeated local hour once, and records a skipped one with a reason", async () => {
      const config = serviceConfig({ schedule: { ...DEFAULT_SERVICE_CONFIG.schedule, grid_minutes: 60, window_start: "00:00", window_end_exclusive: "24:00" }, cadence: { tiers: [{ battery_at_least: 0, every_minutes: 60 }], unknown_battery_every_minutes: 60 } });

      const autumn = await harness({ config, startMs: Date.parse("2026-11-01T05:00:00Z") });
      for (const iso of ["2026-11-01T05:00:00Z", "2026-11-01T06:00:00Z", "2026-11-01T07:00:00Z", "2026-11-01T08:00:00Z"]) {
        autumn.clock.ms = Date.parse(iso);
        while ((await autumn.service.tick(autumn.signal)) === 0);
      }
      const localTimes = autumn.state.allCaptures().map((capture) => capture.frame_received_at);
      assert.equal(autumn.adapter.opens, 3, "00:00, 01:00 once, and 02:00. The repeated 01:00 doesn't run twice");
      assert.equal(localTimes.length, 3);
      autumn.state.close();

      const spring = await harness({ config, startMs: Date.parse("2026-03-08T07:00:00Z") });
      await spring.service.tick(spring.signal);
      assert.equal(spring.state.getSlot("construction/site-overview/nonexistent-2026-03-08T02:00")?.reason, "dst_nonexistent");
      assert.equal(spring.state.getSlot("construction/site-overview/2026-03-08T08:00:00.000Z")?.local_time, "03:00", "the real 03:00 keeps its own slot");
      spring.state.close();
    });
  });

  describe("manual capture", () => {
    it("stores a frame without touching the scheduled metrics", async () => {
      const h = await harness({ startMs: AT_0800 - 120 * MINUTE });
      const result = await h.service.captureManual(h.signal);
      assert.ok(!(result instanceof CaptureFailure));
      assert.equal(result.kind, "manual");
      assert.equal(result.slot_id, null);
      assert.equal(h.state.latestCapture(), undefined, "a manual frame isn't the last scheduled success");
      h.state.close();
    });

    it("reports a failure rather than inventing a frame", async () => {
      const h = await harness({ open: hangUp });
      const result = await h.service.captureManual(h.signal);
      assert.ok(result instanceof CaptureFailure);
      assert.equal(h.state.allCaptures().length, 0);
      h.state.close();
    });
  });

  describe("status and calibration", () => {
    it("reports completeness, keeping policy skips visible, and reliability by path", async () => {
      const script = [hangUp, fresh, fresh];
      const h = await harness({ open: async () => (script.shift() as () => Promise<LiveSession>)() });
      await runAt(h, [0, 5]);
      h.state.setFlag("operator_paused", "now");
      await runAt(h, [10]);

      const status = buildStatus(h.state, serviceConfig(), new Date(h.clock.ms), 12_345);
      assert.equal(status.completeness_24h.captured_at_target_quality, 2);
      assert.equal(status.completeness_24h.scheduled, 3, "a skipped slot stays in the denominator");
      assert.equal(status.completeness_24h.skipped_by_reason.operator_paused, 1);
      assert.equal(status.completeness_24h.capture_success_percent, 100);
      assert.deepEqual(status.pause_reasons, ["operator_paused"]);
      assert.equal(status.disk_free_mb, 12_345);
      assert.equal(status.last_success?.width, 1280);
      assert.equal(status.reliability_24h.tries, 3);
      assert.equal(status.reliability_24h.by_path.direct?.at_target, 2);
      assert.equal(status.reliability_24h.failures_by_reason.capture_timeout, 1);
      assert.equal(status.reliability_24h.first_try_success_percent, 50);
      assert.equal(status.next_slot?.local_time, "2026-07-01 08:15");
      h.state.close();
    });

    it("shows battery against capture load, hour by hour", async () => {
      const camera = reading(80);
      camera.telemetry = { charging: false, solarIntensity: 3 };
      const h = await harness({ camera });
      await runAt(h, [0]);
      camera.battery.percent = 78;
      await runAt(h, [5]);
      camera.battery.percent = 75;
      await runAt(h, [60]);

      const { hours } = buildCalibration(h.state, serviceConfig(), new Date(AT_0800 - MINUTE));
      assert.equal(hours.length, 2);
      assert.equal(hours[0]?.local_time, "2026-07-01 08:00");
      assert.deepEqual([hours[0]?.battery_first, hours[0]?.battery_last], [80, 78]);
      assert.equal(hours[0]?.captured, 2);
      assert.equal(hours[0]?.solar_intensity_max, 3);
      assert.equal(hours[0]?.charging_seen, false);
      assert.equal(hours[1]?.battery_last, 75);
      h.state.close();
    });
  });
});
