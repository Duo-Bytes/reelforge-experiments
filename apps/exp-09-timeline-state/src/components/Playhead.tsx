"use client";

import { useEffect, useRef } from "react";
import { useTimelineStore } from "../store/timeline";

/**
 * Playhead is a refs-only DOM element. The rAF loop mutates style.transform
 * directly. The component itself NEVER re-renders during playback. The only
 * subscribed bit (`zoom`) is read inside the loop via getState() — it
 * could be subscribed via useTimelineStore but we avoid even that to keep
 * this component "transparent" to React Profiler.
 */
export function Playhead({
  playingRef,
  playheadUsRef,
  scrollRef,
}: {
  playingRef: React.MutableRefObject<boolean>;
  playheadUsRef: React.MutableRefObject<number>;
  scrollRef: React.MutableRefObject<number>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      if (playingRef.current) {
        playheadUsRef.current += dt * 1000;
      }
      const { zoom } = useTimelineStore.getState();
      const px = (playheadUsRef.current / 1_000_000) * zoom - scrollRef.current;
      if (ref.current) {
        ref.current.style.transform = `translateX(${px}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playingRef, playheadUsRef, scrollRef]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute top-0 bottom-0 z-50 w-px bg-red-500"
      style={{ willChange: "transform", left: 0 }}
    />
  );
}
