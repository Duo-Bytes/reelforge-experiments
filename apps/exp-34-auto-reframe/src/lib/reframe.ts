// Placeholder saliency + smoothing for exp-34.
//
// v1: brightness-weighted center-of-mass on the downsampled frame.
// v2: replace `saliencyHeuristic` with MobileSAM-distilled ONNX inference.

export type FocusSample = {
  t: number;
  x: number; y: number;
  w: number; h: number;
};

export function saliencyHeuristic(
  ctx: CanvasRenderingContext2D,
  srcW: number,
  srcH: number,
): { x: number; y: number; w: number; h: number; conf: number } {
  // Downsample to a working grid by sampling every Nth pixel.
  const sampleStride = Math.max(1, Math.floor(Math.min(srcW, srcH) / 64));
  const data = ctx.getImageData(0, 0, srcW, srcH).data;

  let sumW = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  // Saliency proxy: luma × edge magnitude. Center-of-mass over that map.
  for (let y = sampleStride; y < srcH - sampleStride; y += sampleStride) {
    for (let x = sampleStride; x < srcW - sampleStride; x += sampleStride) {
      const i = (y * srcW + x) * 4;
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const iE = (y * srcW + x + sampleStride) * 4;
      const iS = ((y + sampleStride) * srcW + x) * 4;
      const dx = Math.abs(data[iE] - data[i]) + Math.abs(data[iE + 1] - data[i + 1]);
      const dy = Math.abs(data[iS] - data[i]) + Math.abs(data[iS + 1] - data[i + 1]);
      const w = (luma + 1) * (dx + dy + 1);
      sumW += w;
      sumX += w * x;
      sumY += w * y;
      sumXX += w * x * x;
      sumYY += w * y * y;
    }
  }
  if (sumW <= 0) {
    return { x: srcW / 2, y: srcH / 2, w: srcW / 2, h: srcH / 2, conf: 0 };
  }
  const cx = sumX / sumW;
  const cy = sumY / sumW;
  const vx = Math.max(1, sumXX / sumW - cx * cx);
  const vy = Math.max(1, sumYY / sumW - cy * cy);
  const stdX = Math.sqrt(vx);
  const stdY = Math.sqrt(vy);
  return {
    x: cx,
    y: cy,
    w: Math.min(srcW, stdX * 3.0),
    h: Math.min(srcH, stdY * 3.0),
    conf: Math.min(1, sumW / (srcW * srcH * 255)),
  };
}

// Catmull-Rom style smoothing over the last N samples nearest t.
export function smoothFocusPath(path: FocusSample[], t: number): FocusSample {
  if (path.length === 0) {
    return { t, x: 0, y: 0, w: 1, h: 1 };
  }
  const window = 8;
  const recent = path.slice(-window);
  let sx = 0;
  let sy = 0;
  let sw = 0;
  let sh = 0;
  let wsum = 0;
  for (const p of recent) {
    const dt = Math.abs(p.t - t);
    const w = 1 / (1 + dt);
    sx += p.x * w;
    sy += p.y * w;
    sw += p.w * w;
    sh += p.h * w;
    wsum += w;
  }
  return { t, x: sx / wsum, y: sy / wsum, w: sw / wsum, h: sh / wsum };
}
