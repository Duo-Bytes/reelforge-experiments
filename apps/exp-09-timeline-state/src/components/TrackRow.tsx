"use client";

import { useTimelineStore } from "../store/timeline";
import { useShallow } from "zustand/react/shallow";
import { ClipItem } from "./ClipItem";
import type { TrackId } from "../lib/types";

const VIEWPORT_OVERSCAN_PX = 200;

/**
 * Per-track strip with manual viewport-cull virtualization. We cannot use
 * `react-window`'s FixedSizeList here because clips are absolutely positioned
 * with variable widths. Instead we filter the track's clipIds to those whose
 * pixel range overlaps the visible window + overscan.
 */
export function TrackRow({
  trackId,
  viewportPx,
}: {
  trackId: TrackId;
  viewportPx: number;
}) {
  const clipIds = useTimelineStore(
    useShallow((s) => s.tracks.find((t) => t.id === trackId)?.clipIds ?? []),
  );
  const trackLabel = useTimelineStore(
    (s) => s.tracks.find((t) => t.id === trackId)?.label ?? "",
  );
  const zoom = useTimelineStore((s) => s.zoom);
  const scroll = useTimelineStore((s) => s.scrollOffsetPx);

  // Compute visible IDs purely from store snapshot of clip startUs/durationUs.
  // Subscribe via shallow on clipIds array; clip data atomically per ClipItem.
  const visibleStart = scroll - VIEWPORT_OVERSCAN_PX;
  const visibleEnd = scroll + viewportPx + VIEWPORT_OVERSCAN_PX;

  const visible = useTimelineStore(
    useShallow((s) => {
      const out: string[] = [];
      for (const id of clipIds) {
        const c = s.clips[id];
        if (!c) continue;
        const left = (c.startUs / 1_000_000) * zoom;
        const right = left + (c.durationUs / 1_000_000) * zoom;
        if (right >= visibleStart && left <= visibleEnd) out.push(id);
      }
      return out;
    }),
  );

  return (
    <div className="relative h-14 w-full border-b border-zinc-800 bg-zinc-950">
      <div className="sticky left-0 z-10 inline-block bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300">
        {trackLabel}
      </div>
      <div className="absolute inset-0">
        {visible.map((id) => (
          <ClipItem key={id} clipId={id} />
        ))}
      </div>
    </div>
  );
}
