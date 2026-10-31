import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { CaptureFailure } from "../adapters/adapter.ts";
import type { AbortCause, CameraAdapter, CleanupResult, FailurePhase, FailureReason, LiveSession } from "../adapters/adapter.ts";
import { extractKeyframes, identifyStream, probeImage } from "../media/ffmpeg.ts";

export const TRAFFIC_BASIS = "media_payload_only: excludes P2P framing, encryption overhead, retransmits and connection setup";
export const FRESHNESS_BASIS = "bytes received on a live P2P session opened for this attempt, written to this attempt's own file";

export interface AcquireOptions {
  adapter: CameraAdapter;
  cameraKey: string;
  outputDir: string;
  acquisitionTimeoutMs: number;
  cleanupTimeoutMs: number;
  /** How long to keep the stream open after the first media arrives. */
  streamMs: number;
  minWidth: number;
  minHeight: number;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface KeyframeRecord {
  file: string;
  width: number;
  height: number;
  bytes: number;
}

export interface AttemptRecord {
  attempt_id: string;
  capture_session_id: string;
  status: "captured" | "captured_degraded" | "failed";
  failure: { reason: FailureReason; phase: FailurePhase; message: string } | null;
  timing: {
    request_started_at: string;
    stream_started_at: string | null;
    first_media_at: string | null;
    frame_saved_at: string | null;
    connect_ms: number | null;
    session_ms: number;
  };
  video: {
    reported_codec: string | null;
    reported_width: number | null;
    reported_height: number | null;
    reported_fps: number | null;
    actual_codec: string | null;
    actual_width: number | null;
    actual_height: number | null;
  };
  freshness: {
    source: "live_p2p";
    retained: false;
    basis: string;
    cold_connection: boolean | null;
  };
  traffic: { video_bytes: number; audio_bytes: number; basis: string };
  cleanup: CleanupResult;
  connect_retries: number | null;
  audio_error: string | null;
  frame: { file: string; width: number; height: number; bytes: number; sha256: string } | null;
  keyframes: KeyframeRecord[];
}

interface StreamStats {
  firstMediaAt: Date | null;
  videoBytes: number;
  audioBytes: number;
  audioError: string | null;
}

/**
 * Writes the live video to `path` until `streamMs` after the first media, the stream ends, or the
 * signal fires. A deadline with media in hand keeps what arrived; it isn't a failure.
 */
function collectStream(
  session: LiveSession,
  path: string,
  streamMs: number,
  signal: AbortSignal,
  now: () => Date,
): { stats: StreamStats; done: Promise<void> } {
  const stats: StreamStats = { firstMediaAt: null, videoBytes: 0, audioBytes: 0, audioError: null };
  const done = new Promise<void>((resolve, reject) => {
    const sink = createWriteStream(path);
    let settled = false;
    let stopTimer: NodeJS.Timeout | undefined;

    const finish = (failure?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(stopTimer);
      signal.removeEventListener("abort", onAbort);
      sink.end(() => (failure === undefined ? resolve() : reject(failure)));
    };
    const onAbort = (): void => {
      const cause = signal.reason as AbortCause;
      if (cause === "terminated") {
        finish(new CaptureFailure("aborted", "first_media", "Stopped by a termination signal."));
      } else if (stats.firstMediaAt === null) {
        finish(new CaptureFailure("capture_timeout", "first_media", "The live stream started, but no video arrived before the attempt deadline."));
      } else {
        finish();
      }
    };
    const onStreamGone = (): void => {
      if (stats.firstMediaAt === null) {
        finish(new CaptureFailure("capture_timeout", "first_media", "The live stream ended before any video arrived."));
      } else {
        finish();
      }
    };

    session.video.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stats.firstMediaAt === null) {
        stats.firstMediaAt = now();
        stopTimer = setTimeout(finish, streamMs);
      }
      stats.videoBytes += chunk.length;
      sink.write(chunk);
    });
    session.video.once("end", onStreamGone);
    session.video.once("close", onStreamGone);
    session.video.once("error", (error: Error) => {
      finish(new CaptureFailure("capture_timeout", "first_media", `The video stream failed: ${error.message}`, { cause: error }));
    });
    session.audio.on("data", (chunk: Buffer) => {
      if (!settled) stats.audioBytes += chunk.length;
    });
    // Audio isn't part of the frame, so losing it doesn't fail the attempt. It still goes in the report.
    session.audio.once("error", (error: Error) => {
      stats.audioError = error.message;
    });
    sink.once("error", (error: Error) => finish(error));

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return { stats, done };
}

async function boundedTeardown(adapter: CameraAdapter, cameraKey: string, timeoutMs: number): Promise<CleanupResult> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<CleanupResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout", detail: `teardown did not finish within ${timeoutMs} ms` }), timeoutMs);
  });
  // A teardown fault must never cost a frame that is already on disk, so it's recorded, not thrown.
  const attempted = adapter.teardown(cameraKey, timeoutMs).catch((error: Error) => ({ status: "error" as const, detail: error.message }));
  const result = await Promise.race([attempted, timedOut]);
  clearTimeout(timer);
  return result;
}

/**
 * One capture attempt: new live session, bounded stream, teardown, then decode. The camera is released
 * before FFmpeg runs, so decode time never keeps it awake. Anything but a CaptureFailure propagates,
 * after teardown has run.
 */
export async function acquireFrame(options: AcquireOptions): Promise<AttemptRecord> {
  const now = options.now ?? (() => new Date());
  await mkdir(options.outputDir, { recursive: true });
  const streamPath = join(options.outputDir, "stream.bin");

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort("deadline" satisfies AbortCause), options.acquisitionTimeoutMs);
  const onExternalAbort = (): void => controller.abort("terminated" satisfies AbortCause);
  if (options.signal?.aborted === true) onExternalAbort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const requestStartedAt = now();
  let streamStartedAt: Date | null = null;
  let session: LiveSession | undefined;
  let stats: StreamStats | undefined;
  let failure: CaptureFailure | undefined;
  let cleanup: CleanupResult;

  try {
    session = await options.adapter.openLiveSession(options.cameraKey, controller.signal);
    streamStartedAt = now();
    const collecting = collectStream(session, streamPath, options.streamMs, controller.signal, now);
    stats = collecting.stats;
    await collecting.done;
  } catch (error) {
    if (!(error instanceof CaptureFailure)) throw error;
    failure = error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", onExternalAbort);
    cleanup = await boundedTeardown(options.adapter, options.cameraKey, options.cleanupTimeoutMs);
  }
  const releasedAt = now();

  const record: AttemptRecord = {
    attempt_id: basename(options.outputDir),
    capture_session_id: randomUUID(),
    status: "failed",
    failure: null,
    timing: {
      request_started_at: requestStartedAt.toISOString(),
      stream_started_at: streamStartedAt?.toISOString() ?? null,
      first_media_at: stats?.firstMediaAt?.toISOString() ?? null,
      frame_saved_at: null,
      connect_ms: session?.connectMs ?? null,
      session_ms: releasedAt.getTime() - requestStartedAt.getTime(),
    },
    video: {
      reported_codec: session?.codec ?? null,
      reported_width: session?.reportedWidth ?? null,
      reported_height: session?.reportedHeight ?? null,
      reported_fps: session?.reportedFps ?? null,
      actual_codec: null,
      actual_width: null,
      actual_height: null,
    },
    freshness: { source: "live_p2p", retained: false, basis: FRESHNESS_BASIS, cold_connection: session?.coldConnection ?? null },
    traffic: { video_bytes: stats?.videoBytes ?? 0, audio_bytes: stats?.audioBytes ?? 0, basis: TRAFFIC_BASIS },
    cleanup,
    connect_retries: session?.connectRetries ?? null,
    audio_error: stats?.audioError ?? null,
    frame: null,
    keyframes: [],
  };

  if (failure === undefined && session !== undefined) {
    try {
      await saveFrame(record, session, streamPath, options, now);
    } catch (error) {
      if (!(error instanceof CaptureFailure)) throw error;
      failure = error;
    }
  }
  if (failure !== undefined) {
    record.status = "failed";
    record.failure = { reason: failure.reason, phase: failure.phase, message: failure.message };
  }
  return record;
}

async function saveFrame(
  record: AttemptRecord,
  session: LiveSession,
  streamPath: string,
  options: AcquireOptions,
  now: () => Date,
): Promise<void> {
  const { format, properties } = await identifyStream(streamPath, session.codec);
  record.video.actual_codec = properties.codec;
  record.video.actual_width = properties.width;
  record.video.actual_height = properties.height;

  const keyframePaths = await extractKeyframes(streamPath, format, options.outputDir);
  for (const path of keyframePaths) {
    const image = await probeImage(path);
    const { size } = await stat(path);
    record.keyframes.push({ file: basename(path), width: image.width, height: image.height, bytes: size });
  }

  // The last keyframe has had the longest to settle after a cold start. Every keyframe stays on disk,
  // so the policy can be revisited against real footage.
  const chosen = keyframePaths[keyframePaths.length - 1];
  const chosenRecord = record.keyframes[record.keyframes.length - 1];
  if (chosen === undefined || chosenRecord === undefined) {
    throw new CaptureFailure("decode_failed", "decode", "FFmpeg returned no keyframes.");
  }
  const framePath = join(options.outputDir, "frame.jpg");
  await copyFile(chosen, `${framePath}.tmp`);
  await rename(`${framePath}.tmp`, framePath);

  const content = await readFile(framePath);
  record.frame = {
    file: "frame.jpg",
    width: chosenRecord.width,
    height: chosenRecord.height,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  record.timing.frame_saved_at = now().toISOString();
  const meetsMinimum = chosenRecord.width >= options.minWidth && chosenRecord.height >= options.minHeight;
  record.status = meetsMinimum ? "captured" : "captured_degraded";
}
