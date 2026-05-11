import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";

enableMapSet();

export type AssetId = string;
export type ClipId = string;
export type TrackId = string;

/** A media asset = a single ingested file (source) plus optional proxy metadata. */
export interface Asset {
  id: AssetId;
  name: string;
  sourceFileId: string;
  proxyFileId: string | null;
  width: number;
  height: number;
  durationUs: number;
  fps: number;
  hasAudio: boolean;
}

export interface Clip {
  id: ClipId;
  trackId: TrackId;
  assetId: AssetId;
  startUs: number;        // position on timeline
  inUs: number;           // offset into asset
  durationUs: number;     // length of this clip
  bgRemoval: boolean;
  label: string;
}

export interface Track {
  id: TrackId;
  type: "video" | "audio";
  label: string;
  clipIds: ClipId[];
}

interface State {
  assets: Record<AssetId, Asset>;
  tracks: Track[];
  clips: Record<ClipId, Clip>;
  zoom: number;
  selectedClipId: ClipId | null;
}

interface Actions {
  addAsset: (a: Asset) => void;
  updateAsset: (id: AssetId, patch: Partial<Asset>) => void;
  addClip: (c: Clip) => void;
  moveClip: (id: ClipId, newStartUs: number) => void;
  trimClip: (id: ClipId, durationUs: number) => void;
  selectClip: (id: ClipId | null) => void;
  toggleBgRemoval: (id: ClipId) => void;
  setZoom: (z: number) => void;
  reset: () => void;
}

const initialTracks: Track[] = [
  { id: "v1", type: "video", label: "V1", clipIds: [] },
  { id: "v2", type: "video", label: "V2", clipIds: [] },
  { id: "a1", type: "audio", label: "A1", clipIds: [] },
];

export const useEditor = create<State & Actions>()(
  immer((set) => ({
    assets: {},
    tracks: initialTracks,
    clips: {},
    zoom: 80,
    selectedClipId: null,

    addAsset: (a) =>
      set((s) => {
        s.assets[a.id] = a;
      }),

    updateAsset: (id, patch) =>
      set((s) => {
        const a = s.assets[id];
        if (a) Object.assign(a, patch);
      }),

    addClip: (c) =>
      set((s) => {
        s.clips[c.id] = c;
        const t = s.tracks.find((x) => x.id === c.trackId);
        if (t) {
          t.clipIds.push(c.id);
          t.clipIds.sort((a, b) => s.clips[a].startUs - s.clips[b].startUs);
        }
      }),

    moveClip: (id, newStartUs) =>
      set((s) => {
        const c = s.clips[id];
        if (!c) return;
        c.startUs = Math.max(0, newStartUs);
        const t = s.tracks.find((x) => x.id === c.trackId);
        if (t) {
          t.clipIds.sort((a, b) => s.clips[a].startUs - s.clips[b].startUs);
        }
      }),

    trimClip: (id, durationUs) =>
      set((s) => {
        const c = s.clips[id];
        if (c) c.durationUs = Math.max(100_000, durationUs);
      }),

    selectClip: (id) =>
      set((s) => {
        s.selectedClipId = id;
      }),

    toggleBgRemoval: (id) =>
      set((s) => {
        const c = s.clips[id];
        if (c) c.bgRemoval = !c.bgRemoval;
      }),

    setZoom: (z) =>
      set((s) => {
        s.zoom = Math.max(20, Math.min(400, z));
      }),

    reset: () =>
      set((s) => {
        s.assets = {};
        s.tracks = initialTracks.map((t) => ({ ...t, clipIds: [] }));
        s.clips = {};
        s.selectedClipId = null;
      }),
  })),
);

export function getEditor() {
  return useEditor.getState();
}

/** Find clip whose [startUs, startUs+durationUs) covers `playheadUs` on a video track.
 *  Returns null if none. */
export function clipAtTime(playheadUs: number, kind: "video" | "audio") {
  const s = useEditor.getState();
  for (const t of s.tracks) {
    if (t.type !== kind) continue;
    for (const id of t.clipIds) {
      const c = s.clips[id];
      if (!c) continue;
      if (playheadUs >= c.startUs && playheadUs < c.startUs + c.durationUs) {
        return c;
      }
    }
  }
  return null;
}

/** Convert timeline PTS to asset PTS for a given clip. */
export function timelineToAssetUs(clip: Clip, timelineUs: number): number {
  return clip.inUs + (timelineUs - clip.startUs);
}
