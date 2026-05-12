/// <reference lib="webworker" />
import { createFile, MP4BoxBuffer, type ISOFile, type Sample } from 'mp4box'

type Ingest = { type: 'INGEST'; reqId: string; file: File; fileId: string }
type Read = { type: 'READ'; reqId: string; fileId: string; offset: number; size: number }
type InMsg = Ingest | Read

const handles = new Map<string, FileSystemSyncAccessHandle>()

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data
  try {
    switch (m.type) {
      case 'INGEST': await ingest(m); break
      case 'READ': read(m); break
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', reqId: m.reqId, message: (err as Error).message })
  }
}

async function ingest(m: Ingest) {
  const root = await navigator.storage.getDirectory()
  const fh = await root.getFileHandle(m.fileId, { create: true })
  const sync = await fh.createSyncAccessHandle()
  sync.truncate(0)

  const mp4: ISOFile = createFile()
  const samples: { timestamp: number; duration: number; offset: number; size: number; isKeyframe: boolean }[] = []
  let codec = ''
  let codedWidth = 0
  let codedHeight = 0
  let description: Uint8Array | null = null
  let durationUs = 0
  let fps = 30
  let resolveReady: () => void = () => {}
  let rejectReady: (e: Error) => void = () => {}
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej })

  mp4.onError = (mod, msg) => rejectReady(new Error(`mp4box ${mod}: ${msg}`))
  mp4.onReady = (info) => {
    const v = info.videoTracks?.[0]
    if (!v) { rejectReady(new Error('no video track')); return }
    const trakBox = mp4.getTrackById(v.id) as unknown as {
      mdia: { minf: { stbl: { stsd: { entries: Array<{ avcC?: { data: ArrayBuffer | Uint8Array }; hvcC?: { data: ArrayBuffer | Uint8Array } }> } } } }
    }
    const entry = trakBox.mdia.minf.stbl.stsd.entries[0]
    const box = entry.avcC ?? entry.hvcC
    if (!box?.data) { rejectReady(new Error('no avcC/hvcC')); return }
    description = box.data instanceof Uint8Array ? box.data : new Uint8Array(box.data)
    codec = v.codec
    codedWidth = (v as { video?: { width: number } }).video?.width ?? (v as { track_width: number }).track_width
    codedHeight = (v as { video?: { height: number } }).video?.height ?? (v as { track_height: number }).track_height
    durationUs = Math.round((v.duration * 1_000_000) / v.timescale)
    fps = Math.round(((v.nb_samples ?? 0) * v.timescale) / v.duration) || 30
    mp4.setExtractionOptions(v.id, null, { nbSamples: Infinity })
    mp4.start()
    resolveReady()
  }
  mp4.onSamples = (_id, _u, ss: Sample[]) => {
    for (const s of ss) {
      const pts = s.pts ?? s.cts
      samples.push({
        timestamp: Math.round((pts * 1_000_000) / s.timescale),
        duration: Math.round((s.duration * 1_000_000) / s.timescale),
        offset: s.offset,
        size: s.size,
        isKeyframe: s.is_sync,
      })
    }
  }

  const CHUNK = 4 * 1024 * 1024
  let off = 0
  while (off < m.file.size) {
    const slice = m.file.slice(off, Math.min(off + CHUNK, m.file.size))
    const ab = await slice.arrayBuffer()
    sync.write(new Uint8Array(ab), { at: off })
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab.slice(0), off))
    off += ab.byteLength
    self.postMessage({ type: 'INGEST_PROGRESS', reqId: m.reqId, percent: (off / m.file.size) * 100 })
  }
  mp4.flush()
  sync.flush()
  handles.set(m.fileId, sync)

  await ready
  const ptsIndex = samples.map((_, i) => i).sort((a, b) => samples[a].timestamp - samples[b].timestamp)
  self.postMessage({
    type: 'INGEST_DONE',
    reqId: m.reqId,
    fileId: m.fileId,
    codec,
    codedWidth,
    codedHeight,
    description,
    samples,
    ptsIndex,
    durationUs,
    fps,
    fileName: m.file.name,
    fileSize: m.file.size,
  })
}

function read(m: Read) {
  const h = handles.get(m.fileId)
  if (!h) throw new Error('no opfs handle')
  const buf = new Uint8Array(m.size)
  h.read(buf, { at: m.offset })
  self.postMessage(
    { type: 'READ_RESULT', reqId: m.reqId, bytes: buf },
    [buf.buffer],
  )
}

export {}
