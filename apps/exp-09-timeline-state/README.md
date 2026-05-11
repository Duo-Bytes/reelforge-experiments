# exp-09 · Timeline State

## Purpose

Build a **React** timeline UI that survives 500+ clips, a 60fps playhead, and constant drag/zoom interaction without grinding the main thread. A naive `useState` playhead with 500 clip subscriptions = 30,000 re-renders/sec. Solution: atomic Zustand+Immer selectors per clip, viewport culling, and a refs-only playhead that bypasses React entirely.

## Architecture

```
src/store/timeline.ts (Zustand + Immer + Set support)
├── State: tracks: Track[], clips: Record<ClipId, Clip>, zoom, scrollOffsetPx, selectedClipIds: Set
├── Actions: seedClips, addClip, moveClip, trimClip, selectClip, setZoom, setScroll
└── getTimelineSnapshot() — read store outside React (used by drag handlers)

src/components/ClipItem.tsx
├── useTimelineStore(s => s.clips[clipId])      ← atomic per-clip
├── useTimelineStore(s => s.zoom)               ← atomic zoom
├── useTimelineStore(s => s.selectedClipIds.has(clipId))  ← atomic selection bit
├── pointerdown -> capture pointer, stash startX/startLeft in ref (NO setState)
├── pointermove -> ref.style.transform = translateX(dx)   ← direct DOM mutation
└── pointerup   -> single getTimelineSnapshot().moveClip(clipId, newStartUs) commit

src/components/TrackRow.tsx
├── useTimelineStore(useShallow(s => track.clipIds))   ← stable ref unless ids change
├── Manual viewport cull:
│     visibleStart = scroll - 200, visibleEnd = scroll + viewportPx + 200
│     filter clipIds whose pixel range overlaps -> render only visible
└── No FixedSizeList because clips are absolutely positioned with variable widths

src/components/Playhead.tsx
├── ref-only: ZERO React re-renders during playback
├── useEffect installs ONE rAF loop on mount
├── playheadUsRef.current += dt * 1000 (when playingRef.current)
├── px = (playheadUs / 1e6) * zoom - scrollOffset
└── ref.current.style.transform = `translateX(${px}px)`   ← direct DOM mutation

src/app/page.tsx
├── Mounts <TrackRow> per trackId (subscribed via useShallow)
├── Holds playingRef, playheadUsRef, scrollRef as plain refs
├── FPS meter via separate rAF loop mutating textContent (no setState)
└── Reseed input + zoom slider (only zoom triggers visible re-renders)
```

## Research notes

- **Atomic selectors** are the core of avoiding cascade re-renders. `s => s.clips[id]` returns a stable reference (Immer creates a new object only when *that clip* mutates) so `ClipItem` for clip 42 does not re-render when clip 7 moves.
- **`useShallow`** is required for selectors that return arrays/objects (`s => s.tracks.map(t => t.id)`). Without it, every store update creates a new array reference and the component re-renders on every commit.
- **Direct DOM mutation during drag.** Setting `ref.current.style.transform` skips React entirely. Committing `moveClip` once on pointerup means a single re-render for the moved clip — not 60 per second.
- **`getTimelineSnapshot()`** (`useTimelineStore.getState()`) lets pointer handlers read the live store outside React's render cycle. Avoids stale-closure bugs and prevents subscribing to fields the handler shouldn't depend on.
- **Refs-only playhead.** The single biggest win. The playhead is a `<div>` whose `style.transform` is updated by a rAF loop. Zero subscriptions, zero re-renders, ever. The `zoom` value is read inside the loop via `useTimelineStore.getState()` so we don't even subscribe to that.
- **Pointer events over mouse events.** `setPointerCapture(e.pointerId)` keeps the drag working even when the cursor leaves the clip element — no need for global `mousemove`/`mouseup` listeners that leak between drags.
- **Immer Set/Map support** requires `enableMapSet()` (called once at module load).
- **Viewport culling** with overscan = 200px keeps DOM node count bounded regardless of total clip count. Off-screen clips don't exist in the DOM, so resize/scroll cost is O(visible) not O(total).
- **`react-window` doesn't fit** absolute-positioned variable-width clips. Manual filter on `clip.startUs/durationUs/zoom` against `[scroll, scroll+viewport]` is straightforward and faster than reaching for a list-virtualizer.
- **`@dnd-kit/core`** (mentioned in the doc) is overkill for translate-only drags. Native pointer events + `setPointerCapture` give us sub-millisecond drag response with no bundle cost.

## Files

| File | Purpose |
|---|---|
| `src/lib/types.ts` | `Clip`, `Track`, `ClipId`, `TrackId`, color palette |
| `src/store/timeline.ts` | Zustand+Immer store, seed action, selectors |
| `src/components/ClipItem.tsx` | Atomic-per-clip subscription, pointer-capture drag, ref-mutation |
| `src/components/TrackRow.tsx` | Per-track viewport-cull virtualization |
| `src/components/Playhead.tsx` | Refs-only playhead — does not re-render |
| `src/app/page.tsx` | Transport controls, zoom slider, reseed, FPS meter |

## Run

```bash
pnpm --filter exp-09-timeline-state dev
```

Open the [React Scan](https://github.com/aidenybai/react-scan) bookmarklet to visualize re-renders. Drag a clip — only that clip flashes. Press play — nothing flashes (playhead is pure DOM).

## Success criteria

| Metric | Target |
|---|---|
| 500 clips, smooth scroll | 60fps in DevTools Performance |
| Playhead at 60fps | 0 React re-renders during playback |
| Dragging one clip | only that clip's DOM node mutates; commit on pointerup only |
| 5s scrub session | 0 component re-renders (verified with React Scan) |
| 500-clip heap delta vs empty | < 50MB |
