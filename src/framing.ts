/** Frames are compared small: a pan moves thousands of pixels at 4K, and the tolerance is far coarser than one small pixel. */
export const GRAY_WIDTH = 480;
export const GRAY_HEIGHT = 270;
const FOUR_K_PIXELS_PER_GRAY_PIXEL = 3840 / GRAY_WIDTH;

const PATCH_WIDTH = 48;
const PATCH_HEIGHT = 36;
const PATCH_STEP = 2;
/** The trees and the ground, not the sky, whose clouds match nothing five minutes later. */
const PATCH_COLUMNS = [70, 190, 310, 410];
const PATCH_ROWS = [80, 130, 185];
const REACH_X = 120;
const REACH_Y = 70;
/** Below this a patch is sky, fog or night, and any match in it means nothing. */
const MIN_PATCH_DEVIATION = 6;
const MIN_MATCH_SCORE = 0.6;
const MIN_IN_PLACE_SCORE = 0.5;
const AGREEMENT_RADIUS = 2;
/** Nothing on 193 real pairs of frames, hours apart or not, produced a false shift with this many patches behind it. */
const MIN_AGREEING = 3;
const MIN_PATCHES_TO_JUDGE = 6;
/** Real frames with no match between them turned up only across long gaps, night to day, so a mismatch needs a recent reference. */
const MISMATCH_MAX_REFERENCE_AGE_MS = 30 * 60_000;
const MISMATCH_MAX_BRIGHTNESS_CHANGE = 0.3;

export interface FrameComparison {
  /** Patches in the reference with enough detail to match. */
  texturedPatches: number;
  /** Patches in the frame with enough detail to match. */
  frameTexturedPatches: number;
  /** The largest group of patches that found the same shift. */
  agreeing: number;
  /** That group's shift, in 4K pixels. */
  dx: number;
  dy: number;
  /** Patches that still match with no shift at all. */
  matchingInPlace: number;
  referenceBrightness: number;
  frameBrightness: number;
}

export type FramingStatus = "on_target" | "off_target" | "unsure";

export interface FramingVerdict {
  status: FramingStatus;
  /** How far, in 4K pixels. Null when the view has moved too far to measure, or nothing could be measured. */
  dx: number | null;
  dy: number | null;
  detail: string;
}

interface PatchMatch {
  dx: number;
  dy: number;
  score: number;
  inPlaceScore: number;
}

function patchDeviation(image: Uint8Array, left: number, top: number): number {
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = top; y < top + PATCH_HEIGHT; y += PATCH_STEP) {
    for (let x = left; x < left + PATCH_WIDTH; x += PATCH_STEP) {
      const value = image[y * GRAY_WIDTH + x] ?? 0;
      sum += value;
      squares += value * value;
      count += 1;
    }
  }
  return Math.sqrt(Math.max(squares / count - (sum / count) ** 2, 0));
}

/** Normalized correlation, so a change of light moves the score far less than a change of view does. */
function bestMatch(reference: Uint8Array, frame: Uint8Array, left: number, top: number): PatchMatch {
  const offsets: number[] = [];
  const values: number[] = [];
  let sum = 0;
  for (let y = top; y < top + PATCH_HEIGHT; y += PATCH_STEP) {
    for (let x = left; x < left + PATCH_WIDTH; x += PATCH_STEP) {
      const value = reference[y * GRAY_WIDTH + x] ?? 0;
      offsets.push(y * GRAY_WIDTH + x);
      values.push(value);
      sum += value;
    }
  }
  const count = values.length;
  const mean = sum / count;
  const centered = Float64Array.from(values, (value) => value - mean);
  const positions = Int32Array.from(offsets);
  let energy = 0;
  for (let i = 0; i < count; i += 1) energy += (centered[i] as number) ** 2;

  const best: PatchMatch = { dx: 0, dy: 0, score: -2, inPlaceScore: 0 };
  for (let dy = Math.max(-REACH_Y, -top); dy <= Math.min(REACH_Y, GRAY_HEIGHT - PATCH_HEIGHT - top); dy += 1) {
    for (let dx = Math.max(-REACH_X, -left); dx <= Math.min(REACH_X, GRAY_WIDTH - PATCH_WIDTH - left); dx += 1) {
      const shift = dy * GRAY_WIDTH + dx;
      let frameSum = 0;
      let frameSquares = 0;
      let product = 0;
      for (let i = 0; i < count; i += 1) {
        const value = frame[(positions[i] as number) + shift] as number;
        frameSum += value;
        frameSquares += value * value;
        product += (centered[i] as number) * value;
      }
      const frameEnergy = frameSquares - (frameSum * frameSum) / count;
      const score = frameEnergy > 0 ? product / Math.sqrt(energy * frameEnergy) : 0;
      if (dx === 0 && dy === 0) best.inPlaceScore = score;
      if (score > best.score) {
        best.score = score;
        best.dx = dx;
        best.dy = dy;
      }
    }
  }
  return best;
}

function brightness(image: Uint8Array): number {
  let sum = 0;
  for (const value of image) sum += value;
  return Math.round(sum / image.length);
}

/** The biggest group wins, and between equal groups the smaller shift, since a camera that hasn't moved is the usual case. */
function largestAgreement(matches: PatchMatch[]): PatchMatch[] {
  let largest: PatchMatch[] = [];
  let largestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of matches) {
    const group = matches.filter((other) => Math.abs(other.dx - candidate.dx) <= AGREEMENT_RADIUS && Math.abs(other.dy - candidate.dy) <= AGREEMENT_RADIUS);
    const distance = Math.hypot(candidate.dx, candidate.dy);
    if (group.length > largest.length || (group.length === largest.length && distance < largestDistance)) {
      largest = group;
      largestDistance = distance;
    }
  }
  return largest;
}

/** Takes two frames as GRAY_WIDTH x GRAY_HEIGHT gray pixels. Measures only: judgeFraming decides what the numbers mean. */
export function compareFrames(reference: Uint8Array, frame: Uint8Array): FrameComparison {
  for (const image of [reference, frame]) {
    if (image.length !== GRAY_WIDTH * GRAY_HEIGHT) throw new Error(`A frame to compare must be ${GRAY_WIDTH}x${GRAY_HEIGHT} gray pixels, and this one has ${image.length}.`);
  }
  const matches: PatchMatch[] = [];
  let texturedPatches = 0;
  let frameTexturedPatches = 0;
  for (const top of PATCH_ROWS) {
    for (const left of PATCH_COLUMNS) {
      if (patchDeviation(frame, left, top) >= MIN_PATCH_DEVIATION) frameTexturedPatches += 1;
      if (patchDeviation(reference, left, top) < MIN_PATCH_DEVIATION) continue;
      texturedPatches += 1;
      matches.push(bestMatch(reference, frame, left, top));
    }
  }
  const agreement = largestAgreement(matches.filter((match) => match.score >= MIN_MATCH_SCORE));
  const average = (pick: (match: PatchMatch) => number): number => (agreement.length === 0 ? 0 : Math.round(agreement.reduce((sum, match) => sum + pick(match), 0) / agreement.length) * FOUR_K_PIXELS_PER_GRAY_PIXEL);
  return {
    texturedPatches,
    frameTexturedPatches,
    agreeing: agreement.length,
    dx: average((match) => match.dx),
    dy: average((match) => match.dy),
    matchingInPlace: matches.filter((match) => match.inPlaceScore >= MIN_IN_PLACE_SCORE).length,
    referenceBrightness: brightness(reference),
    frameBrightness: brightness(frame),
  };
}

/** Off target moves a motor, so anything short of good evidence is unsure, and unsure does nothing. */
export function judgeFraming(comparison: FrameComparison, context: { referenceAgeMs: number; tolerancePixels: number }): FramingVerdict {
  const { agreeing, dx, dy, texturedPatches, frameTexturedPatches, matchingInPlace, referenceBrightness, frameBrightness } = comparison;
  if (agreeing >= MIN_AGREEING) {
    const moved = Math.hypot(dx, dy);
    if (moved <= context.tolerancePixels) return { status: "on_target", dx, dy, detail: `${agreeing} areas agree the view is within ${Math.round(moved)} pixels` };
    return { status: "off_target", dx, dy, detail: `${agreeing} areas agree the view moved ${Math.round(moved)} pixels` };
  }
  const brightnessChange = Math.abs(frameBrightness - referenceBrightness) / Math.max(referenceBrightness, 1);
  const enoughDetail = texturedPatches >= MIN_PATCHES_TO_JUDGE && frameTexturedPatches >= MIN_PATCHES_TO_JUDGE;
  const sameLight = context.referenceAgeMs <= MISMATCH_MAX_REFERENCE_AGE_MS && brightnessChange <= MISMATCH_MAX_BRIGHTNESS_CHANGE;
  if (enoughDetail && sameLight && matchingInPlace === 0) return { status: "off_target", dx: null, dy: null, detail: "nothing in this frame matches the last good one, taken in similar light" };
  return { status: "unsure", dx: null, dy: null, detail: `only ${agreeing} areas agree, and ${matchingInPlace} match in place, which isn't enough to say` };
}

const MINUTES_PER_DAY = 1440;

function minutesApartOnTheClock(a: Date, b: Date): number {
  const minutes = (date: Date): number => date.getUTCHours() * 60 + date.getUTCMinutes();
  const apart = Math.abs(minutes(a) - minutes(b));
  return Math.min(apart, MINUTES_PER_DAY - apart);
}

/**
 * What to compare a frame with: the last good frame if it's recent, since that's the closest in light and in what's been
 * built. Otherwise the good frame nearest this time of day, so the first frame of a morning isn't judged against the last,
 * dark one of the evening before.
 */
export function chooseReference<T extends { frame_received_at: string }>(candidates: readonly T[], at: Date): T | undefined {
  const earlier = candidates.filter((candidate) => Date.parse(candidate.frame_received_at) < at.getTime());
  const newestFirst = [...earlier].sort((a, b) => Date.parse(b.frame_received_at) - Date.parse(a.frame_received_at));
  const newest = newestFirst[0];
  if (newest === undefined || at.getTime() - Date.parse(newest.frame_received_at) <= MISMATCH_MAX_REFERENCE_AGE_MS) return newest;
  let closest = newest;
  let closestApart = Number.POSITIVE_INFINITY;
  for (const candidate of newestFirst) {
    const apart = minutesApartOnTheClock(new Date(candidate.frame_received_at), at);
    if (apart < closestApart) {
      closest = candidate;
      closestApart = apart;
    }
  }
  return closest;
}
