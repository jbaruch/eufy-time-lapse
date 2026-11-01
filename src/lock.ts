import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat, utimes } from "node:fs/promises";

const HEARTBEAT_MS = 5_000;
/** A holder this long without a heartbeat is gone. */
const STALE_AFTER_MS = 20_000;

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

export interface LockOptions {
  /** The current time, for judging a holder stale and for its heartbeat. */
  now?: () => number;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

/**
 * Removes a stale lock, re-checking under a guard. Without the guard, two contenders could judge the same lock stale,
 * and the slower one would remove the lock the faster one had just taken, leaving both with the camera.
 */
export async function evictIfStale(lockPath: string, now: () => number): Promise<void> {
  const guardPath = `${lockPath}.evict`;
  try {
    await (await open(guardPath, "wx")).close();
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    // Another contender is evicting. A guard this old means it crashed doing so, and the next try can take over.
    if (now() - (await stat(guardPath)).mtimeMs >= STALE_AFTER_MS) await rm(guardPath, { force: true });
    throw new CameraLockHeldError(lockPath);
  }
  try {
    if (now() - (await stat(lockPath)).mtimeMs >= STALE_AFTER_MS) await rm(lockPath, { force: true });
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  } finally {
    await rm(guardPath, { force: true });
  }
}

async function acquire(lockPath: string, token: string, now: () => number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(token);
      await handle.close();
      return;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    let ageMs: number;
    try {
      ageMs = now() - (await stat(lockPath)).mtimeMs;
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue; // The holder released it between the two calls.
      throw error;
    }
    if (ageMs < STALE_AFTER_MS) throw new CameraLockHeldError(lockPath);
    await evictIfStale(lockPath, now);
  }
  throw new Error(`Could not take the camera lock at ${lockPath}: another process keeps recreating it.`);
}

/** Removes the lock only if it's still this holder's. A stale holder must not delete its successor's. */
async function release(lockPath: string, token: string): Promise<void> {
  let holder: string;
  try {
    holder = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (holder === token) await rm(lockPath, { force: true });
}

/**
 * Runs `work` holding the exclusive camera lock. Holders prove they're alive with a heartbeat rather than
 * a PID: every container's process can be PID 1, so a PID can't tell a live holder from a crashed one.
 *
 * A heartbeat that fails means another process could soon take the lock as stale. `work` gets a signal that
 * aborts when that happens, and has to stop using the camera. The call then rejects with CameraLockLostError.
 */
export async function withCameraLock<T>(lockPath: string, work: (lost: AbortSignal) => Promise<T>, options: LockOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const token = randomUUID();
  await acquire(lockPath, token, now);

  const controller = new AbortController();
  let lostBecause: string | undefined;
  const lose = (detail: string): void => {
    lostBecause ??= detail;
    clearInterval(heartbeat);
    controller.abort("terminated");
  };
  const beat = async (): Promise<void> => {
    if ((await readFile(lockPath, "utf8")) !== token) throw new Error("another process replaced it");
    const at = new Date(now());
    await utimes(lockPath, at, at);
  };
  const heartbeat = setInterval(() => {
    // Any failure here means this holder can't prove it holds the lock, whatever the cause.
    beat().catch((error: Error) => lose(error.message));
  }, HEARTBEAT_MS);
  heartbeat.unref();

  try {
    const result = await work(controller.signal);
    if (lostBecause !== undefined) throw new CameraLockLostError(lockPath, lostBecause);
    return result;
  } catch (error) {
    if (lostBecause !== undefined && !(error instanceof CameraLockLostError)) throw new CameraLockLostError(lockPath, lostBecause, { cause: error });
    throw error;
  } finally {
    clearInterval(heartbeat);
    await release(lockPath, token);
  }
}
