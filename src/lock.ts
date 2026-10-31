import { open, readFile, rm } from "node:fs/promises";

export class CameraLockHeldError extends Error {
  constructor(lockPath: string, pid: number) {
    super(`Another process (pid ${pid}) is using the camera. Wait for it to finish, or stop it. Lock file: ${lockPath}`);
    this.name = "CameraLockHeldError";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function acquire(lockPath: string, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(pid));
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number.parseInt(await readFile(lockPath, "utf8"), 10);
    if (Number.isInteger(holder) && isAlive(holder)) throw new CameraLockHeldError(lockPath, holder);
    await rm(lockPath, { force: true });
  }
  throw new Error(`Could not take the camera lock at ${lockPath}: another process keeps recreating it.`);
}

/** Runs `work` holding the exclusive camera lock. A lock left by a dead process is replaced. */
export async function withCameraLock<T>(lockPath: string, work: () => Promise<T>, pid: number = process.pid): Promise<T> {
  await acquire(lockPath, pid);
  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true });
  }
}
