export type VideoSample = {
  /** Composition (presentation) timestamp in microseconds */
  ptsUs: number;
  /** Decode timestamp in microseconds */
  dtsUs: number;
  /** Frame duration in microseconds */
  durationUs: number;
  /** Byte offset in the source file */
  offset: number;
  /** Sample byte length */
  size: number;
  /** True for I-frames (sync samples) */
  isKeyframe: boolean;
};

export type CodecConfig = {
  /** WebCodecs codec string, e.g. "avc1.640028" */
  codec: string;
  /** Raw avcC / hvcC box body */
  description: Uint8Array;
  width: number;
  height: number;
  fps: number;
};

export type DemuxResult = {
  source: "mp4box" | "mediabunny";
  config: CodecConfig;
  samplesByPts: VideoSample[];
  samplesByDts: VideoSample[];
  durationUs: number;
  parseMs: number;
};

export type GopRange = {
  /** Sample index of first frame (an I-frame) */
  startIdx: number;
  /** Exclusive end index (next I-frame, or samples.length) */
  endIdx: number;
  /** Byte offset of first sample */
  byteStart: number;
  /** Byte offset of end of last sample */
  byteEnd: number;
  frameCount: number;
};

/**
 * Find the GOP containing the target PTS.
 * Returns sample range from the keyframe at-or-before targetUs through the
 * sample before the next keyframe. Samples must be sorted by PTS ascending.
 */
export function getSamplesForGOP(
  samplesByPts: VideoSample[],
  targetUs: number,
): GopRange | null {
  if (samplesByPts.length === 0) return null;

  // Binary search for largest idx with ptsUs <= targetUs
  let lo = 0;
  let hi = samplesByPts.length - 1;
  let targetIdx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samplesByPts[mid].ptsUs <= targetUs) {
      targetIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let start = targetIdx;
  while (start > 0 && !samplesByPts[start].isKeyframe) start--;

  let end = start + 1;
  while (end < samplesByPts.length && !samplesByPts[end].isKeyframe) end++;

  const first = samplesByPts[start];
  const last = samplesByPts[end - 1];
  return {
    startIdx: start,
    endIdx: end,
    byteStart: first.offset,
    byteEnd: last.offset + last.size,
    frameCount: end - start,
  };
}
