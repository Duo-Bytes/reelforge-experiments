import { describe, it, expect } from "vitest";
import {
  buildPeaks,
  serializePeaks,
  parsePeaks,
  PEAK_MAGIC,
  PEAK_VERSION,
  type PeakData,
} from "../apps/exp-25-waveforms/src/lib/peak-format";

describe("exp-25 peak-format round-trip", () => {
  it("serialize → parse preserves header + min/max bins", () => {
    // 8 samples, small LODs so we get >1 bin per lod.
    const samples = new Float32Array([
      -1, 1, -0.5, 0.5, 0, 0.25, -0.25, 0.75,
    ]);
    const built = buildPeaks(samples, 48000, [2, 4]);
    const round: PeakData = parsePeaks(serializePeaks(built));

    expect(round.channels).toBe(built.channels);
    expect(round.sampleRate).toBe(48000);
    expect(round.sampleCount).toBe(8);
    expect(round.lods.length).toBe(built.lods.length);

    for (let i = 0; i < built.lods.length; i += 1) {
      const a = built.lods[i]!;
      const b = round.lods[i]!;
      expect(b.binSize).toBe(a.binSize);
      expect(b.binCount).toBe(a.binCount);
      expect(Array.from(b.data)).toEqual(Array.from(a.data));
    }
  });

  it("encodes the extreme samples as full-scale int16 min/max in the first bin", () => {
    const samples = new Float32Array([-1, 1, -0.5, 0.5]);
    const built = buildPeaks(samples, 44100, [2]);
    const round = parsePeaks(serializePeaks(built));
    const lod0 = round.lods[0]!;
    // bin 0 covers samples [-1, 1] -> min ~ -32767, max 32767.
    expect(lod0.data[0]).toBe(Math.round(-1 * 32767));
    expect(lod0.data[1]).toBe(Math.round(1 * 32767));
  });

  it("round-trips the magic and version markers", () => {
    const built = buildPeaks(new Float32Array([0.1, -0.1]), 8000, [2]);
    const buf = serializePeaks(built);
    const view = new DataView(buf);
    expect(view.getUint32(0, true)).toBe(PEAK_MAGIC);
    expect(view.getUint16(4, true)).toBe(PEAK_VERSION);
  });

  it("handles the empty-bin / empty-input edge case", () => {
    // No samples: binCount is 0, data is empty; round-trip must hold.
    const built = buildPeaks(new Float32Array([]), 48000, [256]);
    expect(built.sampleCount).toBe(0);
    expect(built.lods[0]!.binCount).toBe(0);
    expect(built.lods[0]!.data.length).toBe(0);

    const round = parsePeaks(serializePeaks(built));
    expect(round.sampleCount).toBe(0);
    expect(round.lods[0]!.binCount).toBe(0);
    expect(round.lods[0]!.data.length).toBe(0);
  });
});
