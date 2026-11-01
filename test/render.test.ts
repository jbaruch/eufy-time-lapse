import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { ffmpegVersionLine, outputSize, render, RenderError, selectFrames } from "../src/render.ts";
import { State } from "../src/state.ts";
import type { CaptureRow } from "../src/state.ts";
import { storedMetadata, tempDir } from "./helpers/fixtures.ts";

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

describe("ffmpegVersionLine", () => {
  let dir: { path: string; remove: () => Promise<void> };

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  async function pathWithFfmpeg(name: string, body: string): Promise<NodeJS.ProcessEnv> {
    const stubs = join(dir.path, name);
    await mkdir(stubs);
    await writeFile(join(stubs, "ffmpeg"), `#!/bin/sh\n${body}\n`);
    await chmod(join(stubs, "ffmpeg"), 0o755);
    return { PATH: stubs };
  }

  it("reads the first line", async () => {
    assert.equal(await ffmpegVersionLine(await pathWithFfmpeg("works", 'echo "ffmpeg version 9.0.2"; echo "built with something"')), "ffmpeg version 9.0.2");
  });

  it("explains FFmpeg failing, as a render failure", async () => {
    const env = await pathWithFfmpeg("fails", 'echo "broken install" >&2; exit 3');
    await assert.rejects(ffmpegVersionLine(env), (error: Error) => error instanceof RenderError && /broken install/.test(error.message));
  });

  it("explains FFmpeg not being there", async () => {
    await assert.rejects(ffmpegVersionLine({ PATH: join(dir.path, "nothing-here") }), RenderError);
  });

  it("gives up on an FFmpeg that hangs, and says so", async () => {
    const env = await pathWithFfmpeg("hangs", "exec /bin/sleep 60");
    await assert.rejects(ffmpegVersionLine(env, 50), (error: Error) => error instanceof RenderError && /didn't answer within 50 ms/.test(error.message));
  });

  it("lets a bug on the way there through as itself", async () => {
    await assert.rejects(ffmpegVersionLine({ PATH: "a\0b" }), (error: Error) => error instanceof TypeError && !(error instanceof RenderError));
  });
});

describe("selectFrames", () => {
  it("takes scheduled frames at quality, and lists everything it leaves out", () => {
    const { selected, exclusions } = selectFrames([capture("1"), capture("2", { kind: "manual" }), capture("3", { quality_status: "degraded", width: 320, height: 180 })], { includeManual: false, includeDegraded: false, includeOffTarget: false, offTarget: new Set() });
    assert.deepEqual(selected.map((frame) => frame.capture_id), ["1"]);
    assert.deepEqual(exclusions, [
      { capture_id: "2", reason: "manual capture" },
      { capture_id: "3", reason: "below the required size: 320x180" },
    ]);
  });

  it("leaves out frames the framing check found off target, and says why", () => {
    const { selected, exclusions } = selectFrames([capture("1"), capture("2")], { includeManual: false, includeDegraded: false, includeOffTarget: false, offTarget: new Set(["2"]) });
    assert.deepEqual(selected.map((frame) => frame.capture_id), ["1"]);
    assert.deepEqual(exclusions, [{ capture_id: "2", reason: "the camera was pointing away from its saved position" }]);
  });

  it("takes off-target frames when asked", () => {
    const { selected, exclusions } = selectFrames([capture("2")], { includeManual: false, includeDegraded: false, includeOffTarget: true, offTarget: new Set(["2"]) });
    assert.equal(selected.length, 1);
    assert.deepEqual(exclusions, []);
  });

  it("takes them when asked", () => {
    const { selected, exclusions } = selectFrames([capture("2", { kind: "manual" }), capture("3", { quality_status: "degraded" })], { includeManual: true, includeDegraded: true, includeOffTarget: false, offTarget: new Set() });
    assert.equal(selected.length, 2);
    assert.deepEqual(exclusions, []);
  });
});

describe("outputSize", () => {
  it("never exceeds the smallest frame, and stays even for H.264", () => {
    assert.deepEqual(outputSize([capture("1", { width: 3840, height: 2160 }), capture("2", { width: 1281, height: 721 })]), { width: 1280, height: 720 });
  });
});

const OWNER = { projectId: "construction", cameraId: "site-overview" };
const frameDir = (id: string, date = "2026-07-01"): string => join("spool", OWNER.projectId, OWNER.cameraId, ...date.split("-"), id);

describe("render", () => {
  let dir: { path: string; remove: () => Promise<void> };
  let state: State;

  /** Writes a real frame, and answers what its record should say about it. */
  async function frame(id: string, width: number, height: number, date?: string): Promise<Partial<CaptureRow>> {
    const directory = join(dir.path, frameDir(id, date));
    await mkdir(directory, { recursive: true });
    const path = join(directory, "frame.jpg");
    await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=1`, "-frames:v", "1", "-update", "1", path]);
    const content = await readFile(path);
    return { jpeg_bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), relative_dir: frameDir(id, date) };
  }

  /** Stores a capture's record beside its frame and in the database, as the service does. */
  async function keep(target: State, row: CaptureRow): Promise<void> {
    const metadata = storedMetadata({ project_id: OWNER.projectId, camera_id: OWNER.cameraId, capture_id: row.capture_id, slot_id: row.slot_id, kind: row.kind, local_date: row.local_date, frame_received_at: row.frame_received_at, width: row.width, height: row.height, jpeg_bytes: row.jpeg_bytes, sha256: row.sha256, quality_status: row.quality_status, schedule_revision: row.slot_id === null ? null : "revision-one", scheduled_at_utc: row.slot_id === null ? null : "2026-05-01T13:00:00.000Z", every_minutes: row.slot_id === null ? null : 5 });
    await writeFile(join(dir.path, row.relative_dir, "metadata.json"), JSON.stringify(metadata));
    target.insertCapture(row);
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
      await keep(state, capture(id, await frame(id, 640, 360)));
    }
    await keep(state, capture("7", { ...(await frame("7", 320, 180)), quality_status: "degraded", width: 320, height: 180 }));
    await keep(state, capture("8", { ...(await frame("8", 640, 360)), kind: "manual", slot_id: null }));
    await keep(state, capture("9", { ...(await frame("9", 640, 360, "2026-07-02")), local_date: "2026-07-02", frame_received_at: "2026-07-02T13:00:00.000Z" }));
  });
  after(async () => {
    state.close();
    await dir.remove();
  });

  const base = { dataDir: "", owner: OWNER, from: "2026-07-01", to: "2026-07-01", fps: 30, includeManual: false, includeDegraded: false, includeOffTarget: false, now: () => new Date("2026-07-03T00:00:00Z") };

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

  it("leaves out a frame the framing check flagged, and keeps it when asked", async () => {
    const day = { local_date: "2026-07-03" };
    await keep(state, capture("10", { ...(await frame("10", 640, 360, "2026-07-03")), ...day, frame_received_at: "2026-07-03T13:00:00.000Z" }));
    await keep(state, capture("11", { ...(await frame("11", 640, 360, "2026-07-03")), ...day, frame_received_at: "2026-07-03T13:05:00.000Z" }));
    state.recordFramingCheck({ capture_id: "11", checked_at: "2026-07-03T13:05:01.000Z", status: "off_target", reference_capture_id: "10", dx: 400, dy: 0, detail: "test" });
    const range = { from: "2026-07-03", to: "2026-07-03" };
    const left = await render({ ...base, ...range, state, dataDir: dir.path, outputPath: join(dir.path, "renders", "on-target.mp4") });
    assert.deepEqual(left.inputs.map((input) => input.capture_id), ["10"]);
    assert.deepEqual(left.exclusions.map((exclusion) => exclusion.capture_id), ["11"]);
    const kept = await render({ ...base, ...range, state, dataDir: dir.path, outputPath: join(dir.path, "renders", "all.mp4"), includeOffTarget: true });
    assert.deepEqual(kept.inputs.map((input) => input.capture_id), ["10", "11"]);
  });

  it("explains an empty selection", async () => {
    await assert.rejects(render({ ...base, state, dataDir: dir.path, from: "2020-01-01", to: "2020-01-02", outputPath: join(dir.path, "renders", "none.mp4") }), (error: RenderError) => error instanceof RenderError && /No frames/.test(error.message));
  });

  it("reports FFmpeg failing as a render failure", async () => {
    await assert.rejects(render({ ...base, state, dataDir: dir.path, fps: Number.NaN, outputPath: join(dir.path, "renders", "bad-rate.mp4") }), RenderError);
  });

  it("lets a bug on the way to FFmpeg through as itself", async () => {
    const fps = "\0" as unknown as number;
    await assert.rejects(render({ ...base, state, dataDir: dir.path, fps, outputPath: join(dir.path, "renders", "bug.mp4") }), (error: Error) => error instanceof TypeError && !(error instanceof RenderError));
  });

  describe("an output path that lands on the service's own files", () => {
    const frameOne = () => join(dir.path, frameDir("1"), "frame.jpg");

    async function assertRefused(outputPath: string): Promise<void> {
      const before = await readFile(frameOne());
      const database = await readFile(join(dir.path, "state.sqlite"));
      await assert.rejects(render({ ...base, state, dataDir: dir.path, outputPath }), (error: RenderError) => error instanceof RenderError && /belongs to the service/.test(error.message));
      assert.deepEqual(await readFile(frameOne()), before);
      assert.deepEqual(await readFile(join(dir.path, "state.sqlite")), database);
      assert.deepEqual((await readdir(join(dir.path, frameDir("1")))).sort(), ["frame.jpg", "metadata.json"]);
    }

    it("refuses a frame", async () => {
      await assertRefused(frameOne());
    });

    it("refuses a new file in a frame's directory", async () => {
      await assertRefused(join(dir.path, frameDir("1"), "video.mp4"));
    });

    it("refuses the database", async () => {
      await assertRefused(join(dir.path, "state.sqlite"));
    });

    it("refuses a file at the top of the data directory", async () => {
      await assertRefused(join(dir.path, "video.mp4"));
    });

    it("refuses a path that climbs back out of renders", async () => {
      await assertRefused(join(dir.path, "renders", "..", frameDir("1"), "frame.jpg"));
    });

    it("refuses a symlink to a frame", async () => {
      await mkdir(join(dir.path, "renders"), { recursive: true });
      const link = join(dir.path, "renders", "link-to-frame.mp4");
      await symlink(frameOne(), link);
      await assertRefused(link);
    });

    it("refuses a symlink to nothing yet, which writing would create inside the spool", async () => {
      await mkdir(join(dir.path, "renders"), { recursive: true });
      const link = join(dir.path, "renders", "dangling.mp4");
      await symlink(join(dir.path, frameDir("1"), "not-yet.mp4"), link);
      await assertRefused(link);
    });

    it("refuses a path through a symlinked directory", async () => {
      await mkdir(join(dir.path, "renders"), { recursive: true });
      const link = join(dir.path, "renders", "link-to-spool");
      await symlink(join(dir.path, "spool"), link);
      await assertRefused(join(link, OWNER.projectId, OWNER.cameraId, "2026", "07", "01", "1", "frame.jpg"));
    });

    it("refuses when only the manifest beside the video would land there", async () => {
      await mkdir(join(dir.path, "renders"), { recursive: true });
      await symlink(frameOne(), join(dir.path, "renders", "sidecar.mp4.manifest.json"));
      await assertRefused(join(dir.path, "renders", "sidecar.mp4"));
    });

    it("still writes outside the data directory", async () => {
      const elsewhere = await tempDir();
      const outputPath = join(elsewhere.path, "video.mp4");
      const manifest = await render({ ...base, state, dataDir: dir.path, outputPath });
      assert.equal(manifest.frame_count, 6);
      await elsewhere.remove();
    });
  });

  describe("a frame that no longer matches its record", () => {
    let verified = 0;

    async function withBadFrame(arrange: (path: string, good: Partial<CaptureRow>) => Promise<void>): Promise<{ other: State; good: string }> {
      const other = new State(join(dir.path, `verify-${verified++}.sqlite`));
      const goodId = `good-${verified}`;
      await keep(other, capture(goodId, { ...(await frame(goodId, 640, 360)), frame_received_at: "2026-07-01T13:00:01.000Z" }));
      const badId = `bad-${verified}`;
      const facts = await frame(badId, 640, 360);
      await keep(other, capture(badId, { ...facts, frame_received_at: "2026-07-01T13:00:02.000Z" }));
      await arrange(join(dir.path, frameDir(badId), "frame.jpg"), facts);
      return { other, good: goodId };
    }

    async function editMetadata(framePath: string, change: Record<string, unknown>): Promise<void> {
      const path = join(dirname(framePath), "metadata.json");
      await writeFile(path, JSON.stringify({ ...(JSON.parse(await readFile(path, "utf8")) as object), ...change }));
    }

    let elsewhere: { path: string; remove: () => Promise<void> };
    const outside = (): string => elsewhere.path;
    before(async () => {
      elsewhere = await tempDir();
    });
    after(async () => {
      await elsewhere.remove();
    });

    const cases: Array<[string, (path: string, good: Partial<CaptureRow>) => Promise<void>, RegExp]> = [
      ["was deleted", async (path) => rm(path), /frame file is missing/],
      ["was replaced", async (path, good) => writeFile(path, Buffer.alloc(good.jpeg_bytes ?? 0, 7)), /frame file doesn't match/],
      ["was cut short", async (path) => writeFile(path, Buffer.alloc(10)), /frame file doesn't match/],
      ["has a directory in place of its frame", async (path) => { await rm(path); await mkdir(path); }, /frame file can't be read \(EISDIR\)/],
      ["lost its metadata", async (path) => rm(join(dirname(path), "metadata.json")), /metadata file is missing/],
      ["has metadata that isn't JSON", async (path) => writeFile(join(dirname(path), "metadata.json"), "{ nope"), /metadata file doesn't match/],
      ["has metadata from another project", async (path) => editMetadata(path, { project_id: "other-site" }), /metadata file doesn't match/],
      ["has metadata from another camera", async (path) => editMetadata(path, { camera_id: "other-camera" }), /metadata file doesn't match/],
      ["has metadata naming another slot", async (path) => editMetadata(path, { slot_id: "another-slot" }), /metadata file doesn't match/],
      ["has metadata claiming a retained frame", async (path) => editMetadata(path, { retained: true }), /metadata file doesn't match/],
      ["has metadata that's lost part of its record", async (path) => editMetadata(path, { source: undefined }), /metadata file doesn't match/],
      ["has metadata with another receive time", async (path) => editMetadata(path, { frame_received_at: "2026-07-01T13:00:09.000Z" }), /metadata file doesn't match/],
      ["has its frame linked in from elsewhere", async (path) => { const away = `${outside()}/frame-${verified}.jpg`; await rename(path, away); await symlink(away, path); }, /frame file leads outside/],
      ["has its metadata linked in from elsewhere", async (path) => { const here = join(dirname(path), "metadata.json"); const away = `${outside()}/metadata-${verified}.json`; await rename(here, away); await symlink(away, here); }, /metadata file leads outside/],
      ["has its directory linked in from elsewhere", async (path) => { const here = dirname(path); const away = `${outside()}/directory-${verified}`; await rename(here, away); await symlink(away, here); }, /leads outside/],
    ];
    for (const [name, arrange, reason] of cases) {
      it(`leaves one that ${name} out, lists why, and renders the rest`, async () => {
        const { other, good } = await withBadFrame(arrange);
        const outputPath = join(dir.path, "renders", `verify-${verified}.mp4`);
        const manifest = await render({ ...base, state: other, dataDir: dir.path, outputPath });
        assert.deepEqual(manifest.inputs.map((input) => input.capture_id), [good]);
        assert.equal(manifest.exclusions.length, 1);
        assert.match(manifest.exclusions[0]?.reason ?? "", reason);
        other.close();
      });
    }

    for (const [name, location] of [
      ["inside the data directory, but not where it belongs", (id: string) => join("copies", id)],
      ["outside the data directory", (id: string) => join("..", "copies-outside", id)],
      ["in another camera's place", (id: string) => join("spool", OWNER.projectId, "other-camera", "2026", "07", "01", id)],
    ] as const) {
      it(`leaves out a row recording a perfect copy ${name}`, async () => {
        const other = new State(join(dir.path, `verify-${verified++}.sqlite`));
        const goodId = `good-${verified}`;
        await keep(other, capture(goodId, { ...(await frame(goodId, 640, 360)), frame_received_at: "2026-07-01T13:00:01.000Z" }));
        const badId = `bad-${verified}`;
        const facts = await frame(badId, 640, 360);
        await keep(other, capture(badId, { ...facts, frame_received_at: "2026-07-01T13:00:02.000Z" }));
        const relative = location(badId);
        await cp(join(dir.path, frameDir(badId)), join(dir.path, relative), { recursive: true });
        new DatabaseSync(join(dir.path, `verify-${verified - 1}.sqlite`)).prepare("UPDATE captures SET relative_dir = ? WHERE capture_id = ?").run(relative, badId);
        const manifest = await render({ ...base, state: other, dataDir: dir.path, outputPath: join(dir.path, "renders", `verify-${verified}.mp4`) });
        assert.deepEqual(manifest.inputs.map((input) => input.capture_id), [goodId]);
        assert.match(manifest.exclusions[0]?.reason ?? "", /recorded location/);
        other.close();
      });
    }

    it("leaves out a row whose capture id would climb out of the spool", async () => {
      const other = new State(join(dir.path, `verify-${verified++}.sqlite`));
      const facts = await frame(`climb-${verified}`, 640, 360);
      const climbing = "../../../../../../../outside";
      other.insertCapture(capture(climbing, { ...facts, relative_dir: join(frameDir("x"), "..", climbing), frame_received_at: "2026-07-01T13:00:02.000Z" }));
      await assert.rejects(render({ ...base, state: other, dataDir: dir.path, outputPath: join(dir.path, "renders", `verify-${verified}.mp4`) }), /No frames/);
      other.close();
    });

    it("explains when nothing is left to render, and leaves the source files alone", async () => {
      const other = new State(join(dir.path, "only-bad.sqlite"));
      other.insertCapture(capture("missing", { relative_dir: "spool/not-there" }));
      await assert.rejects(render({ ...base, state: other, dataDir: dir.path, outputPath: join(dir.path, "renders", "broken.mp4") }), RenderError);
      other.close();
      await readFile(join(dir.path, frameDir("1"), "frame.jpg"));
    });
  });
});
