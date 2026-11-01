import { open, rm, stat, utimes } from "node:fs/promises";

const HEARTBEAT_MS = 5_000;
/** A holder this long without a heartbeat is gone. */
const STALE_AFTER_MS = 20_000;

export class CameraLockHeldError extends Error {
  constructor(lockPath: string) {
    super(`Another process is using the camera. Wait for it to finish, or stop it. Lock file: ${lockPath}`);
    this.name = "CameraLockHeldError";
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

async function acquire(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    let ageMs: number;
    try {
      ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue; // The holder released it between the two calls.
      throw error;
    }
    if (ageMs < STALE_AFTER_MS) throw new CameraLockHeldError(lockPath);
    await rm(lockPath, { force: true });
  }
  throw new Error(`Could not take the camera lock at ${lockPath}: another process keeps recreating it.`);
}

/**
 * Runs `work` holding the exclusive camera lock. Holders prove they're alive with a heartbeat rather than
 * a PID: every container's process can be PID 1, so a PID can't tell a live holder from a crashed one.
 */
export async function withCameraLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  await acquire(lockPath);
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockPath, now, now).catch((error: Error) => {
      process.stderr.write(`camera lock heartbeat failed: ${error.message}\n`);
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { force: true });
  }
}
