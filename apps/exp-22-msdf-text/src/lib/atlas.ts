// Build a 1-channel SDF (signed distance field) atlas of ASCII printable
// glyphs at runtime.
//
// Strategy:
//   1. Render every glyph in `chars` to a high-resolution bitmap on an
//      OffscreenCanvas using ctx.fillText.
//   2. For each pixel in the atlas, run a brute-force search for the
//      nearest opacity-boundary pixel within `searchRadius`. Convert the
//      signed distance into a single byte where 128 = "on the edge".
//   3. Pack glyph metrics (atlas rect + ascent + advance) into a side
//      table so the renderer can place quads.
//
// This is intentionally simple and slow: a real implementation should use
// jump flooding or Felzenszwalb's 1-D EDT. The atlas is built once at
// startup, so O(n² · r²) is tolerable for the demo.
//
// We label this "SDF" not "MSDF" — true MSDF preserves sharp corners via
// median-of-three across three channels (Chlumsky 2015). The fwidth-based
// AA in the shader works identically.

export const ATLAS_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?'-:";

export type GlyphMetric = {
  ch: string;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  advance: number;   // in `cellPx` units, 0..1
};

export type Atlas = {
  width: number;
  height: number;
  cellPx: number;
  searchRadius: number;
  pixels: Uint8Array;   // single channel, length = width * height
  glyphs: Map<string, GlyphMetric>;
  fontFamily: string;
};

export type AtlasOptions = {
  fontFamily: string;
  cellPx?: number;       // glyph bounding box; default 64
  searchRadius?: number; // SDF spread, in pixels; default 8
  cols?: number;         // atlas columns; default Math.ceil(sqrt(N))
};

export async function buildAtlas(opts: AtlasOptions): Promise<Atlas> {
  const cellPx = opts.cellPx ?? 64;
  const searchRadius = opts.searchRadius ?? 8;
  const chars = ATLAS_CHARS;
  const cols = opts.cols ?? Math.ceil(Math.sqrt(chars.length));
  const rows = Math.ceil(chars.length / cols);
  const W = cols * cellPx;
  const H = rows * cellPx;

  // We *must* wait for the font to be fully ready before drawing; FontFace
  // resolves before the raster is uploaded into the platform cache and
  // fillText falls back silently otherwise.
  if (typeof document !== "undefined") {
    await document.fonts.ready;
  }

  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d unavailable");
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "white";
  // Inset slightly so descenders don't get clipped at the cell edge.
  const fontPx = Math.floor(cellPx * 0.78);
  ctx.font = `${fontPx}px ${opts.fontFamily}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  const glyphs = new Map<string, GlyphMetric>();
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = col * cellPx;
    const cellY = row * cellPx;
    const metrics = ctx.measureText(ch);
    const advance = metrics.width / cellPx;

    // Centre glyph horizontally in its cell; baseline ~80% down.
    const drawX = cellX + (cellPx - metrics.width) / 2;
    const drawY = cellY + cellPx * 0.8;
    ctx.fillText(ch, drawX, drawY);

    glyphs.set(ch, {
      ch,
      u0: cellX / W,
      v0: cellY / H,
      u1: (cellX + cellPx) / W,
      v1: (cellY + cellPx) / H,
      advance,
    });
  }

  const img = ctx.getImageData(0, 0, W, H);
  const alpha = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = img.data[i * 4 + 3];

  const sdf = sdfFromAlpha(alpha, W, H, searchRadius);

  return {
    width: W,
    height: H,
    cellPx,
    searchRadius,
    pixels: sdf,
    glyphs,
    fontFamily: opts.fontFamily,
  };
}

/**
 * Build an SDF from an alpha bitmap. The output is centred on 128 — values
 * above 128 are "inside" the glyph, below are "outside", and exactly 128
 * is the polygon boundary. Brute force, O(W·H·r²).
 */
function sdfFromAlpha(
  alpha: Uint8Array,
  W: number,
  H: number,
  r: number,
): Uint8Array {
  const out = new Uint8Array(W * H);
  // Precompute "inside" predicate.
  const isInside = (x: number, y: number) => alpha[y * W + x] >= 128;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = isInside(x, y);
      let best = r * r;
      const xMin = Math.max(0, x - r);
      const xMax = Math.min(W - 1, x + r);
      const yMin = Math.max(0, y - r);
      const yMax = Math.min(H - 1, y + r);
      for (let yy = yMin; yy <= yMax; yy++) {
        for (let xx = xMin; xx <= xMax; xx++) {
          if (isInside(xx, yy) === inside) continue;
          const dx = xx - x;
          const dy = yy - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) best = d2;
        }
      }
      const dist = Math.sqrt(best);
      // Sign by inside/outside, normalise to [-1, 1] over the search radius,
      // then map to 0..255 with 128 = boundary.
      const signed = (inside ? dist : -dist) / r;
      const v = Math.max(0, Math.min(255, Math.round((signed + 1) * 0.5 * 255)));
      out[y * W + x] = v;
    }
  }
  return out;
}

/**
 * Lay out a string. Returns per-glyph quads in *pixel* space relative to a
 * baseline at y = 0. The caller multiplies by a model matrix in WGSL.
 */
export type LaidGlyph = {
  ch: string;
  // Quad rect in pixel space (relative to the layout origin):
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  // Atlas UV rect:
  u0: number;
  v0: number;
  u1: number;
  v1: number;
};

export function layoutString(
  atlas: Atlas,
  text: string,
  pixelHeight: number,
): { glyphs: LaidGlyph[]; widthPx: number } {
  const out: LaidGlyph[] = [];
  let cursor = 0;
  const scale = pixelHeight / atlas.cellPx;
  for (const ch of text) {
    const g = atlas.glyphs.get(ch);
    if (!g) {
      cursor += pixelHeight * 0.3;
      continue;
    }
    const quadSize = atlas.cellPx * scale;
    const x0 = cursor;
    const y0 = -quadSize * 0.8;   // baseline at y=0
    const x1 = x0 + quadSize;
    const y1 = y0 + quadSize;
    out.push({
      ch,
      x0,
      y0,
      x1,
      y1,
      u0: g.u0,
      v0: g.v0,
      u1: g.u1,
      v1: g.v1,
    });
    cursor += g.advance * pixelHeight;
  }
  return { glyphs: out, widthPx: cursor };
}
