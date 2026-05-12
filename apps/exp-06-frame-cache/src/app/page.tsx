'use client'

import { useEffect, useRef, useState } from 'react'
import { createFile, MP4BoxBuffer, type ISOFile, type Sample } from 'mp4box'
import { LRUCache } from '../lib/lru'
import { WGSL } from '../lib/wgsl'

type Sample2 = {
  timestamp: number
  duration: number
  offset: number
  size: number
  isKeyframe: boolean
}
type Codec = {
  codec: string
  codedWidth: number
  codedHeight: number
  description: Uint8Array
}

type SeekResult = { ts: number; latencyMs: number; tier: 'vram' | 'ram' | 'miss' }

const VRAM_CAPACITY = 200
const RAM_CAPACITY = 900

function fmtMs(n: number) {
  if (n < 1) return `${(n * 1000).toFixed(0)} µs`
  if (n < 100) return `${n.toFixed(2)} ms`
  return `${n.toFixed(0)} ms`
}

export default function FrameCachePage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fileRef = useRef<File | null>(null)
  const samplesRef = useRef<Sample2[]>([])
  const ptsIndexRef = useRef<number[]>([])
  const codecRef = useRef<Codec | null>(null)
  const decoderRef = useRef<VideoDecoder | null>(null)
  const decoderTargetRef = useRef<number | null>(null)
  const decoderResolveRef = useRef<((f: VideoFrame) => void) | null>(null)

  const deviceRef = useRef<GPUDevice | null>(null)
  const contextRef = useRef<GPUCanvasContext | null>(null)
  const pipelineRef = useRef<GPURenderPipeline | null>(null)
  const samplerRef = useRef<GPUSampler | null>(null)

  const vramRef = useRef<LRUCache<number, GPUTexture> | null>(null)
  const ramRef = useRef<LRUCache<number, ImageBitmap> | null>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [codecInfo, setCodecInfo] = useState<Codec | null>(null)
  const [frameCount, setFrameCount] = useState(0)
  const [seekFrame, setSeekFrame] = useState(0)
  const [last, setLast] = useState<SeekResult | null>(null)
  const [stats, setStats] = useState({
    vramFrames: 0,
    ramFrames: 0,
    vramHits: 0,
    ramHits: 0,
    misses: 0,
    seeks: 0,
    medianMs: 0,
    p95Ms: 0,
  })
  const samplesLatRef = useRef<number[]>([])

  useEffect(() => {
    return () => {
      vramRef.current?.clear()
      ramRef.current?.clear()
      if (decoderRef.current && decoderRef.current.state !== 'closed') decoderRef.current.close()
    }
  }, [])

  async function initGpu() {
    const canvas = canvasRef.current
    if (!canvas) throw new Error('no canvas')
    if (!('gpu' in navigator)) throw new Error('WebGPU not supported')
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('no adapter')
    const device = await adapter.requestDevice()
    device.lost.then((l) => setStatus(`GPU device lost: ${l.reason}: ${l.message}`))
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
    deviceRef.current = device
    contextRef.current = context
    pipelineRef.current = pipeline
    samplerRef.current = sampler
    vramRef.current = new LRUCache<number, GPUTexture>(VRAM_CAPACITY, (_k, tex) => tex.destroy())
    ramRef.current = new LRUCache<number, ImageBitmap>(RAM_CAPACITY, (_k, bmp) => bmp.close())
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setStatus(`demuxing ${file.name}…`)
    setProgress(0)
    samplesLatRef.current = []
    setStats({ vramFrames: 0, ramFrames: 0, vramHits: 0, ramHits: 0, misses: 0, seeks: 0, medianMs: 0, p95Ms: 0 })
    setLast(null)
    try {
      if (!deviceRef.current) await initGpu()
      else { vramRef.current?.clear(); ramRef.current?.clear() }
      fileRef.current = file
      await demux(file)
      const c = codecRef.current
      if (!c) throw new Error('no codec extracted')
      setCodecInfo(c)
      setFrameCount(samplesRef.current.length)
      setSeekFrame(0)
      const support = await VideoDecoder.isConfigSupported({
        codec: c.codec, codedWidth: c.codedWidth, codedHeight: c.codedHeight, description: c.description, hardwareAcceleration: 'prefer-hardware',
      })
      if (!support.supported) throw new Error(`codec not supported: ${c.codec}`)
      const dec = new VideoDecoder({ output: onDecoded, error: (err) => setStatus(`decoder error: ${err.message}`) })
      dec.configure({ codec: c.codec, codedWidth: c.codedWidth, codedHeight: c.codedHeight, description: c.description, hardwareAcceleration: 'prefer-hardware' })
      decoderRef.current = dec
      setStatus(`ready — ${samplesRef.current.length.toLocaleString()} frames`)
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`)
    } finally { setBusy(false); e.target.value = '' }
  }

  async function demux(file: File) {
    const mp4: ISOFile = createFile()
    const samples: Sample2[] = []
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
      const description = box.data instanceof Uint8Array ? box.data : new Uint8Array(box.data)
      codecRef.current = {
        codec: v.codec,
        codedWidth: (v as { video?: { width: number } }).video?.width ?? (v as { track_width: number }).track_width,
        codedHeight: (v as { video?: { height: number } }).video?.height ?? (v as { track_height: number }).track_height,
        description,
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
    while (off < file.size) {
      const slice = file.slice(off, Math.min(off + CHUNK, file.size))
      const ab = await slice.arrayBuffer()
      mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab.slice(0), off))
      off += ab.byteLength
      setProgress((off / file.size) * 100)
    }
    mp4.flush()
    await ready
    samplesRef.current = samples
    ptsIndexRef.current = samples.map((_, i) => i).sort((a, b) => samples[a].timestamp - samples[b].timestamp)
  }

  function onDecoded(frame: VideoFrame) {
    const target = decoderTargetRef.current
    if (target !== null && frame.timestamp === target && decoderResolveRef.current) {
      const r = decoderResolveRef.current
      decoderResolveRef.current = null
      decoderTargetRef.current = null
      r(frame)
      return
    }
    // Warm the RAM cache with adjacent frames decoded as side-effect of the GOP feed.
    ;(async () => {
      try {
        const bmp = await createImageBitmap(frame)
        ramRef.current?.set(frame.timestamp, bmp)
      } finally {
        frame.close()
      }
    })()
  }

  function gopForTarget(targetUs: number): Sample2[] {
    const arr = samplesRef.current
    const pts = ptsIndexRef.current
    let lo = 0, hi = pts.length - 1, ptsRank = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (arr[pts[mid]].timestamp <= targetUs) { ptsRank = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    const dtsIdx = pts[ptsRank]
    let s = dtsIdx
    while (s > 0 && !arr[s].isKeyframe) s--
    let e = dtsIdx + 1
    while (e < arr.length && !arr[e].isKeyframe) e++
    return arr.slice(s, e)
  }

  function uploadToGpu(bmp: ImageBitmap): GPUTexture {
    const device = deviceRef.current!
    const tex = device.createTexture({
      size: [bmp.width, bmp.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height])
    return tex
  }

  function render(tex: GPUTexture) {
    const device = deviceRef.current!
    const context = contextRef.current!
    const pipeline = pipelineRef.current!
    const sampler = samplerRef.current!
    const canvas = canvasRef.current!
    if (canvas.width !== tex.width) canvas.width = tex.width
    if (canvas.height !== tex.height) canvas.height = tex.height
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: tex.createView() },
      ],
    })
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bg)
    pass.draw(6)
    pass.end()
    device.queue.submit([enc.finish()])
  }

  async function decodeGopForTarget(targetUs: number): Promise<VideoFrame> {
    const file = fileRef.current!
    const dec = decoderRef.current!
    if (dec.state === 'closed') throw new Error('decoder closed')
    decoderTargetRef.current = targetUs
    const framePromise = new Promise<VideoFrame>((resolve) => { decoderResolveRef.current = resolve })
    const gop = gopForTarget(targetUs)
    for (const s of gop) {
      while (dec.decodeQueueSize > 5) {
        await new Promise<void>((r) => setTimeout(r, 0))
      }
      const data = new Uint8Array(await file.slice(s.offset, s.offset + s.size).arrayBuffer())
      dec.decode(new EncodedVideoChunk({
        type: s.isKeyframe ? 'key' : 'delta',
        timestamp: s.timestamp,
        duration: s.duration,
        data,
      }))
    }
    await dec.flush()
    return framePromise
  }

  async function getFrameTexture(targetUs: number): Promise<{ tex: GPUTexture; tier: 'vram' | 'ram' | 'miss'; latencyMs: number }> {
    const t = performance.now()
    const vram = vramRef.current!
    const ram = ramRef.current!
    const fromVram = vram.get(targetUs)
    if (fromVram) return { tex: fromVram, tier: 'vram', latencyMs: performance.now() - t }
    const fromRam = ram.get(targetUs)
    if (fromRam) {
      const tex = uploadToGpu(fromRam)
      vram.set(targetUs, tex)
      return { tex, tier: 'ram', latencyMs: performance.now() - t }
    }
    const frame = await decodeGopForTarget(targetUs)
    const bmp = await createImageBitmap(frame)
    frame.close()
    ram.set(targetUs, bmp)
    const tex = uploadToGpu(bmp)
    vram.set(targetUs, tex)
    return { tex, tier: 'miss', latencyMs: performance.now() - t }
  }

  async function seek(targetUs: number) {
    const r = await getFrameTexture(targetUs)
    render(r.tex)
    samplesLatRef.current.push(r.latencyMs)
    samplesLatRef.current = samplesLatRef.current.slice(-200)
    const sorted = [...samplesLatRef.current].sort((a, b) => a - b)
    const medianMs = sorted[Math.floor(sorted.length / 2)] ?? 0
    const p95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? 0
    setStats((s) => ({
      ...s,
      seeks: s.seeks + 1,
      vramHits: s.vramHits + (r.tier === 'vram' ? 1 : 0),
      ramHits: s.ramHits + (r.tier === 'ram' ? 1 : 0),
      misses: s.misses + (r.tier === 'miss' ? 1 : 0),
      vramFrames: vramRef.current!.size,
      ramFrames: ramRef.current!.size,
      medianMs,
      p95Ms,
    }))
    setLast({ ts: targetUs, latencyMs: r.latencyMs, tier: r.tier })
  }

  async function seekToFrame(idx: number) {
    if (!samplesRef.current.length) return
    const ptsIdx = ptsIndexRef.current[Math.max(0, Math.min(samplesRef.current.length - 1, idx))]
    const ts = samplesRef.current[ptsIdx].timestamp
    await seek(ts)
  }

  async function scrubStress() {
    if (!samplesRef.current.length) return
    setBusy(true)
    setStatus('scrub stress: 60 seeks within ±30 frames of playhead…')
    const around = 30
    for (let i = 0; i < 60; i++) {
      const ofs = Math.floor((Math.random() - 0.5) * 2 * around)
      const idx = Math.max(0, Math.min(frameCount - 1, seekFrame + ofs))
      await seekToFrame(idx)
    }
    setStatus('scrub stress done')
    setBusy(false)
  }

  async function clearCaches() {
    vramRef.current?.clear()
    ramRef.current?.clear()
    samplesLatRef.current = []
    setStats({ vramFrames: 0, ramFrames: 0, vramHits: 0, ramHits: 0, misses: 0, seeks: 0, medianMs: 0, p95Ms: 0 })
    setLast(null)
  }

  const hitRate = stats.seeks ? ((stats.vramHits + stats.ramHits) / stats.seeks) * 100 : 0

  return (
    <main className="mx-auto max-w-4xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-06 · Frame Cache</h1>
      <p className="mb-6 text-zinc-500">
        Two-tier LRU cache: <code>GPUTexture</code> (Tier 1, capacity {VRAM_CAPACITY}) and
        <code> ImageBitmap</code> (Tier 2, capacity {RAM_CAPACITY}). A cache miss decodes the
        target GOP, caches the target + all sibling frames in RAM, and uploads the target into VRAM.
        Subsequent seeks within the cached window are Tier-1 or Tier-2 hits.
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <label className="block">
          <span className="block pb-2 font-semibold">Pick an MP4</span>
          <input type="file" accept="video/mp4,video/*" onChange={onFileChange} disabled={busy} />
        </label>
        {progress > 0 && progress < 100 && <progress value={progress} max={100} className="mt-3 w-full" />}
        <p className="mt-3"><span className="text-zinc-500">status:</span> {status}</p>
        {codecInfo && (
          <p className="text-zinc-500">{codecInfo.codec} {codecInfo.codedWidth}×{codecInfo.codedHeight} — {frameCount.toLocaleString()} frames</p>
        )}
      </section>

      {codecInfo && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Seek</h2>
          <input
            type="range"
            min={0}
            max={Math.max(0, frameCount - 1)}
            value={seekFrame}
            onChange={(e) => setSeekFrame(Number(e.target.value))}
            className="w-full"
            disabled={busy}
          />
          <div className="mt-2 flex justify-between text-zinc-500"><span>frame {seekFrame.toLocaleString()}</span><span>/ {frameCount.toLocaleString()}</span></div>
          <button onClick={() => seekToFrame(seekFrame)} disabled={busy} className="mt-3 rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black">
            seek
          </button>
          <button onClick={scrubStress} disabled={busy} className="ml-2 rounded border border-zinc-400 px-3 py-1 disabled:opacity-50">
            scrub stress (60 seeks ±30 frames)
          </button>
          <button onClick={clearCaches} disabled={busy} className="ml-2 rounded border border-zinc-400 px-3 py-1 disabled:opacity-50">
            clear caches
          </button>
        </section>
      )}

      {codecInfo && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Frame</h2>
          <canvas ref={canvasRef} className="w-full rounded border border-zinc-200 bg-black dark:border-zinc-800" />
          {last && (
            <p className="mt-3">
              <span className="text-zinc-500">last:</span> PTS {(last.ts / 1000).toFixed(3)} ms,
              tier <span className={last.tier === 'vram' ? 'text-emerald-600 dark:text-emerald-400' : last.tier === 'ram' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}>{last.tier}</span>,
              latency {fmtMs(last.latencyMs)}
            </p>
          )}
        </section>
      )}

      {codecInfo && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Cache stats</h2>
          <table className="w-full text-left">
            <tbody>
              <tr><td className="w-48 text-zinc-500">VRAM frames</td><td>{stats.vramFrames.toLocaleString()} / {VRAM_CAPACITY}</td></tr>
              <tr><td className="text-zinc-500">RAM frames</td><td>{stats.ramFrames.toLocaleString()} / {RAM_CAPACITY}</td></tr>
              <tr><td className="text-zinc-500">seeks</td><td>{stats.seeks.toLocaleString()}</td></tr>
              <tr><td className="text-zinc-500">VRAM hits</td><td className="text-emerald-600 dark:text-emerald-400">{stats.vramHits.toLocaleString()}</td></tr>
              <tr><td className="text-zinc-500">RAM hits</td><td className="text-amber-600 dark:text-amber-400">{stats.ramHits.toLocaleString()}</td></tr>
              <tr><td className="text-zinc-500">misses</td><td className="text-red-600 dark:text-red-400">{stats.misses.toLocaleString()}</td></tr>
              <tr><td className="text-zinc-500">hit rate</td><td>{hitRate.toFixed(1)} %</td></tr>
              <tr><td className="text-zinc-500">latency median / p95 (last 200)</td><td>{fmtMs(stats.medianMs)} / {fmtMs(stats.p95Ms)}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>First seek to any timestamp: tier=miss, latency &lt; 500 ms</li>
          <li>Immediate re-seek to same frame: tier=vram, latency &lt; 2 ms</li>
          <li>Seek to a frame in the same GOP: tier=ram, latency &lt; 5 ms</li>
          <li>"Scrub stress (60 ±30)" reports 100 % hit rate after a cold pre-warm</li>
          <li>1000 evictions: heap snapshot stable; no GPUTexture or ImageBitmap leaks</li>
        </ul>
      </section>
    </main>
  )
}
