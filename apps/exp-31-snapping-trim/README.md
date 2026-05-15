# exp-31 · Snapping Engine + Ripple/Roll/Slip/Slide

## Purpose

Prove that the four core trim primitives — ripple, roll, slip, slide —
plus a magnetic snapping engine hold sub-16 ms drag latency on a
500-clip timeline. These are the editing primitives every NLE has.
They are non-trivial to get right (each has its own definition of
"what moves") and they have to compose with undo/redo and linked
clips down the line.

## What's here

- `src/lib/trim.ts` — pure trim primitives + snap math + a seeded
  500-clip generator + an in-page test harness that asserts each
  primitive against a canned scenario.
- `src/app/page.tsx` — windowed timeline (only clips intersecting the
  scroll viewport are mounted), pointer-event coalescing, rAF-batched
  DOM mutation in the hot path, `useReducer` commit on pointerup.

## How to run

```
pnpm --filter exp-31-snapping-trim dev
```

The page loads with 500 clips across 4 tracks. Drag a left/right edge
of any clip. Switch trim modes with the buttons. Adjust the snap
threshold with the slider.

## What to look for

- The "drag latency" stat stays under 16 ms while dragging — it
  measures `pointermove → rAF → DOM mutation`. Coalesced pointer
  events fold to "latest point wins" rather than "sum of deltas",
  which is what makes the math sane at 1000 Hz mice.
- The snap line appears exactly when the cursor is within N px of a
  target (playhead / clip edge / marker) and disappears the moment it
  isn't.
- The "run tests" button asserts each primitive against a known
  scenario; all should pass.

## Success bar

1. With 500 clips, dragging an edge keeps p95 latency &lt; 16 ms.
2. Each primitive produces the correct state delta on the canned test.
3. The snap line tracks the threshold accurately and disappears when
   outside it.
4. State is one commit per drag — confirm by checking the React
   devtools and noting only one render on pointerup.

## Known foot-guns

- `setState` on every pointermove kills the timeline. The dragged
  clip&apos;s `style.left` and `style.width` are mutated directly via
  `useRef`; only pointerup dispatches.
- Coalesced events come in order, not as one mega-delta. We take the
  most recent sample — the meaningful position is the latest, not the
  sum.
- Ripple must only touch clips on the same `trackId`. Cross-track
  ripple is a different feature (called "ripple all" elsewhere).
- Slip clamps to `mediaDuration`, not `duration` — otherwise the user
  can slip past the end of the source asset.
- The window cull uses committed state for layout; the live drag
  position is applied by direct DOM mutation. Otherwise the dragged
  clip can pop out of the viewport mid-drag.
- Float drift compounds. Each commit is rounded to the 240 Hz frame
  quantum — switch to rational time if you need sample-accurate
  timecode.
