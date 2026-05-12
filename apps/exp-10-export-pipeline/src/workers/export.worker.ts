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

type Ingest = { type: 'INGEST'; reqId: string; file: File; fileId: string }
type Export = {
  type: 'EXPORT'
  reqId: string
  sourceFileId: string
  effect: 'identity' | 'grayscale' | 'invert'
  bitrate: number
  outputCodec: 'avc1.640028' | 'avc1.4d0028' | 'avc1.42E01E'
}
type Read = { type: 'READ'; reqId: string; fileId: string }
type Del = { type: 'DELETE'; reqId: string; fileId: string }
type InMsg = Ingest | Export | Read | Del

type Sample2 = { timestamp: number; duration: number; offset: number; size: number; isKeyframe: boolean }
type SourceMeta = { codec: string; codedWidth: number; codedHeight: number; description: Uint8Array; samples: Sample2[]; fps: number; durationUs: number }

const handles = new Map<string, FileSystemSyncAccessHandle>()
const sources = new Map<string, SourceMeta>()

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data
  try {
    switch (m.type) {
      case 'INGEST': await ingest(m); break
      case 'EXPORT': await runExport(m); break
      case 'READ': await read(m); break
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
  const samples: Sample2[] = []
  let resolveReady: () => void = () => {}
  let rejectReady: (e: Error) => void = () => {}
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej })

  let meta: SourceMeta | null = null
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
    const description = box.data instanceof Uint8Array ? box.data : new Uint8Array(box.data)
    meta = {
      codec: v.codec,
      codedWidth: (v as { video?: { width: number } }).video?.width ?? (v as { track_width: number }).track_width,
      codedHeight: (v as { video?: { height: number } }).video?.height ?? (v as { track_height: number }).track_height,
      description,
      samples,
      fps: Math.round(((v.nb_samples ?? 0) * v.timescale) / v.duration) || 30,
      durationUs: Math.round((v.duration * 1_000_000) / v.timescale),
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
  const finalMeta = meta as unknown as SourceMeta | null
  if (!finalMeta) throw new Error('no meta')
  sources.set(m.fileId, finalMeta)
  self.postMessage({
    type: 'INGEST_DONE',
    reqId: m.reqId,
    fileId: m.fileId,
    codec: finalMeta.codec,
    width: finalMeta.codedWidth,
    height: finalMeta.codedHeight,
    fps: finalMeta.fps,
    durationUs: finalMeta.durationUs,
    frameCount: finalMeta.samples.length,
  })
}

const WGSL = /* wgsl */ `
struct VSOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  var o: VSOut;
  o.position = vec4f(positions[vi], 0.0, 1.0);
  o.uv = uvs[vi];
  return o;
}
struct U { effect: u32, _pad: vec3u }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@group(0) @binding(2) var<uniform> u: U;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let c = textureSampleBaseClampToEdge(tex, samp, in.uv);
  if (u.effect == 1u) {
    let l = dot(c.rgb, vec3f(0.299, 0.587, 0.114));
    return vec4f(l, l, l, 1.0);
  } else if (u.effect == 2u) {
    return vec4f(1.0 - c.r, 1.0 - c.g, 1.0 - c.b, 1.0);
  }
  return c;
}
`

function readRange(fileId: string, offset: number, size: number): Uint8Array {
  const h = handles.get(fileId)
  if (!h) throw new Error('no handle')
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

async function runExport(m: Export) {
  const src = sources.get(m.sourceFileId)
  if (!src) throw new Error('source not ingested')
  const t0 = performance.now()

  // 1. WebGPU setup (in worker)
  if (!('gpu' in navigator)) throw new Error('WebGPU not in worker')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('no adapter')
  const device = await adapter.requestDevice()
  device.lost.then((l) => self.postMessage({ type: 'DEVICE_LOST', reason: l.reason, message: l.message }))
  const canvas = new OffscreenCanvas(src.codedWidth, src.codedHeight)
  const context = canvas.getContext('webgpu') as GPUCanvasContext
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })
  const module = device.createShaderModule({ code: WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const effectIdx = m.effect === 'grayscale' ? 1 : m.effect === 'invert' ? 2 : 0
  const uniformBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(uniformBuf, 0, new Uint32Array([effectIdx, 0, 0, 0]))

  // 2. Mediabunny output to OPFS
  const outFileId = `export_${m.sourceFileId}`
  const root = await navigator.storage.getDirectory()
  const outHandle = await (await root.getFileHandle(outFileId, { create: true })).createSyncAccessHandle()
  outHandle.truncate(0)

  const proxyCodec: VideoCodec = 'avc'
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new StreamTarget(makeOpfsWritable(outHandle)),
  })
  const videoSource = new EncodedVideoPacketSource(proxyCodec)
  output.addVideoTrack(videoSource, { frameRate: src.fps })
  await output.start()

  // 3. VideoEncoder
  const encCfg: VideoEncoderConfig = {
    codec: m.outputCodec,
    width: src.codedWidth,
    height: src.codedHeight,
    bitrate: m.bitrate,
    framerate: src.fps,
    latencyMode: 'quality',
  }
  const encSupport = await VideoEncoder.isConfigSupported(encCfg)
  if (!encSupport.supported) throw new Error(`encoder codec not supported: ${m.outputCodec}`)
  let encMeta: EncodedVideoChunkMetadata | undefined
  const pending: Array<Promise<void>> = []
  const encoder = new VideoEncoder({
    output: (chunk, m2) => {
      if (m2) encMeta = m2
      pending.push(videoSource.add(EncodedPacket.fromEncodedChunk(chunk), encMeta))
    },
    error: (err) => self.postMessage({ type: 'ENCODER_ERROR', message: err.message }),
  })
  encoder.configure(encCfg)

  // 4. Decoder
  const decCfg: VideoDecoderConfig = {
    codec: src.codec, codedWidth: src.codedWidth, codedHeight: src.codedHeight,
    description: src.description, hardwareAcceleration: 'prefer-hardware',
  }
  const decSupport = await VideoDecoder.isConfigSupported(decCfg)
  if (!decSupport.supported) throw new Error(`source codec not supported: ${src.codec}`)

  let processed = 0
  const totalFrames = src.samples.length
  const decoded = new Promise<void>((resolveAll, rejectAll) => {
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          // GPU pass: render source frame through WGSL effect, then grab the canvas as a new VideoFrame
          const ext = device.importExternalTexture({ source: frame })
          const bind = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: sampler },
              { binding: 1, resource: ext },
              { binding: 2, resource: { buffer: uniformBuf } },
            ],
          })
          const enc = device.createCommandEncoder()
          const pass = enc.beginRenderPass({
            colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
          })
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, bind)
          pass.draw(6)
          pass.end()
          device.queue.submit([enc.finish()])

          const ts = frame.timestamp
          const dur = frame.duration ?? Math.round(1_000_000 / src.fps)
          frame.close()
          const out = new VideoFrame(canvas, { timestamp: ts, duration: dur })
          encoder.encode(out, { keyFrame: false })
          out.close()
          processed++
          if (processed % 30 === 0 || processed === totalFrames) {
            self.postMessage({ type: 'EXPORT_PROGRESS', reqId: m.reqId, framesProcessed: processed, totalFrames })
          }
          if (processed === totalFrames) {
            decoder.close()
            resolveAll()
          }
        } catch (err) { rejectAll(err as Error) }
      },
      error: (err) => rejectAll(new Error(`decoder: ${err.message}`)),
    })
    decoder.configure(decCfg)
    ;(async () => {
      try {
        for (const s of src.samples) {
          while (decoder.decodeQueueSize > 8 || encoder.encodeQueueSize > 8) {
            await new Promise<void>((r) => setTimeout(r, 0))
          }
          const data = readRange(m.sourceFileId, s.offset, s.size)
          decoder.decode(new EncodedVideoChunk({
            type: s.isKeyframe ? 'key' : 'delta',
            timestamp: s.timestamp,
            duration: s.duration,
            data,
          }))
        }
        await decoder.flush()
      } catch (err) { rejectAll(err as Error) }
    })()
  })

  await decoded
  await encoder.flush()
  encoder.close()
  await Promise.all(pending)
  await output.finalize()
  outHandle.close()

  const elapsedMs = performance.now() - t0
  const fileEntry = await root.getFileHandle(outFileId)
  const out = await fileEntry.getFile()

  self.postMessage({
    type: 'EXPORT_DONE',
    reqId: m.reqId,
    outFileId,
    size: out.size,
    width: src.codedWidth,
    height: src.codedHeight,
    elapsedMs,
    framesEncoded: processed,
    sourceDurationUs: src.durationUs,
    realtime: (src.durationUs / 1000) / elapsedMs,
  })
}

async function read(m: Read) {
  const root = await navigator.storage.getDirectory()
  const fh = await root.getFileHandle(m.fileId)
  const f = await fh.getFile()
  self.postMessage({ type: 'BLOB', reqId: m.reqId, blob: f })
}

async function del(m: Del) {
  handles.get(m.fileId)?.close()
  handles.delete(m.fileId)
  sources.delete(m.fileId)
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry(m.fileId) } catch {}
  try { await root.removeEntry(`export_${m.fileId}`) } catch {}
  self.postMessage({ type: 'DELETE_DONE', reqId: m.reqId, fileId: m.fileId })
}

export {}
