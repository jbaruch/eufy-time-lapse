import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CaptureFailure } from "../adapters/adapter.ts";
import type { VideoCodecName } from "../adapters/adapter.ts";
import { splitKeyframes } from "./annexb.ts";
import type { RawFormat } from "./annexb.ts";

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 15_000;
const DECODE_TIMEOUT_MS = 30_000;
const MAX_KEYFRAMES = 64;

export interface StreamProperties {
  codec: string;
  width: number;
  height: number;
}

interface ExecFailure extends Error {
  code?: string | number;
  killed?: boolean;
  stderr?: string;
}

async function runTool(tool: "ffmpeg" | "ffprobe", args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await run(tool, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const failure = error as ExecFailure;
    if (failure.code === "ENOENT") {
      throw new Error(`${tool} is not installed or not on PATH. Install FFmpeg and run this again.`, { cause: error });
    }
    const detail = failure.killed === true ? `timed out after ${timeoutMs} ms` : (failure.stderr ?? failure.message).trim();
    throw new CaptureFailure("decode_failed", "decode", `${tool} failed: ${detail}`, { cause: error });
  }
}

async function probeProperties(path: string, format: RawFormat | undefined): Promise<StreamProperties | undefined> {
  const args = ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json"];
  if (format !== undefined) args.push("-f", format);
  args.push(path);
  const stdout = await runTool("ffprobe", args, PROBE_TIMEOUT_MS);
  const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_name?: string; width?: number; height?: number }> };
  const stream = parsed.streams?.[0];
  if (stream?.codec_name === undefined || !stream.width || !stream.height) return undefined;
  return { codec: stream.codec_name, width: stream.width, height: stream.height };
}

/** Probes a raw stream as `hint` first, then as the other codec. The camera's stated codec isn't trusted. */
export async function identifyStream(
  path: string,
  hint: VideoCodecName,
): Promise<{ format: RawFormat; properties: StreamProperties }> {
  const order: RawFormat[] = hint === "h264" ? ["h264", "hevc"] : ["hevc", "h264"];
  const tried: string[] = [];
  for (const format of order) {
    try {
      const properties = await probeProperties(path, format);
      if (properties !== undefined) return { format, properties };
      tried.push(`${format}: no video stream found`);
    } catch (error) {
      if (!(error instanceof CaptureFailure)) throw error;
      tried.push(`${format}: ${error.message}`);
    }
  }
  throw new CaptureFailure("decode_failed", "decode", `Could not identify the camera's video stream (${tried.join("; ")}). The raw stream is kept at ${path}.`);
}

export interface ExtractedKeyframes {
  /** JPEG paths in stream order, each at the keyframe's own resolution. */
  paths: string[];
  /** Keyframes that wouldn't decode, while others did. */
  errors: string[];
}

/**
 * Decodes every keyframe in a raw stream to JPEG, one FFmpeg run per keyframe. The camera starts low and
 * steps up mid-stream, and one FFmpeg output can't follow: it scales to the first frame's size, and with
 * -noautoscale it still writes that size. A run per keyframe means nothing is ever rescaled.
 */
export async function extractKeyframes(path: string, format: RawFormat, outputDir: string): Promise<ExtractedKeyframes> {
  const units = splitKeyframes(await readFile(path), format).slice(-MAX_KEYFRAMES);
  const paths: string[] = [];
  const errors: string[] = [];

  for (const [index, unit] of units.entries()) {
    const name = `keyframe-${String(index + 1).padStart(3, "0")}`;
    const unitPath = join(outputDir, `${name}.${format}`);
    const imagePath = join(outputDir, `${name}.jpg`);
    await writeFile(unitPath, unit);
    try {
      await runTool(
        "ffmpeg",
        ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", format, "-i", unitPath, "-frames:v", "1", "-update", "1", "-q:v", "2", imagePath],
        DECODE_TIMEOUT_MS,
      );
      paths.push(imagePath);
    } catch (error) {
      if (!(error instanceof CaptureFailure)) throw error;
      errors.push(`${name}: ${error.message}`);
    } finally {
      await rm(unitPath, { force: true });
    }
  }

  if (paths.length === 0) {
    const detail = errors.length > 0 ? errors.join("; ") : "the stream holds no keyframe with parameter sets";
    throw new CaptureFailure("decode_failed", "decode", `No keyframe decoded (${detail}). The raw stream is kept at ${path}.`);
  }
  return { paths, errors };
}

export async function probeImage(path: string): Promise<StreamProperties> {
  const properties = await probeProperties(path, undefined);
  if (properties === undefined) {
    throw new CaptureFailure("decode_failed", "decode", `FFmpeg wrote an image it can't read back: ${path}`);
  }
  return properties;
}
