/**
 * WebCodecs coerces `EncodedVideoChunk` timestamps/durations to integer
 * microseconds (`[EnforceRange] long long`), and `VideoFrame.timestamp` echoes
 * that integer back. A PTS computed as `cts * 1e6 / timescale` is almost always
 * fractional, so a raw-float seek target never `===` the truncated frame
 * timestamp — the seek then times out. Keying BOTH the fed chunk timestamp and
 * the match target through the same integer rounding makes the equality
 * reliable for every PTS.
 */
export const tsKey = (micros: number): number => Math.round(micros);
