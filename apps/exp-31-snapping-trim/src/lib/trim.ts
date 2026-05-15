// Timeline state + pure trim primitives.
//
// Each primitive is `(state, clipId, delta) => state`. The reducer
// composes them with `tag` (which edge) and `mode` (which trim kind).
// Times are seconds. Pixels are not the trim primitive's problem —
// the host converts pixel deltas to seconds before dispatching.

export type Clip = {
  id: string;
  trackId: string;
  start: number;
  duration: number;
  mediaIn: number;
  mediaOut: number;
  mediaDuration: number;
};

export type Marker = { id: string; time: number; label: string };

export type TimelineState = {
  clips: Clip[];
  markers: Marker[];
  playhead: number;
};

export type Edge = "in" | "out";
export type TrimMode = "ripple" | "roll" | "slip" | "slide";

// Comparators on (start, end).
const clipEnd = (c: Clip) => c.start + c.duration;

// Snap candidate values for the whole project (sorted ascending).
export function buildSnapTargets(state: TimelineState): number[] {
  const set = new Set<number>();
  set.add(state.playhead);
  for (const m of state.markers) set.add(m.time);
  for (const c of state.clips) {
    set.add(c.start);
    set.add(clipEnd(c));
  }
  return [...set].sort((a, b) => a - b);
}

// Snap `value` to the nearest of `targets` if within `thresholdSec`.
export function snap(
  value: number,
  targets: number[],
  thresholdSec: number,
): { value: number; target: number | null } {
  let best: number | null = null;
  let bestDist = thresholdSec;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best == null ? { value, target: null } : { value: best, target: best };
}

// Ripple — extend or shrink the edge of `clipId`, shift every later clip
// on the same track by the same delta. The clip itself grows by `delta`
// for an "out" edge, or shrinks by `delta` for an "in" edge.
export function ripple(
  state: TimelineState,
  clipId: string,
  edge: Edge,
  delta: number,
): TimelineState {
  const target = state.clips.find((c) => c.id === clipId);
  if (!target) return state;
  const trackId = target.trackId;
  const targetStart = target.start;

  const next = state.clips.map((c) => {
    if (c.id === clipId) {
      if (edge === "out") {
        const dur = Math.max(0.1, c.duration + delta);
        const grow = dur - c.duration;
        return {
          ...c,
          duration: dur,
          mediaOut: Math.min(c.mediaDuration, c.mediaOut + grow),
        };
      } else {
        const dur = Math.max(0.1, c.duration - delta);
        const shrink = c.duration - dur;
        return {
          ...c,
          start: c.start + shrink,
          duration: dur,
          mediaIn: Math.max(0, c.mediaIn + shrink),
        };
      }
    }
    if (c.trackId !== trackId) return c;
    // For "out" edge: shift any clip starting >= the target's end forward.
    // For "in" edge: same effect — downstream clips shift by `-delta`
    // when the target shrinks.
    if (edge === "out") {
      if (c.start >= targetStart + target.duration - 1e-6) {
        return { ...c, start: c.start + delta };
      }
    } else {
      if (c.start > targetStart) {
        return { ...c, start: c.start - delta };
      }
    }
    return c;
  });
  return { ...state, clips: next };
}

// Roll — extend one clip's out edge, shrink the next clip's in edge by
// the same amount. No other clips move. The "next" clip is the
// adjacent clip on the same track touching `clipId`'s out edge.
export function roll(
  state: TimelineState,
  clipId: string,
  delta: number,
): TimelineState {
  const target = state.clips.find((c) => c.id === clipId);
  if (!target) return state;
  const targetEnd = clipEnd(target);
  const next = state.clips.find(
    (c) => c.trackId === target.trackId && Math.abs(c.start - targetEnd) < 1e-4,
  );
  if (!next) return state;
  // Clamp delta so neither clip collapses.
  const cappedDelta = Math.max(
    -target.duration + 0.1,
    Math.min(next.duration - 0.1, delta),
  );
  return {
    ...state,
    clips: state.clips.map((c) => {
      if (c.id === target.id) {
        return {
          ...c,
          duration: c.duration + cappedDelta,
          mediaOut: Math.min(c.mediaDuration, c.mediaOut + cappedDelta),
        };
      }
      if (c.id === next.id) {
        return {
          ...c,
          start: c.start + cappedDelta,
          duration: c.duration - cappedDelta,
          mediaIn: Math.max(0, c.mediaIn + cappedDelta),
        };
      }
      return c;
    }),
  };
}

// Slip — shift mediaIn/mediaOut by delta, clamped to [0, mediaDuration].
// On-timeline start and duration unchanged. The clip's position is
// fixed; only the source window shifts.
export function slip(
  state: TimelineState,
  clipId: string,
  delta: number,
): TimelineState {
  return {
    ...state,
    clips: state.clips.map((c) => {
      if (c.id !== clipId) return c;
      const newIn = c.mediaIn + delta;
      const newOut = c.mediaOut + delta;
      // Clamp delta so [newIn, newOut] fits [0, mediaDuration].
      let d = delta;
      if (newIn < 0) d = -c.mediaIn;
      else if (newOut > c.mediaDuration) d = c.mediaDuration - c.mediaOut;
      return { ...c, mediaIn: c.mediaIn + d, mediaOut: c.mediaOut + d };
    }),
  };
}

// Slide — shift the clip's start by delta; adjacent clips on the same
// track keep touching by absorbing the change.
export function slide(
  state: TimelineState,
  clipId: string,
  delta: number,
): TimelineState {
  const target = state.clips.find((c) => c.id === clipId);
  if (!target) return state;
  const prev = state.clips.find(
    (c) =>
      c.trackId === target.trackId &&
      Math.abs(clipEnd(c) - target.start) < 1e-4,
  );
  const next = state.clips.find(
    (c) =>
      c.trackId === target.trackId &&
      Math.abs(c.start - clipEnd(target)) < 1e-4,
  );
  // Clamp delta to neighbours.
  let d = delta;
  if (prev && prev.duration + d < 0.1) d = -prev.duration + 0.1;
  if (next && next.duration - d < 0.1) d = next.duration - 0.1;
  return {
    ...state,
    clips: state.clips.map((c) => {
      if (c.id === target.id) return { ...c, start: c.start + d };
      if (prev && c.id === prev.id) {
        return {
          ...c,
          duration: c.duration + d,
          mediaOut: Math.min(c.mediaDuration, c.mediaOut + d),
        };
      }
      if (next && c.id === next.id) {
        return {
          ...c,
          start: c.start + d,
          duration: c.duration - d,
          mediaIn: Math.max(0, c.mediaIn + d),
        };
      }
      return c;
    }),
  };
}

// Convenience dispatcher for the page's reducer.
export function applyTrim(
  state: TimelineState,
  mode: TrimMode,
  clipId: string,
  edge: Edge,
  delta: number,
): TimelineState {
  switch (mode) {
    case "ripple":
      return ripple(state, clipId, edge, delta);
    case "roll":
      return roll(state, clipId, delta);
    case "slip":
      return slip(state, clipId, delta);
    case "slide":
      return slide(state, clipId, delta);
  }
}

// ---- self-test for the in-page "run tests" button ----

export type TestResult = { name: string; pass: boolean; detail: string };

export function runTrimTests(): TestResult[] {
  const out: TestResult[] = [];
  const baseClip = (id: string, trackId: string, start: number): Clip => ({
    id,
    trackId,
    start,
    duration: 2,
    mediaIn: 0,
    mediaOut: 2,
    mediaDuration: 10,
  });
  const seed: TimelineState = {
    clips: [
      baseClip("a", "v0", 0),
      baseClip("b", "v0", 2),
      baseClip("c", "v0", 4),
      baseClip("d", "v1", 1),
    ],
    markers: [],
    playhead: 0,
  };

  // Ripple
  const r = ripple(seed, "a", "out", 1);
  out.push({
    name: "ripple shifts later clips on same track",
    pass:
      r.clips.find((c) => c.id === "b")?.start === 3 &&
      r.clips.find((c) => c.id === "c")?.start === 5,
    detail: `b.start=${r.clips.find((c) => c.id === "b")?.start}, c.start=${r.clips.find((c) => c.id === "c")?.start}`,
  });
  out.push({
    name: "ripple does not touch other tracks",
    pass: r.clips.find((c) => c.id === "d")?.start === 1,
    detail: `d.start=${r.clips.find((c) => c.id === "d")?.start}`,
  });

  // Roll
  const rl = roll(seed, "a", 0.5);
  out.push({
    name: "roll extends one and shrinks neighbour by same delta",
    pass:
      rl.clips.find((c) => c.id === "a")?.duration === 2.5 &&
      rl.clips.find((c) => c.id === "b")?.start === 2.5 &&
      rl.clips.find((c) => c.id === "b")?.duration === 1.5,
    detail: `a.dur=${rl.clips.find((c) => c.id === "a")?.duration}, b.start=${rl.clips.find((c) => c.id === "b")?.start}, b.dur=${rl.clips.find((c) => c.id === "b")?.duration}`,
  });
  out.push({
    name: "roll does not move c",
    pass: rl.clips.find((c) => c.id === "c")?.start === 4,
    detail: `c.start=${rl.clips.find((c) => c.id === "c")?.start}`,
  });

  // Slip
  const sl = slip(seed, "a", 1);
  out.push({
    name: "slip shifts mediaIn/mediaOut without moving start",
    pass:
      sl.clips.find((c) => c.id === "a")?.start === 0 &&
      sl.clips.find((c) => c.id === "a")?.mediaIn === 1 &&
      sl.clips.find((c) => c.id === "a")?.mediaOut === 3,
    detail: `mediaIn=${sl.clips.find((c) => c.id === "a")?.mediaIn}, mediaOut=${sl.clips.find((c) => c.id === "a")?.mediaOut}`,
  });
  const sl2 = slip(seed, "a", 100);
  out.push({
    name: "slip clamps to mediaDuration",
    pass:
      (sl2.clips.find((c) => c.id === "a")?.mediaOut ?? 0) <= 10 &&
      (sl2.clips.find((c) => c.id === "a")?.mediaIn ?? 0) >= 0,
    detail: `mediaIn=${sl2.clips.find((c) => c.id === "a")?.mediaIn}, mediaOut=${sl2.clips.find((c) => c.id === "a")?.mediaOut}`,
  });

  // Slide
  const sd = slide(seed, "b", 0.5);
  out.push({
    name: "slide moves clip and keeps neighbours touching",
    pass:
      sd.clips.find((c) => c.id === "b")?.start === 2.5 &&
      sd.clips.find((c) => c.id === "a")?.duration === 2.5 &&
      sd.clips.find((c) => c.id === "c")?.start === 4.5 &&
      sd.clips.find((c) => c.id === "c")?.duration === 1.5,
    detail: `a.dur=${sd.clips.find((c) => c.id === "a")?.duration}, b.start=${sd.clips.find((c) => c.id === "b")?.start}, c.start=${sd.clips.find((c) => c.id === "c")?.start}, c.dur=${sd.clips.find((c) => c.id === "c")?.duration}`,
  });

  return out;
}

// Seed a deterministic 500-clip dataset across 4 tracks.
export function seed500(): TimelineState {
  const tracks = ["v0", "v1", "v2", "v3"];
  const clips: Clip[] = [];
  let seed = 0x42a3;
  const rand = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff;
  };
  for (const trackId of tracks) {
    let cursor = 0;
    for (let i = 0; i < 125; i++) {
      const dur = 0.5 + rand() * 3.5;
      const gap = rand() < 0.6 ? 0 : 0.1 + rand() * 0.6;
      cursor += gap;
      clips.push({
        id: `${trackId}-${i}`,
        trackId,
        start: cursor,
        duration: dur,
        mediaIn: 0,
        mediaOut: dur,
        mediaDuration: dur + 5,
      });
      cursor += dur;
    }
  }
  return {
    clips,
    markers: [
      { id: "m0", time: 5, label: "intro" },
      { id: "m1", time: 30, label: "act II" },
      { id: "m2", time: 120, label: "outro" },
    ],
    playhead: 0,
  };
}
