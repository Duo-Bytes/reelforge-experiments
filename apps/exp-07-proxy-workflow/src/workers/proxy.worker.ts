/// <reference lib="webworker" />
import { createFile, MP4BoxBuffer, type ISOFile, type Sample } from 'mp4box'
import {
  Output,
  Mp4OutputFormat,
  StreamTarget,
  EncodedVideoPacketSource,
  EncodedPacket,
  type VideoCodec,
} from 'mediabunny'
import { openDB, type IDBPDatabase } from 'idb'

type Ingest = { type: 'INGEST'; reqId: string; file: File; fileId: string }
type Transcode = { type: 'TRANSCODE'; reqId: string; sourceFileId: string; targetHeight: number; bitrate: number; keyEveryFrame: boolean }
type ListProxies = { type: 'LIST_PROXIES'; reqId: string }
type Del = { type: 'DELETE'; reqId: string; fileId: string; proxyFileId?: string }
type ReadProxy = { type: 'READ_PROXY'; reqId: string; proxyFileId: string }
type InMsg = Ingest | Transcode | ListProxies | Del | ReadProxy

type SampleEntry = {
  timestamp: number
  duration: number
  offset: number
  size: number
  isKeyframe: boolean
}
type SourceMeta = {
  codec: string
  codedWidth: number
  codedHeight: number
  description: Uint8Array
  samples: SampleEntry[]
  durationUs: number
  fps: number
}

const handles = new Map<string, FileSystemSyncAccessHandle>()
const sourceMeta = new Map<string, SourceMeta>()
let db: IDBPDatabase | null = null

async function getDb() {
  if (db) return db
  db = await openDB('reelforge', 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('proxies')) d.createObjectStore('proxies', { keyPath: 'sourceFileId' })
    },
  })
  return db
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data
  try {
    switch (m.type) {
      case 'INGEST': await ingest(m); break
      case 'TRANSCODE': await transcode(m); break
      case 'LIST_PROXIES': await listProxies(m); break
      case 'READ_PROXY': await readProxy(m); break
      case 'DELETE': await del(m); break
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', reqId: m.reqId, message: (err as Error).message + '\n' + (err as Error).stack })
  }
}

async function ingest(m: Ingest) {
  const root = await navigator.storage.getDirectory()
  const fh = await root.getFileHandle(m.fileId, { create: true })
  const sync = await fh.createSyncAccessHandle()
  sync.truncate(0)

  const mp4: ISOFile = createFile()
  const samples: SampleEntry[] = []
  let meta: SourceMeta | null = null
  let resolveReady: () => void = () => {}
  let rejectReady: (e: Error) => void = () => {}
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej })

  mp4.onError = (mod, msg) => rejectReady(new Error(`mp4box ${mod}: ${msg}`))
  mp4.onReady = (info) => {
    const v = info.videoTracks?.[0]
    if (!v) { rejectReady(new Error('no video track')); return }
    const trak = mp4.getTrackById(v.id) as unknown as {
      mdia: { minf: { stbl: { stsd: { entries: Array<{ avcC?: { data: ArrayBuffer | Uint8Array }; hvcC?: { data: ArrayBuffer | Uint8Array } }> } } } }
    }
    const entry = trak.mdia.minf.stbl.stsd.entries[0]
    const box = entry.avcC ?? entry.hvcC
    if (!box?.data) { rejectReady(new Error('no avcC/hvcC')); return }
    const description = box.data instanceof Uint8Array ? box.data : new Uint8Array(box.data)
    meta = {
      codec: v.codec,
      codedWidth: (v as { video?: { width: number } }).video?.width ?? (v as { track_width: number }).track_width,
      codedHeight: (v as { video?: { height: number } }).video?.height ?? (v as { track_height: number }).track_height,
      description,
      samples,
      durationUs: Math.round((v.duration * 1_000_000) / v.timescale),
      fps: Math.round(((v.nb_samples ?? 0) * v.timescale) / v.duration) || 30,
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
    self.postMessage({ type: 'INGEST_PROGRESS', reqId: m.reqId, percent: (off / m.file.size) * 100 })
  }
  mp4.flush()
  sync.flush()
  handles.set(m.fileId, sync)

  await ready
  // `meta` is narrowed to `null` by TS CFA because the only re-assignment is in a callback.
  // Recover the real type via a cast.
  const finalMeta = meta as unknown as SourceMeta | null
  if (!finalMeta) throw new Error('no meta')
  sourceMeta.set(m.fileId, finalMeta)
  self.postMessage({
    type: 'INGEST_DONE',
    reqId: m.reqId,
    fileId: m.fileId,
    size: m.file.size,
    width: finalMeta.codedWidth,
    height: finalMeta.codedHeight,
    durationUs: finalMeta.durationUs,
    fps: finalMeta.fps,
    frameCount: samples.length,
    codec: finalMeta.codec,
  })
}

async function readRange(fileId: string, offset: number, size: number): Promise<Uint8Array> {
  const h = handles.get(fileId)
  if (!h) throw new Error(`no handle for ${fileId}`)
  const buf = new Uint8Array(size)
  h.read(buf, { at: offset })
  return buf
}

function makeOpfsWritable(handle: FileSystemSyncAccessHandle): WritableStream<{ type: 'write'; data: Uint8Array<ArrayBuffer>; position: number }> {
  let highestEnd = 0
  return new WritableStream({
    write(chunk) {
      handle.write(chunk.data, { at: chunk.position })
      const end = chunk.position + chunk.data.byteLength
      if (end > highestEnd) highestEnd = end
    },
    close() {
      handle.flush()
      handle.truncate(highestEnd)
    },
  })
}

async function transcode(m: Transcode) {
  const meta = sourceMeta.get(m.sourceFileId)
  if (!meta) throw new Error('source not ingested')
  const t0 = performance.now()

  // 1. Decide output dimensions, preserving aspect ratio.
  const aspect = meta.codedWidth / meta.codedHeight
  const targetH = m.targetHeight
  const targetW = Math.round((targetH * aspect) / 2) * 2 // even width for encoder
  const fps = meta.fps

  // 2. Allocate the OPFS file for the proxy, open a sync handle on it
  const proxyFileId = `proxy_${m.sourceFileId}`
  const root = await navigator.storage.getDirectory()
  const proxyHandle = await (await root.getFileHandle(proxyFileId, { create: true })).createSyncAccessHandle()
  proxyHandle.truncate(0)

  // 3. Build the mediabunny Output
  const proxyCodec: VideoCodec = 'avc'
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new StreamTarget(makeOpfsWritable(proxyHandle)),
  })
  const videoSource = new EncodedVideoPacketSource(proxyCodec)
  output.addVideoTrack(videoSource, { frameRate: fps })
  await output.start()

  // 4. Source decoder
  const srcConfig: VideoDecoderConfig = {
    codec: meta.codec,
    codedWidth: meta.codedWidth,
    codedHeight: meta.codedHeight,
    description: meta.description,
    hardwareAcceleration: 'prefer-hardware',
  }
  const srcSupport = await VideoDecoder.isConfigSupported(srcConfig)
  if (!srcSupport.supported) throw new Error(`source codec not supported: ${meta.codec}`)

  // 5. Encoder for proxy
  // 'avc1.4d0028' = H.264 Main profile, Level 4.0 — broad hardware support up to 1080p
  // For 720p target we use Level 3.1 ('avc1.4d001f') which is widely accelerated.
  const proxyCodecStr = 'avc1.4d001f'
  const encCfg: VideoEncoderConfig = {
    codec: proxyCodecStr,
    width: targetW,
    height: targetH,
    bitrate: m.bitrate,
    framerate: fps,
    latencyMode: 'quality',
  }
  const encSupport = await VideoEncoder.isConfigSupported(encCfg)
  if (!encSupport.supported) throw new Error(`proxy codec not supported: ${proxyCodecStr}`)

  let encMeta: EncodedVideoChunkMetadata | undefined
  const pending: Array<Promise<void>> = []
  const encoder = new VideoEncoder({
    output: (chunk, m2) => {
      if (m2) encMeta = m2
      // EncodedPacket.fromEncodedChunk preserves type/timestamp/duration/data
      const p = EncodedPacket.fromEncodedChunk(chunk)
      pending.push(videoSource.add(p, encMeta))
    },
    error: (err) => self.postMessage({ type: 'ENCODER_ERROR', message: err.message }),
  })
  encoder.configure(encCfg)

  // 6. Scaling canvas (worker context — OffscreenCanvas)
  const scaleCanvas = new OffscreenCanvas(targetW, targetH)
  const scaleCtx = scaleCanvas.getContext('2d', { alpha: false, willReadFrequently: false })
  if (!scaleCtx) throw new Error('failed to get 2d context')

  // 7. Source decoder. We feed samples in file/DTS order; VideoDecoder reorders to PTS order
  // on the output side, which is what the encoder expects.
  let nextExpectedPts: number | null = null
  let processedFrames = 0
  const totalFrames = meta.samples.length

  const decoded = new Promise<void>((resolveAll, rejectAll) => {
    const decoder = new VideoDecoder({
      output: (frame) => {
        // Scale to target resolution
        scaleCtx.drawImage(frame, 0, 0, targetW, targetH)
        const ts = frame.timestamp
        const dur = frame.duration ?? Math.round(1_000_000 / fps)
        frame.close()
        const scaled = new VideoFrame(scaleCanvas, { timestamp: ts, duration: dur })
        try {
          encoder.encode(scaled, { keyFrame: m.keyEveryFrame })
        } finally {
          scaled.close()
        }
        processedFrames++
        if (nextExpectedPts === null) nextExpectedPts = ts
        // progress in PTS terms — we know durationUs
        self.postMessage({
          type: 'TRANSCODE_PROGRESS',
          reqId: m.reqId,
          percent: meta.durationUs ? (ts / meta.durationUs) * 100 : 0,
          framesProcessed: processedFrames,
          totalFrames,
        })
        if (processedFrames === totalFrames) {
          // all source frames decoded + handed to encoder
          decoder.close()
          resolveAll()
        }
      },
      error: (err) => rejectAll(new Error(`decoder: ${err.message}`)),
    })
    decoder.configure(srcConfig)
    ;(async () => {
      try {
        for (const s of meta.samples) {
          while (decoder.decodeQueueSize > 8 || encoder.encodeQueueSize > 8) {
            await new Promise<void>((r) => setTimeout(r, 0))
          }
          const data = await readRange(m.sourceFileId, s.offset, s.size)
          decoder.decode(new EncodedVideoChunk({
            type: s.isKeyframe ? 'key' : 'delta',
            timestamp: s.timestamp,
            duration: s.duration,
            data,
          }))
        }
        await decoder.flush()
      } catch (err) {
        rejectAll(err as Error)
      }
    })()
  })

  await decoded
  await encoder.flush()
  encoder.close()
  // wait for mediabunny source to absorb all packets, then finalize
  await Promise.all(pending)
  await output.finalize()

  proxyHandle.close()
  const proxySize = (await (await root.getFileHandle(proxyFileId)).getFile()).size
  const elapsedMs = performance.now() - t0

  // store metadata
  const dbi = await getDb()
  await dbi.put('proxies', {
    sourceFileId: m.sourceFileId,
    proxyFileId,
    status: 'ready',
    width: targetW,
    height: targetH,
    bitrate: m.bitrate,
    keyEveryFrame: m.keyEveryFrame,
    proxySize,
    durationUs: meta.durationUs,
    createdAt: Date.now(),
  })

  self.postMessage({
    type: 'TRANSCODE_DONE',
    reqId: m.reqId,
    proxyFileId,
    proxySize,
    width: targetW,
    height: targetH,
    elapsedMs,
    sourceDurationUs: meta.durationUs,
    framesEncoded: processedFrames,
  })
  void nextExpectedPts
}

async function readProxy(m: ReadProxy) {
  const root = await navigator.storage.getDirectory()
  const fh = await root.getFileHandle(m.proxyFileId)
  const file = await fh.getFile()
  self.postMessage({ type: 'PROXY_BLOB', reqId: m.reqId, blob: file })
}

async function listProxies(m: ListProxies) {
  const dbi = await getDb()
  const all = await dbi.getAll('proxies')
  self.postMessage({ type: 'PROXIES_LIST', reqId: m.reqId, items: all })
}

async function del(m: Del) {
  handles.get(m.fileId)?.close()
  handles.delete(m.fileId)
  sourceMeta.delete(m.fileId)
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry(m.fileId) } catch {}
  if (m.proxyFileId) {
    try { await root.removeEntry(m.proxyFileId) } catch {}
    const dbi = await getDb()
    await dbi.delete('proxies', m.fileId)
  }
  self.postMessage({ type: 'DELETE_DONE', reqId: m.reqId, fileId: m.fileId })
}

export {}
