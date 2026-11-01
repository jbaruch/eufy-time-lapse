import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { outputSize, render, RenderError, selectFrames } from "../src/render.ts";
import { State } from "../src/state.ts";
import type { CaptureRow } from "../src/state.ts";
import { tempDir } from "./helpers/fixtures.ts";

const run = promisify(execFile);

function capture(id: string, overrides: Partial<CaptureRow> = {}): CaptureRow {
  return {
    capture_id: id,
    slot_id: `slot-${id}`,
    kind: "scheduled",
    local_date: "2026-07-01",
    frame_received_at: `2026-07-01T13:00:${id.padStart(2, "0")}.000Z`,
    width: 640,
    height: 360,
    jpeg_bytes: 100,
    sha256: `hash-${id}`,
    quality_status: "ok",
    relative_dir: `spool/${id}`,
    archive_status: "not_configured",
    created_at: "2026-07-01T13:01:00.000Z",
    ...overrides,
  };
}

describe("selectFrames", () => {
  it("takes scheduled frames at quality, and lists everything it leaves out", () => {
    const { selected, exclusions } = selectFrames([capture("1"), capture("2", { kind: "manual" }), capture("3", { quality_status: "degraded", width: 320, height: 180 })], { includeManual: false, includeDegraded: false });
    assert.deepEqual(selected.map((frame) => frame.capture_id), ["1"]);
    assert.deepEqual(exclusions, [
      { capture_id: "2", reason: "manual capture" },
      { capture_id: "3", reason: "below the required size: 320x180" },
    ]);
  });

  it("takes them when asked", () => {
    const { selected, exclusions } = selectFrames([capture("2", { kind: "manual" }), capture("3", { quality_status: "degraded" })], { includeManual: true, includeDegraded: true });
    assert.equal(selected.length, 2);
    assert.deepEqual(exclusions, []);
  });
});

describe("outputSize", () => {
  it("never exceeds the smallest frame, and stays even for H.264", () => {
    assert.deepEqual(outputSize([capture("1", { width: 3840, height: 2160 }), capture("2", { width: 1281, height: 721 })]), { width: 1280, height: 720 });
  });
});

describe("render", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let state: State;

  async function frame(id: string, width: number, height: number): Promise<void> {
    const directory = join(dir.path, "spool", id);
    await mkdir(directory, { recursive: true });
    await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=1`, "-frames:v", "1", "-update", "1", join(directory, "frame.jpg")]);
  }

  async function probe(path: string): Promise<{ width: number; height: number; frames: number; duration: number; streams: number; codec: string }> {
    const { stdout } = await run("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames:format=duration", "-of", "json", path]);
    const parsed = JSON.parse(stdout) as { streams: Array<{ codec_name: string; width: number; height: number; nb_read_frames: string }>; format: { duration: string } };
    const video = parsed.streams[0];
    if (video === undefined) throw new Error("no stream");
    return { width: video.width, height: video.height, frames: Number(video.nb_read_frames), duration: Number(parsed.format.duration), streams: parsed.streams.length, codec: video.codec_name };
  }

  before(async () => {
    dir = await tempDir();
    state = new State(join(dir.path, "state.sqlite"));
    for (const id of ["1", "2", "3", "4", "5", "6"]) {
      await frame(id, 640, 360);
      state.insertCapture(capture(id));
    }
    await frame("7", 320, 180);
    state.insertCapture(capture("7", { quality_status: "degraded", width: 320, height: 180 }));
    await frame("8", 640, 360);
    state.insertCapture(capture("8", { kind: "manual", slot_id: null }));
    await frame("9", 640, 360);
    state.insertCapture(capture("9", { local_date: "2026-07-02", frame_received_at: "2026-07-02T13:00:00.000Z" }));
  });
  after(async () => {
    state.close();
    await dir.remove();
  });

  const base = { dataDir: "", from: "2026-07-01", to: "2026-07-01", fps: 30, includeManual: false, includeDegraded: false, now: () => new Date("2026-07-03T00:00:00Z") };

  it("builds a silent H.264 video at the frames' own size, and the duration the spec defines", async () => {
    const outputPath = join(dir.path, "renders", "plain.mp4");
    const manifest = await render({ ...base, state, dataDir: dir.path, outputPath });
    const video = await probe(outputPath);
    assert.equal(video.codec, "h264");
    assert.equal(video.streams, 1, "no audio");
    assert.deepEqual([video.width, video.height], [640, 360]);
    assert.equal(video.frames, 6);
    assert.ok(Math.abs(video.duration - 6 / 30) < 0.05, `duration ${video.duration}`);
    assert.equal(manifest.frame_count, 6);
    assert.deepEqual(manifest.transformations, ["format=yuv420p"], "matching frames are never rescaled");
  });

  it("writes a manifest with inputs in time order, exclusions, and the FFmpeg version", async () => {
    const outputPath = join(dir.path, "renders", "manifest.mp4");
    await render({ ...base, state, dataDir: dir.path, outputPath });
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, "utf8")) as { inputs: Array<{ capture_id: string }>; exclusions: Array<{ capture_id: string }>; ffmpeg_version: string; warnings: string[] };
    assert.deepEqual(manifest.inputs.map((input) => input.capture_id), ["1", "2", "3", "4", "5", "6"]);
    assert.deepEqual(manifest.exclusions.map((exclusion) => exclusion.capture_id).sort(), ["7", "8"]);
    assert.match(manifest.ffmpeg_version, /ffmpeg version/);
    assert.ok(manifest.warnings.some((warning) => warning.includes("2 frame(s) excluded")));
  });

  it("selects by site-local date", async () => {
    const outputPath = join(dir.path, "renders", "next-day.mp4");
    const manifest = await render({ ...base, state, dataDir: dir.path, from: "2026-07-02", to: "2026-07-02", outputPath });
    assert.deepEqual(manifest.inputs.map((input) => input.capture_id), ["9"]);
  });

  it("includes undersized frames only when asked, and warns that it scaled everything down", async () => {
    const outputPath = join(dir.path, "renders", "degraded.mp4");
    const manifest = await render({ ...base, state, dataDir: dir.path, outputPath, includeDegraded: true });
    const video = await probe(outputPath);
    assert.deepEqual([video.width, video.height], [320, 180]);
    assert.ok(manifest.warnings.some((warning) => warning.includes("below the required size")));
    assert.ok(manifest.warnings.some((warning) => warning.includes("scaled")));
  });

  it("explains an empty selection", async () => {
    await assert.rejects(render({ ...base, state, dataDir: dir.path, from: "2030-01-01", to: "2030-01-02", outputPath: join(dir.path, "renders", "none.mp4") }), (error: RenderError) => error instanceof RenderError && /No frames/.test(error.message));
  });

  it("fails loudly on a missing source frame, and leaves the others alone", async () => {
    const empty = new State(join(dir.path, "other.sqlite"));
    empty.insertCapture(capture("missing", { relative_dir: "spool/not-there" }));
    await assert.rejects(render({ ...base, state: empty, dataDir: dir.path, outputPath: join(dir.path, "renders", "broken.mp4") }), RenderError);
    empty.close();
    await writeFile(join(dir.path, "still-here"), "");
    await readFile(join(dir.path, "spool", "1", "frame.jpg"));
  });
});
