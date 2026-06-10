import { describe, expect, test } from 'vitest'
import { serializeBoxToDescription } from '../apps/exp-02-demuxer/src/lib/mp4box-codec'

// Reproduces the "stream.getPosition is not a function" crash: mp4box's
// Box.write() drives a real DataStream (getPosition/writeUint32/writeString/
// writeUint8Array). The old code passed a plain `{buffer,pos}` object that
// lacked getPosition. serializeBoxToDescription must hand box.write() a real
// DataStream, then strip the 8-byte box header (uint32 size + 4-char fourcc)
// so what's left is the codec config record WebCodecs wants.
interface WriteStream {
  getPosition(): number
  writeUint32(v: number): void
  writeString(v: string, encoding: undefined, length: number): void
  writeUint8Array(a: Uint8Array): void
}

// A stand-in box that writes exactly like a real mp4box Box: header then
// payload, using the same stream API methods BoxWriter uses.
function fakeAvcCBox(payload: Uint8Array) {
  return {
    write(s: WriteStream) {
      // mirrors Box.writeHeader: getPosition() is exercised here — the call
      // that threw against the old plain-object stream.
      s.getPosition()
      s.writeUint32(8 + payload.length) // box size
      s.writeString('avcC', undefined, 4) // fourcc
      s.writeUint8Array(payload) // AVCDecoderConfigurationRecord
    },
  }
}

describe('serializeBoxToDescription', () => {
  test('returns the box payload with the 8-byte header stripped', () => {
    // A plausible AVCDecoderConfigurationRecord prefix (version 1, profile…).
    const payload = new Uint8Array([0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x09])
    const desc = serializeBoxToDescription(fakeAvcCBox(payload))
    expect(desc).toBeInstanceOf(Uint8Array)
    expect(Array.from(desc)).toEqual(Array.from(payload))
  })

  test('handles a different payload length', () => {
    const payload = new Uint8Array([0x01, 0x42, 0xc0, 0x1e])
    const desc = serializeBoxToDescription(fakeAvcCBox(payload))
    expect(Array.from(desc)).toEqual(Array.from(payload))
  })
})
