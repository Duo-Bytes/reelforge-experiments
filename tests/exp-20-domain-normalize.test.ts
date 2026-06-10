import { describe, it, expect } from "vitest";
import { domainNormalize } from "../apps/exp-20-lut-3d/src/lib/cube";

describe("exp-20 domainNormalize", () => {
  it("maps input via uvw = (rgb - min) / (max - min)", () => {
    // Domain [0,0,0]..[2,2,2]: input 1.0 maps to 0.5.
    expect(
      domainNormalize([1, 1, 1], [0, 0, 0], [2, 2, 2]),
    ).toEqual([0.5, 0.5, 0.5]);
  });

  it("is identity for the default [0,1] domain", () => {
    expect(domainNormalize([0, 0.5, 1], [0, 0, 0], [1, 1, 1])).toEqual([
      0, 0.5, 1,
    ]);
  });

  it("handles per-channel domains independently", () => {
    // R domain [0,4] -> 2 maps to 0.5; G domain [1,2] -> 1.5 maps to 0.5;
    // B domain [0,1] identity -> 0.25.
    expect(
      domainNormalize([2, 1.5, 0.25], [0, 1, 0], [4, 2, 1]),
    ).toEqual([0.5, 0.5, 0.25]);
  });

  it("guards against a zero-width domain (avoids divide-by-zero)", () => {
    const out = domainNormalize([1, 1, 1], [1, 1, 1], [1, 1, 1]);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });
});
