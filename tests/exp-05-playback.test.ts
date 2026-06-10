import { describe, expect, test } from 'vitest'
import { nextFrameIndex } from '../apps/exp-05-offscreen-worker/src/lib/playback'

// The render loop ticks far faster than the decoder can serve frames. Without
// backpressure + per-frame dedup it floods the decode worker with SEEKs for the
// same frame, the backlog explodes, and playback visibly stalls. nextFrameIndex
// gates requests: emit a frame index only when the playhead has crossed into a
// NEW frame AND no decode is already outstanding.
const STEP = Math.round(1_000_000 / 30) // 33333 µs per frame @ 30fps

describe('nextFrameIndex', () => {
  test('returns null while a decode is already outstanding (backpressure)', () => {
    expect(nextFrameIndex(5 * STEP, STEP, 2, true)).toBeNull()
  })

  test('returns null when still on the same frame as last requested (dedup)', () => {
    const playhead = 4 * STEP + 10 // mid-frame 4
    expect(nextFrameIndex(playhead, STEP, 4, false)).toBeNull()
  })

  test('returns the new frame index when the playhead advances a frame', () => {
    const playhead = 5 * STEP + 10
    expect(nextFrameIndex(playhead, STEP, 4, false)).toBe(5)
  })

  test('first request (lastFrameIndex = -1) emits frame 0', () => {
    expect(nextFrameIndex(0, STEP, -1, false)).toBe(0)
  })

  test('guards a non-positive stepUs instead of dividing by zero', () => {
    // fps misreport must not wedge playback with NaN/Infinity indices.
    const idx = nextFrameIndex(100000, 0, -1, false)
    expect(idx).not.toBeNull()
    expect(Number.isFinite(idx as number)).toBe(true)
  })
})
