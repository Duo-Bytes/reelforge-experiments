"use client";

import { useEffect, useRef } from "react";
import { useTimelineStore, getTimelineSnapshot } from "../store/timeline";
import type { ClipId } from "../lib/types";

/**
 * Atomic per-clip subscription. Re-renders only when this exact clip object
 * is replaced (Immer creates a new object on edit). Selection bit is read
 * via a separate selector — also atomic.
 */
export function ClipItem({ clipId }: { clipId: ClipId }) {
  const clip = useTimelineStore((s) => s.clips[clipId]);
  const zoom = useTimelineStore((s) => s.zoom);
  const selected = useTimelineStore((s) => s.selectedClipIds.has(clipId));
  const ref = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startLeft: number;
    pointerId: number;
  } | null>(null);

  // Stable inline geometry — recomputed only when clip data or zoom changes.
  const widthPx = (clip.durationUs / 1_000_000) * zoom;
  const leftPx = (clip.startUs / 1_000_000) * zoom;

  useEffect(() => {
    if (ref.current) {
      ref.current.style.transform = "translateX(0)";
    }
  }, [clip.startUs, zoom]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    getTimelineSnapshot().selectClip(clipId, e.shiftKey || e.metaKey || e.ctrlKey);
    if (!ref.current) return;
    ref.current.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startLeft: leftPx,
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    // Direct DOM mutation — NO React state update during drag.
    if (ref.current) {
      ref.current.style.transform = `translateX(${dx}px)`;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const newLeftPx = Math.max(0, drag.startLeft + dx);
    const newStartUs = (newLeftPx / getTimelineSnapshot().zoom) * 1_000_000;
    dragRef.current = null;
    if (ref.current) ref.current.releasePointerCapture(e.pointerId);
    // Single store commit — Immer makes a new clip object, our selector re-runs.
    getTimelineSnapshot().moveClip(clipId, newStartUs);
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: "absolute",
        left: leftPx,
        top: 4,
        width: Math.max(2, widthPx),
        backgroundColor: clip.color,
        outline: selected ? "2px solid #fff" : "1px solid rgba(255,255,255,0.2)",
      }}
      className="h-12 cursor-grab touch-none rounded text-white shadow-sm select-none active:cursor-grabbing"
    >
      <span className="block truncate px-1 text-[10px] leading-[1.6]">
        {clip.label}
      </span>
    </div>
  );
}
