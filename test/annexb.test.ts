import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitKeyframes } from "../src/media/annexb.ts";

const CODE = [0, 0, 1];

/** An H.265 NAL unit. `first` sets first_slice_segment_in_pic_flag. `id` tells units apart in assertions. */
function hevc(type: number, id: number, first = true): Buffer {
  return Buffer.from([...CODE, type << 1, 1, first ? 0x80 : 0x00, id]);
}

/** An H.264 NAL unit. `first` sets first_mb_in_slice to 0. */
function h264(type: number, id: number, first = true): Buffer {
  return Buffer.from([...CODE, type, first ? 0x80 : 0x00, id]);
}

const [VPS, SPS, PPS, TRAIL, IDR, CRA, SEI] = [32, 33, 34, 1, 19, 21, 39] as const;

describe("splitKeyframes for H.265", () => {
  it("gives each keyframe its parameter sets and drops the frames in between", () => {
    const stream = Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(IDR, 4), hevc(TRAIL, 5), hevc(TRAIL, 6), hevc(VPS, 7), hevc(SPS, 8), hevc(PPS, 9), hevc(IDR, 10), hevc(TRAIL, 11)]);
    assert.deepEqual(splitKeyframes(stream, "hevc"), [
      Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(IDR, 4)]),
      Buffer.concat([hevc(VPS, 7), hevc(SPS, 8), hevc(PPS, 9), hevc(IDR, 10)]),
    ]);
  });

  it("carries parameter sets forward to a keyframe that repeats none", () => {
    const stream = Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(CRA, 4), hevc(TRAIL, 5), hevc(CRA, 6)]);
    assert.deepEqual(splitKeyframes(stream, "hevc")[1], Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(CRA, 6)]));
  });

  it("uses the new resolution's parameter sets after a step up, with none of the old ones", () => {
    const stream = Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(IDR, 4), hevc(VPS, 5), hevc(SPS, 6), hevc(PPS, 7), hevc(IDR, 8)]);
    const second = splitKeyframes(stream, "hevc")[1];
    assert.deepEqual(second, Buffer.concat([hevc(VPS, 5), hevc(SPS, 6), hevc(PPS, 7), hevc(IDR, 8)]));
  });

  it("replaces only the type that changed when a lone PPS arrives", () => {
    const stream = Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(IDR, 4), hevc(PPS, 5), hevc(IDR, 6)]);
    assert.deepEqual(splitKeyframes(stream, "hevc")[1], Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 5), hevc(IDR, 6)]));
  });

  it("keeps every parameter set of a type sent in the same run", () => {
    const stream = Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(PPS, 4), hevc(IDR, 5)]);
    assert.deepEqual(splitKeyframes(stream, "hevc"), [Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(PPS, 4), hevc(IDR, 5)])]);
  });

  it("keeps all the slices of one keyframe together", () => {
    const stream = Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(IDR, 4), hevc(IDR, 5, false), hevc(IDR, 6, false), hevc(TRAIL, 7)]);
    assert.deepEqual(splitKeyframes(stream, "hevc"), [Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(IDR, 4), hevc(IDR, 5, false), hevc(IDR, 6, false)])]);
  });

  it("doesn't let SEI between parameter sets and the slice split them up", () => {
    const stream = Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(SEI, 4), hevc(IDR, 5)]);
    assert.deepEqual(splitKeyframes(stream, "hevc"), [Buffer.concat([hevc(VPS, 1), hevc(SPS, 2), hevc(PPS, 3), hevc(IDR, 5)])]);
  });

  it("drops a keyframe that arrives before any parameter sets, since it can't decode", () => {
    const stream = Buffer.concat([hevc(IDR, 1), hevc(TRAIL, 2), hevc(VPS, 3), hevc(SPS, 4), hevc(PPS, 5), hevc(IDR, 6)]);
    assert.deepEqual(splitKeyframes(stream, "hevc"), [Buffer.concat([hevc(VPS, 3), hevc(SPS, 4), hevc(PPS, 5), hevc(IDR, 6)])]);
  });

  it("finds nothing in a stream with no keyframes, or no start codes", () => {
    assert.deepEqual(splitKeyframes(Buffer.concat([hevc(TRAIL, 1), hevc(TRAIL, 2)]), "hevc"), []);
    assert.deepEqual(splitKeyframes(Buffer.alloc(4096, 0x41), "hevc"), []);
    assert.deepEqual(splitKeyframes(Buffer.alloc(0), "hevc"), []);
  });
});

describe("splitKeyframes for H.264", () => {
  const [H264_SPS, H264_PPS, H264_IDR, H264_SLICE] = [7, 8, 5, 1] as const;

  it("reads H.264's NAL types and slice marker", () => {
    const stream = Buffer.concat([h264(H264_SPS, 1), h264(H264_PPS, 2), h264(H264_IDR, 3), h264(H264_IDR, 4, false), h264(H264_SLICE, 5), h264(H264_IDR, 6)]);
    assert.deepEqual(splitKeyframes(stream, "h264"), [
      Buffer.concat([h264(H264_SPS, 1), h264(H264_PPS, 2), h264(H264_IDR, 3), h264(H264_IDR, 4, false)]),
      Buffer.concat([h264(H264_SPS, 1), h264(H264_PPS, 2), h264(H264_IDR, 6)]),
    ]);
  });
});
