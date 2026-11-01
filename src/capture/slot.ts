import { setTimeout as delay } from "node:timers/promises";
import type { FailureReason } from "../adapters/adapter.ts";
import { acquireFrame } from "./acquire.ts";
import type { AcquireOptions, AttemptRecord } from "./acquire.ts";

/** Transient connectivity and media errors. Auth, stale sources and shutdowns must never loop. */
const RETRYABLE: ReadonlySet<FailureReason> = new Set<FailureReason>(["camera_unreachable", "capture_timeout", "decode_failed"]);

export interface SlotOptions extends Omit<AcquireOptions, "outputDir"> {
  /** Tries write to `<slotDir>` and then `<slotDir>-retry-N`, so every frame stays on disk. */
  slotDir: string;
  maxTries: number;
  retryDelayMs: number;
  slotDeadlineMs: number;
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

/** On a tie the later try wins: a clean retry beats the failure it followed. */
function chooseBest(tries: AttemptRecord[]): AttemptRecord {
  return tries.reduce((best, record) => (rank(record) >= rank(best) ? record : best));
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

  for (let index = 0; index < options.maxTries; index += 1) {
    const outputDir = index === 0 ? options.slotDir : `${options.slotDir}-retry-${index}`;
    const record = await acquireFrame({ ...options, outputDir, signal, now });
    tries.push(record);

    if (!shouldRetry(record) || index + 1 === options.maxTries || signal.aborted) break;

    const needed = options.retryDelayMs + options.acquisitionTimeoutMs + options.cleanupTimeoutMs;
    if (now().getTime() - startedAt + needed > options.slotDeadlineMs) {
      options.log(`not retrying: another try wouldn't finish inside the ${options.slotDeadlineMs / 1000} s slot deadline`);
      break;
    }
    options.log(`try ${index + 1} ended as ${record.failure?.reason ?? record.status}: retrying in ${options.retryDelayMs / 1000} s`);
    await sleep(options.retryDelayMs, signal);
    if (signal.aborted) break;
  }

  const chosen = chooseBest(tries);
  const [first] = tries;
  return {
    chosen,
    otherTries: tries.filter((record) => record !== chosen),
    firstTryStatus: first === undefined ? chosen.status : first.status,
  };
}
