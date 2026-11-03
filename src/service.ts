import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CaptureFailure } from "./adapters/adapter.ts";
import type { BatteryReading, CameraAdapter, CameraInfo } from "./adapters/adapter.ts";
import { AlertTracker } from "./alerts.ts";
import type { Notify } from "./alerts.ts";
import { recoverAttempt, TRAFFIC_BASIS } from "./capture/acquire.ts";
import type { AttemptRecord, RecoveredAttempt } from "./capture/acquire.ts";
import { abortableSleep, captureSlot, chooseBest, tryDirectory } from "./capture/slot.ts";
import { dailyReport } from "./daily-report.ts";
import { chooseReference, compareFrames, judgeFraming } from "./framing.ts";
import type { FrameComparison, FramingVerdict } from "./framing.ts";
import { CameraLockHeldError, CameraLockLostError, withCameraLock } from "./lock.ts";
import type { LockOptions } from "./lock.ts";
import { readGrayFrame } from "./media/ffmpeg.ts";
import { dataBudgetSpent, decide, nextBatteryPaused, reservedSessionMs, sessionBudgetSpent } from "./policy.ts";
import type { PolicyInput } from "./policy.ts";
import type { CameraLink } from "./probe/report.ts";
import { addDays, formatClock, isActiveForInterval, lastSlotMinutes, localParts, planDay } from "./schedule.ts";
import { EXPOSURE_TIME_NOTE, readStoredCapture, spoolDirectory, storedCaptureProblem } from "./stored-capture.ts";
import type { CaptureMetadata, CaptureOwner } from "./stored-capture.ts";
import type { ScheduleConfig } from "./schedule.ts";
import { FRAME_STEP_SECONDS } from "./service-config.ts";
import type { ServiceConfig } from "./service-config.ts";
import type { AttemptRow, CaptureRow, FramingReference, SlotRow, State } from "./state.ts";

const IDLE_WAKE_MS = 60_000;
/** Nothing in a tick waits this long when it's working: the slot deadline bounds a capture, and the lock refuses rather than waits. */
const STUCK_AFTER_MS = 15 * 60_000;
const WATCHDOG_CHECK_MS = 30_000;
/** How long a stuck loop's last alert gets, in case the alert is what's stuck. Telegram's own timeouts come to less. */
const STUCK_ALERT_GRACE_MS = 40_000;
/** Eufy's tokens last 30 days. A week leaves room for a person, if Eufy asks for one. */
const RENEW_LOGIN_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
/** Each try that Eufy challenges sends the account an email. */
const RENEW_LOGIN_EVERY_MS = 24 * 60 * 60 * 1000;
const SPOOL_TMP_KEEP_DAYS = 1;
/** Everything that says what a frame is. When a row was written, and its archive state, don't. */
const CAPTURE_ROW_IDENTITY = ["slot_id", "kind", "local_date", "frame_received_at", "width", "height", "jpeg_bytes", "sha256", "quality_status", "relative_dir"] as const;
const ARCHIVE_DISABLED = "not_configured";

export interface ServiceOptions {
  config: ServiceConfig;
  state: State;
  /** `onFatal` is how an adapter reports a failure on its own timer, which would otherwise have no way into the service. */
  createAdapter: (onFatal: (error: Error) => void) => CameraAdapter;
  dataDir: string;
  cameraSerial?: string;
  minWidth: number;
  minHeight: number;
  link: CameraLink | null;
  operator: string | null;
  log: (message: string) => void;
  notify: Notify;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  diskFreeMb?: () => Promise<number>;
  /** How often to check the loop is still coming round. */
  watchdogCheckMs?: number;
  /** Gets a stuck loop's error. By default it ends the process, which the restart policy brings back. */
  onStuck?: (error: Error) => void;
  /** How two stored frames compare. By default it reads and measures them. */
  compareFrames?: (referencePath: string, framePath: string) => Promise<FrameComparison>;
}

/** How far back to look for a frame taken at this time of day. */
const FRAMING_REFERENCE_DAYS = 3;
/** How many times to try getting the camera ready for one frame. */
const FRAME_RESET_TRIES = 2;
const FRAME_STEP_MS = FRAME_STEP_SECONDS * 1000;
/** How long to wait between tries at turning tracking back on, once a slot hasn't managed it. */
const TRACKING_RETRY_MS = 5 * 60_000;
/** On the first real afternoon a failure here cleared itself in under 3 minutes, and that's not worth two messages. */
const TRACKING_ALERT_AFTER_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

interface JudgedFrame {
  reference: FramingReference | undefined;
  verdict: FramingVerdict;
}

/**
 * When the comparison can't say, a camera that just went to its saved position is the best word on where it points. Without
 * this, a site that changed overnight matches no earlier frame, so no frame is ever on target again to compare the next with.
 */
function vouchedByReset(judged: JudgedFrame): JudgedFrame {
  if (judged.verdict.status !== "unsure") return judged;
  return { reference: undefined, verdict: { status: "on_target", dx: null, dy: null, offset: { dx: 0, dy: 0 }, detail: `the camera went to its saved position just before this frame, and comparing couldn't say (${judged.verdict.detail})` } };
}

async function compareStoredFrames(referencePath: string, framePath: string): Promise<FrameComparison> {
  return compareFrames(await readGrayFrame(referencePath), await readGrayFrame(framePath));
}

function crash(error: Error): void {
  setImmediate(() => {
    throw error;
  });
}

export function scheduleConfigOf(config: ServiceConfig): ScheduleConfig {
  return {
    siteTimeZone: config.project.site_time_zone,
    gridMinutes: config.schedule.grid_minutes,
    windowStart: config.schedule.window_start,
    windowEndExclusive: config.schedule.window_end_exclusive,
    days: config.schedule.days,
  };
}

/** Where a slot's tries keep their files, worked out from the slot so that crash recovery can find them. */
function workKeyFor(slot: Pick<SlotRow, "scheduled_at_utc">): string {
  return slot.scheduled_at_utc.replace(/[^0-9A-Z]/g, "");
}

export function scheduleRevision(config: ServiceConfig): string {
  return createHash("sha256").update(JSON.stringify({ schedule: config.schedule, cadence: config.cadence, zone: config.project.site_time_zone })).digest("hex").slice(0, 12);
}

export class CaptureService {
  private readonly options: ServiceOptions;
  private readonly config: ServiceConfig;
  private readonly state: State;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly alerts: AlertTracker;
  private adapter: CameraAdapter | undefined;
  private camera: CameraInfo | undefined;
  private lastPruneDate: string | undefined;
  /** A failure from background work, which the next tick raises so it takes the same path as any other crash. */
  private backgroundFailure: Error | undefined;
  private dailyReportReadFor: string | undefined;
  private trackingRetryAtMs: number | undefined;
  /** Unset until the service runs. */
  private loopBeatAt: number | undefined;
  private loopDeclaredStuck = false;
  private readonly onBackgroundFailure = (error: Error): void => {
    this.backgroundFailure ??= error;
  };
  /** How many stray camera connections have been alerted about, so an old one doesn't keep re-raising. */
  private unexpectedSeen = 0;

  constructor(options: ServiceOptions) {
    this.options = options;
    this.config = options.config;
    this.state = options.state;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    this.alerts = new AlertTracker(options.state, options.notify, options.config.alerts.reminder_hours, this.now);
  }

  private get zone(): string {
    return this.config.project.site_time_zone;
  }

  private get owner(): CaptureOwner {
    return { projectId: this.config.project.id, cameraId: this.config.camera.id };
  }

  private get lockPath(): string {
    return join(this.options.dataDir, "camera-lock.sqlite");
  }

  private get lockOptions(): LockOptions {
    return { now: () => this.now().getTime(), warn: this.options.log };
  }

  private async freeDiskMb(): Promise<number> {
    if (this.options.diskFreeMb !== undefined) return await this.options.diskFreeMb();
    const stats = await statfs(this.options.dataDir);
    return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
  }

  /** Recovers from whatever a crash left: a slot marked running, or a published frame the database never heard about. */
  async reconcile(): Promise<void> {
    await this.adoptPublishedFrames();
    await this.repairSlotLinks();
    await this.recoverInterruptedSlots();
    for (const slot of this.state.markInterruptedSlots()) {
      this.state.addEvent("slot_interrupted", slot.slot_id);
      this.options.log(`slot ${slot.local_date} ${slot.local_time} was interrupted by a restart; marked missed`);
    }
    this.state.closeInterruptedReservations();
    await this.pruneDiagnostics();
  }

  /** The whole spool, however long the service was down. A year of frames is one directory walk at startup. */
  private async adoptPublishedFrames(): Promise<void> {
    const root = join("spool", this.config.project.id, this.config.camera.id);
    const unreadable: string[] = [];
    for (const year of await this.subdirectories(root)) {
      for (const month of await this.subdirectories(join(root, year))) {
        for (const day of await this.subdirectories(join(root, year, month))) {
          const relativeDay = join(root, year, month, day);
          for (const captureId of await this.subdirectories(relativeDay)) {
            // Rebuilding a lost database from a full spool is slow on purpose, and each frame is progress.
            this.beat();
            const relativeDir = join(relativeDay, captureId);
            const known = this.state.getCapture(captureId);
            if (known !== undefined) {
              // The row's own directory is the audit's to check. A second one under that id isn't anything's but this.
              if (known.relative_dir !== relativeDir) unreadable.push(relativeDir);
              continue;
            }
            const metadata = await readStoredCapture(this.options.dataDir, relativeDir, captureId, `${year}-${month}-${day}`, this.owner);
            if (metadata === null || !this.slotClaimHolds(metadata)) {
              unreadable.push(relativeDir);
              continue;
            }
            // All or nothing, so a crash here can't leave a frame's row with no slot to show for it.
            this.state.inTransaction(() => {
              this.insertCaptureRow(metadata, relativeDir);
              this.finishRecoveredSlot(metadata);
              this.state.addEvent("capture_adopted", captureId);
            });
          }
        }
      }
    }
    // Left in place for a person: one bad file must not stop capture, and frames are never deleted.
    for (const relativeDir of unreadable) this.state.addEvent("capture_unreadable", relativeDir);
    await this.alerts.set("spool_unreadable", unreadable.length > 0, `${unreadable.length} frame(s) in the spool have unreadable metadata and aren't in the database, starting with ${unreadable[0] ?? ""}`);
  }

  /** Rebuilds a frame's slot if its row is gone, and marks the slot as having that frame. */
  private finishRecoveredSlot(metadata: CaptureMetadata): void {
    const { slot_id: slotId, schedule_revision: revision, scheduled_at_utc: scheduled } = metadata;
    if (slotId === null || revision === null || scheduled === null) return;
    const scheduledAt = new Date(scheduled);
    const { date, minutes } = localParts(scheduledAt, this.zone);
    this.state.restoreSlot(slotId, { scheduledAt, localDate: date, localTime: formatClock(minutes), localMinutes: minutes, nonexistent: false }, revision);
    this.state.setSlot(slotId, metadata.quality_status === "ok" ? "captured" : "captured_degraded", { captureId: metadata.capture_id });
  }

  private async subdirectories(relativePath: string): Promise<string[]> {
    try {
      const entries = await readdir(join(this.options.dataDir, relativePath), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** What a frame's own record can show about its claim on a slot: a manual frame has none, and a scheduled one claims its own time's, after that time. */
  private claimIsWellFormed(metadata: CaptureMetadata): boolean {
    const { slot_id: slotId, scheduled_at_utc: scheduledAt } = metadata;
    if (slotId === null || scheduledAt === null) return true;
    if (slotId !== `${this.config.project.id}/${this.config.camera.id}/${scheduledAt}`) return false;
    const receivedAt = Date.parse(metadata.frame_received_at);
    return receivedAt >= Date.parse(scheduledAt) && receivedAt <= this.now().getTime();
  }

  /**
   * A claim counts only if the writer could have made it. Beyond being well formed, the slot has to be free, and the writer
   * only leaves a frame unrecorded by dying while that slot is running. A slot with no row at all has nothing to compare
   * with: its row is rebuilt from the frame, so a lost row can't send the camera after a slot that already has one.
   */
  private slotClaimHolds(metadata: CaptureMetadata): boolean {
    if (!this.claimIsWellFormed(metadata)) return false;
    const { slot_id: slotId, schedule_revision: revision, scheduled_at_utc: scheduledAt } = metadata;
    if (slotId === null) return true;
    if (this.state.slotHasCapture(slotId)) return false;
    const slot = this.state.getSlot(slotId);
    if (slot === undefined) return true;
    return slot.state === "running" && slot.schedule_revision === revision && slot.scheduled_at_utc === scheduledAt && (slot.capture_id === null || slot.capture_id === metadata.capture_id);
  }

  /**
   * The writer saves a frame's row, then finishes its slot, so a crash between them leaves a stored frame on a running slot
   * that names no capture. That's the only shape to finish here. Any other disagreement isn't this code's to settle.
   */
  private async repairSlotLinks(): Promise<void> {
    const disputed: string[] = [];
    for (const row of this.state.capturesMissingSlots()) {
      const stored = await readStoredCapture(this.options.dataDir, row.relative_dir, row.capture_id, row.local_date, this.owner);
      if (stored !== null && this.claimIsWellFormed(stored) && (await storedCaptureProblem(this.options.dataDir, row, this.owner)) === null) {
        this.state.inTransaction(() => {
          this.finishRecoveredSlot(stored);
          this.state.addEvent("slot_restored", row.capture_id);
        });
      } else {
        disputed.push(row.capture_id);
        this.state.addEvent("slot_link_disputed", row.capture_id);
      }
    }
    for (const row of this.state.unlinkedCaptures()) {
      if (row.slot_state === "running" && row.slot_capture_id === null && (await storedCaptureProblem(this.options.dataDir, row, this.owner)) === null) {
        this.state.setSlot(row.slot_id, row.quality_status === "ok" ? "captured" : "captured_degraded", { captureId: row.capture_id });
        this.state.addEvent("slot_link_repaired", row.capture_id);
      } else {
        disputed.push(row.capture_id);
        this.state.addEvent("slot_link_disputed", row.capture_id);
      }
    }
    await this.alerts.set("slot_links_disputed", disputed.length > 0, `${disputed.length} stored frame(s) and their slots disagree about each other, starting with capture ${disputed[0] ?? ""}. Both are left as they are for a person to look at`);
  }

  /**
   * Decoding waits until the camera is released, so a crash can land after a frame's bytes have arrived and before they're a
   * frame. Those bytes are still this slot's, so they get finished here. Anything that won't decode counts as missed.
   */
  private async recoverInterruptedSlots(): Promise<void> {
    const lost: string[] = [];
    for (const slot of this.state.runningSlots()) await this.recoverSlot(slot, lost);
    await this.syncUnrecoverableAlert(lost);
  }

  private async syncUnrecoverableAlert(lost: string[]): Promise<void> {
    await this.alerts.set("capture_unrecoverable", lost.length > 0, `${lost.length} tries that were interrupted couldn't be recovered, starting with ${lost[0] ?? ""}. They count as missed, and the log says why`);
  }

  /** Finishes one interrupted slot from what its tries left on disk, and answers whether that got it a frame. */
  private async recoverSlot(slot: SlotRow, lost: string[]): Promise<boolean> {
    // A record has to say which tier it ran at, and this slot never got as far as choosing.
    if (slot.every_minutes === null) return false;
    // What's on disk, not what the setting says now: it may have been lowered since these tries ran.
    const tries = await this.tryDirectories(workKeyFor(slot));
    const recovered: RecoveredAttempt[] = [];
    for (const attemptId of tries) {
      const outcome = await recoverAttempt({ outputDir: join(this.options.dataDir, "work", attemptId), minWidth: this.options.minWidth, minHeight: this.options.minHeight });
      if (outcome.kind === "recovered") {
        recovered.push(outcome.attempt);
      } else if (outcome.kind === "unrecoverable") {
        lost.push(`${slot.local_date} ${slot.local_time}`);
        this.state.addEvent("capture_unrecoverable", `${attemptId}: ${outcome.reason}`);
        this.options.log(`${slot.local_date} ${slot.local_time}: couldn't recover the frame that was interrupted: ${outcome.reason}. Its files stay in work/${attemptId} until they're pruned.`);
      }
    }
    // Before the frame, as any capture does. Dying after this finds the same tries again, and settling them twice changes
    // nothing. Dying after the publish leaves a frame that adoption finishes, and by then nothing is left to settle.
    if (tries.length > 0) this.settleRecoveredTries(slot, tries, recovered);
    const [first] = recovered;
    if (first === undefined) return false;
    const chosen = chooseBest(recovered.map((attempt) => attempt.record));
    const captureId = randomUUID();
    const relativeDir = await this.publish(captureId, chosen, tries.length, { adapter: first.adapter, kind: "scheduled", slot, camera: { firmware: null }, reading: null, everyMinutes: slot.every_minutes });
    this.state.inTransaction(() => {
      this.state.setSlot(slot.slot_id, chosen.status === "captured" ? "captured" : "captured_degraded", { captureId, everyMinutes: slot.every_minutes });
      this.state.addEvent("capture_recovered", captureId);
    });
    this.options.log(`${slot.local_date} ${slot.local_time}: recovered the frame that was interrupted (${relativeDir})`);
    for (const attempt of recovered) await rm(join(this.options.dataDir, "work", attempt.record.attempt_id), { recursive: true, force: true });
    return true;
  }

  /** The tries a slot started, in order. Each one makes its own directory before anything else. */
  private async tryDirectories(workKey: string): Promise<string[]> {
    const pattern = new RegExp(`^${workKey}(-retry-(\\d+))?$`);
    const retryOf = (name: string): number => Number(pattern.exec(name)?.[2] ?? 0);
    return (await this.subdirectories("work")).filter((name) => pattern.test(name)).sort((a, b) => retryOf(a) - retryOf(b));
  }

  /** The tries replace the reservation, as they do after any capture. One whose details died with the process is charged what it could have cost. */
  private settleRecoveredTries(slot: SlotRow, tries: string[], recovered: RecoveredAttempt[]): void {
    const budgetDay = slot.local_date;
    const known = new Map(recovered.map((attempt) => [attempt.record.attempt_id, attempt.record]));
    const { acquisition_timeout_seconds: acquire, cleanup_timeout_seconds: cleanup } = this.config.capture;
    const rows = tries.map((attemptId): AttemptRow => {
      const record = known.get(attemptId);
      if (record !== undefined) return this.attemptRow(record, slot.slot_id, budgetDay);
      return { attempt_id: attemptId, slot_id: slot.slot_id, started_at: slot.scheduled_at_utc, status: "failed", reason: "unknown_after_crash", phase: null, connection_path: null, connect_ms: null, session_ms: null, reserved_ms: (acquire + cleanup) * 1000, video_bytes: 0, audio_bytes: 0, cleanup_status: "unknown_after_crash", stream_stop: null, width: null, height: null, budget_day: budgetDay, budget_month: budgetDay.slice(0, 7) };
    });
    this.state.settleReservation(`reservation-${workKeyFor(slot)}`, rows);
  }

  /**
   * Frames are the whole project, and otherwise nothing notices one going missing until a render. Run once per start, in the
   * background: a year of frames takes minutes to read, and no slot should be missed waiting for that. Damage is left in place.
   */
  async auditStoredFrames(signal: AbortSignal): Promise<void> {
    const damaged: string[] = [];
    for (const row of this.state.allCaptures()) {
      if (signal.aborted) return;
      const problem = await storedCaptureProblem(this.options.dataDir, row, this.owner);
      if (problem === null) continue;
      damaged.push(row.relative_dir);
      this.state.addEvent("capture_damaged", `${row.relative_dir}: ${problem}`);
    }
    await this.alerts.set("spool_damaged", damaged.length > 0, `${damaged.length} stored frame(s) no longer match their records, starting with ${damaged[0] ?? ""}. They're left as they are for a person to look at, and renders leave them out`);
  }

  /** A service that runs for a year needs its diagnostics to expire. Frames and the database never do. */
  private async pruneDiagnostics(): Promise<void> {
    // Another process may be publishing right now: a manual capture does it after giving back the camera lock.
    // A publish takes seconds, so only something this old is proven to be what a crash left behind.
    await this.pruneOlderThan(join(this.options.dataDir, "spool-tmp"), SPOOL_TMP_KEEP_DAYS);
    await this.pruneOlderThan(join(this.options.dataDir, "work"), this.config.storage.keep_failed_work_days);
    await this.pruneOlderThan(join(this.options.dataDir, "logs"), this.config.storage.keep_logs_days);
  }

  private async pruneOlderThan(root: string, days: number): Promise<void> {
    const cutoff = this.now().getTime() - days * 86_400_000;
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(root, entry);
      let modifiedMs: number;
      try {
        modifiedMs = (await stat(path)).mtimeMs;
      } catch (error) {
        // Gone since the listing, which is what a publisher finishing looks like.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (modifiedMs < cutoff) await rm(path, { recursive: true, force: true });
    }
  }

  /** Runs what's due now, and answers how long to wait before looking again. */
  async tick(signal: AbortSignal): Promise<number> {
    if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
    const now = this.now();
    const today = localParts(now, this.zone).date;
    const revision = scheduleRevision(this.config);
    const prefix = `${this.config.project.id}/${this.config.camera.id}`;
    // Time before the first start was never the service's to capture. Downtime after it does count as missed.
    if (this.state.getFlag("first_started_at") === undefined) this.state.setFlag("first_started_at", now.toISOString());
    const firstStartedAt = Date.parse(this.state.getFlag("first_started_at") as string);
    // Downtime counts as missed, so every day since the plan last reached needs its slots, however long ago that was.
    const newest = this.state.newestSlotDate();
    const firstDate = newest !== undefined && newest < today ? newest : today;
    for (let date = firstDate; date <= addDays(today, 1); date = addDays(date, 1)) {
      const planned = planDay(date, scheduleConfigOf(this.config)).filter((slot) => slot.scheduledAt.getTime() >= firstStartedAt);
      this.state.materialize(planned, prefix, revision);
    }
    if (this.lastPruneDate !== today) {
      await this.pruneDiagnostics();
      this.lastPruneDate = today;
    }

    // Past slots stay missed. A burst of present-day frames must never stand in for them.
    const lastUsefulStart = this.config.capture.slot_deadline_seconds * 1000;
    const expired = this.state.expirePending(new Date(now.getTime() - lastUsefulStart));
    if (expired > 0) {
      this.options.log(`${expired} slot(s) passed their deadline and were marked missed`);
      await this.syncFailureAlert();
    }

    const due = this.state.duePending(now);
    if (due !== undefined) {
      await this.processSlot(due, signal);
      await this.alerts.clear("service_crashed");
      await this.alerts.retryOwed();
      return 0;
    }
    await this.renewLoginIfDue();
    await this.resumeTrackingIfOwed();
    await this.sendDailyReportIfDue();
    const next = this.state.nextPending(now);
    return next === undefined ? IDLE_WAKE_MS : Math.min(IDLE_WAKE_MS, Math.max(0, Date.parse(next.scheduled_at_utc) - now.getTime()));
  }

  private beat(): void {
    this.loopBeatAt = this.now().getTime();
  }

  /**
   * A hung await would leave the process alive and /healthz answering, with no slot and no alert ever again, since
   * alerts come from the same loop. A restart recovers, and reconcile records what was interrupted.
   */
  checkLoop(): void {
    if (this.loopBeatAt === undefined || this.loopDeclaredStuck) return;
    const silentMs = this.now().getTime() - this.loopBeatAt;
    if (silentMs < Math.max(STUCK_AFTER_MS, this.config.capture.slot_deadline_seconds * 2000)) return;
    this.loopDeclaredStuck = true;
    const minutes = Math.round(silentMs / 60_000);
    const error = new Error(`The capture loop made no progress for ${minutes} minutes, so the service is restarting itself.`);
    this.options.log(error.message);
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      clearTimeout(grace);
      (this.options.onStuck ?? crash)(error);
    };
    const grace = setTimeout(end, STUCK_ALERT_GRACE_MS);
    this.alerts.raise("service_crashed", `the capture loop made no progress for ${minutes} minutes, and the service is restarting itself`).then(end, (cause: unknown) => {
      this.options.log(`couldn't raise the alert for a stuck loop: ${String(cause)}`);
      end();
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    let audit: Promise<void> = Promise.resolve();
    const watchdog = setInterval(() => this.checkLoop(), this.options.watchdogCheckMs ?? WATCHDOG_CHECK_MS);
    watchdog.unref();
    try {
      this.beat();
      await this.reconcile();
      audit = this.auditStoredFrames(signal).catch(this.onBackgroundFailure);
      while (!signal.aborted) {
        this.beat();
        // No swallowing here: an unexpected error should crash this process. The restart policy brings it back,
        // and reconcile records the interrupted slot, which beats limping on in an unknown state.
        const waitMs = await this.tick(signal);
        if (waitMs > 0) await this.sleep(waitMs, signal);
      }
    } catch (error) {
      // A crash that keeps recurring would otherwise die before any slot's alert. The tracker dedupes across restarts.
      clearInterval(watchdog);
      await this.alerts.raise("service_crashed", `the service stopped on an unexpected ${error instanceof Error ? error.name : "error"} and restarts by itself. If this repeats, read the container log`);
      throw error;
    }
    clearInterval(watchdog);
    await audit;
    await this.adapter?.shutdown();
    // Background work's last chance to report. There's no next tick to raise it.
    if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
  }

  /**
   * Once a day, after the last slot of the window. Also the only sign of life that doesn't need something to go wrong, so
   * it goes out on a paused day or a day with no slots too. An undelivered or late one is tried at each idle wake until the
   * next day's is due, so only the newest is ever owed.
   */
  private async sendDailyReportIfDue(): Promise<void> {
    if (!this.config.alerts.daily_report) return;
    const now = this.now();
    const local = localParts(now, this.zone);
    const lastSent = this.state.getFlag("daily_report_date");
    // From the last slot's turn, not the window's end: the clock never reaches a window ending at 24:00.
    const { window_start: start, window_end_exclusive: end, grid_minutes: grid } = this.config.schedule;
    const todaysIsDue = local.minutes >= lastSlotMinutes(start, end, grid);
    // Until then it's yesterday's that may be owed, after an outage or a failed delivery that ran past midnight.
    const date = todaysIsDue ? local.date : addDays(local.date, -1);
    if ((lastSent !== undefined && lastSent >= date) || this.state.hasUnfinishedSlotsOn(date)) return;
    if (todaysIsDue && this.dailyReportReadFor !== date) {
      // Cloud only, so it doesn't wake the camera. Without it, a day with no slots would have no reading at all.
      const reading = await this.readCamera({ forSlot: false });
      // Readers take the newest row's pace as the current one, and this read doesn't change it.
      this.recordBatteryReading(now, reading, this.state.latestBattery()?.every_minutes ?? null);
      this.dailyReportReadFor = date;
    }
    const readings = this.state.batterySince(new Date(now.getTime() - 2 * DAY_MS).toISOString()).filter((row) => localParts(new Date(row.read_at), this.zone).date === date);
    const slots = this.state.slotCountsOn(date);
    // Nothing on record means a day from before this service existed, and there's nothing to say about that.
    if (readings.length === 0 && Object.keys(slots).length === 0) return;
    const paused: string[] = [];
    if (this.state.getFlag("operator_paused") !== undefined) paused.push("by you");
    if (this.state.getFlag("battery_paused") !== undefined) paused.push("low battery");
    if (this.state.getFlag("auth_required") !== undefined) paused.push("needs a login");
    const text = dailyReport({
      date,
      zone: this.zone,
      slots,
      retried: this.state.retriedSlotsOn(date),
      missedMinutes: this.state.missedMinutesOn(date),
      gridMinutes: this.config.schedule.grid_minutes,
      readings,
      // Everything before the day's first row is from an earlier day, with no need to work out when the day began.
      previous: this.state.lastKnownBatteryBefore(readings[0]?.read_at ?? now.toISOString()),
      offTarget: this.state.offTargetCountOn(date),
      paused,
    });
    if (await this.options.notify(text)) this.state.setFlag("daily_report_date", date);
  }

  /**
   * Eufy asks even a trusted device for a code once its token has expired or it hasn't logged in for 30 days, so a
   * login has to happen before then to need nobody. One that Eufy challenges early costs nothing: the held token keeps
   * working, and a person gets days of warning instead of a stopped camera.
   */
  private async renewLoginIfDue(): Promise<void> {
    if (this.adapter === undefined || this.state.getFlag("auth_required") !== undefined) return;
    const now = this.now().getTime();
    const expiresAt = this.adapter.loginExpiresAt();
    if (expiresAt === null || expiresAt.getTime() - now > RENEW_LOGIN_WITHIN_MS) {
      this.state.setFlag("login_renewal_tried_at", null);
      await this.alerts.clear("login_renewal");
      return;
    }
    const triedAt = this.state.getFlag("login_renewal_tried_at");
    if (triedAt !== undefined && now - Date.parse(triedAt) < RENEW_LOGIN_EVERY_MS) return;
    this.state.setFlag("login_renewal_tried_at", new Date(now).toISOString());
    const needsPerson = (why: string): Promise<void> =>
      this.alerts.set("login_renewal", true, `${why} The login ends ${expiresAt.toISOString()}. Run the login command before then, or captures stop.`);
    try {
      const renewal = await this.adapter.renewLogin();
      if (renewal.status === "renewed") {
        this.state.addEvent("login_renewed", `replaced a login ending ${expiresAt.toISOString()}`);
        this.options.log("renewed the Eufy login");
      } else {
        await needsPerson("Eufy wants a code to renew the login.");
      }
    } catch (error) {
      if (!(error instanceof CaptureFailure)) throw error;
      if (error.reason === "auth_required") {
        await needsPerson(`Eufy refused to renew the login: ${error.message}`);
        return;
      }
      this.options.log(`couldn't renew the Eufy login, and will try again tomorrow: ${error.message}`);
    }
  }

  /**
   * A cloud read that doesn't wake the camera. Nothing here contacts the camera, including the login restore. Only a slot's
   * read counts toward the alert about failed reads, which says how many slots in a row failed.
   */
  private async readCamera({ forSlot }: { forSlot: boolean }): Promise<BatteryReading | null> {
    if (this.state.getFlag("auth_required") !== undefined) {
      await this.retireAdapter();
      return null;
    }
    // Holds a timer and a client from the moment it exists, so a failed start must still shut it down.
    let starting: CameraAdapter | undefined;
    try {
      if (this.adapter === undefined) {
        starting = this.options.createAdapter(this.onBackgroundFailure);
        const auth = await starting.authenticate();
        if (auth.status !== "authenticated") throw new CaptureFailure("auth_required", "auth", "Eufy wants a manual login step. Run the login command in a terminal.");
        this.adapter = starting;
        starting = undefined;
      }
      this.camera = await this.adapter.discoverCamera(this.camera?.key ?? this.options.cameraSerial);
      if (forSlot) await this.noteCameraRead(true);
      return this.camera.battery;
    } catch (error) {
      // Anything but a failure the adapter recognised is a bug, and should crash rather than limp on.
      if (!(error instanceof CaptureFailure)) throw error;
      if (error.reason === "auth_required") {
        this.state.setFlag("auth_required", error.message);
        await this.retireAdapter();
        return null;
      }
      // The cloud being unreachable is a reason to skip a reading. The capture attempt reports its own failure.
      this.state.addEvent("camera_read_failed", error.message);
      this.options.log(`could not read camera state: ${error.message}`);
      if (forSlot) await this.noteCameraRead(false);
      return null;
    } finally {
      await starting?.shutdown();
    }
  }

  /** A cloud outage that outlasts a few slots is worth saying out loud, even while capture carries on without it. */
  private async noteCameraRead(succeeded: boolean): Promise<void> {
    const failures = succeeded ? 0 : Number(this.state.getFlag("camera_read_failures") ?? "0") + 1;
    this.state.setFlag("camera_read_failures", failures === 0 ? null : String(failures));
    await this.alerts.set("camera_read_failing", failures >= this.config.alerts.consecutive_failed_slots, `the camera's state couldn't be read from Eufy's cloud at ${failures} slots in a row. Capture uses the last battery reading until it's too old. The log has the reason`);
  }

  /** A failed read keeps the last camera around, and its telemetry says nothing about now. */
  private recordBatteryReading(now: Date, reading: BatteryReading | null, everyMinutes: number | null): void {
    this.state.recordBattery({
      read_at: now.toISOString(),
      percent: reading?.percent ?? null,
      observed_at: reading?.observedAt ?? null,
      every_minutes: everyMinutes,
      telemetry_json: JSON.stringify(reading === null ? {} : (this.camera?.telemetry ?? {})),
    });
  }

  /** What the last good read said, for a read that failed. A failed read says nothing about the battery either way. */
  private lastKnownReading(): BatteryReading | null {
    const row = this.state.lastKnownBattery();
    return row === undefined ? null : { percent: row.percent, observedAt: row.observed_at, note: "the last good reading" };
  }

  private async retireAdapter(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = undefined;
    await adapter?.shutdown();
  }

  private effectivePercent(reading: BatteryReading | null): number | null {
    // A reading of unknown age could be any age, so it counts as unknown. A cached full charge must not keep the fastest tier running.
    if (reading === null || reading.percent === null || reading.observedAt === null) return null;
    const ageMs = this.now().getTime() - Date.parse(reading.observedAt);
    return ageMs > this.config.battery.reading_max_age_hours * 3_600_000 ? null : reading.percent;
  }

  private async processSlot(slot: SlotRow, signal: AbortSignal): Promise<void> {
    const reading = await this.readCamera({ forSlot: true });
    // Only a real reading can clear a battery pause. For choosing a rate, the last one counts for as long as any reading does.
    const freshPercent = this.effectivePercent(reading);
    const percent = this.effectivePercent(reading ?? this.lastKnownReading());
    const now = this.now();
    const local = localParts(now, this.zone);

    const wasPaused = this.state.getFlag("battery_paused") !== undefined;
    const batteryPaused = nextBatteryPaused(wasPaused, freshPercent, this.config.battery);
    if (batteryPaused !== wasPaused) {
      this.state.setFlag("battery_paused", batteryPaused ? String(freshPercent) : null);
      // An override covers the pause it was given for. A later pause has to be enforced.
      this.state.setFlag("battery_override", null);
      this.state.addEvent(batteryPaused ? "battery_pause" : "battery_resume", String(freshPercent));
    }

    const input: PolicyInput = {
      batteryPercent: percent,
      batteryPaused,
      batteryOverride: this.state.getFlag("battery_override") !== undefined,
      operatorPaused: this.state.getFlag("operator_paused") !== undefined,
      authRequired: this.state.getFlag("auth_required") !== undefined,
      diskFreeMb: await this.freeDiskMb(),
      sessionUsedMs: this.state.sessionUsedMs(local.date),
      monthBytes: this.state.monthBytes(local.date.slice(0, 7)),
      localMinutes: slot.local_minutes,
    };
    const decision = decide(input, this.config, (every) => isActiveForInterval(slot.local_minutes, this.config.schedule.window_start, every));

    this.recordBatteryReading(now, reading, decision.everyMinutes);
    await this.syncPolicyAlerts(input, percent, local.date);

    if (decision.action === "skip") {
      this.state.setSlot(slot.slot_id, "skipped_policy", { reason: decision.reason, everyMinutes: decision.everyMinutes });
      return;
    }
    if (this.camera === undefined || this.adapter === undefined) {
      this.state.setSlot(slot.slot_id, "missed", { reason: "camera_unreachable", everyMinutes: decision.everyMinutes });
      await this.syncFailureAlert();
      return;
    }

    this.state.setSlot(slot.slot_id, "running", { everyMinutes: decision.everyMinutes });
    await this.captureForSlot(slot, this.adapter, this.camera, reading, decision.everyMinutes, signal);
  }

  private async captureForSlot(slot: SlotRow, adapter: CameraAdapter, camera: CameraInfo, reading: BatteryReading | null, everyMinutes: number, signal: AbortSignal): Promise<void> {
    const startedAt = this.now();
    const local = localParts(startedAt, this.zone);
    const { acquisition_timeout_seconds: acquire, cleanup_timeout_seconds: cleanup, slot_deadline_seconds: deadline } = this.config.capture;
    // The deadline counts from the slot's scheduled time, not from whenever the service got to it.
    const remainingMs = Date.parse(slot.scheduled_at_utc) + deadline * 1000 - startedAt.getTime();
    if (remainingMs < (acquire + cleanup) * 1000) {
      this.state.setSlot(slot.slot_id, "missed", { reason: "deadline_passed", everyMinutes });
      this.options.log(`${slot.local_date} ${slot.local_time}: missed: too late for a try to finish inside the slot's deadline`);
      await this.syncFailureAlert();
      return;
    }
    const workKey = workKeyFor(slot);
    const reservationId = `reservation-${workKey}`;
    // Charged in full if the process dies mid-capture, so a crash can't reset the day's budget.
    this.state.insertAttempt({
      attempt_id: reservationId,
      slot_id: slot.slot_id,
      started_at: startedAt.toISOString(),
      status: "running",
      reason: null,
      phase: null,
      connection_path: null,
      connect_ms: null,
      session_ms: null,
      reserved_ms: reservedSessionMs(this.config.capture),
      video_bytes: 0,
      audio_bytes: 0,
      cleanup_status: null,
      stream_stop: null,
      width: null,
      height: null,
      budget_day: local.date,
      budget_month: local.date.slice(0, 7),
    });

    const slotDir = join(this.options.dataDir, "work", workKey);
    const savedPosition = this.state.getFlag("framing_position_id");
    const positionId = this.config.framing.reset_before_frame && savedPosition !== undefined ? Number(savedPosition) : undefined;
    const deadlineAtMs = startedAt.getTime() + remainingMs;
    const judged = new Map<string, JudgedFrame>();
    let resetHeld = false;
    let result: Awaited<ReturnType<typeof captureSlot>>;
    try {
      await mkdir(join(this.options.dataDir, "work"), { recursive: true });
      result = await withCameraLock(
        this.lockPath,
        async (lockLost) => {
          const taken = await captureSlot({
            adapter,
            cameraKey: camera.key,
            slotDir,
            acquisitionTimeoutMs: acquire * 1000,
            cleanupTimeoutMs: cleanup * 1000,
            targetKeyframes: this.config.capture.target_keyframes,
            minWidth: this.options.minWidth,
            minHeight: this.options.minHeight,
            maxTries: this.config.capture.max_attempts,
            retryDelayMs: this.config.capture.retry_delay_seconds * 1000,
            // Turning tracking back on has to fit too, so a try can't start that would leave no time for it.
            slotDeadlineMs: positionId === undefined ? remainingMs : remainingMs - FRAME_STEP_MS,
            signal: AbortSignal.any([signal, lockLost]),
            log: this.options.log,
            sleep: this.sleep,
            now: this.now,
            onLateFailure: this.onBackgroundFailure,
            ...(positionId === undefined
              ? {}
              : {
                  beforeTry: async () => {
                    resetHeld = await this.resetCamera(adapter, camera, positionId, deadlineAtMs);
                  },
                  beforeTryMs: FRAME_STEP_MS,
                  isOffTarget: async (record: AttemptRecord) => {
                    const compared = await this.judgeFrame(join(this.options.dataDir, "work", record.attempt_id, "frame.jpg"), new Date(record.timing.frame_saved_at ?? this.now()));
                    const verdict = resetHeld ? vouchedByReset(compared) : compared;
                    judged.set(record.attempt_id, verdict);
                    if (verdict.verdict.status !== "off_target") return false;
                    this.options.log(`this try's frame is off target: ${verdict.verdict.detail}`);
                    return true;
                  },
                }),
          });
          // A connection that may still be closing could cut this off, and a lost lock isn't ours to act under. The next idle wake does it instead.
          const closed = [taken.chosen, ...taken.otherTries].every((record) => record.cleanup.status === "ok");
          if (positionId !== undefined && closed && !lockLost.aborted) await this.resumeTracking(adapter, camera);
          return taken;
        },
        this.lockOptions,
      );
    } catch (error) {
      if (error instanceof CameraLockHeldError) {
        // The one case that proves no try began, so the only one that gives the reservation back.
        this.state.deleteAttempt(reservationId);
        this.state.setSlot(slot.slot_id, "skipped_policy", { reason: "camera_busy" });
        this.options.log(`skipped ${slot.local_date} ${slot.local_time}: the camera lock is held`);
        return;
      }
      if (!(error instanceof CameraLockLostError)) throw error;
      this.state.addEvent("lock_lost", error.message);
      // The bytes may already be safe on disk, and finishing them doesn't touch the camera, whoever has it now.
      const lost: string[] = [];
      const running = this.state.getSlot(slot.slot_id);
      if (running !== undefined && (await this.recoverSlot(running, lost))) {
        this.options.log(`${slot.local_date} ${slot.local_time}: lost the camera lock after the frame arrived, and kept the frame: ${error.message}`);
        return;
      }
      this.state.setSlot(slot.slot_id, "missed", { reason: "lock_lost", everyMinutes });
      this.options.log(`${slot.local_date} ${slot.local_time}: missed: ${error.message}`);
      await this.syncUnrecoverableAlert(lost);
      await this.syncFailureAlert();
      return;
    }

    const { chosen, otherTries } = result;
    this.state.settleReservation(reservationId, [chosen, ...otherTries].map((record) => this.attemptRow(record, slot.slot_id, local.date)));
    if ([chosen, ...otherTries].some((record) => record.cleanup.status === "timeout")) {
      // Its teardown is still running, and could cut off a later capture on the same adapter. Not awaited: it may hang too.
      this.adapter = undefined;
      adapter.shutdown().catch(this.onBackgroundFailure);
    }

    const cleanupFault = [chosen, ...otherTries].find((record) => record.cleanup.status !== "ok");
    await this.alerts.set("cleanup_failed", cleanupFault !== undefined, `the camera connection may not have closed: ${cleanupFault?.cleanup.detail ?? ""}`);
    const unexpected = adapter.unexpectedConnectionCount();
    await this.alerts.set("unexpected_wakes", unexpected > this.unexpectedSeen, `${unexpected - this.unexpectedSeen} camera connection(s) opened outside a capture`);
    this.unexpectedSeen = unexpected;

    if (chosen.frame !== null) {
      const captureId = randomUUID();
      const relativeDir = await this.publish(captureId, chosen, otherTries.length + 1, {
        adapter,
        kind: "scheduled",
        slot,
        camera,
        reading,
        everyMinutes,
      });
      this.state.setSlot(slot.slot_id, chosen.status === "captured" ? "captured" : "captured_degraded", { captureId, everyMinutes });
      await this.checkFraming(captureId, judged.get(chosen.attempt_id));
      // Every try's directory, the kept one included. Each holds raw 4K video.
      for (const record of [chosen, ...otherTries]) await rm(join(this.options.dataDir, "work", record.attempt_id), { recursive: true, force: true });
      this.options.log(`${slot.local_date} ${slot.local_time}: ${chosen.status} ${chosen.frame.width}x${chosen.frame.height} via ${chosen.connection_path ?? "unknown"} in ${chosen.timing.session_ms} ms, ${otherTries.length + 1} tries (${relativeDir})`);
    } else {
      const reason = chosen.failure?.reason ?? "capture_timeout";
      this.state.setSlot(slot.slot_id, "missed", { reason, everyMinutes });
      this.options.log(`${slot.local_date} ${slot.local_time}: missed (${reason}): ${chosen.failure?.message ?? "no detail"}`);
    }
    await this.syncFailureAlert();
  }

  private attemptRow(record: AttemptRecord, slotId: string | null, localDate: string): AttemptRow {
    return {
      attempt_id: record.attempt_id,
      slot_id: slotId,
      started_at: record.timing.request_started_at,
      status: record.status,
      reason: record.failure?.reason ?? null,
      phase: record.failure?.phase ?? null,
      connection_path: record.connection_path,
      connect_ms: record.timing.connect_ms,
      session_ms: record.timing.session_ms,
      reserved_ms: record.timing.session_ms,
      video_bytes: record.traffic.video_bytes,
      audio_bytes: record.traffic.audio_bytes,
      cleanup_status: record.cleanup.status,
      stream_stop: record.stream_stop,
      width: record.frame?.width ?? null,
      height: record.frame?.height ?? null,
      budget_day: localDate,
      budget_month: localDate.slice(0, 7),
    };
  }

  private insertCaptureRow(metadata: CaptureMetadata, relativeDir: string): CaptureRow {
    const row: CaptureRow = {
      capture_id: metadata.capture_id,
      slot_id: metadata.slot_id,
      kind: metadata.kind,
      local_date: metadata.local_date,
      frame_received_at: metadata.frame_received_at,
      width: metadata.width,
      height: metadata.height,
      jpeg_bytes: metadata.jpeg_bytes,
      sha256: metadata.sha256,
      quality_status: metadata.quality_status,
      relative_dir: relativeDir,
      archive_status: ARCHIVE_DISABLED,
      created_at: this.now().toISOString(),
    };
    // A service starting right now can adopt a frame in the moment after another process publishes it. The same frame gets
    // the same row, and either order is fine. A different row under one id is something else entirely.
    const stored = this.state.insertCapture(row);
    if (CAPTURE_ROW_IDENTITY.some((field) => stored[field] !== row[field])) {
      throw new Error(`Capture ${row.capture_id} already has a different row in the database, so its record wasn't saved. The frame is at ${relativeDir}.`);
    }
    return row;
  }

  /** The frame and its metadata appear together or not at all: both go in a temp directory, which is then renamed. */
  private async publish(
    captureId: string,
    record: AttemptRecord,
    attemptCount: number,
    origin: { adapter: Pick<CameraAdapter, "name" | "version">; kind: "scheduled" | "manual"; slot: SlotRow | null; camera: Pick<CameraInfo, "firmware">; reading: BatteryReading | null; everyMinutes: number | null },
  ): Promise<string> {
    if (record.frame === null) throw new Error("publish needs a frame");
    const receivedAt = record.timing.frame_saved_at ?? this.now().toISOString();
    const localDate = localParts(new Date(receivedAt), this.zone).date;
    const relativeDir = spoolDirectory(this.owner, localDate, captureId);
    const tempDir = join(this.options.dataDir, "spool-tmp", captureId);
    await mkdir(tempDir, { recursive: true });
    await copyFile(join(this.options.dataDir, "work", record.attempt_id, "frame.jpg"), join(tempDir, "frame.jpg"));

    const metadata: CaptureMetadata = {
      schema_version: 1,
      capture_id: captureId,
      project_id: this.config.project.id,
      camera_id: this.config.camera.id,
      kind: origin.kind,
      slot_id: origin.slot?.slot_id ?? null,
      attempt_id: record.attempt_id,
      schedule_revision: origin.slot?.schedule_revision ?? null,
      scheduled_at_utc: origin.slot?.scheduled_at_utc ?? null,
      request_started_at: record.timing.request_started_at,
      stream_started_at: record.timing.stream_started_at,
      frame_received_at: receivedAt,
      camera_captured_at: null,
      camera_captured_at_note: EXPOSURE_TIME_NOTE,
      site_time_zone: this.zone,
      local_date: localDate,
      source: "live_p2p",
      capture_session_id: record.capture_session_id,
      freshness_basis: record.freshness.basis,
      cold_connection: record.freshness.cold_connection,
      retained: false,
      adapter: origin.adapter.name,
      adapter_version: origin.adapter.version,
      camera_firmware: origin.camera.firmware,
      connection_type: this.options.link,
      connection_path: record.connection_path,
      cellular_operator: this.options.operator,
      width: record.frame.width,
      height: record.frame.height,
      source_codec: record.video.actual_codec,
      jpeg_bytes: record.frame.bytes,
      sha256: record.frame.sha256,
      quality_status: record.status === "captured" ? "ok" : "degraded",
      attempt_count: attemptCount,
      connect_ms: record.timing.connect_ms,
      session_ms: record.timing.session_ms,
      cleanup_status: record.cleanup.status,
      cleanup_detail: record.cleanup.detail,
      battery_percent: origin.reading?.percent ?? null,
      battery_observed_at: origin.reading?.observedAt ?? null,
      battery_note: origin.reading?.note ?? "no reading was available",
      every_minutes: origin.everyMinutes,
      media_video_bytes: record.traffic.video_bytes,
      media_audio_bytes: record.traffic.audio_bytes,
      traffic_measurement_basis: TRAFFIC_BASIS,
    };
    await writeFile(join(tempDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    await mkdir(dirname(join(this.options.dataDir, relativeDir)), { recursive: true });
    await rename(tempDir, join(this.options.dataDir, relativeDir));
    this.insertCaptureRow(metadata, relativeDir);
    return relativeDir;
  }

  /** The frame is already safe, so nothing here can cost it. A verdict only says how to use it. */
  private async checkFraming(captureId: string, alreadyJudged?: JudgedFrame): Promise<void> {
    if (this.state.getFlag("framing_position_id") === undefined) return;
    const capture = this.state.getCapture(captureId);
    if (capture === undefined) throw new Error(`capture ${captureId} was published but has no row`);
    const { reference, verdict } = alreadyJudged ?? (await this.judgeFrame(join(this.options.dataDir, capture.relative_dir, "frame.jpg"), new Date(capture.frame_received_at)));
    this.state.recordFramingCheck({ capture_id: captureId, checked_at: this.now().toISOString(), status: verdict.status, reference_capture_id: reference?.capture_id ?? null, dx: verdict.dx, dy: verdict.dy, offset_dx: verdict.offset?.dx ?? null, offset_dy: verdict.offset?.dy ?? null, detail: verdict.detail });
    if (verdict.status === "unsure") return;
    if (verdict.status === "on_target") {
      await this.alerts.clear("framing_off_target");
      return;
    }
    this.options.log(`${capture.local_date}: this frame is off target: ${verdict.detail}`);
    const inARow = this.state.offTargetSlotsInARow();
    if (inARow >= this.config.framing.alert_after_off_target_slots) {
      await this.alerts.raise("framing_off_target", `the camera has been pointing away from its saved position for ${inARow} slots. Those frames are left out of renders. Look at the latest frame, and if this is the view you want, run framing set`);
    }
  }

  private async judgeFrame(framePath: string, at: Date): Promise<JudgedFrame> {
    const references = this.state.framingReferences(new Date(at.getTime() - FRAMING_REFERENCE_DAYS * DAY_MS).toISOString(), this.state.getFlag("framing_position_saved_at") ?? "");
    const reference = chooseReference(references, at);
    if (reference === undefined) return { reference, verdict: { status: "unsure", dx: null, dy: null, offset: null, detail: "there's no earlier on-target frame to compare with" } };
    try {
      const comparison = await (this.options.compareFrames ?? compareStoredFrames)(join(this.options.dataDir, reference.relative_dir, "frame.jpg"), framePath);
      return { reference, verdict: judgeFraming(comparison, { referenceAgeMs: at.getTime() - Date.parse(reference.frame_received_at), referenceOffset: { dx: reference.offset_dx ?? 0, dy: reference.offset_dy ?? 0 }, tolerancePixels: this.config.framing.tolerance_pixels }) };
    } catch (error) {
      if (!(error instanceof CaptureFailure)) throw error;
      return { reference, verdict: { status: "unsure", dx: null, dy: null, offset: null, detail: `couldn't compare the frames: ${error.message}` } };
    }
  }

  /**
   * Stops the camera chasing what it detects, and sends it back to its position. This can't cost a frame: a failed reset
   * usually leaves the camera where it belongs, and the check on the frame catches it when it doesn't. Says whether the
   * camera went to its saved position.
   */
  private async resetCamera(adapter: CameraAdapter, camera: CameraInfo, positionId: number, deadlineAtMs: number): Promise<boolean> {
    const { acquisition_timeout_seconds: acquire, cleanup_timeout_seconds: cleanup } = this.config.capture;
    for (let attempt = 1; attempt <= FRAME_RESET_TRIES; attempt += 1) {
      // This step, a capture, and turning tracking back on. Without room for all three, the frame is what matters.
      if (this.now().getTime() + 2 * FRAME_STEP_MS + (acquire + cleanup) * 1000 > deadlineAtMs) {
        this.options.log("not resetting the camera: there's only time left for the frame");
        return false;
      }
      // Written before tracking goes off, so a process that dies from here on still owes turning it back on. An earlier
      // time is kept: tracking has been off since then, and the alert counts from it.
      if (this.state.getFlag("tracking_paused_at") === undefined) this.state.setFlag("tracking_paused_at", this.now().toISOString());
      try {
        const outcome = await adapter.prepareFrame(camera.key, positionId);
        if (outcome === "gone") await this.alerts.raise("framing_position_gone", "the camera's saved position no longer exists, so it can't go back to it. Aim it where it should be, then run framing set");
        return outcome === "ready";
      } catch (error) {
        if (!(error instanceof CaptureFailure)) throw error;
        this.state.addEvent("framing_reset_failed", error.message);
        this.options.log(`couldn't reset the camera before a frame, on try ${attempt} of ${FRAME_RESET_TRIES}: ${error.message}`);
      }
    }
    return false;
  }

  private async resumeTracking(adapter: CameraAdapter, camera: CameraInfo): Promise<void> {
    try {
      await adapter.resumeTracking(camera.key);
    } catch (error) {
      if (!(error instanceof CaptureFailure)) throw error;
      this.state.addEvent("tracking_resume_failed", error.message);
      this.options.log(`couldn't turn the camera's tracking back on, and will try again: ${error.message}`);
      return;
    }
    this.state.setFlag("tracking_paused_at", null);
    await this.alerts.clear("tracking_left_off");
  }

  /** For a slot that couldn't turn tracking back on, or a process that died before it could. */
  private async resumeTrackingIfOwed(): Promise<void> {
    const pausedAt = this.state.getFlag("tracking_paused_at");
    if (pausedAt === undefined) return;
    const now = this.now();
    if (this.trackingRetryAtMs !== undefined && now.getTime() < this.trackingRetryAtMs) return;
    // A slot about to start does this itself when it's done, and holding the camera now could cost it its frame.
    const next = this.state.nextPending(now);
    if (next !== undefined && Date.parse(next.scheduled_at_utc) - now.getTime() < FRAME_STEP_MS) return;
    this.trackingRetryAtMs = now.getTime() + TRACKING_RETRY_MS;
    let outcome: void | CaptureFailure;
    try {
      outcome = await this.onCamera((adapter, camera) => adapter.resumeTracking(camera.key));
    } catch (error) {
      if (!(error instanceof CameraLockHeldError) && !(error instanceof CameraLockLostError)) throw error;
      outcome = new CaptureFailure("camera_unreachable", "position", error.message, { cause: error });
    }
    if (outcome instanceof CaptureFailure) {
      this.state.addEvent("tracking_resume_failed", outcome.message);
      if (now.getTime() - Date.parse(pausedAt) >= TRACKING_ALERT_AFTER_MS) {
        await this.alerts.raise("tracking_left_off", `the camera's AI tracking is still off after a frame, so events won't follow what they detect. It keeps trying: ${outcome.message}`);
      }
      return;
    }
    this.state.setFlag("tracking_paused_at", null);
    this.trackingRetryAtMs = undefined;
    await this.alerts.clear("tracking_left_off");
  }

  /** One piece of camera work outside a slot, for a command that ends straight after. */
  private async onCamera<T>(work: (adapter: CameraAdapter, camera: CameraInfo) => Promise<T>): Promise<T | CaptureFailure> {
    await this.readCamera({ forSlot: false });
    const { adapter, camera } = this;
    if (adapter === undefined || camera === undefined) return new CaptureFailure("camera_unreachable", "discovery", "The camera can't be reached right now. The log line above says why.");
    try {
      return await withCameraLock(this.lockPath, () => work(adapter, camera), this.lockOptions);
    } catch (error) {
      if (error instanceof CaptureFailure) return error;
      throw error;
    } finally {
      await adapter.shutdown();
      this.adapter = undefined;
    }
  }

  /** Makes where the camera points now the position it comes back to. The frame comes first: it proves the camera answers, and nothing has changed yet if it doesn't. */
  async setFramingPosition(signal: AbortSignal): Promise<number | CaptureFailure> {
    const frame = await this.captureManual(signal);
    if (frame instanceof CaptureFailure) return frame;
    const earlier = this.state.getFlag("framing_position_id");
    const saved = await this.onCamera(async (adapter, camera) => {
      const positionId = await adapter.savePosition(camera.key);
      if (earlier !== undefined) {
        try {
          await adapter.forgetPosition(camera.key, Number(earlier));
        } catch (error) {
          if (!(error instanceof CaptureFailure)) throw error;
          this.options.log(`saved the new position, but couldn't delete the old one in slot ${earlier}. Delete it in the Eufy app if you don't want it: ${error.message}`);
        }
      }
      return positionId;
    });
    if (saved instanceof CaptureFailure) return saved;
    this.state.recordFramingCheck({ capture_id: frame.capture_id, checked_at: this.now().toISOString(), status: "on_target", reference_capture_id: null, dx: 0, dy: 0, offset_dx: 0, offset_dy: 0, detail: "this frame was taken when the position was saved" });
    this.state.setFlag("framing_position_id", String(saved));
    this.state.setFlag("framing_position_saved_at", frame.frame_received_at);
    this.state.addEvent("framing_position_saved", `saved position ${saved}`);
    await this.alerts.clear("framing_off_target");
    await this.alerts.clear("framing_position_gone");
    return saved;
  }

  /** Stops watching the framing, and removes the saved position from the camera. */
  async forgetFramingPosition(): Promise<CaptureFailure | undefined> {
    const flagged = this.state.getFlag("framing_position_id");
    if (flagged === undefined) return undefined;
    const forgotten = await this.onCamera((adapter, camera) => adapter.forgetPosition(camera.key, Number(flagged)));
    if (forgotten instanceof CaptureFailure) return forgotten;
    this.state.setFlag("framing_position_id", null);
    this.state.setFlag("framing_position_saved_at", null);
    this.state.addEvent("framing_position_forgotten", `forgot position ${flagged}`);
    await this.alerts.clear("framing_off_target");
    await this.alerts.clear("framing_position_gone");
    return undefined;
  }

  /** Each condition stands on its own. Reading them from the one skip reason that won would call one condition's end whenever another outranked it. */
  private async syncPolicyAlerts(input: PolicyInput, percent: number | null, localDate: string): Promise<void> {
    const { battery, cadence, traffic, storage } = this.config;
    await this.alerts.set("battery_unknown", percent === null, `there's no battery reading from the last ${battery.reading_max_age_hours} hours, so capture is running at its unknown-battery rate of every ${cadence.unknown_battery_every_minutes} minutes. The time budgets still apply`);
    await this.alerts.set("auth_required", input.authRequired, `Eufy needs a manual login: ${this.state.getFlag("auth_required") ?? ""}`);
    await this.alerts.set("operator_paused", input.operatorPaused, "capture is paused by the operator");
    await this.alerts.set("battery_paused", input.batteryPaused && !input.batteryOverride, `capture paused on low battery (${percent ?? "unknown"}%). If the reading is old, check the app and run resume --battery-checked`);
    await this.alerts.set("storage_full", input.diskFreeMb <= storage.min_free_disk_mb, "capture paused: the disk is nearly full");
    await this.alerts.set("session_budget", sessionBudgetSpent(input, this.config), "capture paused: today's camera-contact budget is spent");
    await this.alerts.set("data_budget", dataBudgetSpent(input, this.config), "capture paused: this month's data budget is spent");
    // An unknown reading says nothing either way, so it can't call a low battery recovered.
    if (percent !== null) await this.alerts.set("battery_warning", percent < battery.warn_below_percent, `battery is at ${percent}%`);
    // With no budget there's nothing to warn about, including a warning left from when there was one.
    const used = this.state.monthBytes(localDate.slice(0, 7));
    const budget = traffic.monthly_budget_mb;
    await this.alerts.set("data_warning", budget !== null && used >= budget * 1024 * 1024 * traffic.warn_fraction, `data use is at ${Math.round(used / (1024 * 1024))} MB of ${budget ?? 0} MB this month`);
  }

  private async syncFailureAlert(): Promise<void> {
    const limit = this.config.alerts.consecutive_failed_slots;
    const recent = this.state.recentOutcomes(limit);
    const failing = recent.length >= limit && recent.every((slot) => slot.state === "missed");
    await this.syncFirstTryAlert();
    await this.alerts.set("consecutive_failures", failing, `${limit} scheduled slots in a row got no frame (latest: ${recent[0]?.reason ?? "unknown"})`);
  }

  /** Retries hide a failing connect from slot counts while spending battery. A change on Eufy's side would look like this first. */
  private async syncFirstTryAlert(): Promise<void> {
    const { first_try_window: window, first_try_warn_percent: warnPercent } = this.config.alerts;
    const tries = this.state.recentFirstTries(window);
    const percent = tries.length > 0 ? Math.round((tries.filter((attempt) => attempt.status === "captured").length / tries.length) * 100) : 100;
    await this.alerts.set("first_try_drift", tries.length >= window && percent < warnPercent, `only ${percent}% of the last ${window} slots got their frame on the first try, under the ${warnPercent}% this warns at. Retries are spending battery, so check the service log and the attempts in status`);
  }

  /** A one-off frame. It holds the same lock, spends the same budgets, and never affects completeness. */
  async captureManual(signal: AbortSignal): Promise<CaptureRow | CaptureFailure> {
    const reading = await this.readCamera({ forSlot: false });
    if (this.adapter === undefined || this.camera === undefined) {
      const needsLogin = this.state.getFlag("auth_required");
      if (needsLogin !== undefined) return new CaptureFailure("auth_required", "auth", needsLogin);
      return new CaptureFailure("camera_unreachable", "discovery", "The camera can't be reached right now. The log line above says why.");
    }
    const adapter = this.adapter;
    const camera = this.camera;
    const startedAt = this.now();
    const local = localParts(startedAt, this.zone);
    const budgets = { sessionUsedMs: this.state.sessionUsedMs(local.date), monthBytes: this.state.monthBytes(local.date.slice(0, 7)) };
    if (sessionBudgetSpent(budgets, this.config) || dataBudgetSpent(budgets, this.config)) {
      return new CaptureFailure("budget_spent", "discovery", "The camera-contact or data budget is spent, and manual captures share them. Raise it in the config, or wait for it to reset.");
    }
    if ((await this.freeDiskMb()) <= this.config.storage.min_free_disk_mb) {
      return new CaptureFailure("storage_full", "discovery", `The disk is at or below its ${this.config.storage.min_free_disk_mb} MB floor, so the camera wasn't woken. Free some space, or lower storage.min_free_disk_mb.`);
    }
    const key = `manual-${randomUUID()}`;
    const reservationId = `reservation-${key}`;
    // Charged in full if the process dies mid-capture, the same as a scheduled one.
    this.state.insertAttempt({
      attempt_id: reservationId,
      slot_id: null,
      started_at: startedAt.toISOString(),
      status: "running",
      reason: null,
      phase: null,
      connection_path: null,
      connect_ms: null,
      session_ms: null,
      reserved_ms: (this.config.capture.acquisition_timeout_seconds + this.config.capture.cleanup_timeout_seconds) * 1000,
      video_bytes: 0,
      audio_bytes: 0,
      cleanup_status: null,
      stream_stop: null,
      width: null,
      height: null,
      budget_day: local.date,
      budget_month: local.date.slice(0, 7),
    });
    const giveBackIfNoTryBegan = (error: unknown): never => {
      if (error instanceof CameraLockHeldError) this.state.deleteAttempt(reservationId);
      throw error;
    };
    const result = await withCameraLock(this.lockPath, (lockLost) =>
      captureSlot({
        adapter,
        cameraKey: camera.key,
        slotDir: join(this.options.dataDir, "work", key),
        acquisitionTimeoutMs: this.config.capture.acquisition_timeout_seconds * 1000,
        cleanupTimeoutMs: this.config.capture.cleanup_timeout_seconds * 1000,
        targetKeyframes: this.config.capture.target_keyframes,
        minWidth: this.options.minWidth,
        minHeight: this.options.minHeight,
        maxTries: 1,
        retryDelayMs: 0,
        slotDeadlineMs: this.config.capture.slot_deadline_seconds * 1000,
        signal: AbortSignal.any([signal, lockLost]),
        log: this.options.log,
        sleep: this.sleep,
        now: this.now,
      }),
      this.lockOptions,
    ).catch(giveBackIfNoTryBegan);
    this.state.settleReservation(reservationId, [this.attemptRow(result.chosen, null, local.date)]);
    if (result.chosen.frame === null) {
      return new CaptureFailure(result.chosen.failure?.reason ?? "capture_timeout", result.chosen.failure?.phase ?? "first_media", result.chosen.failure?.message ?? "No frame arrived.");
    }
    const captureId = randomUUID();
    await this.publish(captureId, result.chosen, 1, { adapter, kind: "manual", slot: null, camera, reading, everyMinutes: null });
    await rm(join(this.options.dataDir, "work", key), { recursive: true, force: true });
    if (result.chosen.cleanup.status === "timeout") {
      // This process is about to end, so anything that teardown does later has nobody to tell. Say so now, and fail the command.
      return new CaptureFailure("cleanup_timeout", "cleanup", `The frame was saved as capture ${captureId}, but the camera connection didn't close in time. It may stay open for a while, which spends battery. Don't run another capture yet.`);
    }
    if (result.chosen.cleanup.status !== "ok") {
      // The frame is safe, so the command still succeeded. The camera connection is what needs looking at.
      this.options.log(`The frame was saved as capture ${captureId}, but closing the camera connection reported a problem: ${result.chosen.cleanup.detail ?? "no detail"}`);
      await this.alerts.raise("cleanup_failed", `the camera connection may not have closed after a manual capture: ${result.chosen.cleanup.detail ?? "no detail"}`);
    }
    await this.adapter.shutdown();
    this.adapter = undefined;
    const row = this.state.getCapture(captureId);
    if (row === undefined) throw new Error(`capture ${captureId} was published but has no row`);
    return row;
  }
}
