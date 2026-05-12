/// <reference lib="webworker" />
import { createFile, MP4BoxBuffer, type ISOFile, type Sample } from 'mp4box'

type Ingest = { type: 'INGEST'; reqId: string; file: File; fileId: string }
type Seek = { type: 'SEEK'; reqId: string; targetUs: number }
type Probe = { type: 'PROBE'; reqId: string }
type Del = { type: 'DELETE'; reqId: string; fileId: string }
type InMsg = Ingest | Seek | Probe | Del

type VideoSampleEntry = {
  timestamp: number
  duration: number
  offset: number
  size: number
  isKeyframe: boolean
}
type CodecConfig = {
  codec: string
  codedWidth: number
  codedHeight: number
  description: Uint8Array
  timescale: number
}

const handles = new Map<string, FileSystemSyncAccessHandle>()
let samples: VideoSampleEntry[] = []
let ptsIndex: number[] = []
let codec: CodecConfig | null = null
let decoder: VideoDecoder | null = null
let openFileId: string | null = null

// SEEK state
let targetTs: number | null = null
let seekReqId: string | null = null
let peakQueue = 0
let seekStart = 0

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data
  try {
    switch (m.type) {
      case 'INGEST': await ingest(m); break
      case 'SEEK': await seek(m); break
      case 'PROBE': await probe(m); break
      case 'DELETE': await del(m); break
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', reqId: m.reqId, message: (err as Error).message + '\n' + (err as Error).stack })
  }
}

function codecConfigForDecoder(): VideoDecoderConfig {
  if (!codec) throw new Error('no codec')
  return {
    codec: codec.codec,
    codedWidth: codec.codedWidth,
    codedHeight: codec.codedHeight,
    description: codec.description,
    hardwareAcceleration: 'prefer-hardware',
  }
}

function onDecodedFrame(frame: VideoFrame) {
  if (decoder) peakQueue = Math.max(peakQueue, decoder.decodeQueueSize)
  if (targetTs !== null && frame.timestamp === targetTs && seekReqId !== null) {
    const elapsedMs = performance.now() - seekStart
    self.postMessage(
      { type: 'FRAME', reqId: seekReqId, frame, elapsedMs, peakQueue, targetUs: targetTs },
      [frame as unknown as Transferable]
    )
    targetTs = null
    seekReqId = null
  } else {
    frame.close()
  }
}

async function ingest(m: Ingest) {
  resetState()
  const root = await navigator.storage.getDirectory()
  const fh = await root.getFileHandle(m.fileId, { create: true })
  const sync = await fh.createSyncAccessHandle()
  sync.truncate(0)

  const mp4: ISOFile = createFile()
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
    if (!box?.data) { rejectReady(new Error('no avcC/hvcC raw bytes available')); return }
    const description = box.data instanceof Uint8Array ? box.data : new Uint8Array(box.data)
    codec = {
      codec: v.codec,
      codedWidth: (v as { video?: { width: number } }).video?.width ?? (v as { track_width: number }).track_width,
      codedHeight: (v as { video?: { height: number } }).video?.height ?? (v as { track_height: number }).track_height,
      description,
      timescale: v.timescale,
    }
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
    self.postMessage({ type: 'PROGRESS', reqId: m.reqId, percent: (off / m.file.size) * 100 })
  }
  mp4.flush()
  sync.flush()
  handles.set(m.fileId, sync)
  openFileId = m.fileId

  await ready
  // samples are in DTS order (the order mp4box emits them = file order).
  // Build a parallel PTS-sorted index for binary search on seek.
  ptsIndex = samples.map((_, i) => i).sort((a, b) => samples[a].timestamp - samples[b].timestamp)

  const support = await VideoDecoder.isConfigSupported(codecConfigForDecoder())
  if (!support.supported) throw new Error(`codec not supported: ${codec!.codec}`)
  decoder = new VideoDecoder({
    output: onDecodedFrame,
    error: (e) => self.postMessage({ type: 'DECODER_ERROR', message: (e as DOMException).message }),
  })
  decoder.configure(codecConfigForDecoder())

  self.postMessage({
    type: 'INGEST_DONE',
    reqId: m.reqId,
    fileId: m.fileId,
    size: m.file.size,
    codec,
    frameCount: samples.length,
    keyframeCount: samples.filter((s) => s.isKeyframe).length,
    durationUs: samples.length ? samples[samples.length - 1].timestamp + samples[samples.length - 1].duration : 0,
  })
}

/** Returns the GOP slice containing targetUs, in DTS (decode-feed) order. */
function gopForTarget(targetUs: number): VideoSampleEntry[] {
  // binary search the PTS-sorted view for the largest pts <= targetUs
  let lo = 0, hi = ptsIndex.length - 1, ptsRank = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (samples[ptsIndex[mid]].timestamp <= targetUs) { ptsRank = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  const dtsIdx = ptsIndex[ptsRank]
  let gopStart = dtsIdx
  while (gopStart > 0 && !samples[gopStart].isKeyframe) gopStart--
  let gopEnd = dtsIdx + 1
  while (gopEnd < samples.length && !samples[gopEnd].isKeyframe) gopEnd++
  return samples.slice(gopStart, gopEnd)
}

async function readRange(fileId: string, offset: number, size: number): Promise<Uint8Array> {
  const h = handles.get(fileId)
  if (!h) throw new Error('no opfs handle')
  const buf = new Uint8Array(size)
  h.read(buf, { at: offset })
  return buf
}

async function seek(m: Seek) {
  if (!decoder || !codec || !openFileId) throw new Error('not ingested')
  if (decoder.state === 'closed') {
    decoder = new VideoDecoder({ output: onDecodedFrame, error: () => {} })
    decoder.configure(codecConfigForDecoder())
  }
  targetTs = m.targetUs
  seekReqId = m.reqId
  peakQueue = 0
  seekStart = performance.now()

  const gop = gopForTarget(m.targetUs)
  for (const s of gop) {
    while (decoder.decodeQueueSize > 5) {
      await new Promise<void>((r) => setTimeout(r, 0))
    }
    const data = await readRange(openFileId, s.offset, s.size)
    decoder.decode(new EncodedVideoChunk({
      type: s.isKeyframe ? 'key' : 'delta',
      timestamp: s.timestamp,
      duration: s.duration,
      data,
    }))
  }
  await decoder.flush()
  // If the target frame's PTS didn't match anything in the GOP (clamped seek
  // to a real sample timestamp on the main side normally), surface a miss.
  if (seekReqId !== null) {
    self.postMessage({ type: 'SEEK_MISS', reqId: seekReqId, targetUs: m.targetUs })
    seekReqId = null
    targetTs = null
  }
}

async function probe(m: Probe) {
  const tests: Array<{ label: string; codec: string }> = [
    { label: 'H.264 baseline', codec: 'avc1.42E01E' },
    { label: 'H.264 high', codec: 'avc1.640028' },
    { label: 'HEVC main', codec: 'hvc1.1.6.L93.B0' },
    { label: 'VP9', codec: 'vp09.00.10.08' },
    { label: 'AV1', codec: 'av01.0.05M.08' },
  ]
  const results: Array<{ label: string; codec: string; supported: boolean; acceleration: string }> = []
  for (const t of tests) {
    try {
      const hw = await VideoDecoder.isConfigSupported({
        codec: t.codec, codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: 'prefer-hardware',
      } as VideoDecoderConfig)
      const sw = await VideoDecoder.isConfigSupported({
        codec: t.codec, codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: 'prefer-software',
      } as VideoDecoderConfig)
      const supported = !!(hw.supported || sw.supported)
      const acceleration = hw.supported ? 'hardware' : sw.supported ? 'software only' : 'unsupported'
      results.push({ label: t.label, codec: t.codec, supported, acceleration })
    } catch {
      results.push({ label: t.label, codec: t.codec, supported: false, acceleration: 'error' })
    }
  }
  self.postMessage({ type: 'PROBE_RESULT', reqId: m.reqId, results })
}

async function del(m: Del) {
  handles.get(m.fileId)?.close()
  handles.delete(m.fileId)
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry(m.fileId) } catch {}
  resetState()
  self.postMessage({ type: 'DELETE_DONE', reqId: m.reqId, fileId: m.fileId })
}

function resetState() {
  samples = []
  ptsIndex = []
  codec = null
  if (decoder && decoder.state !== 'closed') decoder.close()
  decoder = null
  openFileId = null
  targetTs = null
  seekReqId = null
  peakQueue = 0
}

export {}
