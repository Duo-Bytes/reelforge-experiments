# Exp-09 · Timeline State

## Goal

Build a React timeline UI with 500+ clips across multiple tracks, a playhead that animates at 60fps, and drag-and-drop clip repositioning — with zero React re-renders during scrubbing and zero re-renders of non-moving clips during drag.

This experiment is independent of the media pipeline. It proves the UI layer can handle NLE-scale state without becoming a bottleneck.

---

## App Location

`apps/exp-09-timeline-state/`

## Why This Matters in the Full NLE

A React timeline with 500 clips using naive `useState` for the playhead will trigger 30,000 re-renders per second during playback (500 clips × 60fps). The DOM cannot keep up. This experiment establishes the patterns that make the timeline fast:
1. Playhead position lives in a `ref`, updated via direct DOM style mutation — never React state
2. Clip positions use atomic Zustand selectors — only the dragged clip re-renders
3. Visible clips only rendered via `react-window` virtualization

---

## Tech Stack for This Experiment

```bash
npm install zustand immer react-window @dnd-kit/core @dnd-kit/sortable
npm install -D @types/react-window
```

---

## Data Model

```ts
// types.ts

type ClipId = string
type TrackId = string

interface Clip {
  id: ClipId
  trackId: TrackId
  startUs: number    // position on timeline (microseconds from t=0)
  durationUs: number
  sourceFileId: string
  label: string
  color: string
}

interface Track {
  id: TrackId
  label: string
  type: 'video' | 'audio'
  clipIds: ClipId[]  // ordered by startUs
}

interface TimelineState {
  tracks: Track[]
  clips: Record<ClipId, Clip>
  zoom: number           // pixels per second
  scrollOffsetPx: number // horizontal scroll position
  selectedClipIds: Set<ClipId>
  // Playhead is NOT here — it lives in a ref
}
```

**Playhead is never in the Zustand store.** It updates 60× per second and must not trigger any React re-renders.

---

## Architecture

```
Main Thread
│
├── useTimelineStore (Zustand + Immer)
│   ├── tracks, clips, zoom, scroll, selection
│   └── actions: addClip, moveClip, trimClip, selectClip, setZoom
│
├── <Timeline> component
│   ├── Renders tracks list (Zustand subscription: tracks array, useShallow)
│   └── For each track: <TrackRow> component
│
├── <TrackRow> component (per track)
│   └── react-window FixedSizeList (virtualized)
│       └── For each visible clip: <ClipItem>
│
├── <ClipItem> component
│   ├── Zustand subscription: useTimelineStore(s => s.clips[id]) — ATOMIC
│   └── Drag: transient position via CSS transform + ref (no state update until mouseup)
│
└── <Playhead> component
    ├── ref = useRef<HTMLDivElement>(null)
    └── Updated by: playheadRef.current.style.transform = `translateX(${px}px)` in rAF loop
```

---

## Implementation Steps

### 1. Create the Zustand store with Immer middleware

```ts
// store/timeline.ts
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

interface TimelineActions {
  addClip: (clip: Clip) => void
  moveClip: (id: ClipId, newStartUs: number) => void
  selectClip: (id: ClipId, multi: boolean) => void
  setZoom: (zoom: number) => void
}

export const useTimelineStore = create<TimelineState & TimelineActions>()(
  immer((set) => ({
    tracks: [],
    clips: {},
    zoom: 100,
    scrollOffsetPx: 0,
    selectedClipIds: new Set(),

    addClip: (clip) => set((state) => {
      state.clips[clip.id] = clip
      const track = state.tracks.find(t => t.id === clip.trackId)
      if (track) track.clipIds.push(clip.id)
    }),

    moveClip: (id, newStartUs) => set((state) => {
      state.clips[id].startUs = newStartUs  // Immer makes this safe
    }),

    selectClip: (id, multi) => set((state) => {
      if (!multi) state.selectedClipIds = new Set([id])
      else state.selectedClipIds.add(id)
    }),

    setZoom: (zoom) => set((state) => { state.zoom = zoom }),
  }))
)
```

### 2. Atomic selector per clip (prevents cascading re-renders)

```tsx
// components/ClipItem.tsx
import { useTimelineStore } from '../store/timeline'

export function ClipItem({ clipId }: { clipId: ClipId }) {
  // This component ONLY re-renders when this specific clip changes
  // It does NOT re-render when other clips, zoom, or playhead change
  const clip = useTimelineStore((s) => s.clips[clipId])
  const zoom = useTimelineStore((s) => s.zoom)

  const widthPx = (clip.durationUs / 1_000_000) * zoom
  const leftPx = (clip.startUs / 1_000_000) * zoom

  return (
    <div
      style={{
        position: 'absolute',
        left: leftPx,
        width: widthPx,
        backgroundColor: clip.color,
      }}
      className="h-12 rounded cursor-pointer border border-white/20 overflow-hidden"
    >
      <span className="text-xs text-white px-1 truncate">{clip.label}</span>
    </div>
  )
}
```

### 3. Transient drag position (no state update during drag)

```tsx
// During drag: update CSS transform directly on the DOM node
// Only commit to Zustand on mouseup (or onDragEnd from dnd-kit)

function ClipItem({ clipId }: { clipId: ClipId }) {
  const divRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef<number>(0)
  const dragStartLeft = useRef<number>(0)

  const onMouseDown = (e: React.MouseEvent) => {
    dragStartX.current = e.clientX
    const computedLeft = parseFloat(divRef.current!.style.left)
    dragStartLeft.current = computedLeft

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - dragStartX.current
      const newLeft = dragStartLeft.current + delta
      // Direct DOM mutation — no React state, no re-render
      divRef.current!.style.left = `${newLeft}px`
    }

    const onMouseUp = (e: MouseEvent) => {
      const delta = e.clientX - dragStartX.current
      const newLeftPx = dragStartLeft.current + delta
      const zoom = useTimelineStore.getState().zoom
      const newStartUs = (newLeftPx / zoom) * 1_000_000
      // ONLY NOW commit to Zustand
      useTimelineStore.getState().moveClip(clipId, newStartUs)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  return <div ref={divRef} onMouseDown={onMouseDown} ... />
}
```

### 4. Playhead: pure ref, no state

```tsx
// components/Playhead.tsx
import { useEffect, useRef } from 'react'

export function Playhead({ zoom }: { zoom: number }) {
  const lineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // This effect runs ONCE — the rAF loop drives updates
    let rafId: number
    const loop = () => {
      const currentUs = getAudioCurrentTimeUs()  // from audio sync module
      const px = (currentUs / 1_000_000) * zoom
      if (lineRef.current) {
        lineRef.current.style.transform = `translateX(${px}px)`
      }
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [zoom])  // zoom changes → recalculate px mapping

  return (
    <div
      ref={lineRef}
      className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none z-50"
      style={{ willChange: 'transform' }}
    />
  )
}
```

### 5. Virtualized track rows with `react-window`

For each track, clips are positioned absolutely within a relative container. Use `react-window`'s `FixedSizeList` to virtualize which clips are rendered based on the timeline's horizontal scroll position:

```tsx
import { FixedSizeList } from 'react-window'

// The "list" is all clip positions on this track
// Only render clips whose pixel range overlaps the visible viewport
const visibleClips = allClips.filter(clip => {
  const leftPx = (clip.startUs / 1_000_000) * zoom
  const rightPx = leftPx + (clip.durationUs / 1_000_000) * zoom
  return rightPx > scrollOffsetPx && leftPx < scrollOffsetPx + viewportWidth
})
```

### 6. Seed 500 clips and measure

```ts
// Generate 500 clips across 5 tracks
const clips: Clip[] = Array.from({ length: 500 }, (_, i) => ({
  id: `clip-${i}`,
  trackId: `track-${i % 5}`,
  startUs: i * 3_000_000,        // 3 seconds apart
  durationUs: 2_500_000,          // 2.5 seconds long
  sourceFileId: 'demo',
  label: `Clip ${i}`,
  color: COLORS[i % COLORS.length],
}))
```

Open React DevTools Profiler → Record → scrub the timeline for 5 seconds → Stop. Count re-renders.

---

## Verifying Zero Re-renders

Install React Scan for automated detection:
```bash
npm install react-scan
```
```ts
import { scan } from 'react-scan'
scan({ enabled: process.env.NODE_ENV === 'development', log: true })
```
React Scan highlights components that re-render. During scrubbing, only `<Playhead>` (which is a ref, not a state update) should show activity. If `<ClipItem>` components highlight, there's a selector issue.

---

## Known Pitfalls

**`useShallow` for array/object selectors.**
If a Zustand selector returns an object or array, it re-renders on every store update even if the returned value is structurally identical. Wrap with `useShallow`:
```ts
import { useShallow } from 'zustand/react/shallow'
const trackIds = useTimelineStore(useShallow(s => s.tracks.map(t => t.id)))
```

**Immer `Set` support.**
Immer 10+ supports ES6 `Set` and `Map` natively. Earlier versions require `enableMapSet()`. If using Immer via Zustand middleware, the version is bundled — check and call `enableMapSet()` if needed.

**`react-window` with absolute positioning.**
`react-window` is designed for list items with fixed heights/widths. Clips with variable widths + absolute positioning within a track need a custom "overscan" approach rather than standard `FixedSizeList`. Implement a custom virtualization: filter visible clips based on scroll position, render only those.

---

## Success Criteria

| Metric | Target |
|---|---|
| 500 clips rendered, no jank on scroll | Smooth scroll at 60fps |
| Playhead moves at 60fps | 0 React re-renders (verified with React Scan) |
| Dragging one clip | Only that clip's DOM node re-renders on mouseup |
| React re-renders during 5s scrub | 0 component re-renders (only ref mutations) |
| Memory: 500 clips | < 50MB heap increase vs empty timeline |

---

## Feeds Into

- **Exp-12** uses this state architecture for the full editor timeline. The store shape defined here (`Track[]`, `Clip[]`, `Record<ClipId, Clip>`) becomes the canonical data model.
