"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTimelineStore } from "../store/timeline";
import { TrackRow } from "../components/TrackRow";
import { Playhead } from "../components/Playhead";

export default function Page() {
  const seedClips = useTimelineStore((s) => s.seedClips);
  const setZoom = useTimelineStore((s) => s.setZoom);
  const setScroll = useTimelineStore((s) => s.setScroll);
  const zoom = useTimelineStore((s) => s.zoom);
  const trackIds = useTimelineStore(
    useShallow((s) => s.tracks.map((t) => t.id)),
  );
  const totalClips = useTimelineStore((s) => Object.keys(s.clips).length);

  const playingRef = useRef(false);
  const playheadUsRef = useRef(0);
  const scrollRef = useRef(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [viewportPx, setViewportPx] = useState(800);
  const [seedCount, setSeedCount] = useState(500);
  const [showFps, setShowFps] = useState(true);

  // Seed once on mount.
  useEffect(() => {
    if (totalClips === 0) seedClips(seedCount, 8);
  }, [seedClips, totalClips, seedCount]);

  // Resize observer for viewport width.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportPx(el.clientWidth));
    ro.observe(el);
    setViewportPx(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // FPS meter (no React state — direct DOM mutation).
  const fpsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const loop = (now: number) => {
      frames++;
      if (now - last >= 500) {
        if (fpsRef.current) {
          fpsRef.current.textContent = `${Math.round((frames * 1000) / (now - last))} fps`;
        }
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Total timeline width — derived from largest clip end + zoom.
  const totalWidth = useTimelineStore(
    useShallow((s) => {
      let max = 0;
      for (const id in s.clips) {
        const c = s.clips[id];
        const end = c.startUs + c.durationUs;
        if (end > max) max = end;
      }
      return Math.max(2000, (max / 1_000_000) * s.zoom + 400);
    }),
  );

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    scrollRef.current = el.scrollLeft;
    setScroll(el.scrollLeft);
  };

  const togglePlay = () => {
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
  };

  const reseed = () => {
    seedClips(seedCount, 8);
    playheadUsRef.current = 0;
    if (scrollerRef.current) scrollerRef.current.scrollLeft = 0;
  };

  const zoomLabel = useMemo(() => `${zoom.toFixed(0)} px/s`, [zoom]);

  return (
    <main className="min-h-screen bg-black p-4 font-mono text-zinc-100">
      <div className="mx-auto max-w-[100vw] space-y-4">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Exp-09 · Timeline State</h1>
            <p className="text-xs text-zinc-400">
              Zustand+Immer atomic selectors · refs-only playhead · viewport
              cull · zero React renders during scrub or playback.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {showFps && (
              <div
                ref={fpsRef}
                className="rounded border border-zinc-700 px-2 py-1 font-mono"
              >
                — fps
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowFps((v) => !v)}
              className="rounded border border-zinc-700 px-2 py-1"
            >
              fps {showFps ? "off" : "on"}
            </button>
          </div>
        </header>

        <section className="rounded border border-zinc-700 p-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <button
              type="button"
              onClick={togglePlay}
              className="rounded bg-zinc-100 px-3 py-1 text-black"
            >
              {playing ? "pause" : "play"}
            </button>
            <button
              type="button"
              onClick={() => {
                playheadUsRef.current = 0;
              }}
              className="rounded border border-zinc-600 px-2 py-1"
            >
              rewind
            </button>
            <label className="flex items-center gap-2">
              zoom
              <input
                type="range"
                min={10}
                max={400}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="w-32"
              />
              <span className="w-20 text-right">{zoomLabel}</span>
            </label>
            <label className="flex items-center gap-2">
              clips
              <input
                type="number"
                min={50}
                max={5000}
                value={seedCount}
                onChange={(e) => setSeedCount(Number(e.target.value))}
                className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
              />
              <button
                type="button"
                onClick={reseed}
                className="rounded border border-zinc-600 px-2 py-1"
              >
                reseed
              </button>
            </label>
            <span className="text-zinc-500">total {totalClips}</span>
          </div>
        </section>

        <section className="relative overflow-hidden rounded border border-zinc-700">
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            className="relative h-[60vh] overflow-x-auto overflow-y-auto bg-zinc-950"
          >
            <div style={{ width: totalWidth }} className="relative">
              {trackIds.map((id) => (
                <TrackRow key={id} trackId={id} viewportPx={viewportPx} />
              ))}
            </div>
            <Playhead
              playingRef={playingRef}
              playheadUsRef={playheadUsRef}
              scrollRef={scrollRef}
            />
          </div>
        </section>

        <footer className="text-xs text-zinc-500">
          Open React DevTools / React Scan: only `ClipItem` for the dragged
          clip and any newly-visible clip on scroll should re-render. Playhead
          mutates `style.transform` directly — no React re-render at all.
        </footer>
      </div>
    </main>
  );
}
