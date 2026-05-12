import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type ClipId = string
export type TrackId = string

export interface Clip {
  id: ClipId
  trackId: TrackId
  /** position on the timeline in microseconds */
  startUs: number
  /** clip length in microseconds */
  durationUs: number
  label: string
  color: string
}

export interface Track {
  id: TrackId
  label: string
  type: 'video' | 'audio'
  clipIds: ClipId[]
}

export interface TimelineState {
  tracks: Track[]
  clips: Record<ClipId, Clip>
  /** pixels per microsecond — the timeline-zoom factor */
  pxPerUs: number
  selectedClipIds: ReadonlySet<ClipId>
  /** monotonic actions counter — pure observability, drives no UI directly */
  actionCount: number

  addClip(c: Clip): void
  moveClip(id: ClipId, startUs: number): void
  trimClip(id: ClipId, durationUs: number): void
  setZoom(pxPerUs: number): void
  selectClip(id: ClipId | null): void
  bulkInit(tracks: Track[], clips: Record<ClipId, Clip>): void
}

export const useTimeline = create<TimelineState>()(
  immer((set) => ({
    tracks: [],
    clips: {},
    pxPerUs: 100 / 1_000_000, // 100 px per second
    selectedClipIds: new Set(),
    actionCount: 0,

    addClip(c) {
      set((s) => {
        s.clips[c.id] = c
        const t = s.tracks.find((t) => t.id === c.trackId)
        if (t) t.clipIds.push(c.id)
        s.actionCount++
      })
    },
    moveClip(id, startUs) {
      set((s) => {
        const c = s.clips[id]
        if (c) c.startUs = Math.max(0, startUs)
        s.actionCount++
      })
    },
    trimClip(id, durationUs) {
      set((s) => {
        const c = s.clips[id]
        if (c) c.durationUs = Math.max(100_000, durationUs) // min 0.1 s
        s.actionCount++
      })
    },
    setZoom(pxPerUs) {
      set((s) => {
        s.pxPerUs = pxPerUs
        s.actionCount++
      })
    },
    selectClip(id) {
      set((s) => {
        s.selectedClipIds = new Set(id ? [id] : [])
        s.actionCount++
      })
    },
    bulkInit(tracks, clips) {
      set((s) => {
        s.tracks = tracks
        s.clips = clips
        s.selectedClipIds = new Set()
        s.actionCount++
      })
    },
  })),
)

export function seed(numTracks: number, clipsPerTrack: number): { tracks: Track[]; clips: Record<ClipId, Clip> } {
  const tracks: Track[] = []
  const clips: Record<ClipId, Clip> = {}
  const palette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#a855f7']
  for (let t = 0; t < numTracks; t++) {
    const trackId = `t${t}`
    const clipIds: string[] = []
    let cursor = 0
    for (let i = 0; i < clipsPerTrack; i++) {
      const id = `${trackId}-c${i}`
      const dur = (1_000_000 * (0.5 + Math.random() * 3)) | 0
      const gap = (1_000_000 * Math.random() * 0.4) | 0
      const c: Clip = {
        id,
        trackId,
        startUs: cursor + gap,
        durationUs: dur,
        label: `clip ${t}.${i}`,
        color: palette[(t * 31 + i) % palette.length],
      }
      cursor = c.startUs + c.durationUs
      clips[id] = c
      clipIds.push(id)
    }
    tracks.push({ id: trackId, label: `track ${t}`, type: t % 2 === 0 ? 'video' : 'audio', clipIds })
  }
  return { tracks, clips }
}
