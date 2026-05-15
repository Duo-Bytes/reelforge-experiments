/**
 * Peak file format for exp-25.
 *
 * header  { magic: u32 = 0x504B5331, version: u16, channels: u16,
 *           sampleRate: u32, sampleCount: u32, lodCount: u16,
 *           binSizes: u16[lodCount] }
 * lod[i]  { binCount: u32, data: Int16Array [min0, max0, min1, max1, ...] }
 *
 * Layout is little-endian throughout. Int16 range is [-32768, 32767];
 * Float32 samples in [-1, 1] are mapped via round(x * 32767).
 */

export const PEAK_MAGIC = 0x504b5331;
export const PEAK_VERSION = 1;
export const DEFAULT_LOD_BINS = [256, 4096, 65536] as const;

export type PeakLod = {
  binSize: number;
  binCount: number;
  data: Int16Array; // pairs of [min, max] per bin
};

export type PeakData = {
  channels: number;
  sampleRate: number;
  sampleCount: number;
  lods: PeakLod[];
};

export function buildPeaks(
  channelData: Float32Array,
  sampleRate: number,
  lodBins: readonly number[] = DEFAULT_LOD_BINS,
): PeakData {
  const lods: PeakLod[] = [];
  for (const binSize of lodBins) {
    const binCount = Math.ceil(channelData.length / binSize);
    const data = new Int16Array(binCount * 2);
    for (let b = 0; b < binCount; b += 1) {
      let mn = 1;
      let mx = -1;
      const start = b * binSize;
      const end = Math.min(start + binSize, channelData.length);
      for (let i = start; i < end; i += 1) {
        const s = channelData[i]!;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      data[b * 2] = Math.round(mn * 32767);
      data[b * 2 + 1] = Math.round(mx * 32767);
    }
    lods.push({ binSize, binCount, data });
  }
  return {
    channels: 1,
    sampleRate,
    sampleCount: channelData.length,
    lods,
  };
}

export function serializePeaks(p: PeakData): ArrayBuffer {
  const headerSize = 4 + 2 + 2 + 4 + 4 + 2 + p.lods.length * 2;
  let bodySize = 0;
  for (const lod of p.lods) {
    bodySize += 4 + lod.data.byteLength;
  }
  const out = new ArrayBuffer(headerSize + bodySize);
  const view = new DataView(out);
  let o = 0;
  view.setUint32(o, PEAK_MAGIC, true);
  o += 4;
  view.setUint16(o, PEAK_VERSION, true);
  o += 2;
  view.setUint16(o, p.channels, true);
  o += 2;
  view.setUint32(o, p.sampleRate, true);
  o += 4;
  view.setUint32(o, p.sampleCount, true);
  o += 4;
  view.setUint16(o, p.lods.length, true);
  o += 2;
  for (const lod of p.lods) {
    view.setUint16(o, lod.binSize, true);
    o += 2;
  }
  for (const lod of p.lods) {
    view.setUint32(o, lod.binCount, true);
    o += 4;
    new Int16Array(out, o, lod.data.length).set(lod.data);
    o += lod.data.byteLength;
  }
  return out;
}

export function parsePeaks(buf: ArrayBuffer): PeakData {
  const view = new DataView(buf);
  let o = 0;
  const magic = view.getUint32(o, true);
  o += 4;
  if (magic !== PEAK_MAGIC) throw new Error("Bad peak file magic");
  const version = view.getUint16(o, true);
  o += 2;
  if (version !== PEAK_VERSION) throw new Error(`Unknown peak version ${version}`);
  const channels = view.getUint16(o, true);
  o += 2;
  const sampleRate = view.getUint32(o, true);
  o += 4;
  const sampleCount = view.getUint32(o, true);
  o += 4;
  const lodCount = view.getUint16(o, true);
  o += 2;
  const binSizes: number[] = [];
  for (let i = 0; i < lodCount; i += 1) {
    binSizes.push(view.getUint16(o, true));
    o += 2;
  }
  const lods: PeakLod[] = [];
  for (let i = 0; i < lodCount; i += 1) {
    const binCount = view.getUint32(o, true);
    o += 4;
    const data = new Int16Array(buf, o, binCount * 2).slice();
    o += binCount * 4;
    lods.push({ binSize: binSizes[i]!, binCount, data });
  }
  return { channels, sampleRate, sampleCount, lods };
}

export function pickLod(p: PeakData, samplesPerPixel: number): PeakLod {
  let best = p.lods[0]!;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const lod of p.lods) {
    if (lod.binSize > samplesPerPixel) continue;
    const diff = samplesPerPixel - lod.binSize;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = lod;
    }
  }
  return best;
}
