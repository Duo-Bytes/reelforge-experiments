'use client'

import { useEffect, useRef, useState } from 'react'

type RunResult = {
  preprocessMs: number
  inferMs: number
  postprocessMs: number
  totalMs: number
  inputShape: readonly number[]
  outputShape: readonly number[]
  ep: 'webgpu' | 'wasm'
}

const RMBG14_URL = 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx'
const MODEL_CACHE = 'reelforge-onnx-models'

async function fetchCached(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const cache = await caches.open(MODEL_CACHE)
  const hit = await cache.match(url)
  if (hit) return await hit.arrayBuffer()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body) return await res.arrayBuffer()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    onProgress?.(received, total)
  }
  const buf = new Uint8Array(received)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(received) } }))
  return buf.buffer as ArrayBuffer
}

export default function AIPage() {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const compositeCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const sessionRef = useRef<unknown>(null)
  const ortRef = useRef<typeof import('onnxruntime-web') | null>(null)

  const [supported, setSupported] = useState<boolean | null>(null)
  const [modelUrl, setModelUrl] = useState(RMBG14_URL)
  const [wasmPaths, setWasmPaths] = useState('/onnx/')
  const [ep, setEp] = useState<'webgpu' | 'wasm'>('webgpu')
  const [status, setStatus] = useState('idle')
  const [downloaded, setDownloaded] = useState<{ received: number; total: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)

  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && 'gpu' in navigator)
    import('onnxruntime-web')
      .then((ort) => { ortRef.current = ort; setStatus('onnxruntime-web loaded') })
      .catch((err) => setStatus(`onnxruntime-web failed to load: ${(err as Error).message}`))
  }, [])

  async function ensureSession() {
    const ort = ortRef.current
    if (!ort) throw new Error('onnxruntime-web not loaded')
    ort.env.wasm.wasmPaths = wasmPaths
    if (sessionRef.current) return sessionRef.current

    setBusy(true)
    setStatus('fetching model…')
    setDownloaded(null)
    const tLoad0 = performance.now()
    const buf = await fetchCached(modelUrl, (received, total) => setDownloaded({ received, total }))
    setStatus(`creating inference session on ${ep}…`)
    const session = await ort.InferenceSession.create(buf, {
      executionProviders: [ep === 'webgpu' ? 'webgpu' : 'wasm'],
      graphOptimizationLevel: 'all',
    })
    sessionRef.current = session
    setStatus(`session ready (${(performance.now() - tLoad0).toFixed(0)} ms)`)
    setBusy(false)
    return session
  }

  function onImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (imgUrl) URL.revokeObjectURL(imgUrl)
    setImgUrl(URL.createObjectURL(file))
    setResult(null)
    e.target.value = ''
  }

  async function run() {
    const img = imgRef.current
    if (!img || !img.complete || img.naturalWidth === 0) {
      setStatus('image not loaded yet')
      return
    }
    setBusy(true)
    setStatus('running inference…')
    try {
      const session = await ensureSession() as Awaited<ReturnType<typeof import('onnxruntime-web').InferenceSession.create>>
      const ort = ortRef.current!
      const tPre0 = performance.now()
      const W = 1024, H = 1024
      const off = new OffscreenCanvas(W, H)
      const octx = off.getContext('2d', { alpha: false })!
      octx.drawImage(img, 0, 0, W, H)
      const id = octx.getImageData(0, 0, W, H)
      const planar = new Float32Array(3 * W * H)
      for (let i = 0; i < W * H; i++) {
        planar[0 * W * H + i] = id.data[i * 4] / 255
        planar[1 * W * H + i] = id.data[i * 4 + 1] / 255
        planar[2 * W * H + i] = id.data[i * 4 + 2] / 255
      }
      const inputName = session.inputNames[0]
      const input = new ort.Tensor('float32', planar, [1, 3, H, W])
      const tPre1 = performance.now()
      const tInf0 = performance.now()
      const out = await session.run({ [inputName]: input })
      const tInf1 = performance.now()
      const outputName = session.outputNames[0]
      const mask = out[outputName]
      const tPost0 = performance.now()
      const mc = maskCanvasRef.current!
      mc.width = img.naturalWidth
      mc.height = img.naturalHeight
      const mctx = mc.getContext('2d')!
      const maskOff = new OffscreenCanvas(W, H)
      const moctx = maskOff.getContext('2d')!
      const maskImage = moctx.createImageData(W, H)
      const md = mask.data as Float32Array
      for (let i = 0; i < W * H; i++) {
        const v = Math.max(0, Math.min(1, md[i])) * 255
        maskImage.data[i * 4] = v
        maskImage.data[i * 4 + 1] = v
        maskImage.data[i * 4 + 2] = v
        maskImage.data[i * 4 + 3] = 255
      }
      moctx.putImageData(maskImage, 0, 0)
      mctx.drawImage(maskOff, 0, 0, mc.width, mc.height)

      const cc = compositeCanvasRef.current!
      cc.width = img.naturalWidth
      cc.height = img.naturalHeight
      const cctx = cc.getContext('2d')!
      cctx.fillStyle = '#00b347'
      cctx.fillRect(0, 0, cc.width, cc.height)
      cctx.drawImage(img, 0, 0)
      cctx.globalCompositeOperation = 'destination-in'
      cctx.drawImage(maskOff, 0, 0, cc.width, cc.height)
      cctx.globalCompositeOperation = 'destination-over'
      cctx.fillStyle = '#00b347'
      cctx.fillRect(0, 0, cc.width, cc.height)
      cctx.globalCompositeOperation = 'source-over'
      const tPost1 = performance.now()
      const totalMs = tPost1 - tPre0

      setResult({
        preprocessMs: tPre1 - tPre0,
        inferMs: tInf1 - tInf0,
        postprocessMs: tPost1 - tPost0,
        totalMs,
        inputShape: input.dims,
        outputShape: mask.dims,
        ep,
      })
      setStatus(`done in ${totalMs.toFixed(0)} ms (infer ${(tInf1 - tInf0).toFixed(0)} ms)`)
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function clearCache() {
    try {
      const c = await caches.open(MODEL_CACHE)
      const keys = await c.keys()
      for (const k of keys) await c.delete(k)
      setStatus(`cleared ${keys.length} cached model entr${keys.length === 1 ? 'y' : 'ies'}`)
    } catch (err) {
      setStatus(`cache clear failed: ${(err as Error).message}`)
    }
  }

  function destroySession() {
    const s = sessionRef.current as { release?: () => Promise<void> } | null
    s?.release?.().catch(() => {})
    sessionRef.current = null
    setStatus('session released')
  }

  const pct = downloaded?.total ? (downloaded.received / downloaded.total) * 100 : null

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-11 · AI Background Removal</h1>
      <p className="mb-6 text-zinc-500">
        On-device segmentation via <code>onnxruntime-web</code> with the WebGPU execution provider.
        No data leaves the machine. Default model: RMBG-1.4 (~176 MB, fetched once and cached in
        the Cache API).
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <p>
          <span className="text-zinc-500">WebGPU available:</span>{' '}
          <span className={supported ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
            {supported === null ? '…' : String(supported)}
          </span>
        </p>
        <p className="text-zinc-500">status: {status}</p>
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Configuration</h2>
        <label className="block">
          <span className="block pb-1 text-zinc-500">Model URL</span>
          <input value={modelUrl} onChange={(e) => setModelUrl(e.target.value)} className="w-full rounded border border-zinc-400 bg-transparent px-2 py-1" />
        </label>
        <label className="mt-3 block">
          <span className="block pb-1 text-zinc-500">ORT WASM path (must be served same-origin under COEP)</span>
          <input value={wasmPaths} onChange={(e) => setWasmPaths(e.target.value)} className="w-full rounded border border-zinc-400 bg-transparent px-2 py-1" />
        </label>
        <p className="mt-2 text-xs text-zinc-500">
          Required setup: copy <code>node_modules/onnxruntime-web/dist/*.wasm</code> and{' '}
          <code>*.jsep.mjs</code> into <code>public/onnx/</code> (or whichever directory matches the
          path above). COEP <code>require-corp</code> prevents fetching the WASM from a CDN unless
          the CDN sets <code>Cross-Origin-Resource-Policy</code>.
        </p>
        <label className="mt-3 inline-flex items-center gap-2">
          <span className="text-zinc-500">execution provider</span>
          <select value={ep} onChange={(e) => setEp(e.target.value as 'webgpu' | 'wasm')} className="rounded border border-zinc-400 bg-transparent px-2 py-1">
            <option value="webgpu">webgpu</option>
            <option value="wasm">wasm</option>
          </select>
        </label>
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Image</h2>
        <input type="file" accept="image/*" onChange={onImage} disabled={busy} />
        {imgUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img ref={imgRef} src={imgUrl} alt="source" className="mt-3 max-h-64 rounded border border-zinc-200 dark:border-zinc-800" />
        )}
      </section>

      <section className="mb-6 flex flex-wrap gap-2">
        <button onClick={run} disabled={busy || !imgUrl} className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black">
          segment
        </button>
        <button onClick={destroySession} disabled={busy} className="rounded border border-zinc-400 px-3 py-1 disabled:opacity-50">
          release session
        </button>
        <button onClick={clearCache} disabled={busy} className="rounded border border-zinc-400 px-3 py-1 disabled:opacity-50">
          clear cached models
        </button>
      </section>

      {pct !== null && pct < 100 && downloaded && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <p className="text-zinc-500">downloading model… {(downloaded.received / 1024 / 1024).toFixed(1)} MiB / {(downloaded.total / 1024 / 1024).toFixed(1)} MiB</p>
          <progress value={pct} max={100} className="mt-2 w-full" />
        </section>
      )}

      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <p className="mb-2 text-zinc-500">mask</p>
          <canvas ref={maskCanvasRef} className="w-full rounded border border-zinc-200 bg-black dark:border-zinc-800" />
        </div>
        <div className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
          <p className="mb-2 text-zinc-500">composite (green background)</p>
          <canvas ref={compositeCanvasRef} className="w-full rounded border border-zinc-200 bg-black dark:border-zinc-800" />
        </div>
      </section>

      {result && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Timing</h2>
          <table className="w-full text-left">
            <tbody>
              <tr><td className="w-48 text-zinc-500">execution provider</td><td>{result.ep}</td></tr>
              <tr><td className="text-zinc-500">input shape</td><td>{result.inputShape.join(' × ')}</td></tr>
              <tr><td className="text-zinc-500">output shape</td><td>{result.outputShape.join(' × ')}</td></tr>
              <tr><td className="text-zinc-500">preprocess</td><td>{result.preprocessMs.toFixed(1)} ms</td></tr>
              <tr><td className="text-zinc-500">inference</td><td>{result.inferMs.toFixed(1)} ms</td></tr>
              <tr><td className="text-zinc-500">postprocess</td><td>{result.postprocessMs.toFixed(1)} ms</td></tr>
              <tr><td className="text-zinc-500">total (this run)</td><td>{result.totalMs.toFixed(1)} ms</td></tr>
            </tbody>
          </table>
        </section>
      )}

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>Place onnxruntime-web WASM files in <code>public/onnx/</code> (or update the path field)</li>
          <li>WebGPU EP infer time &lt; 100 ms/frame at 1024×1024 on a modern discrete GPU; WASM EP is the SW fallback</li>
          <li>Mask preview shows a clean soft-alpha matte; composite over green shows the subject cleanly cut out</li>
          <li>Second segmentation call reuses the cached session: total time drops to ~ infer + pre/post (no fetch, no compile)</li>
          <li>"clear cached models" purges the Cache API entry; next run re-downloads from HuggingFace</li>
        </ul>
      </section>
    </main>
  )
}
