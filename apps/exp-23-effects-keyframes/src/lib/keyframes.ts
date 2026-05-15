// Bezier keyframe evaluator.
//
// A Keyframe carries a (time, value) anchor plus two relative tangents,
// inTangent (the handle pulling out toward the previous key) and
// outTangent (the handle pulling out toward the next key). Tangents are
// expressed as relative offsets in (seconds, value) space — that lets a
// drag handle in the SVG editor translate directly to a numeric tweak
// without re-projecting through the curve.
//
// `evaluate(track, time)` walks the segment that brackets `time` and
// solves a cubic bezier in x for parameter `t`, then evaluates the same
// curve in y. The x-solve uses Newton's method (cheap, converges in 2-3
// iterations for well-conditioned curves) with a bisection fall-back for
// near-vertical tangents where dx/dt collapses.

export type Vec2 = { x: number; y: number };

export type Keyframe = {
  time: number;
  value: number;
  inTangent: Vec2;
  outTangent: Vec2;
  type: "linear" | "bezier" | "hold";
};

const NEWTON_ITERS = 8;
const BISECT_ITERS = 20;
const DERIVATIVE_FLOOR = 1e-6;

// Cubic bezier B(t) on a 1D axis: P0 (1-t)^3 + 3 P1 t(1-t)^2 + 3 P2 t^2(1-t) + P3 t^3
function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return (
    p0 * u * u * u + 3 * p1 * t * u * u + 3 * p2 * t * t * u + p3 * t * t * t
  );
}

function cubicDerivative(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const u = 1 - t;
  return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

// Solve cubic(p0..p3, t) = target for t in [0,1].
function solveT(
  target: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number,
): number {
  // Newton's method seeded at the linear estimate.
  let t = (target - p0) / Math.max(p3 - p0, 1e-9);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  for (let i = 0; i < NEWTON_ITERS; i++) {
    const x = cubic(p0, p1, p2, p3, t) - target;
    const dx = cubicDerivative(p0, p1, p2, p3, t);
    if (Math.abs(dx) < DERIVATIVE_FLOOR) break;
    const next = t - x / dx;
    if (next < 0) t = 0;
    else if (next > 1) t = 1;
    else t = next;
    if (Math.abs(x) < 1e-7) return t;
  }
  // Bisection fall-back.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECT_ITERS; i++) {
    const mid = (lo + hi) * 0.5;
    if (cubic(p0, p1, p2, p3, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

function findSegment(track: Keyframe[], time: number): number {
  // Returns the index `i` such that track[i].time <= time < track[i+1].time
  // or -1 if before the first key, track.length-1 if after the last.
  if (track.length === 0) return -1;
  if (time < track[0].time) return -1;
  if (time >= track[track.length - 1].time) return track.length - 1;
  let lo = 0;
  let hi = track.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].time <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function evaluate(track: Keyframe[], time: number): number {
  if (track.length === 0) return 0;
  const i = findSegment(track, time);
  if (i < 0) return track[0].value;
  if (i >= track.length - 1) return track[track.length - 1].value;

  const a = track[i];
  const b = track[i + 1];

  if (a.type === "hold") return a.value;

  if (a.type === "linear" || b.type === "linear") {
    const t = (time - a.time) / (b.time - a.time);
    return a.value + (b.value - a.value) * t;
  }

  // Cubic bezier in (t,v).
  const p0x = a.time;
  const p1x = a.time + a.outTangent.x;
  const p2x = b.time + b.inTangent.x;
  const p3x = b.time;
  const p0y = a.value;
  const p1y = a.value + a.outTangent.y;
  const p2y = b.value + b.inTangent.y;
  const p3y = b.value;

  const t = solveT(time, p0x, p1x, p2x, p3x);
  return cubic(p0y, p1y, p2y, p3y, t);
}

// Convenience: build a default keyframe with mild tangents.
export function makeKeyframe(time: number, value: number): Keyframe {
  return {
    time,
    value,
    inTangent: { x: -0.15, y: 0 },
    outTangent: { x: 0.15, y: 0 },
    type: "bezier",
  };
}

// Sort + dedupe by time (used after a drag).
export function normalizeTrack(track: Keyframe[]): Keyframe[] {
  const sorted = [...track].sort((a, b) => a.time - b.time);
  const out: Keyframe[] = [];
  for (const k of sorted) {
    if (out.length && Math.abs(out[out.length - 1].time - k.time) < 1e-4) continue;
    out.push(k);
  }
  return out;
}
