import { describe, it, expect } from "vitest";
import { median, computeStats, type LoAFEntry } from "../apps/exp-28-loaf-budget/src/lib/loaf";

describe("exp-28 median", () => {
  it("averages the two middle elements for even-length arrays", () => {
    expect(median([10, 20])).toBe(15);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns the middle element for odd-length arrays", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([5])).toBe(5);
  });

  it("returns 0 for an empty array (matches computeStats empty contract)", () => {
    expect(median([])).toBe(0);
  });

  it("does not require a pre-sorted input", () => {
    expect(median([20, 10])).toBe(15);
    expect(median([3, 1, 2])).toBe(2);
  });
});

describe("exp-28 computeStats median", () => {
  const mkEntry = (duration: number): LoAFEntry => ({
    name: "long-animation-frame",
    entryType: "long-animation-frame",
    startTime: 0,
    duration,
    renderStart: 0,
    styleAndLayoutStart: 0,
    firstUIEventTimestamp: 0,
    blockingDuration: 0,
    scripts: [],
  });

  it("computeStats median averages the two middles for even counts", () => {
    const stats = computeStats([mkEntry(10), mkEntry(20)]);
    expect(stats.median).toBe(15);
    expect(stats.count).toBe(2);
    expect(stats.max).toBe(20);
  });

  it("computeStats median is the middle for odd counts", () => {
    const stats = computeStats([mkEntry(10), mkEntry(30), mkEntry(20)]);
    expect(stats.median).toBe(20);
  });
});
