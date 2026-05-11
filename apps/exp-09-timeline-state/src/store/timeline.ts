import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";
import type { Clip, ClipId, Track, TrackId } from "../lib/types";
import { PALETTE } from "../lib/types";

enableMapSet();

interface TimelineState {
  tracks: Track[];
  clips: Record<ClipId, Clip>;
  zoom: number; // pixels per second
  scrollOffsetPx: number;
  selectedClipIds: Set<ClipId>;
}

interface TimelineActions {
  seedClips: (count: number, trackCount: number) => void;
  addClip: (clip: Clip) => void;
  moveClip: (id: ClipId, newStartUs: number) => void;
  trimClip: (id: ClipId, durationUs: number) => void;
  selectClip: (id: ClipId, multi: boolean) => void;
  clearSelection: () => void;
  setZoom: (zoom: number) => void;
  setScroll: (px: number) => void;
}

export const useTimelineStore = create<TimelineState & TimelineActions>()(
  immer((set) => ({
    tracks: [],
    clips: {},
    zoom: 80,
    scrollOffsetPx: 0,
    selectedClipIds: new Set(),

    seedClips: (count, trackCount) =>
      set((state) => {
        state.tracks = Array.from({ length: trackCount }, (_, i) => ({
          id: `track-${i}`,
          label: i % 2 === 0 ? `V${Math.floor(i / 2) + 1}` : `A${Math.floor(i / 2) + 1}`,
          type: i % 2 === 0 ? "video" : "audio",
          clipIds: [],
        }));
        state.clips = {};
        for (let i = 0; i < count; i++) {
          const trackIdx = i % trackCount;
          const trackId = `track-${trackIdx}`;
          const startUs = (i * 2_500_000) % (count * 100_000);
          const id = `clip-${i}`;
          state.clips[id] = {
            id,
            trackId,
            startUs,
            durationUs: 1_500_000 + Math.floor(Math.random() * 3_000_000),
            sourceFileId: "demo",
            label: `Clip ${i}`,
            color: PALETTE[i % PALETTE.length],
          };
          state.tracks[trackIdx].clipIds.push(id);
        }
        for (const t of state.tracks) {
          t.clipIds.sort(
            (a, b) => state.clips[a].startUs - state.clips[b].startUs,
          );
        }
        state.selectedClipIds = new Set();
        state.scrollOffsetPx = 0;
      }),

    addClip: (clip) =>
      set((state) => {
        state.clips[clip.id] = clip;
        const t = state.tracks.find((tr) => tr.id === clip.trackId);
        if (t) {
          t.clipIds.push(clip.id);
          t.clipIds.sort(
            (a, b) => state.clips[a].startUs - state.clips[b].startUs,
          );
        }
      }),

    moveClip: (id, newStartUs) =>
      set((state) => {
        const c = state.clips[id];
        if (!c) return;
        c.startUs = Math.max(0, newStartUs);
        const t = state.tracks.find((tr) => tr.id === c.trackId);
        if (t) {
          t.clipIds.sort(
            (a, b) => state.clips[a].startUs - state.clips[b].startUs,
          );
        }
      }),

    trimClip: (id, durationUs) =>
      set((state) => {
        const c = state.clips[id];
        if (!c) return;
        c.durationUs = Math.max(100_000, durationUs);
      }),

    selectClip: (id, multi) =>
      set((state) => {
        if (!multi) state.selectedClipIds = new Set([id]);
        else state.selectedClipIds.add(id);
      }),

    clearSelection: () =>
      set((state) => {
        state.selectedClipIds = new Set();
      }),

    setZoom: (zoom) =>
      set((state) => {
        state.zoom = Math.max(10, Math.min(500, zoom));
      }),

    setScroll: (px) =>
      set((state) => {
        state.scrollOffsetPx = Math.max(0, px);
      }),
  })),
);

/** Read store snapshot without subscribing — useful inside DOM event handlers. */
export function getTimelineSnapshot(): TimelineState & TimelineActions {
  return useTimelineStore.getState();
}

export function timelineApi(): TrackId[] {
  return useTimelineStore.getState().tracks.map((t) => t.id);
}
