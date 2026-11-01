import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseReference, compareFrames, GRAY_HEIGHT, GRAY_WIDTH, judgeFraming } from "../src/framing.ts";
import type { FrameComparison } from "../src/framing.ts";

const FOUR_K_PIXELS_PER_GRAY_PIXEL = 8;
const TOLERANCE = 32;
const MINUTE = 60_000;

/** A fixed pattern from an integer hash, so every run compares the same pixels. Blocks like this have one best match. */
function hashed(x: number, y: number, seed: number): number {
  let h = (Math.floor(x / 5) * 73856093) ^ (Math.floor(y / 5) * 19349663) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) % 200;
}

function scene(seed: number, shiftX = 0, shiftY = 0): Uint8Array {
  const frame = new Uint8Array(GRAY_WIDTH * GRAY_HEIGHT);
  for (let y = 0; y < GRAY_HEIGHT; y += 1) {
    for (let x = 0; x < GRAY_WIDTH; x += 1) frame[y * GRAY_WIDTH + x] = 30 + hashed(x + shiftX, y + shiftY, seed);
  }
  return frame;
}

function flat(value: number): Uint8Array {
  return new Uint8Array(GRAY_WIDTH * GRAY_HEIGHT).fill(value);
}

const SITE = 12_345;
const ELSEWHERE = 98_765;

describe("compareFrames", () => {
  it("sees an unchanged view as all patches agreeing on no movement", () => {
    const result = compareFrames(scene(SITE), scene(SITE));
    assert.equal(result.agreeing, result.texturedPatches);
    assert.ok(result.agreeing >= 6);
    assert.deepEqual([result.dx, result.dy], [0, 0]);
    assert.equal(result.matchingInPlace, result.texturedPatches);
  });

  it("measures how far the view's content moved in the frame, in 4K pixels", () => {
    // A pattern sampled 10 to the right has moved 10 to the left in the frame.
    const result = compareFrames(scene(SITE), scene(SITE, 10, -4));
    assert.equal(result.dx, -10 * FOUR_K_PIXELS_PER_GRAY_PIXEL);
    assert.equal(result.dy, 4 * FOUR_K_PIXELS_PER_GRAY_PIXEL);
    assert.ok(result.agreeing >= 6);
  });

  it("doesn't care about a change of brightness or contrast", () => {
    const dimmer = scene(SITE).map((value) => Math.round(value * 0.6) + 15);
    const result = compareFrames(scene(SITE), dimmer);
    assert.deepEqual([result.dx, result.dy], [0, 0]);
    assert.ok(result.agreeing >= 6);
  });

  it("isn't fooled by something new covering part of the view", () => {
    const covered = scene(SITE);
    const truck = scene(ELSEWHERE);
    for (let y = 100; y < GRAY_HEIGHT; y += 1) {
      for (let x = 0; x < GRAY_WIDTH / 2; x += 1) covered[y * GRAY_WIDTH + x] = truck[y * GRAY_WIDTH + x] ?? 0;
    }
    const result = compareFrames(scene(SITE), covered);
    assert.deepEqual([result.dx, result.dy], [0, 0]);
    assert.ok(result.agreeing >= 3);
  });

  it("finds no agreement between two unrelated views", () => {
    const result = compareFrames(scene(SITE), scene(ELSEWHERE));
    assert.ok(result.agreeing < 3, `only ${result.agreeing} agreed`);
    assert.equal(result.matchingInPlace, 0);
    assert.ok(result.frameTexturedPatches >= 6);
  });

  it("counts a featureless frame as having nothing to compare", () => {
    const fog = compareFrames(scene(SITE), flat(128));
    assert.equal(fog.agreeing, 0);
    assert.equal(fog.frameTexturedPatches, 0);
    const blankReference = compareFrames(flat(128), scene(SITE));
    assert.equal(blankReference.texturedPatches, 0);
    assert.equal(blankReference.agreeing, 0);
  });

  it("reports how bright each frame is", () => {
    const result = compareFrames(flat(100), flat(150));
    assert.equal(result.referenceBrightness, 100);
    assert.equal(result.frameBrightness, 150);
  });

  it("refuses frames of the wrong size rather than comparing nonsense", () => {
    assert.throws(() => compareFrames(new Uint8Array(10), scene(SITE)), /480x270/);
    assert.throws(() => compareFrames(scene(SITE), new Uint8Array(10)), /480x270/);
  });
});

describe("judgeFraming", () => {
  const measured: FrameComparison = { texturedPatches: 12, agreeing: 12, dx: 0, dy: 0, matchingInPlace: 12, frameTexturedPatches: 12, referenceBrightness: 110, frameBrightness: 112 };
  const noMatch: FrameComparison = { texturedPatches: 12, agreeing: 1, dx: 0, dy: 0, matchingInPlace: 0, frameTexturedPatches: 12, referenceBrightness: 110, frameBrightness: 112 };
  const recent = { referenceAgeMs: 5 * MINUTE, tolerancePixels: TOLERANCE };

  it("calls agreement within the tolerance on target", () => {
    assert.equal(judgeFraming(measured, recent).status, "on_target");
    assert.equal(judgeFraming({ ...measured, dx: 16, dy: 8 }, recent).status, "on_target");
  });

  it("treats the tolerance as a distance, not one axis at a time", () => {
    assert.equal(judgeFraming({ ...measured, dx: 32, dy: 0 }, recent).status, "on_target");
    assert.equal(judgeFraming({ ...measured, dx: 32, dy: 32 }, recent).status, "off_target");
  });

  it("calls agreement on a real shift off target, and says how far", () => {
    const verdict = judgeFraming({ ...measured, agreeing: 4, dx: -48, dy: 0 }, recent);
    assert.equal(verdict.status, "off_target");
    assert.deepEqual([verdict.dx, verdict.dy], [-48, 0]);
  });

  it("trusts a measured shift however old the reference is", () => {
    assert.equal(judgeFraming({ ...measured, dx: 80, dy: 0 }, { ...recent, referenceAgeMs: 24 * 60 * MINUTE }).status, "off_target");
  });

  it("needs three patches to agree before believing a shift", () => {
    assert.equal(judgeFraming({ ...measured, agreeing: 3, dx: 80 }, recent).status, "off_target");
    assert.equal(judgeFraming({ ...measured, agreeing: 2, dx: 80, matchingInPlace: 1 }, recent).status, "unsure");
  });

  it("calls a recent, similar frame with nothing in common off target: that's a far pan", () => {
    const verdict = judgeFraming(noMatch, recent);
    assert.equal(verdict.status, "off_target");
    assert.deepEqual([verdict.dx, verdict.dy], [null, null]);
  });

  it("is only unsure about the same mismatch across a long gap, because dusk and dawn look like it too", () => {
    assert.equal(judgeFraming(noMatch, { ...recent, referenceAgeMs: 30 * MINUTE }).status, "off_target");
    assert.equal(judgeFraming(noMatch, { ...recent, referenceAgeMs: 31 * MINUTE }).status, "unsure");
  });

  it("is unsure when the light has changed, because that can look like a far pan", () => {
    assert.equal(judgeFraming({ ...noMatch, frameBrightness: 143 }, recent).status, "off_target");
    assert.equal(judgeFraming({ ...noMatch, frameBrightness: 144 }, recent).status, "unsure");
    assert.equal(judgeFraming({ ...noMatch, frameBrightness: 76 }, recent).status, "unsure");
  });

  it("is unsure when some patches still match in place", () => {
    assert.equal(judgeFraming({ ...noMatch, matchingInPlace: 1 }, recent).status, "unsure");
  });

  it("is unsure about a frame with too little in it, like fog or a dark night", () => {
    assert.equal(judgeFraming({ ...noMatch, frameTexturedPatches: 5 }, recent).status, "unsure");
    assert.equal(judgeFraming({ ...noMatch, texturedPatches: 5 }, recent).status, "unsure");
  });
});

describe("chooseReference", () => {
  const frame = (at: string): { frame_received_at: string } => ({ frame_received_at: at });

  it("takes the last good frame when it's recent", () => {
    const chosen = chooseReference([frame("2026-11-03T14:00:00.000Z"), frame("2026-11-03T14:55:00.000Z"), frame("2026-11-03T14:50:00.000Z")], new Date("2026-11-03T15:00:00.000Z"));
    assert.equal(chosen?.frame_received_at, "2026-11-03T14:55:00.000Z");
  });

  it("goes by the time of day across a night, so morning isn't judged against dusk", () => {
    const yesterday = [frame("2026-11-02T13:05:00.000Z"), frame("2026-11-02T18:00:00.000Z"), frame("2026-11-02T23:55:00.000Z")];
    assert.equal(chooseReference(yesterday, new Date("2026-11-03T13:00:00.000Z"))?.frame_received_at, "2026-11-02T13:05:00.000Z");
  });

  it("prefers the newest of two days at the same time of day", () => {
    const days = [frame("2026-11-01T13:00:00.000Z"), frame("2026-11-02T13:00:00.000Z")];
    assert.equal(chooseReference(days, new Date("2026-11-03T13:00:00.000Z"))?.frame_received_at, "2026-11-02T13:00:00.000Z");
  });

  it("treats the clock as a circle", () => {
    const days = [frame("2026-11-02T23:58:00.000Z"), frame("2026-11-02T12:00:00.000Z")];
    assert.equal(chooseReference(days, new Date("2026-11-03T00:05:00.000Z"))?.frame_received_at, "2026-11-02T23:58:00.000Z");
  });

  it("never compares a frame with itself or anything later", () => {
    const at = "2026-11-03T15:00:00.000Z";
    assert.equal(chooseReference([frame(at), frame("2026-11-03T15:05:00.000Z")], new Date(at)), undefined);
  });

  it("has nothing to offer with no good frames", () => {
    assert.equal(chooseReference([], new Date("2026-11-03T15:00:00.000Z")), undefined);
  });
});
