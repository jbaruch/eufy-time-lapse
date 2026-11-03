import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { PlannedSlot } from "./schedule.ts";

/**
 * The service's durable state. Owner and sole migrator: this module. The MIGRATIONS array is the schema of
 * record, and PRAGMA user_version is its version. Readers go through this class.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE slots (
    slot_id TEXT PRIMARY KEY,
    scheduled_at_utc TEXT NOT NULL,
    local_date TEXT NOT NULL,
    local_time TEXT NOT NULL,
    local_minutes INTEGER NOT NULL,
    schedule_revision TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'captured', 'captured_degraded', 'missed', 'skipped_policy')),
    reason TEXT,
    capture_id TEXT,
    every_minutes INTEGER,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX slots_by_time ON slots (scheduled_at_utc);
  CREATE INDEX slots_by_state ON slots (state, scheduled_at_utc);

  CREATE TABLE attempts (
    attempt_id TEXT PRIMARY KEY,
    slot_id TEXT,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    phase TEXT,
    connection_path TEXT,
    connect_ms INTEGER,
    session_ms INTEGER,
    reserved_ms INTEGER NOT NULL,
    video_bytes INTEGER NOT NULL DEFAULT 0,
    audio_bytes INTEGER NOT NULL DEFAULT 0,
    cleanup_status TEXT,
    stream_stop TEXT,
    width INTEGER,
    height INTEGER,
    budget_day TEXT NOT NULL,
    budget_month TEXT NOT NULL
  );
  CREATE INDEX attempts_by_day ON attempts (budget_day);
  CREATE INDEX attempts_by_month ON attempts (budget_month);

  CREATE TABLE captures (
    capture_id TEXT PRIMARY KEY,
    slot_id TEXT UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'manual')),
    local_date TEXT NOT NULL,
    frame_received_at TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    jpeg_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    quality_status TEXT NOT NULL,
    relative_dir TEXT NOT NULL,
    archive_status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX captures_by_date ON captures (local_date, frame_received_at);

  CREATE TABLE battery_readings (
    read_at TEXT NOT NULL,
    percent INTEGER,
    observed_at TEXT,
    every_minutes INTEGER,
    telemetry_json TEXT NOT NULL
  );
  CREATE INDEX battery_by_time ON battery_readings (read_at);

  CREATE TABLE flags (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE alerts (key TEXT PRIMARY KEY, detail TEXT NOT NULL, active_since TEXT NOT NULL, last_sent_at TEXT NOT NULL);
  CREATE TABLE events (at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
  `,
  `ALTER TABLE alerts ADD COLUMN recovery_owed_since TEXT;`,
  `
  CREATE TABLE framing_checks (
    capture_id TEXT PRIMARY KEY,
    checked_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('on_target', 'off_target', 'unsure')),
    reference_capture_id TEXT,
    dx INTEGER,
    dy INTEGER,
    detail TEXT NOT NULL
  );
  CREATE INDEX framing_checks_by_time ON framing_checks (checked_at);
  `,
  `
  ALTER TABLE framing_checks ADD COLUMN offset_dx INTEGER;
  ALTER TABLE framing_checks ADD COLUMN offset_dy INTEGER;
  `,
];

export type SlotState = "pending" | "running" | "captured" | "captured_degraded" | "missed" | "skipped_policy";

export interface SlotRow {
  slot_id: string;
  scheduled_at_utc: string;
  local_date: string;
  local_time: string;
  local_minutes: number;
  schedule_revision: string;
  state: SlotState;
  reason: string | null;
  capture_id: string | null;
  every_minutes: number | null;
}

export interface AttemptRow {
  attempt_id: string;
  slot_id: string | null;
  started_at: string;
  status: string;
  reason: string | null;
  phase: string | null;
  connection_path: string | null;
  connect_ms: number | null;
  session_ms: number | null;
  reserved_ms: number;
  video_bytes: number;
  audio_bytes: number;
  cleanup_status: string | null;
  stream_stop: string | null;
  width: number | null;
  height: number | null;
  budget_day: string;
  budget_month: string;
}

export interface CaptureRow {
  capture_id: string;
  slot_id: string | null;
  kind: "scheduled" | "manual";
  local_date: string;
  frame_received_at: string;
  width: number;
  height: number;
  jpeg_bytes: number;
  sha256: string;
  quality_status: string;
  relative_dir: string;
  archive_status: string;
  created_at: string;
}

export interface UnlinkedCapture extends CaptureRow {
  slot_id: string;
  slot_state: SlotState;
  slot_capture_id: string | null;
}

export interface AlertRow {
  key: string;
  detail: string;
  active_since: string;
  last_sent_at: string;
  /** When the problem ended, while nobody has been told yet. */
  recovery_owed_since: string | null;
}

export interface BatteryRow {
  read_at: string;
  percent: number | null;
  observed_at: string | null;
  every_minutes: number | null;
  telemetry_json: string;
}

export type FlagName = "operator_paused" | "battery_paused" | "battery_override" | "auth_required" | "first_started_at" | "camera_read_failures" | "login_renewal_tried_at" | "framing_position_id" | "framing_position_saved_at" | "tracking_paused_at" | "daily_report_date";

export type FramingCheckStatus = "on_target" | "off_target" | "unsure";

export interface FramingCheckRow {
  capture_id: string;
  checked_at: string;
  status: FramingCheckStatus;
  reference_capture_id: string | null;
  /** How far from the frame it was compared with. */
  dx: number | null;
  dy: number | null;
  /** How far from the saved position. Null when it couldn't be measured, and on rows from before this was kept. */
  offset_dx: number | null;
  offset_dy: number | null;
  detail: string;
}

/** A frame the framing check found on target, and so can be compared against. */
export interface FramingReference {
  capture_id: string;
  relative_dir: string;
  frame_received_at: string;
  offset_dx: number | null;
  offset_dy: number | null;
}

export class State {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.now = now;
    // In this order: switching to WAL needs the file to itself, so it's the first thing that can find it busy.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private schemaVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  /** The service and a command can both open a new database at once, so the version is only worth reading under the write lock. */
  private migrate(): void {
    if (this.schemaVersion() === MIGRATIONS.length) return;
    this.inTransaction(() => {
      const version = this.schemaVersion();
      if (version > MIGRATIONS.length) {
        throw new Error(`The state database is version ${version}, and this build knows ${MIGRATIONS.length}. Run the newer build, or restore a backup.`);
      }
      for (let index = version; index < MIGRATIONS.length; index += 1) {
        this.db.exec(MIGRATIONS[index] as string);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      }
    });
  }

  close(): void {
    this.db.close();
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** All of `work` or none of it. One already open just gets joined, so these can be built out of each other. */
  inTransaction(work: () => void): void {
    if (this.db.isTransaction) {
      work();
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("COMMIT");
  }

  /**
   * Adds plan entries that don't exist yet. A slot's id never changes, so rerunning this is harmless.
   * A schedule change retires what the old plan left pending, so the service never acts on a slot the current plan lacks.
   */
  materialize(slots: readonly PlannedSlot[], slotIdPrefix: string, scheduleRevision: string): void {
    this.db.prepare("DELETE FROM slots WHERE state = 'pending' AND schedule_revision != ?").run(scheduleRevision);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO slots (slot_id, scheduled_at_utc, local_date, local_time, local_minutes, schedule_revision, state, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const stamp = this.stamp();
    for (const slot of slots) {
      // A skipped local time maps onto the instant of a real one, so it can't take that instant as its id.
      const id = slot.nonexistent ? `${slotIdPrefix}/nonexistent-${slot.localDate}T${slot.localTime}` : `${slotIdPrefix}/${slot.scheduledAt.toISOString()}`;
      insert.run(id, slot.scheduledAt.toISOString(), slot.localDate, slot.localTime, slot.localMinutes, scheduleRevision, slot.nonexistent ? "skipped_policy" : "pending", slot.nonexistent ? "dst_nonexistent" : null, stamp);
    }
  }

  /** Slots whose deadline has passed never run, and are never made up later with present-day frames. */
  expirePending(before: Date): number {
    const result = this.db.prepare("UPDATE slots SET state = 'missed', reason = 'deadline_passed', updated_at = ? WHERE state = 'pending' AND scheduled_at_utc < ?").run(this.stamp(), before.toISOString());
    return Number(result.changes);
  }

  /** A slot that already has a frame is never due, whatever its row says: capturing it again would wake the camera for nothing. */
  duePending(now: Date): SlotRow | undefined {
    return this.one<SlotRow>("SELECT s.* FROM slots s WHERE s.state = 'pending' AND s.scheduled_at_utc <= ? AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.slot_id = s.slot_id) ORDER BY s.scheduled_at_utc LIMIT 1", now.toISOString());
  }

  /** How a local date's slots went, by state. */
  slotCountsOn(localDate: string): Partial<Record<SlotState, number>> {
    const rows = this.all<{ state: SlotState; count: number }>("SELECT state, COUNT(*) AS count FROM slots WHERE local_date = ? GROUP BY state", localDate);
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  /** Whether a local date still has slots to come, or one under way. */
  hasUnfinishedSlotsOn(localDate: string): boolean {
    return this.one("SELECT 1 FROM slots WHERE local_date = ? AND state IN ('pending', 'running') LIMIT 1", localDate) !== undefined;
  }

  offTargetCountOn(localDate: string): number {
    return this.one<{ count: number }>("SELECT COUNT(*) AS count FROM framing_checks f JOIN captures c ON c.capture_id = f.capture_id WHERE f.status = 'off_target' AND c.local_date = ?", localDate)?.count ?? 0;
  }

  /** Slots on a local date that took a second try. A retry's attempt id carries a -retry- suffix. */
  retriedSlotsOn(localDate: string): number {
    return this.one<{ count: number }>("SELECT COUNT(DISTINCT a.slot_id) AS count FROM attempts a JOIN slots s ON s.slot_id = a.slot_id WHERE s.local_date = ? AND a.attempt_id LIKE '%-retry-%' AND a.attempt_id NOT LIKE 'reservation-%'", localDate)?.count ?? 0;
  }

  /** When a local date's missed slots were due, in local minutes, earliest first. */
  missedMinutesOn(localDate: string): number[] {
    return this.all<{ local_minutes: number }>("SELECT local_minutes FROM slots WHERE local_date = ? AND state = 'missed' ORDER BY scheduled_at_utc", localDate).map((row) => row.local_minutes);
  }

  nextPending(after: Date): SlotRow | undefined {
    return this.one<SlotRow>("SELECT * FROM slots WHERE state = 'pending' AND scheduled_at_utc > ? ORDER BY scheduled_at_utc LIMIT 1", after.toISOString());
  }

  getSlot(slotId: string): SlotRow | undefined {
    return this.one<SlotRow>("SELECT * FROM slots WHERE slot_id = ?", slotId);
  }

  setSlot(slotId: string, state: SlotState, fields: { reason?: string | null; captureId?: string | null; everyMinutes?: number | null } = {}): void {
    this.db
      .prepare("UPDATE slots SET state = ?, reason = ?, capture_id = COALESCE(?, capture_id), every_minutes = COALESCE(?, every_minutes), updated_at = ? WHERE slot_id = ?")
      .run(state, fields.reason ?? null, fields.captureId ?? null, fields.everyMinutes ?? null, this.stamp(), slotId);
  }

  /** Puts back the row of a slot whose frame outlived it. The row starts as the writer left it, and an existing one is kept. */
  restoreSlot(slotId: string, slot: PlannedSlot, scheduleRevision: string): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO slots (slot_id, scheduled_at_utc, local_date, local_time, local_minutes, schedule_revision, state, reason, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?)`)
      .run(slotId, slot.scheduledAt.toISOString(), slot.localDate, slot.localTime, slot.localMinutes, scheduleRevision, this.stamp());
  }

  /** The latest day the plan has reached, which is where a long outage starts. */
  newestSlotDate(): string | undefined {
    return this.one<{ newest: string | null }>("SELECT MAX(local_date) AS newest FROM slots")?.newest ?? undefined;
  }

  /** Frames whose slot has no row at all. */
  capturesMissingSlots(): CaptureRow[] {
    return this.all<CaptureRow>("SELECT c.* FROM captures c LEFT JOIN slots s ON s.slot_id = c.slot_id WHERE c.slot_id IS NOT NULL AND s.slot_id IS NULL");
  }

  /** Frames whose slot doesn't name them back. */
  unlinkedCaptures(): UnlinkedCapture[] {
    return this.all<UnlinkedCapture>(`
      SELECT c.*, s.state AS slot_state, s.capture_id AS slot_capture_id FROM captures c JOIN slots s ON s.slot_id = c.slot_id
      WHERE s.capture_id IS NULL OR s.capture_id != c.capture_id`);
  }

  runningSlots(): SlotRow[] {
    return this.all<SlotRow>("SELECT * FROM slots WHERE state = 'running'");
  }

  /**
   * A scheduled capture's reservation that's still open at startup belongs to a process that's gone. It stays charged, because
   * nothing shows what it cost, but it shouldn't read as running. A manual one could be another process's, so that's left be.
   */
  closeInterruptedReservations(): void {
    this.db.prepare("UPDATE attempts SET status = 'failed', reason = 'unknown_after_crash', cleanup_status = 'unknown_after_crash' WHERE status = 'running' AND slot_id IS NOT NULL").run();
  }

  /** A slot left running means the process died mid-capture. Whether the camera connection closed is unknowable. */
  markInterruptedSlots(): SlotRow[] {
    const rows = this.all<SlotRow>("SELECT * FROM slots WHERE state = 'running'");
    for (const row of rows) this.setSlot(row.slot_id, "missed", { reason: "unknown_after_crash" });
    return rows;
  }

  insertAttempt(row: AttemptRow): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO attempts (attempt_id, slot_id, started_at, status, reason, phase, connection_path, connect_ms, session_ms, reserved_ms, video_bytes, audio_bytes, cleanup_status, stream_stop, width, height, budget_day, budget_month)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.attempt_id, row.slot_id, row.started_at, row.status, row.reason, row.phase, row.connection_path, row.connect_ms, row.session_ms, row.reserved_ms, row.video_bytes, row.audio_bytes, row.cleanup_status, row.stream_stop, row.width, row.height, row.budget_day, row.budget_month);
  }

  deleteAttempt(attemptId: string): void {
    this.db.prepare("DELETE FROM attempts WHERE attempt_id = ?").run(attemptId);
  }

  /** Swaps a reservation for the tries it paid for in one step, so no crash can leave the day's budget uncharged. */
  settleReservation(reservationId: string, attempts: readonly AttemptRow[]): void {
    this.inTransaction(() => {
      this.deleteAttempt(reservationId);
      for (const attempt of attempts) this.insertAttempt(attempt);
    });
  }

  /** An attempt with no recorded time was interrupted, so it's charged its full reservation. A restart can't reset this. */
  sessionUsedMs(budgetDay: string): number {
    return this.one<{ used: number }>("SELECT COALESCE(SUM(COALESCE(session_ms, reserved_ms)), 0) AS used FROM attempts WHERE budget_day = ?", budgetDay)?.used ?? 0;
  }

  monthBytes(budgetMonth: string): number {
    return this.one<{ bytes: number }>("SELECT COALESCE(SUM(video_bytes + audio_bytes), 0) AS bytes FROM attempts WHERE budget_month = ?", budgetMonth)?.bytes ?? 0;
  }

  attemptsSince(since: string): AttemptRow[] {
    return this.all<AttemptRow>("SELECT * FROM attempts WHERE started_at >= ? ORDER BY started_at", since);
  }

  /** Saves a frame's row, or leaves the one already there under its id, and answers what's stored. Another frame taking the same slot still fails. */
  insertCapture(row: CaptureRow): CaptureRow {
    this.db
      .prepare(`
        INSERT INTO captures (capture_id, slot_id, kind, local_date, frame_received_at, width, height, jpeg_bytes, sha256, quality_status, relative_dir, archive_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (capture_id) DO NOTHING`)
      .run(row.capture_id, row.slot_id, row.kind, row.local_date, row.frame_received_at, row.width, row.height, row.jpeg_bytes, row.sha256, row.quality_status, row.relative_dir, row.archive_status, row.created_at);
    return this.one<CaptureRow>("SELECT * FROM captures WHERE capture_id = ?", row.capture_id) as CaptureRow;
  }

  getCapture(captureId: string): CaptureRow | undefined {
    return this.one<CaptureRow>("SELECT * FROM captures WHERE capture_id = ?", captureId);
  }

  hasCapture(captureId: string): boolean {
    return this.one("SELECT 1 FROM captures WHERE capture_id = ?", captureId) !== undefined;
  }

  slotHasCapture(slotId: string): boolean {
    return this.one("SELECT 1 FROM captures WHERE slot_id = ?", slotId) !== undefined;
  }

  capturesBetween(from: string, to: string): CaptureRow[] {
    return this.all<CaptureRow>("SELECT * FROM captures WHERE local_date >= ? AND local_date <= ? ORDER BY frame_received_at", from, to);
  }

  allCaptures(): CaptureRow[] {
    return this.all<CaptureRow>("SELECT * FROM captures ORDER BY frame_received_at");
  }

  latestCapture(): CaptureRow | undefined {
    return this.one<CaptureRow>("SELECT * FROM captures WHERE kind = 'scheduled' ORDER BY frame_received_at DESC LIMIT 1");
  }

  recordBattery(row: BatteryRow): void {
    this.db.prepare("INSERT INTO battery_readings (read_at, percent, observed_at, every_minutes, telemetry_json) VALUES (?, ?, ?, ?, ?)").run(row.read_at, row.percent, row.observed_at, row.every_minutes, row.telemetry_json);
  }

  /** The newest reading that has both a value and a time, as opposed to a read that failed or came back empty. */
  lastKnownBattery(): BatteryRow | undefined {
    return this.one<BatteryRow>("SELECT * FROM battery_readings WHERE percent IS NOT NULL AND observed_at IS NOT NULL ORDER BY read_at DESC LIMIT 1");
  }

  /** The same, as of a moment in the past. */
  lastKnownBatteryBefore(at: string): BatteryRow | undefined {
    return this.one<BatteryRow>("SELECT * FROM battery_readings WHERE percent IS NOT NULL AND observed_at IS NOT NULL AND read_at < ? ORDER BY read_at DESC LIMIT 1", at);
  }

  latestBattery(): BatteryRow | undefined {
    return this.one<BatteryRow>("SELECT * FROM battery_readings ORDER BY read_at DESC LIMIT 1");
  }

  batterySince(since: string): BatteryRow[] {
    return this.all<BatteryRow>("SELECT * FROM battery_readings WHERE read_at >= ? ORDER BY read_at", since);
  }

  getFlag(name: FlagName): string | undefined {
    return this.one<{ value: string }>("SELECT value FROM flags WHERE key = ?", name)?.value;
  }

  setFlag(name: FlagName, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM flags WHERE key = ?").run(name);
      return;
    }
    this.db.prepare("INSERT INTO flags (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(name, value, this.stamp());
  }

  /** Later checks of the same frame are ignored, so a retried publish can't rewrite a verdict. */
  recordFramingCheck(row: FramingCheckRow): void {
    this.db
      .prepare("INSERT INTO framing_checks (capture_id, checked_at, status, reference_capture_id, dx, dy, offset_dx, offset_dy, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (capture_id) DO NOTHING")
      .run(row.capture_id, row.checked_at, row.status, row.reference_capture_id, row.dx, row.dy, row.offset_dx, row.offset_dy, row.detail);
  }

  latestFramingCheck(): FramingCheckRow | undefined {
    return this.one<FramingCheckRow>("SELECT * FROM framing_checks ORDER BY checked_at DESC, rowid DESC LIMIT 1");
  }

  /**
   * Good frames since a time, or else the newest one of any age, so a long stop doesn't leave nothing to compare with.
   * Nothing from before the position was saved, however good: those frames show another view.
   */
  framingReferences(since: string, positionSavedAt: string): FramingReference[] {
    const query = "SELECT c.capture_id, c.relative_dir, c.frame_received_at, f.offset_dx, f.offset_dy FROM framing_checks f JOIN captures c ON c.capture_id = f.capture_id WHERE f.status = 'on_target' AND c.frame_received_at >= ?";
    const recent = this.all<FramingReference>(`${query} AND c.frame_received_at >= ? ORDER BY c.frame_received_at`, positionSavedAt, since);
    return recent.length > 0 ? recent : this.all<FramingReference>(`${query} ORDER BY c.frame_received_at DESC LIMIT 1`, positionSavedAt);
  }

  /** Off-target verdicts since the last on-target one. Unsure neither adds to them nor ends them. */
  offTargetSlotsInARow(): number {
    const lastGood = this.one<{ at: string }>("SELECT checked_at AS at FROM framing_checks WHERE status = 'on_target' ORDER BY checked_at DESC, rowid DESC LIMIT 1")?.at ?? "";
    return this.one<{ count: number }>("SELECT COUNT(*) AS count FROM framing_checks WHERE status = 'off_target' AND checked_at > ?", lastGood)?.count ?? 0;
  }

  offTargetCaptureIds(from: string, to: string): Set<string> {
    const rows = this.all<{ capture_id: string }>("SELECT c.capture_id FROM framing_checks f JOIN captures c ON c.capture_id = f.capture_id WHERE f.status = 'off_target' AND c.local_date >= ? AND c.local_date <= ?", from, to);
    return new Set(rows.map((row) => row.capture_id));
  }

  countEventsSince(kind: string, since: string): number {
    return this.one<{ count: number }>("SELECT COUNT(*) AS count FROM events WHERE kind = ? AND at >= ?", kind, since)?.count ?? 0;
  }

  addEvent(kind: string, detail: string): void {
    this.db.prepare("INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)").run(this.stamp(), kind, detail);
  }

  /** Scheduled slots' first tries, newest first. A retry's attempt id carries a -retry- suffix, and a manual capture has no slot. */
  recentFirstTries(limit: number): AttemptRow[] {
    return this.all<AttemptRow>("SELECT * FROM attempts WHERE slot_id IS NOT NULL AND attempt_id NOT LIKE '%-retry-%' AND attempt_id NOT LIKE 'reservation-%' AND status != 'running' ORDER BY started_at DESC LIMIT ?", limit);
  }

  /** Scheduled slots whose time has come, newest first. Grid slots a battery tier passed over don't count as outcomes here. */
  recentOutcomes(limit: number): SlotRow[] {
    return this.all<SlotRow>("SELECT * FROM slots WHERE state IN ('captured', 'captured_degraded', 'missed') ORDER BY scheduled_at_utc DESC LIMIT ?", limit);
  }

  slotCountsSince(sinceUtc: string, untilUtc: string): Array<{ state: SlotState; reason: string | null; count: number }> {
    return this.all("SELECT state, reason, COUNT(*) AS count FROM slots WHERE scheduled_at_utc >= ? AND scheduled_at_utc <= ? GROUP BY state, reason", sinceUtc, untilUtc);
  }

  getAlert(key: string): AlertRow | undefined {
    return this.one("SELECT * FROM alerts WHERE key = ?", key);
  }

  /** Problems still going on. One that has ended, with its recovery message still owed, isn't among them. */
  listAlerts(): AlertRow[] {
    return this.all("SELECT * FROM alerts WHERE recovery_owed_since IS NULL ORDER BY active_since");
  }

  listOwedRecoveries(): AlertRow[] {
    return this.all("SELECT * FROM alerts WHERE recovery_owed_since IS NOT NULL ORDER BY recovery_owed_since");
  }

  oweRecovery(key: string, at: string): void {
    this.db.prepare("UPDATE alerts SET recovery_owed_since = ? WHERE key = ?").run(at, key);
  }

  upsertAlert(key: string, detail: string, activeSince: string, lastSentAt: string): void {
    this.db
      .prepare("INSERT INTO alerts (key, detail, active_since, last_sent_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET recovery_owed_since = NULL, detail = excluded.detail, last_sent_at = excluded.last_sent_at")
      .run(key, detail, activeSince, lastSentAt);
  }

  deleteAlert(key: string): void {
    this.db.prepare("DELETE FROM alerts WHERE key = ?").run(key);
  }

  /** Records that a problem's first message went out. One that ended meanwhile stays ended. */
  markAlertSent(key: string, at: string): void {
    this.db.prepare("UPDATE alerts SET last_sent_at = ? WHERE key = ?").run(at, key);
  }

  /** Removes an alert whose recovery went out, unless the problem came back since: that's a new problem, still owed its message. */
  deleteOwedRecovery(key: string, owedSince: string): void {
    this.db.prepare("DELETE FROM alerts WHERE key = ? AND recovery_owed_since = ?").run(key, owedSince);
  }
}
