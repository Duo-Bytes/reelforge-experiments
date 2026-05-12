'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore, activeClipAt, type Clip, type Sample, type SourceMedia } from '../lib/store'
// shaders are inlined in this file so they can share the bind group layout assumptions

type WorkerOut =
  | { type: 'INGEST_PROGRESS'; reqId: string; percent: number }
  | { type: 'INGEST_DONE'; reqId: string; fileId: string; codec: string; codedWidth: number; codedHeight: number; description: Uint8Array; samples: Sample[]; ptsIndex: number[]; durationUs: number; fps: number; fileName: string; fileSize: number }
  | { type: 'READ_RESULT'; reqId: string; bytes: Uint8Array }
  | { type: 'ERROR'; reqId: string; message: string }

const TRACK_HEIGHT = 56
const HEADER_HEIGHT = 28
const VRAM_PER_SOURCE = 60

const EXT_WGSL = /* wgsl */ `
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
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(tex, samp, in.uv);
}
`

const BLIT_WGSL = /* wgsl */ `
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
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return textureSampleLevel(tex, samp, in.uv, 0.0);
}
`

export default function IntegrationPage() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, (msg: WorkerOut) => void>>(new Map())
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const playheadRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const playStartTRef = useRef(0)
  const playStartUsRef = useRef(0)
  const playheadUsRef = useRef(0)

  const decodersRef = useRef<Map<string, VideoDecoder>>(new Map())
  const decoderPendingRef = useRef<Map<string, { targetTs: number; resolve: (f: VideoFrame) => void; reject: (e: Error) => void }>>(new Map())
  const vramRef = useRef<Map<string, Map<number, GPUTexture>>>(new Map())

  const deviceRef = useRef<GPUDevice | null>(null)
  const contextRef = useRef<GPUCanvasContext | null>(null)
  const extPipeRef = useRef<GPURenderPipeline | null>(null)
  const blitPipeRef = useRef<GPURenderPipeline | null>(null)
  const samplerRef = useRef<GPUSampler | null>(null)

  const sources = useStore(useShallow((s) => Object.values(s.sources)))
  const clips = useStore(useShallow((s) => s.clips))
  const pxPerSec = useStore((s) => s.pxPerSec)
  const totalDurationUs = useMemo(() => clips.reduce((acc, c) => Math.max(acc, c.startUs + c.durationUs), 0), [clips])

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('idle')
  const [ingestPct, setIngestPct] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playheadUs, setPlayheadUs] = useState(0)
  const [renderTier, setRenderTier] = useState<'vram' | 'decode' | 'gap' | 'idle'>('idle')
  const [lastRenderMs, setLastRenderMs] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = new Worker(new URL('../workers/ingest.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      if (m.type === 'INGEST_PROGRESS') { setIngestPct(m.percent); return }
      const cb = pendingRef.current.get(m.reqId)
      if (cb) { pendingRef.current.delete(m.reqId); cb(m) }
    }
    return () => {
      w.terminate(); workerRef.current = null
      for (const [, d] of decodersRef.current) if (d.state !== 'closed') d.close()
      for (const [, vmap] of vramRef.current) for (const [, t] of vmap) t.destroy()
    }
  }, [])

  function request<T extends WorkerOut>(msg: { type: string } & Record<string, unknown>): Promise<T> {
    const w = workerRef.current
    if (!w) return Promise.reject(new Error('worker not ready'))
    const reqId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      pendingRef.current.set(reqId, (out) => {
        if (out.type === 'ERROR') reject(new Error(out.message))
        else resolve(out as T)
      })
      w.postMessage({ ...msg, reqId })
    })
  }

  async function initGpu() {
    if (deviceRef.current) return
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
    const extModule = device.createShaderModule({ code: EXT_WGSL })
    const blitModule = device.createShaderModule({ code: BLIT_WGSL })
    const extPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: extModule, entryPoint: 'vs_main' },
      fragment: { module: extModule, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
    const blitPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blitModule, entryPoint: 'vs_main' },
      fragment: { module: blitModule, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    deviceRef.current = device
    contextRef.current = context
    extPipeRef.current = extPipe
    blitPipeRef.current = blitPipe
    samplerRef.current = sampler
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    setBusy(true)
    try {
      await initGpu()
      for (const file of files) {
        const fileId = crypto.randomUUID()
        setStatus(`ingesting ${file.name}…`)
        setIngestPct(0)
        const done = await request<Extract<WorkerOut, { type: 'INGEST_DONE' }>>({ type: 'INGEST', file, fileId })
        const sm: SourceMedia = {
          fileId: done.fileId, codec: done.codec, codedWidth: done.codedWidth, codedHeight: done.codedHeight,
          description: done.description, samples: done.samples, ptsIndex: done.ptsIndex,
          durationUs: done.durationUs, fps: done.fps, fileName: done.fileName, fileSize: done.fileSize,
        }
        useStore.getState().addSource(sm)
        useStore.getState().addClip(sm.fileId)
        await ensureDecoder(sm)
      }
      setStatus(`ready — ${useStore.getState().clips.length} clips`)
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`)
    } finally { setBusy(false); e.target.value = '' }
  }

  async function ensureDecoder(src: SourceMedia) {
    if (decodersRef.current.has(src.fileId)) return
    const support = await VideoDecoder.isConfigSupported({
      codec: src.codec, codedWidth: src.codedWidth, codedHeight: src.codedHeight, description: src.description, hardwareAcceleration: 'prefer-hardware',
    })
    if (!support.supported) throw new Error(`codec not supported: ${src.codec}`)
    const dec = new VideoDecoder({
      output: (frame) => {
        const pending = decoderPendingRef.current.get(src.fileId)
        if (pending && frame.timestamp === pending.targetTs) {
          decoderPendingRef.current.delete(src.fileId)
          pending.resolve(frame)
          return
        }
        // adjacent frame in the GOP — cache it
        cacheFrameInVRAM(src.fileId, frame).catch(() => frame.close())
      },
      error: (err) => setStatus(`decoder error (${src.fileName}): ${err.message}`),
    })
    dec.configure({
      codec: src.codec, codedWidth: src.codedWidth, codedHeight: src.codedHeight, description: src.description, hardwareAcceleration: 'prefer-hardware',
    })
    decodersRef.current.set(src.fileId, dec)
    vramRef.current.set(src.fileId, new Map())
  }

  async function cacheFrameInVRAM(fileId: string, frame: VideoFrame) {
    const device = deviceRef.current
    if (!device) { frame.close(); return }
    const map = vramRef.current.get(fileId)
    if (!map) { frame.close(); return }
    const tex = device.createTexture({
      size: [frame.displayWidth, frame.displayHeight, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const ext = device.importExternalTexture({ source: frame })
    const bind = device.createBindGroup({
      layout: extPipeRef.current!.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: samplerRef.current! }, { binding: 1, resource: ext }],
    })
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    })
    pass.setPipeline(extPipeRef.current!)
    pass.setBindGroup(0, bind)
    pass.draw(6)
    pass.end()
    device.queue.submit([enc.finish()])
    const ts = frame.timestamp
    frame.close()
    map.set(ts, tex)
    while (map.size > VRAM_PER_SOURCE) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.get(oldest)?.destroy()
      map.delete(oldest)
    }
  }

  function gopForTarget(src: SourceMedia, targetUs: number): Sample[] {
    const arr = src.samples
    const pts = src.ptsIndex
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

  async function feedGopFor(src: SourceMedia, targetUs: number): Promise<VideoFrame> {
    const dec = decodersRef.current.get(src.fileId)!
    return new Promise<VideoFrame>((resolve, reject) => {
      decoderPendingRef.current.set(src.fileId, { targetTs: targetUs, resolve, reject })
      ;(async () => {
        try {
          const gop = gopForTarget(src, targetUs)
          for (const s of gop) {
            while (dec.decodeQueueSize > 5) await new Promise<void>((r) => setTimeout(r, 0))
            const r = await request<Extract<WorkerOut, { type: 'READ_RESULT' }>>({
              type: 'READ', fileId: src.fileId, offset: s.offset, size: s.size,
            })
            dec.decode(new EncodedVideoChunk({
              type: s.isKeyframe ? 'key' : 'delta',
              timestamp: s.timestamp,
              duration: s.duration,
              data: r.bytes,
            }))
          }
          await dec.flush()
          const p = decoderPendingRef.current.get(src.fileId)
          if (p) { decoderPendingRef.current.delete(src.fileId); reject(new Error('seek miss')) }
        } catch (err) { reject(err as Error) }
      })()
    })
  }

  async function renderAt(timelineUs: number) {
    const t0 = performance.now()
    const c = activeClipAt(timelineUs, clips)
    if (!c) {
      const device = deviceRef.current
      const context = contextRef.current
      if (device && context) {
        const canvas = canvasRef.current!
        if (canvas.width !== 1280) canvas.width = 1280
        if (canvas.height !== 720) canvas.height = 720
        const enc = device.createCommandEncoder()
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        })
        pass.end()
        device.queue.submit([enc.finish()])
      }
      setRenderTier('gap')
      setLastRenderMs(performance.now() - t0)
      return
    }
    const src = useStore.getState().sources[c.sourceFileId]
    if (!src) return
    const sourceTs = c.sourceStartUs + (timelineUs - c.startUs)
    const idx = nearestSampleIdx(src, sourceTs)
    const pts = src.samples[src.ptsIndex[idx]].timestamp

    const vram = vramRef.current.get(src.fileId)!
    let tex = vram.get(pts)
    let tier: 'vram' | 'decode' = 'vram'
    if (!tex) {
      tier = 'decode'
      const frame = await feedGopFor(src, pts)
      await cacheFrameInVRAM(src.fileId, frame)
      tex = vram.get(pts)!
    }
    renderTextureToCanvas(tex)
    setRenderTier(tier)
    setLastRenderMs(performance.now() - t0)
  }

  function nearestSampleIdx(src: SourceMedia, sourceUs: number): number {
    const arr = src.samples
    const pts = src.ptsIndex
    let lo = 0, hi = pts.length - 1, ptsRank = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (arr[pts[mid]].timestamp <= sourceUs) { ptsRank = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    return ptsRank
  }

  function renderTextureToCanvas(tex: GPUTexture) {
    const device = deviceRef.current!
    const context = contextRef.current!
    const blit = blitPipeRef.current!
    const sampler = samplerRef.current!
    const canvas = canvasRef.current!
    if (canvas.width !== tex.width) canvas.width = tex.width
    if (canvas.height !== tex.height) canvas.height = tex.height
    const bind = device.createBindGroup({
      layout: blit.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: tex.createView() }],
    })
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    })
    pass.setPipeline(blit)
    pass.setBindGroup(0, bind)
    pass.draw(6)
    pass.end()
    device.queue.submit([enc.finish()])
  }

  useEffect(() => {
    if (!playing) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      return
    }
    playStartTRef.current = performance.now()
    playStartUsRef.current = playheadUsRef.current
    const loop = async () => {
      const elapsedMs = performance.now() - playStartTRef.current
      const cur = playStartUsRef.current + elapsedMs * 1000
      if (cur >= totalDurationUs) {
        setPlaying(false)
        playheadUsRef.current = totalDurationUs
        const px = (totalDurationUs / 1_000_000) * pxPerSec
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${px}px)`
        return
      }
      playheadUsRef.current = cur
      setPlayheadUs(cur)
      const px = (cur / 1_000_000) * pxPerSec
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${px}px)`
      try { await renderAt(cur) } catch { /* transient */ }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, pxPerSec, totalDurationUs, clips])

  async function seekToFraction(frac: number) {
    const t = Math.max(0, Math.min(totalDurationUs, totalDurationUs * frac))
    playheadUsRef.current = t
    setPlayheadUs(t)
    const px = (t / 1_000_000) * pxPerSec
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${px}px)`
    try { await renderAt(t) } catch (err) { setStatus(`render error: ${(err as Error).message}`) }
  }

  function clearAll() {
    setPlaying(false)
    useStore.getState().clearAll()
    for (const [, d] of decodersRef.current) if (d.state !== 'closed') d.close()
    decodersRef.current.clear()
    for (const [, vmap] of vramRef.current) for (const [, t] of vmap) t.destroy()
    vramRef.current.clear()
    playheadUsRef.current = 0
    setPlayheadUs(0)
    if (playheadRef.current) playheadRef.current.style.transform = 'translateX(0px)'
    setStatus('cleared')
  }

  const totalWidthPx = Math.max(800, (totalDurationUs / 1_000_000) * pxPerSec)

  return (
    <main className="font-mono text-sm">
      <header className="border-b border-zinc-800 bg-black p-4 text-zinc-100">
        <h1 className="text-2xl font-bold">Exp-12 · Mini NLE Integration</h1>
        <p className="text-zinc-500">
          Drop in multiple videos; each becomes a clip on the timeline. Play to advance the
          playhead — the compositor decodes the active source clip, caches frames into a
          per-source VRAM ring, and renders via WebGPU. Gaps render as black.
        </p>
      </header>

      <section className="border-b border-zinc-800 bg-zinc-950 p-4 text-zinc-200">
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept="video/*" multiple onChange={onFile} disabled={busy} />
          {ingestPct > 0 && ingestPct < 100 && <progress value={ingestPct} max={100} className="w-40" />}
          <button onClick={() => setPlaying((p) => !p)} disabled={!clips.length} className="rounded bg-zinc-100 px-3 py-1 text-black disabled:opacity-50">{playing ? 'pause' : 'play'}</button>
          <button onClick={() => seekToFraction(0)} disabled={!clips.length} className="rounded border border-zinc-600 px-3 py-1 disabled:opacity-50">to start</button>
          <button onClick={() => seekToFraction(1)} disabled={!clips.length} className="rounded border border-zinc-600 px-3 py-1 disabled:opacity-50">to end</button>
          <button onClick={clearAll} className="rounded border border-zinc-600 px-3 py-1">clear</button>
          <span className="ml-auto text-zinc-500">
            playhead {(playheadUs / 1_000_000).toFixed(3)} / {(totalDurationUs / 1_000_000).toFixed(3)} s · tier {renderTier} · {lastRenderMs.toFixed(1)} ms
          </span>
        </div>
        <p className="mt-2 text-zinc-500">{status}</p>
      </section>

      <section className="border-b border-zinc-800 bg-black p-4">
        <canvas ref={canvasRef} className="w-full max-h-[60vh] rounded bg-black object-contain" />
      </section>

      <section className="border-b border-zinc-800 bg-black p-4">
        <input
          type="range"
          min={0}
          max={1}
          step={0.0001}
          value={totalDurationUs ? playheadUs / totalDurationUs : 0}
          onChange={(e) => { setPlaying(false); seekToFraction(Number(e.target.value)) }}
          className="w-full"
          disabled={!clips.length}
        />
        <div className="relative mt-3 overflow-x-auto" style={{ height: HEADER_HEIGHT + TRACK_HEIGHT + 16 }}>
          <div className="relative bg-zinc-900" style={{ width: totalWidthPx, height: HEADER_HEIGHT }}>
            {Array.from({ length: Math.ceil(totalDurationUs / 1_000_000) + 1 }).map((_, i) => (
              <div key={i} className="absolute top-0 h-full border-l border-zinc-700 text-[10px] text-zinc-500" style={{ left: i * pxPerSec }}>
                <span className="ml-1">{i}s</span>
              </div>
            ))}
          </div>
          <div className="relative border-b border-zinc-800" style={{ height: TRACK_HEIGHT, width: totalWidthPx }}>
            {clips.map((c) => <ClipBox key={c.id} c={c} pxPerSec={pxPerSec} />)}
            <div ref={playheadRef} className="pointer-events-none absolute top-0 bottom-0 w-px bg-amber-400" style={{ height: TRACK_HEIGHT, transform: 'translateX(0px)' }} />
          </div>
        </div>
        <p className="mt-2 text-zinc-500">{sources.length} source{sources.length === 1 ? '' : 's'} · {clips.length} clip{clips.length === 1 ? '' : 's'}</p>
      </section>

      <section className="m-4 rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>Drop 2 - 3 different videos; each gets a clip on the timeline in order</li>
          <li>Press play; playhead crosses clip boundaries seamlessly (gap shows black)</li>
          <li>renderTier alternates between "decode" (cold) and "vram" (warm); after a few seconds steady-state is mostly "vram"</li>
          <li>Heap snapshot after 5 min playback: no growth (every VideoFrame closed; cache eviction destroys GPUTextures)</li>
          <li>Drag the seek bar across clip boundaries — first decode of a new clip takes ~ a few hundred ms, then steady &lt; 5 ms</li>
        </ul>
      </section>
    </main>
  )
}

function ClipBox({ c, pxPerSec }: { c: Clip; pxPerSec: number }) {
  const x = (c.startUs / 1_000_000) * pxPerSec
  const w = (c.durationUs / 1_000_000) * pxPerSec
  return (
    <div
      className="absolute top-1 bottom-1 flex items-center overflow-hidden rounded px-2 text-xs"
      style={{ left: x, width: Math.max(2, w), background: c.color, color: '#0a0a0a' }}
      title={`${c.label} — start ${(c.startUs / 1000).toFixed(0)} ms, dur ${(c.durationUs / 1000).toFixed(0)} ms`}
    >
      <span className="truncate">{c.label}</span>
    </div>
  )
}
