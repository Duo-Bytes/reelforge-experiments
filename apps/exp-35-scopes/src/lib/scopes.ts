// Test-pattern renderer + CPU scope readback for exp-35.
//
// v1 reads ImageData and accumulates bins in JS so the four scope canvases
// render correctly while the GPU pipeline lands. The eventual production
// path replaces `runScopes` body with a WGSL compute pass over the exp-04
// compositor's output GPUTexture, returning the same `ScopeReadback` shape.

export type ScopeReadback = {
  // luma waveform: cols (image columns sampled) × 256 bins
  lumaWaveform: Uint32Array;
  // rgb parade: 3 channels × cols × 256 bins (interleaved by channel)
  rgbParade: Uint32Array;
  // vectorscope cluster: array of (u, v, count) tuples
  vectorscope: Array<[number, number, number]>;
  // histogram: [r, g, b][256]
  histogram: [Uint32Array, Uint32Array, Uint32Array];
  maxBin: number;
  elapsedMs: number;
};

type Options = {
  sourceCanvas: HTMLCanvasElement;
  onReadback: (rb: ScopeReadback) => void;
};

export async function runScopes(opts: Options): Promise<() => void> {
  let raf = 0;
  const tick = () => {
    const t0 = performance.now();
    const w = opts.sourceCanvas.width;
    const h = opts.sourceCanvas.height;
    const ctx = opts.sourceCanvas.getContext("2d");
    if (!ctx) return;
    const cols = 128;
    const data = ctx.getImageData(0, 0, w, h).data;

    const luma = new Uint32Array(cols * 256);
    const parade = new Uint32Array(3 * cols * 256);
    const histogram: [Uint32Array, Uint32Array, Uint32Array] = [
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256),
    ];
    const vec: Map<string, [number, number, number]> = new Map();
    let maxBin = 0;

    const colWidth = Math.max(1, Math.floor(w / cols));
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const Y = Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
        histogram[0][r]++;
        histogram[1][g]++;
        histogram[2][b]++;

        const col = Math.min(cols - 1, Math.floor(x / colWidth));
        luma[col * 256 + Y]++;
        parade[0 * cols * 256 + col * 256 + r]++;
        parade[1 * cols * 256 + col * 256 + g]++;
        parade[2 * cols * 256 + col * 256 + b]++;

        // BT.709 Cb / Cr — vectorscope plot
        const Cb = (-0.1146 * r - 0.3854 * g + 0.5 * b) / 255;
        const Cr = (0.5 * r - 0.4542 * g - 0.0458 * b) / 255;
        const key = `${Math.round(Cb * 60)}:${Math.round(Cr * 60)}`;
        const prev = vec.get(key);
        if (prev) prev[2]++;
        else vec.set(key, [Cb, Cr, 1]);
      }
    }
    for (let i = 0; i < luma.length; i++) if (luma[i] > maxBin) maxBin = luma[i];

    const out: ScopeReadback = {
      lumaWaveform: luma,
      rgbParade: parade,
      vectorscope: Array.from(vec.values()),
      histogram,
      maxBin,
      elapsedMs: performance.now() - t0,
    };
    opts.onReadback(out);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

export function renderTestPattern(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  kind: "smpte" | "ramp" | "skin",
) {
  ctx.clearRect(0, 0, w, h);
  if (kind === "smpte") {
    const bars: [number, number, number][] = [
      [192, 192, 192], [192, 192, 0], [0, 192, 192],
      [0, 192, 0], [192, 0, 192], [192, 0, 0], [0, 0, 192],
    ];
    const bw = w / bars.length;
    bars.forEach(([r, g, b], i) => {
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(i * bw, 0, bw, h * 0.7);
    });
    ctx.fillStyle = "rgb(0,0,0)";
    ctx.fillRect(0, h * 0.7, w, h * 0.3);
    ctx.fillStyle = "rgb(255,255,255)";
    ctx.fillRect(w * 0.4, h * 0.85, w * 0.2, h * 0.1);
  } else if (kind === "ramp") {
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#000");
    grad.addColorStop(1, "#fff");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  } else {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#f3d2b0");
    grad.addColorStop(0.5, "#d5a07a");
    grad.addColorStop(1, "#6c3c2b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
}
