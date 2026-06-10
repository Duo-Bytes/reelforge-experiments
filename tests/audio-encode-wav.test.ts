import { describe, it, expect } from "vitest";
import { encodeWav } from "../packages/audio/src/index";

// encodeWav is the public mono entry point; it delegates straight to the
// internal encodeWavInterleaved with a single channel. Testing it exercises
// the same RIFF/fmt/data writer.

const ascii = (view: DataView, off: number, len: number): string => {
  let s = "";
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(view.getUint8(off + i));
  return s;
};

describe("@reelforge/audio encodeWav (interleaved RIFF writer)", () => {
  it("writes correct RIFF/WAVE/fmt /data magic and 16-bit PCM header", async () => {
    const sampleRate = 44100;
    // 3 mono samples: full negative, zero, full positive.
    const samples = new Float32Array([-1, 0, 1]);
    const blob = encodeWav(samples, sampleRate);

    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);

    // Chunk magics.
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(ascii(view, 36, 4)).toBe("data");

    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = samples.length * blockAlign;

    // fmt chunk fields.
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM format tag
    expect(view.getUint16(22, true)).toBe(numChannels);
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * blockAlign); // byte rate
    expect(view.getUint16(32, true)).toBe(blockAlign);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample

    // RIFF + data sizes.
    expect(view.getUint32(4, true)).toBe(36 + dataSize);
    expect(view.getUint32(40, true)).toBe(dataSize);

    // Total file length: 44-byte header + PCM body.
    expect(buf.byteLength).toBe(44 + dataSize);
    expect(buf.byteLength).toBe(44 + 3 * 2);
  });

  it("encodes Float32 samples to clamped 16-bit PCM little-endian", async () => {
    const samples = new Float32Array([-1, 0, 1]);
    const buf = await encodeWav(samples, 8000).arrayBuffer();
    const view = new DataView(buf);
    // -1 -> -0x8000, 0 -> 0, 1 -> 0x7fff.
    expect(view.getInt16(44, true)).toBe(-0x8000);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(0x7fff);
  });
});
