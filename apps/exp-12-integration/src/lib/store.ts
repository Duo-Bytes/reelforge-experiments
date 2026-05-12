import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type Sample = {
  timestamp: number
  duration: number
  offset: number
  size: number
  isKeyframe: boolean
}

export type SourceMedia = {
  fileId: string
  codec: string
  codedWidth: number
  codedHeight: number
  description: Uint8Array
  samples: Sample[]
  /** PTS-sorted index into `samples` */
  ptsIndex: number[]
  durationUs: number
  fps: number
  fileName: string
  fileSize: number
}

export type Clip = {
  id: string
  sourceFileId: string
  /** position on the timeline */
  startUs: number
  /** offset within the source media */
  sourceStartUs: number
  /** how long this clip lasts on the timeline */
  durationUs: number
  label: string
  color: string
}

export type TimelineState = {
  sources: Record<string, SourceMedia>
  clips: Clip[]
  pxPerSec: number
  addSource: (m: SourceMedia) => void
  addClip: (sourceFileId: string) => void
  moveClip: (id: string, startUs: number) => void
  trimClip: (id: string, durationUs: number) => void
  removeClip: (id: string) => void
  setZoom: (pxPerSec: number) => void
  clearAll: () => void
}

const palette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']

export const useStore = create<TimelineState>()(
  immer((set, get) => ({
    sources: {},
    clips: [],
    pxPerSec: 100,

    addSource(m) { set((s) => { s.sources[m.fileId] = m }) },

    addClip(sourceFileId) {
      const src = get().sources[sourceFileId]
      if (!src) return
      // append to end of timeline
      const end = get().clips.reduce((acc, c) => Math.max(acc, c.startUs + c.durationUs), 0)
      const clip: Clip = {
        id: crypto.randomUUID(),
        sourceFileId,
        startUs: end,
        sourceStartUs: 0,
        durationUs: src.durationUs,
        label: src.fileName,
        color: palette[get().clips.length % palette.length],
      }
      set((s) => { s.clips.push(clip) })
    },
    moveClip(id, startUs) {
      set((s) => {
        const c = s.clips.find((c) => c.id === id)
        if (c) c.startUs = Math.max(0, startUs)
      })
    },
    trimClip(id, durationUs) {
      set((s) => {
        const c = s.clips.find((c) => c.id === id)
        if (c) c.durationUs = Math.max(100_000, durationUs)
      })
    },
    removeClip(id) {
      set((s) => { s.clips = s.clips.filter((c) => c.id !== id) })
    },
    setZoom(pxPerSec) { set((s) => { s.pxPerSec = pxPerSec }) },
    clearAll() { set((s) => { s.sources = {}; s.clips = [] }) },
  })),
)

export function activeClipAt(timeUs: number, clips: Clip[]): Clip | undefined {
  for (const c of clips) {
    if (timeUs >= c.startUs && timeUs < c.startUs + c.durationUs) return c
  }
  return undefined
}
