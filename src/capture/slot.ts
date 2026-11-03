import { setTimeout as delay } from "node:timers/promises";
import type { FailureReason } from "../adapters/adapter.ts";
import { acquireFrame } from "./acquire.ts";
import type { AcquireOptions, AttemptRecord } from "./acquire.ts";

/** Transient connectivity and media errors. Auth, stale sources and shutdowns must never loop. */
const RETRYABLE: ReadonlySet<FailureReason> = new Set<FailureReason>(["camera_unreachable", "capture_timeout", "stream_lost", "decode_failed"]);

export interface SlotOptions extends Omit<AcquireOptions, "outputDir"> {
  /** Tries write to `<slotDir>` and then `<slotDir>-retry-N`, so every frame stays on disk. */
  slotDir: string;
  maxTries: number;
  retryDelayMs: number;
  slotDeadlineMs: number;
  /** Runs before every try, retries included. Its time counts toward the deadline, so `beforeTryMs` says how long it can take. */
  beforeTry?: () => Promise<void>;
  beforeTryMs?: number;
  /** Whether a frame points the wrong way, which makes it worth another try, however sharp it is. */
  isOffTarget?: (record: AttemptRecord) => Promise<boolean>;
  log: (message: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SlotResult {
  /** The best try: the frame this slot keeps. */
  chosen: AttemptRecord;
  /** Every other try, kept for the record. A failed try still woke the camera. */
  otherTries: AttemptRecord[];
  firstTryStatus: AttemptRecord["status"];
}

/** Where one try of a slot keeps its files. Crash recovery has to find them again. */
export function tryDirectory(slotDir: string, index: number): string {
  return index === 0 ? slotDir : `${slotDir}-retry-${index}`;
}

export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }
}

function shouldRetry(record: AttemptRecord): boolean {
  if (record.status === "captured") return false;
  // A frame below the required size is real, but it isn't what was asked for, so it's worth one more try.
  if (record.status === "captured_degraded") return true;
  return record.failure !== null && RETRYABLE.has(record.failure.reason);
}

function rank(record: AttemptRecord): number {
  if (record.frame === null) return -1;
  const pixels = record.frame.width * record.frame.height;
  return record.status === "captured" ? pixels + Number.MAX_SAFE_INTEGER / 2 : pixels;
}

/**
 * On a tie the later try wins: a clean retry beats the failure it followed. A frame known to be off target loses to any
 * other frame, however much sharper, since renders leave it out.
 */
export function chooseBest(tries: AttemptRecord[], offTarget: ReadonlySet<AttemptRecord> = new Set()): AttemptRecord {
  const usable = (record: AttemptRecord): boolean => record.frame !== null && !offTarget.has(record);
  return tries.reduce((best, record) => (usable(record) !== usable(best) ? (usable(record) ? record : best) : rank(record) >= rank(best) ? record : best));
}

/**
 * One scheduled capture: up to `maxTries`, spaced by `retryDelayMs`, never starting a try that couldn't
 * finish inside the slot's deadline. Keeps the best frame and accounts for every try.
 */
export async function captureSlot(options: SlotOptions): Promise<SlotResult> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const signal = options.signal ?? new AbortController().signal;
  const startedAt = now().getTime();
  const tries: AttemptRecord[] = [];
  const offTargetTries = new Set<AttemptRecord>();

  for (let index = 0; index < options.maxTries; index += 1) {
    await options.beforeTry?.();
    const outputDir = tryDirectory(options.slotDir, index);
    const record = await acquireFrame({ ...options, outputDir, signal, now });
    tries.push(record);

    const offTarget = record.frame !== null && options.isOffTarget !== undefined && (await options.isOffTarget(record));
    if (offTarget) offTargetTries.add(record);
    if ((!shouldRetry(record) && !offTarget) || index + 1 === options.maxTries || signal.aborted) break;
    if (record.cleanup.status !== "ok") {
      options.log(`not retrying: the last try's connection may not have closed (${record.cleanup.status}), and another try would wake the camera on top of it`);
      break;
    }

    const needed = options.retryDelayMs + (options.beforeTryMs ?? 0) + options.acquisitionTimeoutMs + options.cleanupTimeoutMs;
    if (now().getTime() - startedAt + needed > options.slotDeadlineMs) {
      options.log(`not retrying: another try wouldn't finish inside the ${options.slotDeadlineMs / 1000} s slot deadline`);
      break;
    }
    options.log(`try ${index + 1} ended as ${offTarget ? "off target" : (record.failure?.reason ?? record.status)}: retrying in ${options.retryDelayMs / 1000} s`);
    await sleep(options.retryDelayMs, signal);
    if (signal.aborted) break;
  }

  const chosen = chooseBest(tries, offTargetTries);
  const [first] = tries;
  return {
    chosen,
    otherTries: tries.filter((record) => record !== chosen),
    firstTryStatus: first === undefined ? chosen.status : first.status,
  };
}
