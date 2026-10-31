import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CaptureFailure } from "../adapters/adapter.ts";
import type { VideoCodecName } from "../adapters/adapter.ts";

const run = promisify(execFile);

const PROBE_TIMEOUT_MS = 15_000;
const DECODE_TIMEOUT_MS = 30_000;
const MAX_KEYFRAMES = 64;
const FORMAT_BY_CODEC = { h264: "h264", h265: "hevc" } as const;
type RawFormat = (typeof FORMAT_BY_CODEC)[keyof typeof FORMAT_BY_CODEC];

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

/** Decodes every keyframe in a raw stream to JPEG, at its actual resolution. Returns paths in stream order. */
export async function extractKeyframes(path: string, format: RawFormat, outputDir: string): Promise<string[]> {
  await runTool(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-skip_frame",
      "nokey",
      "-f",
      format,
      "-i",
      path,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      String(MAX_KEYFRAMES),
      "-q:v",
      "2",
      join(outputDir, "keyframe-%03d.jpg"),
    ],
    DECODE_TIMEOUT_MS,
  );
  const names = (await readdir(outputDir)).filter((name) => /^keyframe-\d+\.jpg$/.test(name)).sort();
  if (names.length === 0) {
    throw new CaptureFailure("decode_failed", "decode", `FFmpeg found no decodable keyframe in the stream. The raw stream is kept at ${path}.`);
  }
  return names.map((name) => join(outputDir, name));
}

export async function probeImage(path: string): Promise<StreamProperties> {
  const properties = await probeProperties(path, undefined);
  if (properties === undefined) {
    throw new CaptureFailure("decode_failed", "decode", `FFmpeg wrote an image it can't read back: ${path}`);
  }
  return properties;
}
