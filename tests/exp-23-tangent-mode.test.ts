import { describe, it, expect } from "vitest";
import {
  makeKeyframe,
  editTangent,
  type Keyframe,
} from "../apps/exp-23-effects-keyframes/src/lib/keyframes";

describe("exp-23 tangentMode + locked mirroring", () => {
  it("makeKeyframe defaults to tangentMode 'locked'", () => {
    expect(makeKeyframe(0, 0).tangentMode).toBe("locked");
  });

  it("editing the out-tangent of a locked keyframe mirrors the in-tangent (collinear, angle-mirrored)", () => {
    // Use an IN handle that is itself the exact opposite-length of the OUT
    // edit so the angle-mirror lands on a clean expected value.
    const kf: Keyframe = {
      ...makeKeyframe(1, 0),
      inTangent: { x: -0.15, y: 0 }, // length 0.15
    };
    const edited = editTangent(kf, "out", { x: 0.3, y: 0.0 }); // length 0.3
    // out is whatever we set:
    expect(edited.outTangent).toEqual({ x: 0.3, y: 0.0 });
    // in is the angle-mirror: opposite direction, original IN length (0.15)
    // preserved. OUT points along +x, so IN flips to -x at length 0.15.
    expect(edited.inTangent.x).toBeCloseTo(-0.15, 10);
    expect(edited.inTangent.y).toBeCloseTo(0, 10);
    // Collinear: cross product of the two handle vectors is ~0.
    const cross =
      edited.inTangent.x * edited.outTangent.y -
      edited.inTangent.y * edited.outTangent.x;
    expect(cross).toBeCloseTo(0, 10);
    // Opposite direction: dot product is negative.
    const dot =
      edited.inTangent.x * edited.outTangent.x +
      edited.inTangent.y * edited.outTangent.y;
    expect(dot).toBeLessThan(0);
  });

  it("preserves the IN handle length when mirroring (angle, not raw component)", () => {
    // Start with an IN handle of a known length, then edit OUT to a different
    // length. Locked mirroring keeps the IN *length* but flips it to lie on
    // the OUT axis (collinear), so the handle stays a straight line through
    // the anchor.
    const kf: Keyframe = {
      ...makeKeyframe(1, 0),
      inTangent: { x: -0.3, y: -0.4 }, // length 0.5
    };
    const inLen = Math.hypot(kf.inTangent.x, kf.inTangent.y);
    const edited = editTangent(kf, "out", { x: 0.6, y: 0.8 }); // length 1.0
    const newInLen = Math.hypot(edited.inTangent.x, edited.inTangent.y);
    expect(newInLen).toBeCloseTo(inLen, 10); // length preserved
    // collinear & opposite to OUT
    const cross =
      edited.inTangent.x * edited.outTangent.y -
      edited.inTangent.y * edited.outTangent.x;
    expect(cross).toBeCloseTo(0, 10);
    const dot =
      edited.inTangent.x * edited.outTangent.x +
      edited.inTangent.y * edited.outTangent.y;
    expect(dot).toBeLessThan(0);
  });

  it("editing the in-tangent mirrors the out-tangent symmetrically", () => {
    // OUT starts at length 0.5 pointing +x; editing IN flips OUT to the
    // opposite direction of IN while keeping OUT's own length (0.5).
    const kf: Keyframe = {
      ...makeKeyframe(1, 0),
      outTangent: { x: 0.5, y: 0 }, // length 0.5
    };
    const edited = editTangent(kf, "in", { x: -0.6, y: 0.8 }); // unit (-0.6, 0.8)
    expect(edited.inTangent).toEqual({ x: -0.6, y: 0.8 });
    // opposite unit dir of IN is (0.6, -0.8); times OUT length 0.5:
    expect(edited.outTangent.x).toBeCloseTo(0.3, 10);
    expect(edited.outTangent.y).toBeCloseTo(-0.4, 10);
    expect(Math.hypot(edited.outTangent.x, edited.outTangent.y)).toBeCloseTo(
      0.5,
      10,
    );
  });

  it("a broken keyframe leaves the other tangent untouched", () => {
    const kf: Keyframe = { ...makeKeyframe(1, 0), tangentMode: "broken" };
    const originalIn = { ...kf.inTangent };
    const edited = editTangent(kf, "out", { x: 0.9, y: -0.1 });
    expect(edited.outTangent).toEqual({ x: 0.9, y: -0.1 });
    expect(edited.inTangent).toEqual(originalIn);
  });

  it("survives structuredClone with tangentMode intact", () => {
    const kf = editTangent(makeKeyframe(2, 1), "out", { x: 0.3, y: 0.3 });
    const cloned = structuredClone(kf);
    expect(cloned).toEqual(kf);
    expect(cloned.tangentMode).toBe("locked");
    expect(cloned.inTangent).toEqual(kf.inTangent);
    expect(cloned.outTangent).toEqual(kf.outTangent);
  });
});
