// Focus smoothing + a brightness-weighted center-of-mass fallback for
// exp-34. The real subject signal comes from the YOLOS-tiny detector in
// workers/detect.worker.ts; `saliencyHeuristic` only drives the preview
// before the model finishes loading or when no subject is detected.

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

/**
 * Centripetal Catmull-Rom spline interpolation of the focus-point path,
 * evaluated at clip-time `t`.
 *
 * Catmull-Rom is an interpolating spline: the curve passes exactly through
 * every control point (so `smoothFocusPath(path, path[i].t)` returns
 * `path[i]`), while the segments between control points follow a smooth C1
 * curve whose tangents are derived from neighbouring points. We use the
 * *centripetal* parameterisation (knots spaced by sqrt of chord length per
 * channel) because it never produces the cusps or self-intersections that
 * the uniform variant can on sharp turns — important when a subject darts
 * across frame and we don't want the crop to overshoot.
 *
 * The path is assumed monotonic in `t` (samples are appended over time).
 * Queries outside the knot range clamp to the nearest endpoint.
 */
export function smoothFocusPath(path: FocusSample[], t: number): FocusSample {
  const n = path.length;
  if (n === 0) {
    return { t, x: 0, y: 0, w: 1, h: 1 };
  }
  if (n === 1) {
    const p = path[0]!;
    return { t, x: p.x, y: p.y, w: p.w, h: p.h };
  }

  // Clamp outside the sampled range to the endpoints (no extrapolation).
  if (t <= path[0]!.t) {
    const p = path[0]!;
    return { t, x: p.x, y: p.y, w: p.w, h: p.h };
  }
  if (t >= path[n - 1]!.t) {
    const p = path[n - 1]!;
    return { t, x: p.x, y: p.y, w: p.w, h: p.h };
  }

  // Find the segment [i, i+1] that brackets t.
  let i = 0;
  while (i < n - 1 && path[i + 1]!.t <= t) i++;
  const p1 = path[i]!;
  const p2 = path[i + 1]!;

  // Exact hit on a knot → return it (interpolation property; avoids any
  // floating-point drift through the spline maths).
  if (t === p1.t) return { t, x: p1.x, y: p1.y, w: p1.w, h: p1.h };
  if (t === p2.t) return { t, x: p2.x, y: p2.y, w: p2.w, h: p2.h };

  // Phantom endpoints when a neighbour is missing: reflect the segment so
  // the boundary tangent is well-defined without inventing new geometry.
  const p0 = path[i - 1] ?? reflect(p2, p1);
  const p3 = path[i + 2] ?? reflect(p1, p2);

  // Local parameter u ∈ [0,1] across the bracketing segment, using the
  // points' own times as the knot spacing (uniform-in-time within the
  // segment) while the tangents below get the centripetal treatment.
  const u = (t - p1.t) / (p2.t - p1.t);

  return {
    t,
    x: catmullRom(p0.x, p1.x, p2.x, p3.x, u),
    y: catmullRom(p0.y, p1.y, p2.y, p3.y, u),
    w: catmullRom(p0.w, p1.w, p2.w, p3.w, u),
    h: catmullRom(p0.h, p1.h, p2.h, p3.h, u),
  };
}

// Reflect `near` across `pivot` to fabricate a phantom control point that
// mirrors the segment, giving a sensible boundary tangent.
function reflect(near: FocusSample, pivot: FocusSample): FocusSample {
  return {
    t: 2 * pivot.t - near.t,
    x: 2 * pivot.x - near.x,
    y: 2 * pivot.y - near.y,
    w: 2 * pivot.w - near.w,
    h: 2 * pivot.h - near.h,
  };
}

/**
 * Centripetal Catmull-Rom for one scalar channel across the segment p1→p2,
 * with neighbours p0 and p3, evaluated at u ∈ [0,1].
 *
 * Knot spacing uses the centripetal (alpha = 0.5) rule: tj = ti +
 * |Pj − Pi|^0.5. This keeps the curve inside a tight neighbourhood of its
 * control points and prevents the loops/overshoot of the uniform variant.
 * At u=0 the result is exactly p1 and at u=1 exactly p2.
 */
function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  u: number,
): number {
  const alpha = 0.5;
  const t0 = 0;
  const t1 = t0 + Math.pow(Math.abs(p1 - p0), alpha) || t0; // guard 0-length
  const t1c = t1 === t0 ? t0 + 1 : t1;
  const t2 = t1c + (Math.pow(Math.abs(p2 - p1), alpha) || 1);
  const t3 = t2 + (Math.pow(Math.abs(p3 - p2), alpha) || 1);

  // Map the local segment parameter u onto the centripetal knot interval.
  const t = t1c + u * (t2 - t1c);

  const a1 = lerpT(p0, p1, t0, t1c, t);
  const a2 = lerpT(p1, p2, t1c, t2, t);
  const a3 = lerpT(p2, p3, t2, t3, t);
  const b1 = lerpT(a1, a2, t0, t2, t);
  const b2 = lerpT(a2, a3, t1c, t3, t);
  return lerpT(b1, b2, t1c, t2, t);
}

// Linear interpolation in a (possibly non-uniform) parameter space.
function lerpT(a: number, b: number, ta: number, tb: number, t: number): number {
  if (tb === ta) return a;
  const f = (t - ta) / (tb - ta);
  return a + (b - a) * f;
}
