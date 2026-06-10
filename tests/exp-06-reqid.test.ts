import { describe, expect, test } from 'vitest'
import {
  reqIdForTarget,
  targetFromReqId,
} from '../apps/exp-06-frame-cache/src/lib/reqid'

// The decode worker returns a frame whose timestamp is the NEAREST sample PTS,
// which differs from the requested target. The cache/pending maps are keyed by
// the requested target, so the decoded frame must be routed back by its reqId
// (which carries the request key) — NOT by frame.timestamp. These helpers make
// that key reversible.
describe('reqid keying', () => {
  test('round-trips an arbitrary target microsecond', () => {
    for (const us of [0, 33333, 500000, 1234567]) {
      expect(targetFromReqId(reqIdForTarget(us))).toBe(us)
    }
  })

  test('recovers the requested key independent of the frame timestamp', () => {
    const requested = 500000
    const reqId = reqIdForTarget(requested)
    const frameTimestamp = 483333 // nearest sample PTS — different from request
    expect(targetFromReqId(reqId)).toBe(requested)
    expect(targetFromReqId(reqId)).not.toBe(frameTimestamp)
  })
})
