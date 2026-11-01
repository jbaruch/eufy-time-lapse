import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { CaptureFailure } from "../adapters/adapter.ts";
import type { AbortCause, CameraAdapter, CleanupResult, ConnectionPath, FailurePhase, FailureReason, LiveSession } from "../adapters/adapter.ts";
import { extractKeyframes, identifyStream, probeImage } from "../media/ffmpeg.ts";

export const TRAFFIC_BASIS = "media_payload_only: excludes P2P framing, encryption overhead, retransmits and connection setup";
/** Long enough for a keyframe already handed to the stream to reach the file. */
const KEYFRAME_FLUSH_MS = 200;

export const FRESHNESS_BASIS = "bytes received on a live P2P session opened for this attempt, written to this attempt's own file";

export interface AcquireOptions {
  adapter: CameraAdapter;
  cameraKey: string;
  outputDir: string;
  acquisitionTimeoutMs: number;
  cleanupTimeoutMs: number;
  /** Keyframes at the required size to collect before releasing the camera. */
  targetKeyframes: number;
  minWidth: number;
  minHeight: number;
  signal?: AbortSignal;
  now?: () => Date;
  /** Gets a teardown's failure after its timeout has passed, when nothing is left to reject to. By default it ends the process, as any bug should. */
  onLateFailure?: (error: Error) => void;
}

export type StreamStop = "target_reached" | "deadline" | "stream_ended";

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
  connection_path: ConnectionPath | null;
  /** Why the stream stopped: what was wanted arrived, time ran out, or the camera ended it. */
  stream_stop: StreamStop | null;
  audio_error: string | null;
  frame: { file: string; width: number; height: number; bytes: number; sha256: string } | null;
  keyframes: KeyframeRecord[];
  /** Keyframes that wouldn't decode, while others did. */
  keyframe_errors: string[];
}

interface StreamStats {
  firstMediaAt: Date | null;
  videoBytes: number;
  audioBytes: number;
  audioError: string | null;
  stop: StreamStop | null;
}

/**
 * Writes the live video to `path` until enough keyframes at the required size have arrived, the stream
 * ends, or the signal fires. A session starts low and steps up, so a fixed window would cost the 4K
 * frame on a slow path and waste battery on a fast one. A deadline with media in hand keeps what
 * arrived; it isn't a failure.
 */
function collectStream(
  session: LiveSession,
  path: string,
  target: { keyframes: number; minWidth: number; minHeight: number },
  signal: AbortSignal,
  now: () => Date,
): { stats: StreamStats; done: Promise<void> } {
  const stats: StreamStats = { firstMediaAt: null, videoBytes: 0, audioBytes: 0, audioError: null, stop: null };
  const done = new Promise<void>((resolve, reject) => {
    const sink = createWriteStream(path);
    let settled = false;
    let qualifyingKeyframes = 0;
    let flushTimer: NodeJS.Timeout | undefined;

    const finish = (stop: StreamStop | null, failure?: Error): void => {
      if (settled) return;
      settled = true;
      stats.stop = stop;
      clearTimeout(flushTimer);
      signal.removeEventListener("abort", onAbort);
      // The last write can fail too, and by then the error listener below is too late to change the outcome.
      sink.end((flushFailure?: Error | null) => {
        const outcome = failure ?? flushFailure;
        if (outcome === undefined || outcome === null) resolve();
        else reject(outcome);
      });
    };
    const onAbort = (): void => {
      const cause = signal.reason as AbortCause;
      if (cause === "terminated") {
        finish(null, new CaptureFailure("aborted", "first_media", "Stopped by a termination signal."));
      } else if (stats.firstMediaAt === null) {
        finish("deadline", new CaptureFailure("capture_timeout", "first_media", "The live stream started, but no video arrived before the attempt deadline."));
      } else {
        finish("deadline");
      }
    };
    const onStreamGone = (): void => {
      if (stats.firstMediaAt === null) {
        finish("stream_ended", new CaptureFailure("capture_timeout", "first_media", "The live stream ended before any video arrived."));
      } else {
        finish("stream_ended");
      }
    };

    session.onKeyframe((size) => {
      if (settled || flushTimer !== undefined) return;
      if (size.width < target.minWidth || size.height < target.minHeight) return;
      qualifyingKeyframes += 1;
      if (qualifyingKeyframes >= target.keyframes) flushTimer = setTimeout(() => finish("target_reached"), KEYFRAME_FLUSH_MS);
    });
    session.video.on("data", (chunk: Buffer) => {
      if (settled) return;
      stats.firstMediaAt ??= now();
      stats.videoBytes += chunk.length;
      sink.write(chunk);
    });
    session.video.once("end", onStreamGone);
    session.video.once("close", onStreamGone);
    session.video.once("error", (error: Error) => {
      finish("stream_ended", new CaptureFailure("capture_timeout", "first_media", `The video stream failed: ${error.message}`, { cause: error }));
    });
    session.audio.on("data", (chunk: Buffer) => {
      if (!settled) stats.audioBytes += chunk.length;
    });
    // Audio isn't part of the frame, so losing it doesn't fail the attempt. It still goes in the report.
    session.audio.once("error", (error: Error) => {
      stats.audioError = error.message;
    });
    sink.once("error", (error: Error) => finish(null, error));

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return { stats, done };
}

function crash(error: Error): void {
  setImmediate(() => {
    throw error;
  });
}

async function boundedTeardown(adapter: CameraAdapter, cameraKey: string, timeoutMs: number, onLateFailure: (error: Error) => void): Promise<CleanupResult> {
  let timer: NodeJS.Timeout | undefined;
  let decided = false;
  const timedOut = new Promise<CleanupResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout", detail: `teardown did not finish within ${timeoutMs} ms` }), timeoutMs);
  });
  // An adapter reports a teardown it understands as a result, so that fault can't cost the frame. A rejection is a bug.
  const attempted = adapter.teardown(cameraKey, timeoutMs);
  // The race below would quietly absorb a rejection that comes after the timeout has won.
  attempted.catch((error: Error) => {
    if (decided) onLateFailure(error);
  });
  try {
    return await Promise.race([attempted, timedOut]);
  } finally {
    decided = true;
    clearTimeout(timer);
  }
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
    const collecting = collectStream(session, streamPath, { keyframes: options.targetKeyframes, minWidth: options.minWidth, minHeight: options.minHeight }, controller.signal, now);
    stats = collecting.stats;
    await collecting.done;
  } catch (error) {
    if (!(error instanceof CaptureFailure)) throw error;
    failure = error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", onExternalAbort);
    cleanup = await boundedTeardown(options.adapter, options.cameraKey, options.cleanupTimeoutMs, options.onLateFailure ?? crash);
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
    connection_path: session?.connectionPath ?? null,
    stream_stop: stats?.stop ?? null,
    audio_error: stats?.audioError ?? null,
    frame: null,
    keyframes: [],
    keyframe_errors: [],
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

/**
 * The last keyframe at the stream's highest resolution. A cold start begins low and steps up, and the
 * latest frame has had the longest to settle, but it must not win if the camera stepped back down.
 */
export function chooseKeyframe(keyframes: KeyframeRecord[]): KeyframeRecord | undefined {
  const pixels = (keyframe: KeyframeRecord): number => keyframe.width * keyframe.height;
  return keyframes.reduce<KeyframeRecord | undefined>(
    (best, keyframe) => (best === undefined || pixels(keyframe) >= pixels(best) ? keyframe : best),
    undefined,
  );
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
  // Only the stream's first configuration, and the camera steps up from there. Replaced below by the chosen frame's size.
  record.video.actual_width = properties.width;
  record.video.actual_height = properties.height;

  const extracted = await extractKeyframes(streamPath, format, options.outputDir);
  record.keyframe_errors = extracted.errors;
  for (const path of extracted.paths) {
    const image = await probeImage(path);
    const { size } = await stat(path);
    record.keyframes.push({ file: basename(path), width: image.width, height: image.height, bytes: size });
  }

  const chosenRecord = chooseKeyframe(record.keyframes);
  if (chosenRecord === undefined) {
    throw new CaptureFailure("decode_failed", "decode", "FFmpeg returned no keyframes.");
  }
  record.video.actual_width = chosenRecord.width;
  record.video.actual_height = chosenRecord.height;

  const framePath = join(options.outputDir, "frame.jpg");
  await copyFile(join(options.outputDir, chosenRecord.file), `${framePath}.tmp`);
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
