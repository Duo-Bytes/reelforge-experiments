# Exp-31 · Snapping Engine + Ripple/Roll/Slip/Slide

## Goal

Prove a frame-accurate magnetic snapping engine (clip edges, playhead,
markers) and the four core trim primitives — ripple, roll, slip, slide
— each implemented as a pure function over an in-memory timeline state.
The hot path must hold < 16 ms drag latency on a 500-clip timeline.

## App Location

`apps/exp-31-snapping-trim/`

## Why This Matters in the Full NLE

These are the editing primitives every NLE has. They are non-trivial
to implement correctly — ripple has to move every downstream clip on
the same track, roll has to keep the cut centred between two clips,
slip moves the source window without moving the clip, slide moves the
clip while keeping its neighbours touching. They must compose with
undo/redo (exp-09) and with linked audio/video clips. A 500-clip
project is on the small side of "realistic"; latency must stay flat.

## Key APIs

| API | Where used |
|---|---|
| `PointerEvent.getCoalescedEvents()` | Sub-frame pointer samples |
| `requestAnimationFrame` | Commit drag deltas once per frame |
| `useRef` + manual DOM mutation | Hot-path style writes (avoid React churn) |
| `useReducer` | Committed state on pointerup (undo-friendly) |
| `performance.now()` | Drag-latency measurement |

## Model

```ts
type Clip = {
  id: string;
  trackId: string;
  start: number;          // seconds on the timeline
  duration: number;
  mediaIn: number;        // seconds into the source asset
  mediaOut: number;
  mediaDuration: number;  // length of the underlying asset
};
```

Trim primitives are pure functions `(state, clipId, delta) → state`:

- **Ripple** — adjusting a clip's right edge by `+delta` extends the
  clip and shifts every later clip on the same track by `+delta`.
- **Roll** — extending one clip's outpoint by `+delta` shrinks the next
  clip's inpoint by the same amount; no other clips move.
- **Slip** — clip's timeline position is unchanged; `mediaIn` and
  `mediaOut` both shift by `+delta`, clamped to `[0, mediaDuration]`.
- **Slide** — clip's `start` shifts by `+delta`; the previous clip's
  outpoint and the next clip's inpoint adjust to stay touching.

## Approach

1. Seed 500 clips across 4 tracks, mixed lengths, some adjacent some
   gapped. Render via absolute-positioned `<div>`s with simple
   horizontal windowing (only render clips whose `[start, end]`
   intersects the visible scroll range).
2. Snap engine: on every pointermove, compute the nearest of {playhead,
   any clip edge in the visible range, any marker} to the dragged
   edge. Snap if within N px (8 default, configurable). Draw a vertical
   snap-line at the snap target.
3. Coalesce pointer events with `event.getCoalescedEvents()` so a
   1000 Hz mouse on a 60 Hz display produces one commit per frame.
4. During drag, mutate the dragged clip's `style.left` / `style.width`
   directly via `useRef` — do not call `setState`. On pointerup, commit
   the whole delta to the reducer in a single dispatch. This is what
   keeps the reducer fast.
5. Status panel: drag latency (`pointermove → rAF → DOM mutation`),
   clip count, snap target, current trim mode.

## Success Criteria

1. With 500 clips, dragging an edge keeps p95 latency < 16 ms.
2. Each of the four primitives produces the correct state delta on a
   canned test (asserted in-page on a "run tests" button).
3. Snap-line appears exactly when the cursor is within N px of a
   target and disappears the moment it isn't.
4. Undoing a ripple restores all downstream clips to their previous
   positions in a single step.

## Foot-guns

- `setState` on every pointermove kills the timeline. Use refs for the
  hot path and only dispatch once on pointerup.
- Coalesced events arrive in *order*, not as a single point — the
  meaningful delta is the most recent event, not the sum.
- Ripple must not modify clips on *other* tracks; check `trackId`.
- Slip must clamp to the asset duration, not to the clip duration —
  otherwise the user can slip past the available media.
- Floating-point time drift compounds over many edits. Either round to
  the frame boundary on commit, or use rational numbers (n / 24000)
  if you want sample-accurate timecode.
- The visible-window cull must use the *committed* state for layout
  but the *live* drag position for the dragged clip — otherwise the
  dragged clip pops out of the viewport mid-drag.
