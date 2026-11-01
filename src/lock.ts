import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat, utimes } from "node:fs/promises";

const HEARTBEAT_MS = 5_000;
/** A holder this long without a heartbeat is gone. */
const STALE_AFTER_MS = 20_000;
/** Event-loop turns to wait for another contender's guard. It's held for milliseconds, and counting turns needs no clock. */
const GUARD_TRIES = 2_000;

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
 * Runs one lock change with every other contender held off. Taking, evicting and releasing all go through this, so no
 * step can land between another's check and its act: without it, a slow contender could judge a lock stale, and then
 * delete the one a faster contender had just taken, leaving both with the camera.
 */
async function underGuard<T>(lockPath: string, now: () => number, change: () => Promise<T>): Promise<T> {
  const guardPath = `${lockPath}.guard`;
  for (let tries = 0; ; tries += 1) {
    try {
      await (await open(guardPath, "wx")).close();
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    if (tries >= GUARD_TRIES) throw new CameraLockHeldError(lockPath);
    await clearAbandonedGuard(guardPath, now);
    await new Promise((resolve) => setImmediate(resolve));
  }
  try {
    return await change();
  } finally {
    await rm(guardPath, { force: true });
  }
}

/** A guard is held for milliseconds, so one this old belongs to a process that crashed holding it. */
async function clearAbandonedGuard(guardPath: string, now: () => number): Promise<void> {
  try {
    if (now() - (await stat(guardPath)).mtimeMs >= STALE_AFTER_MS) await rm(guardPath, { force: true });
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

async function create(lockPath: string, token: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(token);
    await handle.close();
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
}

async function acquire(lockPath: string, token: string, now: () => number): Promise<void> {
  await underGuard(lockPath, now, async () => {
    if (await create(lockPath, token)) return;
    if (now() - (await stat(lockPath)).mtimeMs < STALE_AFTER_MS) throw new CameraLockHeldError(lockPath);
    await rm(lockPath, { force: true });
    if (!(await create(lockPath, token))) throw new CameraLockHeldError(lockPath);
  });
}

/** Removes the lock only if it's still this holder's. A stale holder must not delete its successor's. */
async function release(lockPath: string, token: string, now: () => number): Promise<void> {
  try {
    await underGuard(lockPath, now, async () => {
      if ((await readFile(lockPath, "utf8")) === token) await rm(lockPath, { force: true });
    });
  } catch (error) {
    // Already gone is what release wants. Stuck behind a guard, the lock goes stale by itself, so the work's result stands.
    if (!isErrno(error, "ENOENT") && !(error instanceof CameraLockHeldError)) throw error;
  }
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
    await release(lockPath, token, now);
  }
}
