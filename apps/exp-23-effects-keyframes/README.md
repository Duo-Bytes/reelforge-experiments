# exp-23 · Effects/Transitions Framework with Bezier Keyframes

## Purpose

Prove a plugin contract for effects and a handle-based bezier-curve
animation system that evaluates to a numeric value at any time. The
graph editor and evaluator must both run at 60 fps; effect ordering
must be deterministic and observable in the live preview.

Every NLE animates parameters this way. There is no built-in web API
for it — the evaluator, tangent semantics, and ordering rule have to be
designed in-house. This experiment builds the smallest credible version
of all three.

## What's here

- `src/lib/keyframes.ts` — `evaluate(track, time)` with cubic-bezier
  segments and Newton's-method t-solve (8 iters, bisection fall-back at
  |dx/dt| &lt; 1e-6). Hold and linear modes short-circuit the cubic.
- `src/lib/effects.ts` — plugin contract: `{ id, name, paramSchema,
  wgslSource }`. Two demo effects (`Brightness`, `Gaussian Blur`).
- `src/app/page.tsx` — timeline strip per parameter, click to add a
  keyframe, right-click to remove, select a key to edit its tangents in
  the SVG sub-panel. Reorderable effect stack. Live canvas preview.

## How to run

```
pnpm --filter exp-23-effects-keyframes dev
```

Open the page. Scrub the playhead; click any parameter strip to drop a
keyframe at the current value. Click a green dot to open the curve
editor and drag the orange/green tangent handles. Use the up/dn
buttons in the effect stack panel to reorder.

## What to look for

- The frame-time meter stays well under 16 ms with both effects active
  and two parameter tracks animating.
- `evaluate()` cost stays in the single-digit microseconds even after
  you've sprinkled in many keyframes (the binary search keeps it
  amortised log-n).
- Swap Brightness/Blur ordering and watch the preview re-render with
  the new ordering on the next frame.

## Success bar

1. A track with 200 random keyframes evaluates at &lt; 50 µs per call.
2. Graph editor handle drag is visually smooth at 60 fps.
3. Swapping effect order changes the preview output deterministically.
4. Project state survives `structuredClone` round-trip (verify in
   DevTools: `structuredClone($r.props.stack)`).

## Known foot-guns

- A cubic bezier in (time, value) space is not parameterised by time.
  Naive `lerp(time)` looks right on linear ramps and wrong everywhere
  else. The lib explicitly solves for `t` from `x` first.
- Locked tangents must mirror in angle, not in component — otherwise a
  symmetric ease becomes asymmetric after one drag. (This experiment
  treats both handles as independent for clarity; the production reducer
  is the place to implement the lock.)
- Effect ordering is part of project state. Sort by anything user-facing
  (name, type, id) and you've lost the user's intended order.
