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

export interface BatteryRow {
  read_at: string;
  percent: number | null;
  observed_at: string | null;
  every_minutes: number | null;
  telemetry_json: string;
}

export type FlagName = "operator_paused" | "battery_paused" | "battery_override" | "auth_required" | "first_started_at" | "camera_read_failures";

export class State {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > MIGRATIONS.length) {
      throw new Error(`The state database is version ${version}, and this build knows ${MIGRATIONS.length}. Run the newer build, or restore a backup.`);
    }
    for (let index = version; index < MIGRATIONS.length; index += 1) {
      this.db.exec("BEGIN");
      this.db.exec(MIGRATIONS[index] as string);
      this.db.exec(`PRAGMA user_version = ${index + 1}`);
      this.db.exec("COMMIT");
    }
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

  inTransaction(work: () => void): void {
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

  insertCapture(row: CaptureRow): void {
    this.db
      .prepare(`
        INSERT INTO captures (capture_id, slot_id, kind, local_date, frame_received_at, width, height, jpeg_bytes, sha256, quality_status, relative_dir, archive_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.capture_id, row.slot_id, row.kind, row.local_date, row.frame_received_at, row.width, row.height, row.jpeg_bytes, row.sha256, row.quality_status, row.relative_dir, row.archive_status, row.created_at);
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

  addEvent(kind: string, detail: string): void {
    this.db.prepare("INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)").run(this.stamp(), kind, detail);
  }

  /** Scheduled slots' first tries, newest first. A retry's attempt id carries a -retry- suffix, and a manual capture has no slot. */
  recentFirstTries(limit: number): AttemptRow[] {
    return this.all<AttemptRow>("SELECT * FROM attempts WHERE slot_id IS NOT NULL AND attempt_id NOT LIKE '%-retry-%' AND status != 'running' ORDER BY started_at DESC LIMIT ?", limit);
  }

  /** Scheduled slots whose time has come, newest first. Grid slots a battery tier passed over don't count as outcomes here. */
  recentOutcomes(limit: number): SlotRow[] {
    return this.all<SlotRow>("SELECT * FROM slots WHERE state IN ('captured', 'captured_degraded', 'missed') ORDER BY scheduled_at_utc DESC LIMIT ?", limit);
  }

  slotCountsSince(sinceUtc: string, untilUtc: string): Array<{ state: SlotState; reason: string | null; count: number }> {
    return this.all("SELECT state, reason, COUNT(*) AS count FROM slots WHERE scheduled_at_utc >= ? AND scheduled_at_utc <= ? GROUP BY state, reason", sinceUtc, untilUtc);
  }

  getAlert(key: string): { key: string; detail: string; active_since: string; last_sent_at: string } | undefined {
    return this.one("SELECT * FROM alerts WHERE key = ?", key);
  }

  listAlerts(): Array<{ key: string; detail: string; active_since: string; last_sent_at: string }> {
    return this.all("SELECT * FROM alerts ORDER BY active_since");
  }

  upsertAlert(key: string, detail: string, activeSince: string, lastSentAt: string): void {
    this.db
      .prepare("INSERT INTO alerts (key, detail, active_since, last_sent_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET detail = excluded.detail, last_sent_at = excluded.last_sent_at")
      .run(key, detail, activeSince, lastSentAt);
  }

  deleteAlert(key: string): void {
    this.db.prepare("DELETE FROM alerts WHERE key = ?").run(key);
  }
}
