import { describe, expect, test } from 'vitest'
import { toMicros } from '../apps/exp-10-export-pipeline/src/lib/types'

// Reproduces "source decode timeout @ 0us" in the export pipeline.
//
// The render loop requests a source frame, feeds the GOP to a VideoDecoder, and
// resolves the pending promise inside the decoder's `output` callback when
// `frame.timestamp === pendingTarget`. WebCodecs stores a chunk's timestamp as
// an int64 (microseconds) and truncates any fractional value; the decoder then
// echoes that SAME integer back as `frame.timestamp`. So whatever we store as a
// sample's PTS must equal the integer the decoder will emit — otherwise the
// strict `===` match never fires and getSourceFrame times out.
//
// `ptsUs = (cts * 1_000_000) / timescale` is fractional for the overwhelmingly
// common case of a timescale that doesn't divide 1e6 evenly (e.g. 90000 @ 30fps
// → 33333.333…). Stored as a float, it can never `===` the 33333 the decoder
// reports. `toMicros` must round to the integer the decoder will emit.
describe('toMicros — integer-microsecond timestamps', () => {
  test('returns the integer WebCodecs/the decoder will emit, not a float', () => {
    // 90000 timescale, one 30fps frame step (cts = 3000).
    const cts = 3000
    const timescale = 90000

    const floatPts = (cts * 1_000_000) / timescale // 33333.333… — the old bug
    const decoderEmits = Math.trunc(floatPts) // what WebCodecs stores & echoes

    expect(Number.isInteger(floatPts)).toBe(false) // the trap

    const stored = toMicros(cts, timescale)
    expect(Number.isInteger(stored)).toBe(true)
    // The stored PTS must equal the frame.timestamp the decoder reports, so the
    // `frame.timestamp === pendingTarget` match in the output callback fires.
    expect(stored).toBe(decoderEmits)
  })

  test('frame 0 (cts 0) stays exactly 0', () => {
    expect(toMicros(0, 90000)).toBe(0)
  })

  test('exact divisions are unchanged', () => {
    expect(toMicros(48000, 48000)).toBe(1_000_000)
  })
})
