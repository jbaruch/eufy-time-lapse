import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { CaptureFailure } from "../src/adapters/adapter.ts";
import { GRAY_HEIGHT, GRAY_WIDTH } from "../src/framing.ts";
import { isToolFailure, probeImage, readGrayFrame } from "../src/media/ffmpeg.ts";
import { tempDir } from "./helpers/fixtures.ts";

const run = promisify(execFile);

async function failureOf(attempt: () => Promise<unknown>): Promise<unknown> {
  try {
    await attempt();
  } catch (error) {
    return error;
  }
  throw new Error("expected this to fail");
}

describe("isToolFailure", () => {
  const failures: Array<[string, () => Promise<unknown>]> = [
    ["a tool that can't start", async () => run("no-such-tool-anywhere", [])],
    ["a tool that exits badly", async () => run(process.execPath, ["-e", "process.exit(3)"])],
    ["a tool killed at its timeout", async () => run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 50, killSignal: "SIGKILL" })],
    ["a tool that says too much", async () => run(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { maxBuffer: 10 })],
  ];
  for (const [name, attempt] of failures) {
    it(`recognizes ${name}`, async () => {
      assert.equal(isToolFailure(await failureOf(attempt)), true);
    });
  }

  it("doesn't take a bug on the way to running a tool for one", async () => {
    assert.equal(isToolFailure(await failureOf(async () => run(process.execPath, ["a\0b"]))), false);
  });

  it("doesn't take any other error for one", () => {
    assert.equal(isToolFailure(new TypeError("x is not a function")), false);
    assert.equal(isToolFailure("a string"), false);
  });
});

describe("running a tool", () => {
  let dir: { path: string; remove: () => Promise<void> };

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  it("reports a tool that fails as a decode failure", async () => {
    await assert.rejects(probeImage(join(dir.path, "not-there.jpg")), (error: CaptureFailure) => error instanceof CaptureFailure && error.reason === "decode_failed");
  });

  it("lets a bug through as itself, not as a missed frame", async () => {
    await assert.rejects(probeImage("a\0b"), (error: Error) => error instanceof TypeError && !(error instanceof CaptureFailure));
  });
});

describe("readGrayFrame", () => {
  let dir: { path: string; remove: () => Promise<void> };

  before(async () => {
    dir = await tempDir();
  });
  after(async () => {
    await dir.remove();
  });

  it("shrinks a frame of any size to the comparison's size, in gray", async () => {
    const path = join(dir.path, "frame.jpg");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=white:s=640x360", "-frames:v", "1", "-update", "1", path]);
    const gray = await readGrayFrame(path);
    assert.equal(gray.length, GRAY_WIDTH * GRAY_HEIGHT);
    assert.ok((gray[0] ?? 0) > 200, "white stays bright");
  });

  it("calls a frame it can't read a decode failure", async () => {
    await assert.rejects(readGrayFrame(join(dir.path, "not-there.jpg")), (error: CaptureFailure) => error instanceof CaptureFailure && error.reason === "decode_failed");
  });

  it("lets a bug on the way there through as itself", async () => {
    await assert.rejects(readGrayFrame("a\0b"), (error: Error) => error instanceof TypeError && !(error instanceof CaptureFailure));
  });
});
