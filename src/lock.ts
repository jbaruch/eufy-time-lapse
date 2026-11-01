import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const HEARTBEAT_MS = 5_000;
/** A holder this long without a heartbeat is gone. */
const STALE_AFTER_MS = 20_000;
const BUSY_WAIT_MS = 2_000;
const SCHEMA_VERSION = 1;
const SQLITE_BUSY = 5;
/** How node:sqlite reports anything SQLite itself refused, from a busy file to one it can't open. */
const SQLITE_FAILURE = "ERR_SQLITE_ERROR";

export class CameraLockHeldError extends Error {
  constructor(lockPath: string) {
    super(`Another process is using the camera. Wait for it to finish, or stop it. Lock file: ${lockPath}`);
    this.name = "CameraLockHeldError";
  }
}

/** The holder can no longer prove it holds the lock, so another process may have the camera. */
export class CameraLockLostError extends Error {
  constructor(lockPath: string, detail: string, options?: ErrorOptions) {
    super(`Lost the camera lock at ${lockPath} (${detail}), so this camera work stopped. Check that the data directory is writable, and that nothing else is replacing the lock.`, options);
    this.name = "CameraLockLostError";
  }
}

/** The lock file doesn't say what this holder needs it to. */
class LockFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockFileError";
  }
}

export interface LockOptions {
  /** The current time, for judging a holder stale and for its heartbeat. */
  now?: () => number;
}

function isBusy(error: unknown): boolean {
  return (error as { errcode?: number }).errcode === SQLITE_BUSY;
}

function isLockFailure(error: unknown): error is Error {
  return error instanceof LockFileError || (error as NodeJS.ErrnoException).code === SQLITE_FAILURE;
}

/**
 * One lock step, as one transaction. SQLite serializes these across processes and containers, so no step can land
 * between another's check and its act. This module is the file's only reader and writer, and opens it fresh each time,
 * so a file that's been removed reads as no holder rather than as a deleted file still held open.
 */
function step<T>(lockPath: string, change: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(lockPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_WAIT_MS}`);
    db.exec("BEGIN IMMEDIATE");
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version === 0) {
      db.exec("CREATE TABLE holder (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, heartbeat_at INTEGER NOT NULL)");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (version !== SCHEMA_VERSION) {
      throw new LockFileError(`The camera lock at ${lockPath} is version ${version}, and this build knows ${SCHEMA_VERSION}. Stop whatever is using the camera, and remove the file.`);
    }
    const result = change(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function take(lockPath: string, token: string, now: () => number): void {
  try {
    step(lockPath, (db) => {
      const holder = db.prepare("SELECT heartbeat_at FROM holder WHERE id = 1").get() as { heartbeat_at: number } | undefined;
      if (holder !== undefined && now() - holder.heartbeat_at < STALE_AFTER_MS) throw new CameraLockHeldError(lockPath);
      db.prepare("INSERT OR REPLACE INTO holder (id, token, heartbeat_at) VALUES (1, ?, ?)").run(token, now());
    });
  } catch (error) {
    throw isBusy(error) ? new CameraLockHeldError(lockPath) : error;
  }
}

function heartbeat(lockPath: string, token: string, now: () => number): void {
  step(lockPath, (db) => {
    const { changes } = db.prepare("UPDATE holder SET heartbeat_at = ? WHERE id = 1 AND token = ?").run(now(), token);
    if (Number(changes) === 0) throw new LockFileError("another process holds it now, or it was removed");
  });
}

/** Removes only this holder's claim. A stale holder must not delete its successor's. */
function release(lockPath: string, token: string): void {
  try {
    step(lockPath, (db) => db.prepare("DELETE FROM holder WHERE id = 1 AND token = ?").run(token));
  } catch (error) {
    // Too busy to answer. The claim goes stale by itself, so the work's result stands.
    if (!isBusy(error)) throw error;
  }
}

/**
 * Runs `work` holding the exclusive camera lock. Holders prove they're alive with a heartbeat rather than
 * a PID: every container's process can be PID 1, so a PID can't tell a live holder from a crashed one.
 *
 * A heartbeat that fails means another process could soon take the lock as stale. `work` gets a signal that
 * aborts when that happens, and has to stop using the camera. The call then rejects with CameraLockLostError,
 * or, if the heartbeat failed on a bug and not on the lock, with that bug.
 */
export async function withCameraLock<T>(lockPath: string, work: (lost: AbortSignal) => Promise<T>, options: LockOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const token = randomUUID();
  take(lockPath, token, now);

  const controller = new AbortController();
  let lostBecause: string | undefined;
  let bug: { error: unknown } | undefined;
  const beating = setInterval(() => {
    try {
      heartbeat(lockPath, token, now);
    } catch (error) {
      // Whatever the cause, this holder can't prove it holds the lock, so the work stops. What it's called is decided here, and reported below.
      if (isLockFailure(error)) lostBecause = error.message;
      else bug = { error };
      clearInterval(beating);
      controller.abort("terminated");
    }
  }, HEARTBEAT_MS);
  beating.unref();

  try {
    const result = await work(controller.signal);
    if (bug !== undefined) throw bug.error;
    if (lostBecause !== undefined) throw new CameraLockLostError(lockPath, lostBecause);
    return result;
  } catch (error) {
    if (bug !== undefined) throw bug.error;
    if (lostBecause !== undefined && !(error instanceof CameraLockLostError)) throw new CameraLockLostError(lockPath, lostBecause, { cause: error });
    throw error;
  } finally {
    clearInterval(beating);
    // A claim this holder can't prove has nothing to give back, and goes stale by itself. What stopped the heartbeat would only stop this too, and hide why.
    if (lostBecause === undefined && bug === undefined) release(lockPath, token);
  }
}
