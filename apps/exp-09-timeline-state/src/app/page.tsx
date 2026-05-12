'use client'

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTimeline, seed } from '../lib/store'

const TRACK_HEIGHT = 56
const HEADER_HEIGHT = 28

declare global {
  interface Window { __renders?: Record<string, number> }
}
function tick(label: string) {
  if (typeof window === 'undefined') return
  window.__renders ??= {}
  window.__renders[label] = (window.__renders[label] ?? 0) + 1
}

const ClipItem = memo(function ClipItem({ id, pxPerUs }: { id: string; pxPerUs: number }) {
  tick(`Clip:${id}`)
  const clip = useTimeline((s) => s.clips[id])
  const isSelected = useTimeline((s) => s.selectedClipIds.has(id))
  const ref = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{ pointerId: number; startX: number; origStartUs: number } | null>(null)

  if (!clip) return null
  const x = clip.startUs * pxPerUs
  const w = clip.durationUs * pxPerUs

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragStateRef.current = { pointerId: e.pointerId, startX: e.clientX, origStartUs: clip.startUs }
    useTimeline.getState().selectClip(clip.id)
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const ds = dragStateRef.current
    if (!ds || ds.pointerId !== e.pointerId) return
    const dx = e.clientX - ds.startX
    const el = ref.current
    if (el) el.style.transform = `translateX(${dx}px)`
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const ds = dragStateRef.current
    if (!ds || ds.pointerId !== e.pointerId) return
    const dx = e.clientX - ds.startX
    const dus = dx / pxPerUs
    dragStateRef.current = null
    const el = ref.current
    if (el) el.style.transform = ''
    useTimeline.getState().moveClip(clip.id, ds.origStartUs + dus)
  }

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`absolute top-1 bottom-1 flex items-center overflow-hidden rounded px-2 text-xs select-none cursor-grab active:cursor-grabbing ${isSelected ? 'ring-2 ring-white' : ''}`}
      style={{ left: x, width: Math.max(2, w), background: clip.color, color: '#0a0a0a' }}
      title={`${clip.label} — start ${(clip.startUs / 1000).toFixed(0)} ms, dur ${(clip.durationUs / 1000).toFixed(0)} ms`}
    >
      <span className="truncate">{clip.label}</span>
    </div>
  )
})

const TrackRow = memo(function TrackRow({ trackIdx, viewportPx }: { trackIdx: number; viewportPx: number }) {
  tick(`Track:${trackIdx}`)
  const clipIds = useTimeline(useShallow((s) => s.tracks[trackIdx]?.clipIds ?? []))
  const pxPerUs = useTimeline((s) => s.pxPerUs)
  return (
    <div className="relative border-b border-zinc-800" style={{ height: TRACK_HEIGHT, width: viewportPx }}>
      {clipIds.map((id) => (<ClipItem key={id} id={id} pxPerUs={pxPerUs} />))}
    </div>
  )
})

function Ruler({ widthPx, pxPerUs }: { widthPx: number; pxPerUs: number }) {
  const totalUs = widthPx / pxPerUs
  const secs = Math.ceil(totalUs / 1_000_000)
  const ticks = []
  for (let i = 0; i <= secs; i++) {
    const x = i * 1_000_000 * pxPerUs
    if (x > widthPx) break
    ticks.push(
      <div key={i} className="absolute top-0 h-full border-l border-zinc-700 text-[10px] text-zinc-500" style={{ left: x }}>
        <span className="ml-1">{i}s</span>
      </div>,
    )
  }
  return (
    <div className="relative bg-zinc-900" style={{ height: HEADER_HEIGHT, width: widthPx }}>
      {ticks}
    </div>
  )
}

export default function TimelinePage() {
  tick('Page')
  const trackCount = useTimeline((s) => s.tracks.length)
  const totalClips = useTimeline((s) => Object.keys(s.clips).length)
  const pxPerUs = useTimeline((s) => s.pxPerUs)
  const actionCount = useTimeline((s) => s.actionCount)

  const containerRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const playStartTRef = useRef<number>(0)
  const playStartUsRef = useRef<number>(0)
  const playheadUsRef = useRef<number>(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [zoomSliderPxPerSec, setZoomSliderPxPerSec] = useState(100)

  const totalWidthPx = useMemo(() => {
    const us = 500 * 1_500_000
    return Math.max(2000, us * pxPerUs)
  }, [pxPerUs])

  useEffect(() => {
    const { tracks, clips } = seed(5, 100)
    useTimeline.getState().bulkInit(tracks, clips)
  }, [])

  useEffect(() => {
    useTimeline.getState().setZoom(zoomSliderPxPerSec / 1_000_000)
  }, [zoomSliderPxPerSec])

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return
    }
    playStartTRef.current = performance.now()
    playStartUsRef.current = playheadUsRef.current
    const fn = () => {
      const elapsedMs = performance.now() - playStartTRef.current
      playheadUsRef.current = playStartUsRef.current + elapsedMs * 1000
      const px = playheadUsRef.current * pxPerUs
      const el = playheadRef.current
      if (el) el.style.transform = `translateX(${px}px)`
      rafRef.current = requestAnimationFrame(fn)
    }
    rafRef.current = requestAnimationFrame(fn)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [isPlaying, pxPerUs])

  function resetPlayhead() {
    playheadUsRef.current = 0
    const el = playheadRef.current
    if (el) el.style.transform = `translateX(0px)`
  }
  function reseed(numTracks: number, perTrack: number) {
    const { tracks, clips } = seed(numTracks, perTrack)
    useTimeline.getState().bulkInit(tracks, clips)
  }
  function stressJiggleOne() {
    const all = Object.keys(useTimeline.getState().clips)
    const id = all[Math.floor(Math.random() * all.length)]
    if (!id) return
    const c = useTimeline.getState().clips[id]
    const t0 = performance.now()
    for (let i = 0; i < 500; i++) {
      useTimeline.getState().moveClip(id, c.startUs + Math.sin(i / 5) * 100_000)
    }
    const t1 = performance.now()
    setTimeout(() => alert(`500 moveClip on ${id}: ${(t1 - t0).toFixed(1)} ms. See window.__renders for per-component counts.`), 50)
  }
  function dumpRenderCounts() {
    const r = window.__renders ?? {}
    const entries = Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 30)
    alert(entries.map(([k, v]) => `${k}: ${v}`).join('\n'))
  }
  function resetRenderCounts() { window.__renders = {} }

  return (
    <main className="font-mono text-sm">
      <header className="border-b border-zinc-800 bg-black p-4 text-zinc-100">
        <h1 className="text-2xl font-bold">Exp-09 · Timeline State</h1>
        <p className="text-zinc-500">
          Zustand + Immer + atomic selectors. Playhead is a ref; its rAF loop writes a CSS
          transform directly without touching React. Drag uses pointer events with a ref-only
          transform during drag and a single store update on pointerup.
        </p>
      </header>

      <section className="border-b border-zinc-800 bg-zinc-950 p-4 text-zinc-200">
        <div className="flex flex-wrap items-center gap-4">
          <span>tracks: {trackCount}</span>
          <span>clips: {totalClips.toLocaleString()}</span>
          <span>actions: {actionCount.toLocaleString()}</span>
          <button onClick={() => setIsPlaying((p) => !p)} className="rounded bg-zinc-100 px-3 py-1 text-black">{isPlaying ? 'pause' : 'play'}</button>
          <button onClick={resetPlayhead} className="rounded border border-zinc-600 px-3 py-1">reset playhead</button>
          <label className="flex items-center gap-2">
            <span className="text-zinc-500">zoom</span>
            <input type="range" min={20} max={500} step={5} value={zoomSliderPxPerSec} onChange={(e) => setZoomSliderPxPerSec(Number(e.target.value))} className="w-40" />
            <span>{zoomSliderPxPerSec} px/s</span>
          </label>
          <button onClick={() => reseed(3, 50)} className="rounded border border-zinc-600 px-3 py-1">seed 150</button>
          <button onClick={() => reseed(5, 100)} className="rounded border border-zinc-600 px-3 py-1">seed 500</button>
          <button onClick={() => reseed(10, 200)} className="rounded border border-zinc-600 px-3 py-1">seed 2000</button>
          <button onClick={stressJiggleOne} className="rounded border border-zinc-600 px-3 py-1">stress: 500 moves on one clip</button>
          <button onClick={dumpRenderCounts} className="rounded border border-zinc-600 px-3 py-1">dump renders</button>
          <button onClick={resetRenderCounts} className="rounded border border-zinc-600 px-3 py-1">reset renders</button>
        </div>
      </section>

      <section ref={containerRef} className="relative overflow-x-auto bg-black text-zinc-100" style={{ height: HEADER_HEIGHT + trackCount * TRACK_HEIGHT + 16 }}>
        <Ruler widthPx={totalWidthPx} pxPerUs={pxPerUs} />
        <div className="relative" style={{ width: totalWidthPx, height: trackCount * TRACK_HEIGHT }}>
          {Array.from({ length: trackCount }).map((_, i) => (
            <div key={i} className="absolute" style={{ left: 0, top: i * TRACK_HEIGHT }}>
              <TrackRow trackIdx={i} viewportPx={totalWidthPx} />
            </div>
          ))}
          <div ref={playheadRef} className="pointer-events-none absolute top-0 bottom-0 w-px bg-amber-400" style={{ height: trackCount * TRACK_HEIGHT, transform: 'translateX(0px)' }} />
        </div>
      </section>

      <section className="m-4 rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>Seed 500: page renders in &lt; 250 ms; ClipItem render counts then stay flat until that specific clip is moved</li>
          <li>Press play: playhead animates smoothly; Page/Track/Clip render counters do NOT increase</li>
          <li>Drag a clip: only that ClipItem's transform updates during drag; on release, only its store entry mutates → only that ClipItem re-renders</li>
          <li>"500 moves on one clip" → the targeted ClipItem render count goes up by 500; siblings stay flat</li>
          <li>Zoom slider triggers re-render of every clip (pxPerUs propagates); this is expected. Timeline should stay smooth.</li>
        </ul>
      </section>
    </main>
  )
}
