export type RawFormat = "h264" | "hevc";

const START_CODE = Buffer.from([0, 0, 1]);

interface NalClass {
  parameterSet: boolean;
  /** Carries picture data. */
  slice: boolean;
  /** A picture that decodes with no earlier frames. */
  keyframe: boolean;
  /** The first slice of its picture. */
  firstSlice: boolean;
}

function classify(format: RawFormat, nal: Buffer): { type: number } & NalClass {
  if (format === "hevc") {
    const type = ((nal[0] ?? 0) >> 1) & 0x3f;
    return {
      type,
      parameterSet: type >= 32 && type <= 34, // VPS, SPS, PPS
      slice: type <= 31,
      keyframe: type >= 16 && type <= 23, // BLA, IDR, CRA
      firstSlice: ((nal[2] ?? 0) & 0x80) !== 0, // first_slice_segment_in_pic_flag
    };
  }
  const type = (nal[0] ?? 0) & 0x1f;
  return {
    type,
    parameterSet: type === 7 || type === 8, // SPS, PPS
    slice: type >= 1 && type <= 5,
    keyframe: type === 5, // IDR
    firstSlice: ((nal[1] ?? 0) & 0x80) !== 0, // first_mb_in_slice == 0, as exp-Golomb
  };
}

/**
 * Cuts a raw Annex-B stream into one self-contained buffer per keyframe: the parameter sets in force
 * at that point, then the keyframe's slices. Each decodes alone, at whatever resolution its own
 * parameter sets declare. A keyframe arriving before any parameter sets can't decode, so it's dropped.
 */
export function splitKeyframes(stream: Buffer, format: RawFormat): Buffer[] {
  const starts: number[] = [];
  for (let at = stream.indexOf(START_CODE); at !== -1; at = stream.indexOf(START_CODE, at + START_CODE.length)) {
    starts.push(at);
  }

  const parameterSets = new Map<number, Buffer[]>();
  let typesInThisRun = new Set<number>();
  const units: Buffer[] = [];
  let current: Buffer[] | undefined;
  const finishCurrent = (): void => {
    if (current !== undefined) units.push(Buffer.concat(current));
    current = undefined;
  };

  starts.forEach((start, index) => {
    const bytes = stream.subarray(start, starts[index + 1] ?? stream.length);
    const nal = classify(format, bytes.subarray(START_CODE.length));

    if (nal.parameterSet) {
      // A repeated type within one run adds to the set, and a new run replaces that type.
      if (!typesInThisRun.has(nal.type)) {
        parameterSets.set(nal.type, []);
        typesInThisRun.add(nal.type);
      }
      parameterSets.get(nal.type)?.push(bytes);
      return;
    }
    if (!nal.slice) return;

    typesInThisRun = new Set();
    if (nal.keyframe && nal.firstSlice) {
      finishCurrent();
      if (parameterSets.size === 0) return;
      const ordered = [...parameterSets.entries()].sort(([a], [b]) => a - b).flatMap(([, sets]) => sets);
      current = [...ordered, bytes];
    } else if (nal.keyframe) {
      current?.push(bytes);
    } else {
      finishCurrent();
    }
  });
  finishCurrent();
  return units;
}
