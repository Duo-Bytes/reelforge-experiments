# Exp-23 · Effects/Transitions Framework with Bezier Keyframes

## Goal

Prove a plugin contract for effects with typed parameter schemas, a
handle-based bezier-curve animation system (locked/broken tangents) that
evaluates to a numeric value at any time, and a deterministic ordering
rule for stacked effects on a clip. The evaluator and the curve editor
must run at 60 fps on a track with hundreds of keyframes.

## App Location

`apps/exp-23-effects-keyframes/`

## Why This Matters in the Full NLE

Every NLE animates parameters with bezier handles. There is no built-in
web API for this — it has to be designed and benchmarked. The graph
editor's job (drag handles, broken/locked tangents, hold steps) is
trivial visually and subtle mathematically: a 1D solve for `t` from `x`
on a cubic bezier segment using Newton's method, with a fall-back
bisection for ill-conditioned curves. Effect ordering is also load
bearing — `Brightness → Blur` is not the same as `Blur → Brightness`,
and any reorder must propagate to the WebGPU compositor (exp-04).

## Key APIs

| API | Where used |
|---|---|
| Custom evaluator (no spec) | `evaluate(track, time)` with cubic bezier + Newton solve |
| WGSL preprocessor | Inject parameter uniforms into effect shaders |
| `structuredClone` | Plugin params travel to workers / undo stack |
| WebGPU render pipeline | Live preview of the effect stack |
| SVG (curve editor) | Drag points + tangent handles |

## Model

```ts
type Keyframe = {
  time: number;            // seconds on the local track
  value: number;
  inTangent: { x: number; y: number };   // relative offset, seconds × value
  outTangent: { x: number; y: number };
  type: "linear" | "bezier" | "hold";
};

type Effect = {
  id: string;
  name: string;
  paramSchema: Array<{
    key: string;
    type: "f32" | "vec2" | "color";
    default: number;
    min: number;
    max: number;
  }>;
  wgslSource: string;      // run through a tiny preprocessor at link time
};
```

`evaluate(track: Keyframe[], time: number): number` walks the segment,
clamps before/after, and for bezier segments solves for `t` from the
elapsed-time x-coordinate using Newton's method (8 iterations, fall back
to bisection if the derivative collapses).

## Approach

1. Implement the evaluator and unit-style sanity checks against known
   curves (linear ramp, ease-in/ease-out, hold step).
2. Build two demo effects: `Brightness` and `Gaussian Blur` (stubbed as
   a box blur in WGSL for sample-budget reasons).
3. Page UI: a 0–10 s timeline strip, a playhead slider, a parameter row
   per effect parameter, click-to-add / drag-to-move / right-click to
   remove a keyframe, and an SVG sub-panel for tangent editing.
4. Live WebGPU preview canvas: render a test gradient with the keyframed
   effect stack applied at the current playhead. Reorder effects via
   up/down buttons — the preview must reflect the new ordering on the
   next frame.
5. Frame-time meter: keep evaluator + WebGPU submit under 16 ms.

## Success Criteria

1. A track with 200 random keyframes evaluates at < 50 µs per call.
2. The graph editor's handle drag is visually smooth at 60 fps.
3. Swapping effect order changes the preview output (and does so
   deterministically across reloads).
4. The curve editor's broken-tangent toggle survives a round-trip
   through `structuredClone`.

## Foot-guns

- A cubic bezier in (time, value) space is *not* parameterised by time.
  You always have to solve for `t` first. Naive `lerp(time)` looks fine
  on linear ramps and wrong everywhere else.
- Newton's method diverges on near-vertical tangents. Fall back to
  bisection if `|dx/dt| < 1e-6`.
- Locked tangents must mirror in *angle*, not in component — otherwise a
  flat ease becomes asymmetric after a drag.
- Effect ordering is part of project state. If your reducer key-sorts
  effects, the user's intended order is silently lost.
- WGSL doesn't have `#include`. The preprocessor must inline parameter
  uniforms before pipeline creation.
