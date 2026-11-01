import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CaptureFailure } from "./adapters/adapter.ts";
import type { BatteryReading, CameraAdapter, CameraInfo } from "./adapters/adapter.ts";
import { AlertTracker } from "./alerts.ts";
import type { Notify } from "./alerts.ts";
import { TRAFFIC_BASIS } from "./capture/acquire.ts";
import type { AttemptRecord } from "./capture/acquire.ts";
import { abortableSleep, captureSlot } from "./capture/slot.ts";
import { CameraLockHeldError, CameraLockLostError, withCameraLock } from "./lock.ts";
import type { LockOptions } from "./lock.ts";
import { dataBudgetSpent, decide, nextBatteryPaused, reservedSessionMs, sessionBudgetSpent } from "./policy.ts";
import type { PolicyInput } from "./policy.ts";
import type { CameraLink } from "./probe/report.ts";
import { addDays, isActiveForInterval, localParts, planDay } from "./schedule.ts";
import type { ScheduleConfig } from "./schedule.ts";
import type { ServiceConfig } from "./service-config.ts";
import type { AttemptRow, CaptureRow, SlotRow, State } from "./state.ts";

const IDLE_WAKE_MS = 60_000;
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
}

/** The immutable record stored beside each frame. Archive state is mutable, so it lives in SQLite instead. */
export interface CaptureMetadata {
  schema_version: 1;
  capture_id: string;
  project_id: string;
  camera_id: string;
  kind: "scheduled" | "manual";
  slot_id: string | null;
  attempt_id: string;
  schedule_revision: string | null;
  scheduled_at_utc: string | null;
  request_started_at: string;
  stream_started_at: string | null;
  frame_received_at: string;
  camera_captured_at: null;
  camera_captured_at_note: string;
  site_time_zone: string;
  local_date: string;
  source: "live_p2p";
  capture_session_id: string;
  freshness_basis: string;
  cold_connection: boolean | null;
  retained: false;
  adapter: string;
  adapter_version: string;
  camera_firmware: string | null;
  connection_type: CameraLink | null;
  connection_path: string | null;
  cellular_operator: string | null;
  width: number;
  height: number;
  source_codec: string | null;
  jpeg_bytes: number;
  sha256: string;
  quality_status: "ok" | "degraded";
  attempt_count: number;
  connect_ms: number | null;
  session_ms: number;
  cleanup_status: string;
  cleanup_detail: string | null;
  battery_percent: number | null;
  battery_observed_at: string | null;
  battery_note: string | null;
  every_minutes: number | null;
  media_video_bytes: number;
  media_audio_bytes: number;
  traffic_measurement_basis: string;
}

/** The part of a capture's stored metadata that recovery reads, which is all this code vouches for. */
export type AdoptableCapture = Pick<CaptureMetadata, "capture_id" | "slot_id" | "kind" | "local_date" | "frame_received_at" | "width" | "height" | "jpeg_bytes" | "sha256" | "quality_status">;

/** Reads what recovery needs from stored metadata, or null if it isn't a version and shape this build understands. */
export function parseCaptureMetadata(text: string): AdoptableCapture | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const field = (key: string): string => (typeof record[key] === "string" ? record[key] : "");
  const counts = ["width", "height", "jpeg_bytes"].every((key) => Number.isInteger(record[key]) && (record[key] as number) > 0);
  const valid =
    record.schema_version === 1 &&
    field("capture_id").length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(field("local_date")) &&
    !Number.isNaN(Date.parse(field("frame_received_at"))) &&
    /^[0-9a-f]{64}$/.test(field("sha256")) &&
    counts &&
    (record.slot_id === null || typeof record.slot_id === "string") &&
    (record.kind === "scheduled" || record.kind === "manual") &&
    (record.quality_status === "ok" || record.quality_status === "degraded");
  return valid ? (record as unknown as AdoptableCapture) : null;
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

  private get lockPath(): string {
    return join(this.options.dataDir, "camera-lock.sqlite");
  }

  private get lockOptions(): LockOptions {
    return { now: () => this.now().getTime() };
  }

  private async freeDiskMb(): Promise<number> {
    if (this.options.diskFreeMb !== undefined) return await this.options.diskFreeMb();
    const stats = await statfs(this.options.dataDir);
    return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
  }

  /** Recovers from whatever a crash left: a slot marked running, or a published frame the database never heard about. */
  async reconcile(): Promise<void> {
    await rm(join(this.options.dataDir, "spool-tmp"), { recursive: true, force: true });
    await this.adoptPublishedFrames();
    for (const captureId of this.state.repairSlotLinks()) this.state.addEvent("slot_link_repaired", captureId);
    for (const slot of this.state.markInterruptedSlots()) {
      this.state.addEvent("slot_interrupted", slot.slot_id);
      this.options.log(`slot ${slot.local_date} ${slot.local_time} was interrupted by a restart; marked missed`);
    }
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
            if (this.state.hasCapture(captureId)) continue;
            const relativeDir = join(relativeDay, captureId);
            const metadata = await this.verifiedCapture(relativeDir, captureId, `${year}-${month}-${day}`);
            if (metadata === null) {
              unreadable.push(relativeDir);
              continue;
            }
            this.insertCaptureRow(metadata, relativeDir);
            if (metadata.slot_id !== null) {
              this.state.setSlot(metadata.slot_id, metadata.quality_status === "ok" ? "captured" : "captured_degraded", { captureId });
            }
            this.state.addEvent("capture_adopted", captureId);
          }
        }
      }
    }
    // Left in place for a person: one bad file must not stop capture, and frames are never deleted.
    for (const relativeDir of unreadable) this.state.addEvent("capture_unreadable", relativeDir);
    await this.alerts.set("spool_unreadable", unreadable.length > 0, `${unreadable.length} frame(s) in the spool have unreadable metadata and aren't in the database, starting with ${unreadable[0] ?? ""}`);
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

  /** A capture the database has never heard of counts only if its record, its place in the spool and its frame all agree. */
  private async verifiedCapture(relativeDir: string, captureId: string, localDate: string): Promise<AdoptableCapture | null> {
    const directory = join(this.options.dataDir, relativeDir);
    try {
      const metadata = parseCaptureMetadata(await readFile(join(directory, "metadata.json"), "utf8"));
      if (metadata === null || metadata.capture_id !== captureId || metadata.local_date !== localDate) return null;
      const frame = await readFile(join(directory, "frame.jpg"));
      const matches = frame.length === metadata.jpeg_bytes && createHash("sha256").update(frame).digest("hex") === metadata.sha256;
      return matches ? metadata : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private spoolDay(localDate: string): string {
    const [year, month, day] = localDate.split("-") as [string, string, string];
    return join("spool", this.config.project.id, this.config.camera.id, year, month, day);
  }

  /** A service that runs for a year needs its diagnostics to expire. Frames and the database never do. */
  private async pruneDiagnostics(): Promise<void> {
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
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
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
    for (const date of [today, addDays(today, 1)]) {
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
      return 0;
    }
    const next = this.state.nextPending(now);
    return next === undefined ? IDLE_WAKE_MS : Math.min(IDLE_WAKE_MS, Math.max(0, Date.parse(next.scheduled_at_utc) - now.getTime()));
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      await this.reconcile();
      while (!signal.aborted) {
        // No swallowing here: an unexpected error should crash this process. The restart policy brings it back,
        // and reconcile records the interrupted slot, which beats limping on in an unknown state.
        const waitMs = await this.tick(signal);
        if (waitMs > 0) await this.sleep(waitMs, signal);
      }
    } catch (error) {
      // A crash that keeps recurring would otherwise die before any slot's alert. The tracker dedupes across restarts.
      await this.alerts.raise("service_crashed", `the service stopped on an unexpected ${error instanceof Error ? error.name : "error"} and restarts by itself. If this repeats, read the container log`);
      throw error;
    }
    await this.adapter?.shutdown();
    // Background work's last chance to report. There's no next tick to raise it.
    if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
  }

  /** A cloud read that doesn't wake the camera. Nothing here contacts the camera, including the login restore. */
  private async readCamera(): Promise<BatteryReading | null> {
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
      return null;
    } finally {
      await starting?.shutdown();
    }
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
    const reading = await this.readCamera();
    const percent = this.effectivePercent(reading);
    const now = this.now();
    const local = localParts(now, this.zone);

    const wasPaused = this.state.getFlag("battery_paused") !== undefined;
    const batteryPaused = nextBatteryPaused(wasPaused, percent, this.config.battery);
    if (batteryPaused !== wasPaused) {
      this.state.setFlag("battery_paused", batteryPaused ? String(percent) : null);
      // An override covers the pause it was given for. A later pause has to be enforced.
      this.state.setFlag("battery_override", null);
      this.state.addEvent(batteryPaused ? "battery_pause" : "battery_resume", String(percent));
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

    this.state.recordBattery({
      read_at: now.toISOString(),
      percent: reading?.percent ?? null,
      observed_at: reading?.observedAt ?? null,
      every_minutes: decision.everyMinutes,
      telemetry_json: JSON.stringify(this.camera?.telemetry ?? {}),
    });
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
    const workKey = slot.scheduled_at_utc.replace(/[^0-9A-Z]/g, "");
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
    let result: Awaited<ReturnType<typeof captureSlot>>;
    try {
      await mkdir(join(this.options.dataDir, "work"), { recursive: true });
      result = await withCameraLock(this.lockPath, (lockLost) =>
        captureSlot({
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
          slotDeadlineMs: remainingMs,
          signal: AbortSignal.any([signal, lockLost]),
          log: this.options.log,
          sleep: this.sleep,
          now: this.now,
          onLateFailure: this.onBackgroundFailure,
        }),
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
      this.state.setSlot(slot.slot_id, "missed", { reason: "lock_lost", everyMinutes });
      this.state.addEvent("lock_lost", error.message);
      this.options.log(`${slot.local_date} ${slot.local_time}: missed: ${error.message}`);
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

  private insertCaptureRow(metadata: AdoptableCapture, relativeDir: string): CaptureRow {
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
    this.state.insertCapture(row);
    return row;
  }

  /** The frame and its metadata appear together or not at all: both go in a temp directory, which is then renamed. */
  private async publish(
    captureId: string,
    record: AttemptRecord,
    attemptCount: number,
    origin: { adapter: CameraAdapter; kind: "scheduled" | "manual"; slot: SlotRow | null; camera: CameraInfo; reading: BatteryReading | null; everyMinutes: number | null },
  ): Promise<string> {
    if (record.frame === null) throw new Error("publish needs a frame");
    const receivedAt = record.timing.frame_saved_at ?? this.now().toISOString();
    const localDate = localParts(new Date(receivedAt), this.zone).date;
    const relativeDay = this.spoolDay(localDate);
    const relativeDir = join(relativeDay, captureId);
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
      camera_captured_at_note: "the stream carries no trustworthy exposure time; the camera's burned-in clock, if enabled, is in the image",
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
    await mkdir(join(this.options.dataDir, relativeDay), { recursive: true });
    await rename(tempDir, join(this.options.dataDir, relativeDir));
    this.insertCaptureRow(metadata, relativeDir);
    return relativeDir;
  }

  /** Each condition stands on its own. Reading them from the one skip reason that won would call one condition's end whenever another outranked it. */
  private async syncPolicyAlerts(input: PolicyInput, percent: number | null, localDate: string): Promise<void> {
    const { battery, traffic, storage } = this.config;
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
    await this.alerts.set("first_try_drift", tries.length >= window && percent < warnPercent, `only ${percent}% of the last ${window} slots got their frame on the first try, where about 98% is normal. Retries are spending battery, so check the service log and the attempts in status`);
  }

  /** A one-off frame. It holds the same lock, spends the same budgets, and never affects completeness. */
  async captureManual(signal: AbortSignal): Promise<CaptureRow | CaptureFailure> {
    const reading = await this.readCamera();
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
    await this.adapter.shutdown();
    this.adapter = undefined;
    const row = this.state.allCaptures().find((capture) => capture.capture_id === captureId);
    if (row === undefined) throw new Error(`capture ${captureId} was published but has no row`);
    return row;
  }
}
