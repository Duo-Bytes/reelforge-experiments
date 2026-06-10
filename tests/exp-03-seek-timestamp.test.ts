import { describe, expect, test } from 'vitest'
import { tsKey } from '../apps/exp-03-webcodecs-decode/src/lib/timestamp'

// WebCodecs coerces EncodedVideoChunkInit.timestamp ([EnforceRange] long long)
// to an integer (truncation toward zero), and VideoFrame.timestamp echoes that
// integer back. So the seek match key must be the SAME integer on both the fed
// chunk and the target — otherwise a fractional-µs PTS (the normal case, e.g.
// 1024/12288 s) never compares equal and the seek times out.
const decoderEcho = (chunkTimestamp: number): number => Math.trunc(chunkTimestamp)

describe('tsKey (seek timestamp keying)', () => {
  test('produces an integer for a fractional-microsecond PTS', () => {
    const ptsUs = (1024 * 1_000_000) / 12288 // 83333.33… µs
    expect(Number.isInteger(ptsUs)).toBe(false)
    expect(Number.isInteger(tsKey(ptsUs))).toBe(true)
  })

  test('the frame the decoder echoes for a keyed chunk matches the keyed target', () => {
    const ptsUs = (1024 * 1_000_000) / 12288
    const fedChunkTimestamp = tsKey(ptsUs) // what we hand EncodedVideoChunk
    const frameTimestamp = decoderEcho(fedChunkTimestamp) // what VideoFrame reports
    const targetKey = tsKey(ptsUs) // what handleFrame compares against
    expect(frameTimestamp === targetKey).toBe(true)
  })

  test('the old approach (raw float target vs truncated frame) never matched', () => {
    const ptsUs = (1024 * 1_000_000) / 12288
    const frameTimestamp = decoderEcho(ptsUs) // chunk fed the raw float → truncated
    expect(frameTimestamp === ptsUs).toBe(false) // this mismatch caused the timeout
  })

  test('whole-microsecond PTS is unchanged', () => {
    expect(tsKey(0)).toBe(0)
    expect(tsKey(500000)).toBe(500000)
  })
})
