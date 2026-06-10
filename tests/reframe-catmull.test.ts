import { describe, it, expect } from "vitest";
import {
  smoothFocusPath,
  type FocusSample,
} from "../apps/exp-34-auto-reframe/src/lib/reframe";

// A monotonic-in-t path of focus points. Catmull-Rom interpolation must
// (a) pass exactly through each control point at its own knot time, and
// (b) for a midpoint query stay inside the convex hull (here: the axis-
//     aligned bounding box) of the two bracketing control points plus their
//     immediate neighbours — i.e. it must not overshoot wildly the way a
//     naive global average would understate the local motion.
const PATH: FocusSample[] = [
  { t: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.4 },
  { t: 1, x: 0.4, y: 0.2, w: 0.35, h: 0.45 },
  { t: 2, x: 0.9, y: 0.8, w: 0.25, h: 0.3 },
  { t: 3, x: 0.5, y: 0.6, w: 0.4, h: 0.5 },
  { t: 4, x: 0.2, y: 0.3, w: 0.3, h: 0.4 },
];

const EPS = 1e-6;

describe("smoothFocusPath — centripetal Catmull-Rom", () => {
  it("passes through every control point at its own knot time", () => {
    for (const p of PATH) {
      const got = smoothFocusPath(PATH, p.t);
      expect(got.x).toBeCloseTo(p.x, 6);
      expect(got.y).toBeCloseTo(p.y, 6);
      expect(got.w).toBeCloseTo(p.w, 6);
      expect(got.h).toBeCloseTo(p.h, 6);
      expect(got.t).toBeCloseTo(p.t, 6);
    }
  });

  it("stays within the bounding box of the bracketing segment's neighbourhood at a midpoint", () => {
    // Query halfway between knot 1 (t=1) and knot 2 (t=2).
    const t = 1.5;
    const got = smoothFocusPath(PATH, t);

    // The four points that influence the segment [P1, P2] under Catmull-Rom
    // are P0, P1, P2, P3. The interpolated value must lie within their
    // combined axis-aligned bounding box (a superset of the convex hull
    // projection on each axis), with a tiny epsilon for float noise.
    const influence = [PATH[0], PATH[1], PATH[2], PATH[3]];
    const minX = Math.min(...influence.map((p) => p.x));
    const maxX = Math.max(...influence.map((p) => p.x));
    const minY = Math.min(...influence.map((p) => p.y));
    const maxY = Math.max(...influence.map((p) => p.y));

    expect(got.x).toBeGreaterThanOrEqual(minX - EPS);
    expect(got.x).toBeLessThanOrEqual(maxX + EPS);
    expect(got.y).toBeGreaterThanOrEqual(minY - EPS);
    expect(got.y).toBeLessThanOrEqual(maxY + EPS);

    // It must also genuinely interpolate (move between P1 and P2), not just
    // collapse to a flat average: x should be strictly between P1.x and P2.x.
    const loX = Math.min(PATH[1].x, PATH[2].x);
    const hiX = Math.max(PATH[1].x, PATH[2].x);
    expect(got.x).toBeGreaterThan(loX - EPS);
    expect(got.x).toBeLessThan(hiX + EPS);
  });

  it("handles a single-point path by returning that point", () => {
    const one: FocusSample[] = [{ t: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }];
    const got = smoothFocusPath(one, 0);
    expect(got.x).toBeCloseTo(0.5, 6);
    expect(got.y).toBeCloseTo(0.5, 6);
  });

  it("clamps queries before the first / after the last knot to the endpoints", () => {
    const before = smoothFocusPath(PATH, -2);
    expect(before.x).toBeCloseTo(PATH[0].x, 6);
    const after = smoothFocusPath(PATH, 99);
    expect(after.x).toBeCloseTo(PATH[PATH.length - 1].x, 6);
  });
});
