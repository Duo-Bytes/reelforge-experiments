'use client'

import { useEffect, useRef, useState } from 'react'
import { COMPOSITOR_WGSL } from '../lib/shaders'

type GPUState = {
  device: GPUDevice
  context: GPUCanvasContext
  pipeline: GPURenderPipeline
  sampler: GPUSampler
  mixBuf: GPUBuffer
}

function fmtMs(n: number) {
  return n < 1 ? `${(n * 1000).toFixed(0)} µs` : `${n.toFixed(2)} ms`
}

export default function CompositorPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoARef = useRef<HTMLVideoElement | null>(null)
  const videoBRef = useRef<HTMLVideoElement | null>(null)
  const gpuRef = useRef<GPUState | null>(null)
  const rvfcARef = useRef<number | null>(null)
  const rvfcBRef = useRef<number | null>(null)
  const latestFrameARef = useRef<{ ts: number; frame: VideoFrame } | null>(null)
  const latestFrameBRef = useRef<{ ts: number; frame: VideoFrame } | null>(null)
  const rafRef = useRef<number | null>(null)
  const statsRef = useRef({ rendered: 0, totalGpuMs: 0, lastGpuMs: 0, peakGpuMs: 0 })
  const topAlphaRef = useRef(0.7)
  const topScaleRef = useRef(0.35)

  const [supported, setSupported] = useState<boolean | null>(null)
  const [status, setStatus] = useState('idle')
  const [aUrl, setAUrl] = useState<string | null>(null)
  const [bUrl, setBUrl] = useState<string | null>(null)
  const [topAlpha, setTopAlpha] = useState(0.7)
  const [topScale, setTopScale] = useState(0.35)
  const [framesRendered, setFramesRendered] = useState(0)
  const [avgGpuMs, setAvgGpuMs] = useState(0)
  const [peakGpuMs, setPeakGpuMs] = useState(0)
  const [adapterInfo, setAdapterInfo] = useState<{ vendor: string; arch: string; description: string } | null>(null)

  useEffect(() => { topAlphaRef.current = topAlpha }, [topAlpha])
  useEffect(() => { topScaleRef.current = topScale }, [topScale])

  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && 'gpu' in navigator)
  }, [])

  async function initGpu() {
    if (gpuRef.current) return gpuRef.current
    const canvas = canvasRef.current
    if (!canvas) throw new Error('no canvas')
    if (!('gpu' in navigator)) throw new Error('WebGPU not supported')
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('no GPU adapter')
    const info = adapter.info
    if (info) setAdapterInfo({ vendor: info.vendor, arch: info.architecture, description: info.description })
    const device = await adapter.requestDevice()
    device.lost.then((l) => {
      setStatus(`GPU device lost: ${l.reason} (${l.message})`)
      gpuRef.current = null
    })
    const context = canvas.getContext('webgpu') as GPUCanvasContext
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })

    const module = device.createShaderModule({ code: COMPOSITOR_WGSL })
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    const mixBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const state: GPUState = { device, context, pipeline, sampler, mixBuf }
    gpuRef.current = state
    return state
  }

  function attachVideo(ref: React.RefObject<HTMLVideoElement | null>, isA: boolean, file: File) {
    const v = ref.current
    if (!v) return
    const url = URL.createObjectURL(file)
    v.src = url
    v.muted = true
    v.loop = true
    v.playsInline = true
    v.play().catch(() => {})
    if (isA) setAUrl(url); else setBUrl(url)
    const cancelRef = isA ? rvfcARef : rvfcBRef
    if (cancelRef.current != null && 'cancelVideoFrameCallback' in v) {
      try { (v as unknown as { cancelVideoFrameCallback: (id: number) => void }).cancelVideoFrameCallback(cancelRef.current) } catch {}
    }
    const latestRef = isA ? latestFrameARef : latestFrameBRef
    const cb = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      try {
        const f = new VideoFrame(v, { timestamp: Math.round(metadata.mediaTime * 1_000_000) })
        latestRef.current?.frame.close()
        latestRef.current = { ts: metadata.mediaTime, frame: f }
      } catch (err) {
        setStatus(`frame source error (${isA ? 'A' : 'B'}): ${(err as Error).message}`)
      }
      cancelRef.current = v.requestVideoFrameCallback(cb)
    }
    cancelRef.current = v.requestVideoFrameCallback(cb)
  }

  async function onPickA(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    try {
      await initGpu()
      attachVideo(videoARef, true, f)
      startRenderLoop()
      setStatus('layer A attached — rendering')
    } catch (err) {
      setStatus(`init error: ${(err as Error).message}`)
    } finally { e.target.value = '' }
  }

  function onPickB(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    attachVideo(videoBRef, false, f)
    setStatus('layer B attached')
    e.target.value = ''
  }

  function clearB() {
    const v = videoBRef.current
    if (v) v.pause()
    if (rvfcBRef.current != null && v && 'cancelVideoFrameCallback' in v) {
      try { (v as unknown as { cancelVideoFrameCallback: (id: number) => void }).cancelVideoFrameCallback(rvfcBRef.current) } catch {}
    }
    rvfcBRef.current = null
    if (latestFrameBRef.current) {
      latestFrameBRef.current.frame.close()
      latestFrameBRef.current = null
    }
    if (bUrl) { URL.revokeObjectURL(bUrl); setBUrl(null) }
  }

  function startRenderLoop() {
    if (rafRef.current != null) return
    const loop = () => {
      const gpu = gpuRef.current
      const a = latestFrameARef.current
      if (!gpu || !a) { rafRef.current = requestAnimationFrame(loop); return }
      const t = performance.now()
      const canvas = canvasRef.current!
      const aw = a.frame.displayWidth
      const ah = a.frame.displayHeight
      if (canvas.width !== aw) canvas.width = aw
      if (canvas.height !== ah) canvas.height = ah

      const b = latestFrameBRef.current
      const hasTop = b ? 1.0 : 0.0
      const mix = new Float32Array([topAlphaRef.current, hasTop, topScaleRef.current, 0])
      gpu.device.queue.writeBuffer(gpu.mixBuf, 0, mix)

      // CRITICAL: importExternalTexture, bind group, and submit must all happen
      // in the same synchronous block — texture_external is invalid after the
      // current microtask completes.
      const ext0 = gpu.device.importExternalTexture({ source: a.frame })
      const ext1 = b
        ? gpu.device.importExternalTexture({ source: b.frame })
        : ext0 // gated by hasTop uniform
      const bind = gpu.device.createBindGroup({
        layout: gpu.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: gpu.sampler },
          { binding: 1, resource: ext0 },
          { binding: 2, resource: ext1 },
          { binding: 3, resource: { buffer: gpu.mixBuf } },
        ],
      })
      const enc = gpu.device.createCommandEncoder()
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: gpu.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      })
      pass.setPipeline(gpu.pipeline)
      pass.setBindGroup(0, bind)
      pass.draw(6)
      pass.end()
      gpu.device.queue.submit([enc.finish()])

      const dt = performance.now() - t
      const s = statsRef.current
      s.rendered++
      s.totalGpuMs += dt
      s.lastGpuMs = dt
      if (dt > s.peakGpuMs) s.peakGpuMs = dt
      if (s.rendered % 30 === 0) {
        setFramesRendered(s.rendered)
        setAvgGpuMs(s.totalGpuMs / s.rendered)
        setPeakGpuMs(s.peakGpuMs)
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
  }

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      latestFrameARef.current?.frame.close()
      latestFrameBRef.current?.frame.close()
      if (aUrl) URL.revokeObjectURL(aUrl)
      if (bUrl) URL.revokeObjectURL(bUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="mx-auto max-w-4xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-04 · WebGPU Compositor</h1>
      <p className="mb-6 text-zinc-500">
        Two video layers → <code>importExternalTexture</code> → WGSL fragment shader → canvas.
        Frame source is <code>requestVideoFrameCallback</code> wrapping each frame as a
        <code> VideoFrame</code> at native resolution. Zero-copy YUV→RGB happens inside the GPU.
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <p>
          <span className="text-zinc-500">WebGPU available:</span>{' '}
          <span className={supported ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
            {supported === null ? '…' : String(supported)}
          </span>
        </p>
        {adapterInfo && (
          <p className="mt-1 text-zinc-500">
            adapter: {adapterInfo.vendor || '?'} / {adapterInfo.arch || '?'} {adapterInfo.description && `· ${adapterInfo.description}`}
          </p>
        )}
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Layer A (base)</h2>
        <input type="file" accept="video/*" onChange={onPickA} />
        <video ref={videoARef} className="mt-3 hidden" />
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Layer B (overlay, picture-in-picture)</h2>
        <input type="file" accept="video/*" onChange={onPickB} />
        <button onClick={clearB} className="ml-2 rounded border border-zinc-400 px-3 py-1">clear B</button>
        <video ref={videoBRef} className="mt-3 hidden" />
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2">
            <span className="text-zinc-500 w-24">top alpha</span>
            <input type="range" min={0} max={1} step={0.01} value={topAlpha} onChange={(e) => setTopAlpha(Number(e.target.value))} className="w-48" />
            <span>{topAlpha.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-zinc-500 w-24">PiP scale</span>
            <input type="range" min={0.1} max={1} step={0.01} value={topScale} onChange={(e) => setTopScale(Number(e.target.value))} className="w-48" />
            <span>{topScale.toFixed(2)}</span>
          </label>
        </div>
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Output</h2>
        <canvas ref={canvasRef} className="w-full rounded border border-zinc-200 bg-black dark:border-zinc-800" />
        <p className="mt-3 text-zinc-500">{status}</p>
        <table className="mt-3 w-full text-left">
          <tbody>
            <tr><td className="w-48 text-zinc-500">frames rendered</td><td>{framesRendered.toLocaleString()}</td></tr>
            <tr><td className="text-zinc-500">avg encode time</td><td>{fmtMs(avgGpuMs)}</td></tr>
            <tr><td className="text-zinc-500">peak encode time</td><td>{fmtMs(peakGpuMs)}</td></tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-500">
          Note: encode time is the JS time recording + submitting the command buffer, not actual
          GPU work. True GPU time requires a timestamp query and a back-channel readback (added
          in exp-06 if needed).
        </p>
      </section>

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>WebGPU available: true; adapter info populated</li>
          <li>Single-layer render visually matches the source video (no color shift = YUV→RGB done by GPU)</li>
          <li>Two-layer PiP renders with adjustable alpha and scale</li>
          <li>Encode time &lt; 2 ms per frame at 1080p</li>
          <li>1000 frames → DevTools heap shows no growth (VideoFrames closed on each new rVFC)</li>
          <li>Main-thread CPU &lt; 3% during steady-state playback</li>
        </ul>
      </section>
    </main>
  )
}
