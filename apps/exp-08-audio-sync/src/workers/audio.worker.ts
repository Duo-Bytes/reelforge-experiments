/// <reference lib="webworker" />
import { createFile, MP4BoxBuffer, type ISOFile, type Sample } from 'mp4box'
import { writeInterleaved } from '../lib/ring-buffer'

type Ingest = { type: 'INGEST'; reqId: string; file: File; fileId: string; sab: SharedArrayBuffer }
type Start = { type: 'START'; reqId: string }
type Stop = { type: 'STOP'; reqId: string }
type Del = { type: 'DELETE'; reqId: string; fileId: string }
type InMsg = Ingest | Start | Stop | Del

type AudioSampleEntry = { timestamp: number; duration: number; offset: number; size: number }
type AudioMeta = {
  codec: string
  sampleRate: number
  numberOfChannels: number
  description: Uint8Array | null
  samples: AudioSampleEntry[]
}

const handles = new Map<string, FileSystemSyncAccessHandle>()
let openFileId: string | null = null
let meta: AudioMeta | null = null
let sab: SharedArrayBuffer | null = null
let decoder: AudioDecoder | null = null
let running = false
let feedAbort = false

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data
  try {
    switch (m.type) {
      case 'INGEST': await ingest(m); break
      case 'START': await start(m); break
      case 'STOP': await stop(m); break
      case 'DELETE': await del(m); break
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', reqId: m.reqId, message: (err as Error).message + '\n' + (err as Error).stack })
  }
}

/** Build a minimal AAC AudioSpecificConfig (2 bytes) when esds isn't directly accessible. */
function aacAsc(sampleRate: number, channels: number, profile = 2 /* AAC LC */): Uint8Array {
  const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
  const srIdx = sampleRates.indexOf(sampleRate)
  if (srIdx < 0) throw new Error(`unsupported sample rate for ASC: ${sampleRate}`)
  // 5 bits profile | 4 bits sample-rate index | 4 bits channel config | 3 bits zero
  const v = (profile << 11) | (srIdx << 7) | (channels << 3)
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff])
}

async function ingest(m: Ingest) {
  sab = m.sab
  resetState()
  const root = await navigator.storage.getDirectory()
  const fh = await root.getFileHandle(m.fileId, { create: true })
  const sync = await fh.createSyncAccessHandle()
  sync.truncate(0)

  const mp4: ISOFile = createFile()
  const samples: AudioSampleEntry[] = []
  let resolveReady: () => void = () => {}
  let rejectReady: (e: Error) => void = () => {}
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej })

  let foundCodec: string | null = null
  let foundRate = 0
  let foundChannels = 0
  let description: Uint8Array | null = null

  mp4.onError = (mod, msg) => rejectReady(new Error(`mp4box ${mod}: ${msg}`))
  mp4.onReady = (info) => {
    const a = info.audioTracks?.[0]
    if (!a) { rejectReady(new Error('no audio track')); return }
    foundCodec = a.codec
    foundRate = (a as { audio?: { sample_rate: number } }).audio?.sample_rate ?? 48000
    foundChannels = (a as { audio?: { channel_count: number } }).audio?.channel_count ?? 2
    const trak = mp4.getTrackById(a.id) as unknown as {
      mdia: { minf: { stbl: { stsd: { entries: Array<{ esds?: { esd?: { descs?: Array<{ descs?: Array<{ data?: ArrayBuffer | Uint8Array }> }> } }; dOps?: { data?: ArrayBuffer | Uint8Array } }> } } } }
    }
    const entry = trak.mdia.minf.stbl.stsd.entries[0]
    // AAC: esds -> ES_Descriptor -> DecoderConfigDescriptor -> DecSpecificInfo.data
    const dscData = entry.esds?.esd?.descs?.[0]?.descs?.[0]?.data
    if (dscData) description = dscData instanceof Uint8Array ? dscData : new Uint8Array(dscData)
    // Opus: dOps box has the codec config bytes
    if (!description && entry.dOps?.data) {
      description = entry.dOps.data instanceof Uint8Array ? entry.dOps.data : new Uint8Array(entry.dOps.data)
    }
    // Fallback for AAC: synthesize a 2-byte ASC from rate + channels
    if (!description && foundCodec && foundCodec.startsWith('mp4a')) {
      try { description = aacAsc(foundRate, foundChannels) } catch { /* leave null */ }
    }
    mp4.setExtractionOptions(a.id, null, { nbSamples: Infinity })
    mp4.start()
    resolveReady()
  }
  mp4.onSamples = (_id, _u, ss: Sample[]) => {
    for (const s of ss) {
      samples.push({
        timestamp: Math.round((s.cts * 1_000_000) / s.timescale),
        duration: Math.round((s.duration * 1_000_000) / s.timescale),
        offset: s.offset,
        size: s.size,
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
  openFileId = m.fileId

  await ready
  if (!foundCodec) throw new Error('no audio codec found')
  meta = {
    codec: foundCodec,
    sampleRate: foundRate,
    numberOfChannels: foundChannels,
    description,
    samples,
  }
  self.postMessage({
    type: 'INGEST_DONE',
    reqId: m.reqId,
    fileId: m.fileId,
    codec: meta.codec,
    sampleRate: meta.sampleRate,
    numberOfChannels: meta.numberOfChannels,
    sampleCount: meta.samples.length,
    description: meta.description?.byteLength ?? 0,
    durationUs: samples.length ? samples[samples.length - 1].timestamp + samples[samples.length - 1].duration : 0,
  })
}

function readRange(fileId: string, offset: number, size: number): Uint8Array {
  const h = handles.get(fileId)
  if (!h) throw new Error('no handle')
  const buf = new Uint8Array(size)
  h.read(buf, { at: offset })
  return buf
}

async function start(m: Start) {
  if (!meta || !sab || !openFileId) throw new Error('not ingested')
  if (running) { self.postMessage({ type: 'STARTED', reqId: m.reqId }); return }

  const cfg: AudioDecoderConfig = {
    codec: meta.codec,
    sampleRate: meta.sampleRate,
    numberOfChannels: meta.numberOfChannels,
    description: meta.description ?? undefined,
  }
  const support = await AudioDecoder.isConfigSupported(cfg)
  if (!support.supported) throw new Error(`audio codec not supported: ${meta.codec}`)

  decoder = new AudioDecoder({
    output: (audioData) => {
      // Pull interleaved Float32. Some sources may give planar — handle both.
      const channels = audioData.numberOfChannels
      const frames = audioData.numberOfFrames
      // Allocate interleaved buffer
      const interleaved = new Float32Array(frames * 2) // we always feed stereo into ring
      // Copy each channel
      const tmp = new Float32Array(frames)
      for (let c = 0; c < Math.min(channels, 2); c++) {
        audioData.copyTo(tmp, { planeIndex: c, format: 'f32-planar' })
        for (let i = 0; i < frames; i++) interleaved[i * 2 + c] = tmp[i]
      }
      // If source is mono, duplicate to right channel
      if (channels === 1) {
        for (let i = 0; i < frames; i++) interleaved[i * 2 + 1] = interleaved[i * 2]
      }
      writeInterleaved(sab!, interleaved)
      audioData.close()
    },
    error: (e) => self.postMessage({ type: 'DECODER_ERROR', message: (e as DOMException).message }),
  })
  decoder.configure(cfg)

  running = true
  feedAbort = false
  self.postMessage({ type: 'STARTED', reqId: m.reqId })
  // Feed loop — decode all samples in order. AudioDecoder output writes into the SAB
  // which the AudioWorklet drains. We yield when decodeQueueSize is large to apply
  // backpressure (the ring buffer itself is the main backpressure mechanism via
  // the overwrite semantics in writeInterleaved).
  ;(async () => {
    for (const s of meta.samples) {
      if (feedAbort) break
      while (decoder!.decodeQueueSize > 8) {
        await new Promise<void>((r) => setTimeout(r, 4))
      }
      const data = readRange(openFileId!, s.offset, s.size)
      try {
        decoder!.decode(new EncodedAudioChunk({
          type: 'key', // every AAC frame is independent
          timestamp: s.timestamp,
          duration: s.duration,
          data,
        }))
      } catch (err) {
        self.postMessage({ type: 'DECODER_ERROR', message: (err as Error).message })
        break
      }
    }
    try { await decoder!.flush() } catch { /* ignore */ }
    self.postMessage({ type: 'FEED_DONE' })
  })()
}

async function stop(m: Stop) {
  feedAbort = true
  if (decoder && decoder.state !== 'closed') decoder.close()
  decoder = null
  running = false
  self.postMessage({ type: 'STOPPED', reqId: m.reqId })
}

async function del(m: Del) {
  await stop({ type: 'STOP', reqId: m.reqId })
  handles.get(m.fileId)?.close()
  handles.delete(m.fileId)
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry(m.fileId) } catch {}
  resetState()
  self.postMessage({ type: 'DELETE_DONE', reqId: m.reqId, fileId: m.fileId })
}

function resetState() {
  if (decoder && decoder.state !== 'closed') decoder.close()
  decoder = null
  meta = null
  openFileId = null
  running = false
  feedAbort = false
}

export {}
