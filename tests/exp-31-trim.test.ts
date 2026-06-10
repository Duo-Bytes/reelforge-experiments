import { describe, it, expect } from "vitest";
import {
  ripple,
  roll,
  slip,
  slide,
  runTrimTests,
  type Clip,
  type TimelineState,
} from "../apps/exp-31-snapping-trim/src/lib/trim";

const baseClip = (id: string, trackId: string, start: number): Clip => ({
  id,
  trackId,
  start,
  duration: 2,
  mediaIn: 0,
  mediaOut: 2,
  mediaDuration: 10,
});

const seed = (): TimelineState => ({
  clips: [
    baseClip("a", "v0", 0),
    baseClip("b", "v0", 2),
    baseClip("c", "v0", 4),
    baseClip("d", "v1", 1),
  ],
  markers: [],
  playhead: 0,
});

const find = (s: TimelineState, id: string): Clip =>
  s.clips.find((c) => c.id === id)!;

describe("exp-31 trim primitives", () => {
  it("ripple (out) shifts later clips on the same track by delta", () => {
    const r = ripple(seed(), "a", "out", 1);
    expect(find(r, "a").duration).toBe(3);
    expect(find(r, "b").start).toBe(3);
    expect(find(r, "c").start).toBe(5);
  });

  it("ripple does not touch clips on other tracks", () => {
    const r = ripple(seed(), "a", "out", 1);
    expect(find(r, "d").start).toBe(1);
  });

  it("roll extends one clip and shrinks its neighbour by the same delta", () => {
    const rl = roll(seed(), "a", 0.5);
    expect(find(rl, "a").duration).toBe(2.5);
    expect(find(rl, "b").start).toBe(2.5);
    expect(find(rl, "b").duration).toBe(1.5);
    // c (not adjacent to the rolled edge) must not move.
    expect(find(rl, "c").start).toBe(4);
  });

  it("slip shifts mediaIn/mediaOut without moving start or duration", () => {
    const sl = slip(seed(), "a", 1);
    const a = find(sl, "a");
    expect(a.start).toBe(0);
    expect(a.duration).toBe(2);
    expect(a.mediaIn).toBe(1);
    expect(a.mediaOut).toBe(3);
  });

  it("slip clamps the source window to [0, mediaDuration]", () => {
    const sl = slip(seed(), "a", 100);
    const a = find(sl, "a");
    expect(a.mediaIn).toBeGreaterThanOrEqual(0);
    expect(a.mediaOut).toBeLessThanOrEqual(10);
  });

  it("slide moves a clip while neighbours absorb the change and stay touching", () => {
    const sd = slide(seed(), "b", 0.5);
    expect(find(sd, "b").start).toBe(2.5);
    expect(find(sd, "a").duration).toBe(2.5);
    expect(find(sd, "c").start).toBe(4.5);
    expect(find(sd, "c").duration).toBe(1.5);
  });

  it("the in-page self-test suite all passes (documented invariants)", () => {
    const results = runTrimTests();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.pass, `${r.name}: ${r.detail}`).toBe(true);
    }
  });
});
