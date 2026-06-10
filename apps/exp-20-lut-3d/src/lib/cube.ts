// Parse Adobe / IRIDAS `.cube` 3D LUT format.
//
// Grammar (extracted from the Adobe Cube LUT spec, 2013):
//   TITLE "..."                  (optional)
//   LUT_3D_SIZE N                (required for 3D LUTs)
//   DOMAIN_MIN r g b             (optional, default 0 0 0)
//   DOMAIN_MAX r g b             (optional, default 1 1 1)
//   r g b                        (N*N*N rows, R varies fastest, then G, then B)
//
// Lines beginning with `#` or empty lines are comments.

export type ParsedLUT = {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** N*N*N RGBA samples (alpha=1), in `r + g*N + b*N*N` order. */
  data: Float32Array;
  title: string | null;
};

export class CubeParseError extends Error {}

/**
 * Remap an input colour into normalised [0,1]^3 texture-coordinate space for
 * a LUT with the given DOMAIN_MIN / DOMAIN_MAX. This is the exact math the
 * WGSL sampler must perform before the 3D texture lookup:
 *
 *   uvw = (rgb - domainMin) / (domainMax - domainMin)
 *
 * For the default domain [0,0,0]..[1,1,1] this is the identity. A zero-width
 * axis (max === min) collapses to 0 rather than producing NaN/Infinity, so a
 * degenerate `.cube` header can't break sampling.
 */
export function domainNormalize(
  rgb: readonly [number, number, number],
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): [number, number, number] {
  const remap = (i: number): number => {
    const span = max[i] - min[i];
    if (span === 0) return 0;
    return (rgb[i] - min[i]) / span;
  };
  return [remap(0), remap(1), remap(2)];
}

export function parseCube(text: string): ParsedLUT {
  let size = -1;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let title: string | null = null;
  const samples: number[] = [];

  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("TITLE")) {
      const m = trimmed.match(/^TITLE\s+"(.*)"\s*$/);
      title = m ? m[1] : trimmed.slice(5).trim();
      continue;
    }
    if (trimmed.startsWith("LUT_1D_SIZE")) {
      throw new CubeParseError("1D LUTs are not supported by this experiment");
    }
    if (trimmed.startsWith("LUT_3D_SIZE")) {
      const n = parseInt(trimmed.split(/\s+/)[1], 10);
      if (!Number.isFinite(n) || n < 2 || n > 256) {
        throw new CubeParseError(`Invalid LUT_3D_SIZE: ${n}`);
      }
      size = n;
      continue;
    }
    if (trimmed.startsWith("DOMAIN_MIN")) {
      const parts = trimmed.split(/\s+/).slice(1).map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        domainMin = [parts[0], parts[1], parts[2]];
      }
      continue;
    }
    if (trimmed.startsWith("DOMAIN_MAX")) {
      const parts = trimmed.split(/\s+/).slice(1).map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        domainMax = [parts[0], parts[1], parts[2]];
      }
      continue;
    }

    // Data row: three floats.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const r = parseFloat(parts[0]);
    const g = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      throw new CubeParseError(`Malformed data row at line ${lineNo + 1}`);
    }
    samples.push(r, g, b);
  }

  if (size < 0) throw new CubeParseError("LUT_3D_SIZE missing");
  const expected = size * size * size;
  if (samples.length !== expected * 3) {
    throw new CubeParseError(
      `Expected ${expected} triplets for size ${size}, got ${samples.length / 3}`,
    );
  }

  // Pad RGB to RGBA for rgba16float upload.
  const padded = new Float32Array(expected * 4);
  for (let i = 0; i < expected; i++) {
    padded[i * 4 + 0] = samples[i * 3 + 0];
    padded[i * 4 + 1] = samples[i * 3 + 1];
    padded[i * 4 + 2] = samples[i * 3 + 2];
    padded[i * 4 + 3] = 1.0;
  }

  return { size, domainMin, domainMax, data: padded, title };
}

/**
 * Build an identity LUT of the given size. `lut[r,g,b] = (r,g,b)/(N-1)`.
 * Useful as a baseline so the page is functional before the user picks a file.
 */
export function buildIdentityLUT(size: number): ParsedLUT {
  const expected = size * size * size;
  const data = new Float32Array(expected * 4);
  const inv = 1 / (size - 1);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const i = (r + g * size + b * size * size) * 4;
        data[i + 0] = r * inv;
        data[i + 1] = g * inv;
        data[i + 2] = b * inv;
        data[i + 3] = 1;
      }
    }
  }
  return {
    size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data,
    title: "Built-in identity",
  };
}

/** A "warm" LUT: boost red, lift shadows, crush blue slightly. */
export function buildWarmLUT(size: number): ParsedLUT {
  const expected = size * size * size;
  const data = new Float32Array(expected * 4);
  const inv = 1 / (size - 1);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const i = (r + g * size + b * size * size) * 4;
        const rn = r * inv;
        const gn = g * inv;
        const bn = b * inv;
        // Lift, then warm-bias: shift toward red/orange.
        const lift = 0.04;
        const rOut = Math.min(1, rn * 1.08 + 0.03 + lift * (1 - rn));
        const gOut = Math.min(1, gn * 1.02 + 0.01 + lift * 0.6 * (1 - gn));
        const bOut = Math.max(0, bn * 0.86 - 0.02);
        data[i + 0] = rOut;
        data[i + 1] = gOut;
        data[i + 2] = bOut;
        data[i + 3] = 1;
      }
    }
  }
  return {
    size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data,
    title: "Built-in warm",
  };
}

/**
 * Serialise a ParsedLUT back to .cube text — handy for "Download" buttons in
 * the demo and for round-trip sanity tests.
 */
export function lutToCubeText(lut: ParsedLUT): string {
  const lines: string[] = [];
  if (lut.title) lines.push(`TITLE "${lut.title}"`);
  lines.push(`LUT_3D_SIZE ${lut.size}`);
  lines.push(
    `DOMAIN_MIN ${lut.domainMin[0]} ${lut.domainMin[1]} ${lut.domainMin[2]}`,
  );
  lines.push(
    `DOMAIN_MAX ${lut.domainMax[0]} ${lut.domainMax[1]} ${lut.domainMax[2]}`,
  );
  const N = lut.size;
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const i = (r + g * N + b * N * N) * 4;
        lines.push(
          `${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`,
        );
      }
    }
  }
  return lines.join("\n");
}
