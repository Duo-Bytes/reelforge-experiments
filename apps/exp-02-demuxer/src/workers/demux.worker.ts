/// <reference lib="webworker" />
import { createFile, MP4BoxBuffer, type ISOFile, type Sample } from 'mp4box'
import { Input, ALL_FORMATS, BlobSource } from 'mediabunny'
import type { CodecConfig, GOPRange, TrackSummary, VideoSample } from '../types'

type IngestMsg = { type: 'INGEST'; reqId: string; file: File; fileId: string }
type GetGopMsg = { type: 'GET_GOP'; reqId: string; targetUs: number }
type ProbeMediabunnyMsg = { type: 'PROBE_MEDIABUNNY'; reqId: string; file: File }
type DeleteMsg = { type: 'DELETE'; reqId: string; fileId: string }
type InMsg = IngestMsg | GetGopMsg | ProbeMediabunnyMsg | DeleteMsg

// ---- demux state ----
let videoSamples: VideoSample[] = []
let videoCodec: CodecConfig | null = null
let trackSummary: TrackSummary | null = null
const handles = new Map<string, FileSystemSyncAccessHandle>()

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data
  try {
    switch (m.type) {
      case 'INGEST':
        await ingestAndDemux(m); break
      case 'GET_GOP':
        getGop(m); break
      case 'PROBE_MEDIABUNNY':
        await probeMediabunny(m); break
      case 'DELETE':
        await del(m); break
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', reqId: m.reqId, message: (err as Error).message + '\n' + (err as Error).stack })
  }
}

async function ingestAndDemux(m: IngestMsg) {
  const t0 = performance.now()
  videoSamples = []
  videoCodec = null
  trackSummary = null

  // 1. Open OPFS file
  const root = await navigator.storage.getDirectory()
  const fh = await root.getFileHandle(m.fileId, { create: true })
  const sync = await fh.createSyncAccessHandle()
  sync.truncate(0)

  // 2. mp4box streaming parser
  const mp4: ISOFile = createFile()
  let readyResolve: (() => void) | null = null
  let readyReject: ((err: Error) => void) | null = null
  const onReadyPromise = new Promise<void>((res, rej) => {
    readyResolve = res
    readyReject = rej
  })

  mp4.onError = (mod, msg) => readyReject?.(new Error(`mp4box error in ${mod}: ${msg}`))

  mp4.onReady = (info) => {
    const vt = info.videoTracks?.[0] ?? info.tracks.find((t) => 'video' in t && t.video)
    if (!vt) {
      readyReject?.(new Error('no video track'))
      return
    }
    const trakBox = mp4.getTrackById(vt.id)
    const description = extractCodecDescription(trakBox)
    const audioTrack = info.audioTracks?.[0]
    videoCodec = {
      codec: vt.codec,
      width: (vt as { video?: { width: number; height: number } }).video?.width ?? (vt as { track_width: number }).track_width,
      height: (vt as { video?: { width: number; height: number } }).video?.height ?? (vt as { track_height: number }).track_height,
      description,
      timescale: vt.timescale,
      trackId: vt.id,
    }
    trackSummary = {
      codec: videoCodec.codec,
      width: videoCodec.width,
      height: videoCodec.height,
      durationUs: (vt.duration * 1_000_000) / vt.timescale,
      fps: Math.round(((vt.nb_samples ?? 0) * vt.timescale) / vt.duration) || 0,
      frameCount: vt.nb_samples ?? 0,
      keyframeCount: 0, // filled in onSamples
      audioTrackId: audioTrack?.id ?? -1,
      audioCodec: audioTrack?.codec,
      audioSampleRate: audioTrack ? (audioTrack as { audio?: { sample_rate: number } }).audio?.sample_rate : undefined,
      audioChannels: audioTrack ? (audioTrack as { audio?: { channel_count: number } }).audio?.channel_count : undefined,
    }
    mp4.setExtractionOptions(vt.id, null, { nbSamples: Infinity })
    mp4.start()
    readyResolve?.()
  }

  mp4.onSamples = (_id, _user, samples: Sample[]) => {
    for (const s of samples) {
      const sampleTs = s.pts ?? s.cts
      videoSamples.push({
        timestamp: Math.round((sampleTs * 1_000_000) / s.timescale),
        decodeTimestamp: Math.round((s.dts * 1_000_000) / s.timescale),
        duration: Math.round((s.duration * 1_000_000) / s.timescale),
        offset: s.offset,
        size: s.size,
        isKeyframe: s.is_sync,
      })
      if (s.is_sync && trackSummary) trackSummary.keyframeCount++
    }
  }

  // 3. Stream the file: copy to OPFS in 4 MiB chunks and feed mp4box the same bytes
  const CHUNK = 4 * 1024 * 1024
  let offset = 0
  let moovReady = false
  while (offset < m.file.size) {
    const slice = m.file.slice(offset, Math.min(offset + CHUNK, m.file.size))
    const ab = await slice.arrayBuffer()
    // write to OPFS
    sync.write(new Uint8Array(ab), { at: offset })
    // feed mp4box (uses a separate copy because appendBuffer retains it)
    if (!moovReady) {
      const buf = MP4BoxBuffer.fromArrayBuffer(ab.slice(0), offset)
      mp4.appendBuffer(buf)
      // try to detect moov-ready
      await Promise.race([
        onReadyPromise.then(() => { moovReady = true }),
        Promise.resolve(),
      ])
    } else {
      // moov already parsed; keep feeding to collect onSamples for the remainder
      const buf = MP4BoxBuffer.fromArrayBuffer(ab.slice(0), offset)
      mp4.appendBuffer(buf)
    }
    offset += ab.byteLength
    self.postMessage({ type: 'PROGRESS', reqId: m.reqId, percent: (offset / m.file.size) * 100 })
  }
  mp4.flush()
  sync.flush()
  handles.set(m.fileId, sync)

  // If moov was at the end, onReady may only fire after the last appendBuffer.
  await onReadyPromise

  // Sort by PTS (mp4box emits in DTS order; usually PTS == DTS, but B-frames break this)
  videoSamples.sort((a, b) => a.timestamp - b.timestamp)

  const elapsedMs = performance.now() - t0
  self.postMessage({
    type: 'INGEST_DONE',
    reqId: m.reqId,
    fileId: m.fileId,
    size: m.file.size,
    elapsedMs,
    codec: videoCodec,
    summary: trackSummary,
    sampleCount: videoSamples.length,
  })
}

function extractCodecDescription(trak: unknown): Uint8Array {
  // trak.mdia.minf.stbl.stsd.entries[0].avcC / hvcC / av1C / vpcC etc.
  // mp4box types these dynamically; introspect.
  const t = trak as {
    mdia: { minf: { stbl: { stsd: { entries: Array<{ avcC?: unknown; hvcC?: unknown; av1C?: unknown; vpcC?: unknown }> } } } }
  }
  const entry = t.mdia?.minf?.stbl?.stsd?.entries?.[0]
  if (!entry) throw new Error('stsd entry not found')
  const box = entry.avcC ?? entry.hvcC ?? entry.av1C ?? entry.vpcC
  if (!box) throw new Error('no codec init box (avcC/hvcC/av1C/vpcC) found')
  // Serialize the parsed box back to bytes by calling its write() with a fresh DataStream.
  // mp4box exposes `DataStream` and each box has a write(ds) method, but for codec init we
  // can rely on the box's already-stored raw `data` field when present, falling back to
  // a manual write.
  const b = box as { data?: ArrayBuffer | Uint8Array; write?: (ds: unknown) => void }
  if (b.data) return b.data instanceof Uint8Array ? b.data : new Uint8Array(b.data)
  throw new Error('codec init box has no raw .data — needs manual serialization (not implemented in exp-02)')
}

function getGop(m: GetGopMsg) {
  const t0 = performance.now()
  if (!videoSamples.length) throw new Error('no samples — ingest first')
  const arr = videoSamples

  // Binary-search the target timestamp (samples sorted by PTS).
  let lo = 0
  let hi = arr.length - 1
  let targetIdx = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid].timestamp <= m.targetUs) {
      targetIdx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  // Walk backward to the nearest preceding keyframe
  let gopStart = targetIdx
  while (gopStart > 0 && !arr[gopStart].isKeyframe) gopStart--

  // Walk forward to the next keyframe (or EOF)
  let gopEnd = gopStart + 1
  while (gopEnd < arr.length && !arr[gopEnd].isKeyframe) gopEnd++

  const slice = arr.slice(gopStart, gopEnd)
  const result: GOPRange = {
    startUs: slice[0].timestamp,
    endUs: slice[slice.length - 1].timestamp + slice[slice.length - 1].duration,
    firstOffset: Math.min(...slice.map((s) => s.offset)),
    lastOffset: Math.max(...slice.map((s) => s.offset + s.size)),
    frameCount: slice.length,
    computeMs: performance.now() - t0,
  }
  self.postMessage({ type: 'GOP_RESULT', reqId: m.reqId, range: result })
}

/**
 * mediabunny investigation
 * ------------------------
 * mediabunny 1.44.2 ships a high-level Input class that takes a Source (BlobSource for browser
 * File/Blob, UrlSource for fetch). It exposes:
 *   - getFormat() / getTracks() / videoTracks / audioTracks
 *   - per-track packet iterator (track.packets()) yielding EncodedPacket with timestamp + data
 *     but NOT byte offsets — packets are decoded out of the container into in-memory chunks.
 *
 * Implication for the seek-index requirement (offset + size in source file):
 *   - mp4box.js is the right tool when we need to map a timestamp → raw byte range in the OPFS
 *     file, because it exposes Sample.offset/size directly.
 *   - mediabunny is the better tool for the EXPORT pipeline (exp-10) where we want clean
 *     EncodedPacket → muxer with no manual byte juggling, and as a general media reader when
 *     we don't care about source byte offsets.
 *
 * Conclusion for the rest of the project:
 *   - exp-03+ uses mp4box.js to build the seek index, then issues OPFS READ_RANGE for those
 *     byte ranges to feed VideoDecoder.
 *   - exp-10 (export) and exp-07 (proxy) use mediabunny for muxing/transcoding.
 */
async function probeMediabunny(m: ProbeMediabunnyMsg) {
  const t0 = performance.now()
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(m.file) })
  const format = await input.getFormat()
  const videoTracks = await input.getVideoTracks()
  const audioTracks = await input.getAudioTracks()
  const v = videoTracks[0]
  const a = audioTracks[0]
  const summary = {
    formatName: format?.name ?? 'unknown',
    videoCount: videoTracks.length,
    audioCount: audioTracks.length,
    videoCodec: v ? await v.getCodec() : null,
    videoSize: v ? { width: v.codedWidth, height: v.codedHeight } : null,
    videoDuration: v ? await v.computeDuration() : null,
    videoPacketCount: v ? await v.computePacketStats().then((s) => s.packetCount).catch(() => null) : null,
    audioCodec: a ? await a.getCodec() : null,
    audioSampleRate: a?.sampleRate ?? null,
    audioChannels: a?.numberOfChannels ?? null,
    elapsedMs: performance.now() - t0,
  }
  self.postMessage({ type: 'MEDIABUNNY_RESULT', reqId: m.reqId, summary })
}

async function del(m: DeleteMsg) {
  handles.get(m.fileId)?.close()
  handles.delete(m.fileId)
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry(m.fileId) } catch {}
  videoSamples = []
  videoCodec = null
  trackSummary = null
  self.postMessage({ type: 'DELETE_DONE', reqId: m.reqId, fileId: m.fileId })
}

export {}
