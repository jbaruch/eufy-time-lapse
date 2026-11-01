import { execFile } from "node:child_process";
import { mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isToolFailure } from "./media/ffmpeg.ts";
import type { CaptureRow, State } from "./state.ts";
import { storedCaptureProblem } from "./stored-capture.ts";
import type { CaptureOwner } from "./stored-capture.ts";

const run = promisify(execFile);

const SECONDS_PER_FRAME_BUDGET = 2;
const MINIMUM_TIMEOUT_MS = 120_000;

export class RenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RenderError";
  }
}

export interface RenderOptions {
  state: State;
  dataDir: string;
  owner: CaptureOwner;
  from: string;
  to: string;
  outputPath: string;
  fps: number;
  includeManual: boolean;
  /** Takes frames below the required size too, which pulls the whole video down to the smallest one. */
  includeDegraded: boolean;
  now: () => Date;
}

export interface RenderManifest {
  schema_version: 1;
  rendered_at: string;
  from: string;
  to: string;
  output: string;
  fps: number;
  width: number;
  height: number;
  frame_count: number;
  duration_seconds: number;
  ffmpeg_version: string;
  transformations: string[];
  warnings: string[];
  inputs: Array<{ capture_id: string; slot_id: string | null; frame_received_at: string; quality_status: string; width: number; height: number; sha256: string }>;
  exclusions: Array<{ capture_id: string; reason: string }>;
}

export function selectFrames(captures: CaptureRow[], options: { includeManual: boolean; includeDegraded: boolean }): { selected: CaptureRow[]; exclusions: RenderManifest["exclusions"] } {
  const selected: CaptureRow[] = [];
  const exclusions: RenderManifest["exclusions"] = [];
  for (const capture of captures) {
    if (capture.kind === "manual" && !options.includeManual) exclusions.push({ capture_id: capture.capture_id, reason: "manual capture" });
    else if (capture.quality_status !== "ok" && !options.includeDegraded) exclusions.push({ capture_id: capture.capture_id, reason: `below the required size: ${capture.width}x${capture.height}` });
    else selected.push(capture);
  }
  return { selected, exclusions };
}

/** Never upscales, and never rescales at all when the frames agree. Odd sizes round down because H.264 needs even ones. */
export function outputSize(frames: CaptureRow[]): { width: number; height: number } {
  const even = (value: number): number => value - (value % 2);
  return { width: even(Math.min(...frames.map((frame) => frame.width))), height: even(Math.min(...frames.map((frame) => frame.height))) };
}

function concatQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** The database's word about a frame is only a record of it. A replaced or damaged capture must not go into a video under the original's name. */
async function verifyFrames(chosen: ReturnType<typeof selectFrames>, options: RenderOptions): Promise<ReturnType<typeof selectFrames>> {
  const selected: CaptureRow[] = [];
  const exclusions = [...chosen.exclusions];
  for (const frame of chosen.selected) {
    const problem = await storedCaptureProblem(options.dataDir, frame, options.owner);
    if (problem === null) selected.push(frame);
    else exclusions.push({ capture_id: frame.capture_id, reason: problem });
  }
  return { selected, exclusions };
}

/** Where writing to a path would really land, following symlinks, including one that points at nothing yet. */
async function whereItLeads(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  if (parent === path) return path;
  let target: string;
  try {
    target = await readlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await whereItLeads(parent), basename(path));
  }
  return whereItLeads(resolve(await whereItLeads(parent), target));
}

/** FFmpeg overwrites its output, so a path that lands on a frame or the database would destroy it. Inside the data directory, only renders/ is a render's. */
async function refuseServiceFiles(paths: string[], dataDir: string): Promise<void> {
  const root = await whereItLeads(resolve(dataDir));
  const renders = join(root, "renders");
  for (const path of paths) {
    const target = await whereItLeads(resolve(path));
    if ((target === root || target.startsWith(`${root}${sep}`)) && !target.startsWith(`${renders}${sep}`)) {
      throw new RenderError(`Refusing to write ${path}: it lands on ${target}, which belongs to the service. Nothing was changed. Pick a file under ${renders}, or outside ${root}.`);
    }
  }
}

/** Builds a video purely from stored frames: no camera contact, and source frames stay untouched. Missing slots compress away. */
export async function render(options: RenderOptions): Promise<RenderManifest> {
  const listPath = `${options.outputPath}.frames.txt`;
  const manifestPath = `${options.outputPath}.manifest.json`;
  await refuseServiceFiles([options.outputPath, listPath, manifestPath], options.dataDir);

  const chosen = selectFrames(options.state.capturesBetween(options.from, options.to), options);
  const { selected, exclusions } = await verifyFrames(chosen, options);
  if (selected.length === 0) {
    throw new RenderError(`No frames to render between ${options.from} and ${options.to} (${exclusions.length} excluded). Check the dates, or use --include-degraded.`);
  }
  const { width, height } = outputSize(selected);
  const lines = selected.map((frame) => `file ${concatQuote(join(options.dataDir, frame.relative_dir, "frame.jpg"))}`);

  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(listPath, `${lines.join("\n")}\n`);

  const needsScaling = selected.some((frame) => frame.width !== width || frame.height !== height);
  const filters = needsScaling ? [`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, "format=yuv420p"] : ["format=yuv420p"];
  const timeout = Math.max(MINIMUM_TIMEOUT_MS, selected.length * SECONDS_PER_FRAME_BUDGET * 1000);

  try {
    await run(
      "ffmpeg",
      // One input frame is exactly one video frame: a constant input rate, with nothing resampled afterwards.
      ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-r", String(options.fps), "-f", "concat", "-safe", "0", "-i", listPath, "-vf", filters.join(","), "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-an", "-movflags", "+faststart", options.outputPath],
      { timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (error) {
    if (!isToolFailure(error)) throw error;
    throw new RenderError(`FFmpeg failed to render ${options.outputPath}: ${error.stderr?.trim() || error.message}. The source frames are untouched.`, { cause: error });
  }

  const { stdout } = await run("ffmpeg", ["-hide_banner", "-version"]);
  const degraded = selected.filter((frame) => frame.quality_status !== "ok");
  const warnings: string[] = [];
  if (degraded.length > 0) warnings.push(`${degraded.length} frame(s) below the required size are included`);
  if (needsScaling) warnings.push(`frames differ in size, so all of them were scaled to ${width}x${height}`);
  if (exclusions.length > 0) warnings.push(`${exclusions.length} frame(s) excluded; see exclusions`);

  const manifest: RenderManifest = {
    schema_version: 1,
    rendered_at: options.now().toISOString(),
    from: options.from,
    to: options.to,
    output: options.outputPath,
    fps: options.fps,
    width,
    height,
    frame_count: selected.length,
    duration_seconds: selected.length / options.fps,
    ffmpeg_version: stdout.split("\n")[0] ?? "unknown",
    transformations: filters,
    warnings,
    inputs: selected.map((frame) => ({ capture_id: frame.capture_id, slot_id: frame.slot_id, frame_received_at: frame.frame_received_at, quality_status: frame.quality_status, width: frame.width, height: frame.height, sha256: frame.sha256 })),
    exclusions,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
