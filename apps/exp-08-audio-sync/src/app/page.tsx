'use client'

import { useEffect, useRef, useState } from 'react'
import { createRingSAB, headerView, RING_FRAMES } from '../lib/ring-buffer'

type WorkerOut =
  | { type: 'INGEST_PROGRESS'; reqId: string; percent: number }
  | { type: 'INGEST_DONE'; reqId: string; fileId: string; codec: string; sampleRate: number; numberOfChannels: number; sampleCount: number; description: number; durationUs: number }
  | { type: 'STARTED'; reqId: string }
  | { type: 'STOPPED'; reqId: string }
  | { type: 'DELETE_DONE'; reqId: string; fileId: string }
  | { type: 'FEED_DONE' }
  | { type: 'DECODER_ERROR'; message: string }
  | { type: 'ERROR'; reqId: string; message: string }

export default function AudioSyncPage() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, (msg: WorkerOut) => void>>(new Map())
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const sabRef = useRef<SharedArrayBuffer | null>(null)
  const rafRef = useRef<number | null>(null)

  const [coi, setCoi] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('idle')
  const [ingestPct, setIngestPct] = useState(0)
  const [src, setSrc] = useState<Extract<WorkerOut, { type: 'INGEST_DONE' }> | null>(null)
  const [running, setRunning] = useState(false)
  const [compensate, setCompensate] = useState(true)
  const [stats, setStats] = useState({
    currentTime: 0,
    outputLatency: 0,
    audibleSec: 0,
    targetUs: 0,
    writeFrames: 0,
    readFrames: 0,
    underruns: 0,
    bufferFillFrames: 0,
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    setCoi(window.crossOriginIsolated)
    const w = new Worker(new URL('../workers/audio.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      if (m.type === 'INGEST_PROGRESS') { setIngestPct(m.percent); return }
      if (m.type === 'DECODER_ERROR') { setStatus(`decoder error: ${m.message}`); return }
      if (m.type === 'FEED_DONE') { setStatus((s) => `${s} (decode feed complete)`); return }
      const cb = pendingRef.current.get(m.reqId)
      if (cb) { pendingRef.current.delete(m.reqId); cb(m) }
    }
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      if (nodeRef.current) { try { nodeRef.current.disconnect() } catch {} }
      if (ctxRef.current) { try { ctxRef.current.close() } catch {} }
      w.terminate()
      workerRef.current = null
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

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setSrc(null); setIngestPct(0)
    setStatus(`ingesting ${file.name}…`)
    const id = crypto.randomUUID()
    const sab = createRingSAB()
    sabRef.current = sab
    try {
      const done = await request<Extract<WorkerOut, { type: 'INGEST_DONE' }>>({ type: 'INGEST', file, fileId: id, sab })
      setSrc(done)
      setStatus(`audio ready: ${done.codec} ${done.sampleRate} Hz × ${done.numberOfChannels} ch, ${done.sampleCount.toLocaleString()} samples`)
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`)
    } finally { setBusy(false); e.target.value = '' }
  }

  async function startPlayback() {
    if (!src || !sabRef.current) return
    setBusy(true)
    try {
      const ctx = new AudioContext({ sampleRate: src.sampleRate })
      ctxRef.current = ctx
      await ctx.audioWorklet.addModule('/audio-worklet-processor.js')
      const node = new AudioWorkletNode(ctx, 'ring-buffer-processor', {
        processorOptions: { sab: sabRef.current },
        outputChannelCount: [2],
      })
      node.connect(ctx.destination)
      nodeRef.current = node
      if (ctx.state !== 'running') await ctx.resume()
      await request({ type: 'START' })
      setRunning(true)
      setStatus(`playing — outputLatency ${(ctx.outputLatency * 1000).toFixed(1)} ms`)
      const tick = () => {
        const c = ctxRef.current
        const sab = sabRef.current
        if (!c || !sab) return
        const h = headerView(sab)
        const writeFrames = Atomics.load(h, 0)
        const readFrames = Atomics.load(h, 1)
        const underruns = Atomics.load(h, 2)
        const audibleSec = c.currentTime - (compensate ? c.outputLatency : 0)
        const targetUs = Math.round(audibleSec * 1_000_000)
        setStats({
          currentTime: c.currentTime,
          outputLatency: c.outputLatency,
          audibleSec,
          targetUs,
          writeFrames,
          readFrames,
          underruns,
          bufferFillFrames: Math.min(writeFrames - readFrames, RING_FRAMES),
        })
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      setStatus(`playback error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function stopPlayback() {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    if (nodeRef.current) { try { nodeRef.current.disconnect() } catch {} }
    nodeRef.current = null
    if (ctxRef.current) { try { await ctxRef.current.close() } catch {} }
    ctxRef.current = null
    if (workerRef.current) await request({ type: 'STOP' }).catch(() => {})
    setRunning(false)
  }

  async function clearAll() {
    if (!src) return
    setBusy(true)
    await stopPlayback()
    await request({ type: 'DELETE', fileId: src.fileId })
    setSrc(null); setStatus('cleared'); setIngestPct(0)
    setBusy(false)
  }

  const durationSec = src ? src.durationUs / 1_000_000 : 0
  const bufferFillMs = src ? (stats.bufferFillFrames / src.sampleRate) * 1000 : 0

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-08 · Audio Sync</h1>
      <p className="mb-6 text-zinc-500">
        AudioDecoder → SharedArrayBuffer ring buffer → AudioWorklet. The display below shows
        the predicted video-frame timestamp for what the user is hearing right now:{' '}
        <code>(currentTime − outputLatency) × 10⁶ μs</code>.
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <p>
          <span className="text-zinc-500">crossOriginIsolated:</span>{' '}
          <span className={coi ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
            {coi === null ? '…' : String(coi)}
          </span>
        </p>
        <p className="text-zinc-500">
          COOP <code>same-origin</code> + COEP <code>require-corp</code> are required for
          SharedArrayBuffer. If false, the worklet/worker SAB plumbing will not work.
        </p>
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <label className="block">
          <span className="block pb-2 font-semibold">Pick a video or audio file</span>
          <input type="file" accept="audio/*,video/*" onChange={onFileChange} disabled={busy} />
        </label>
        {ingestPct > 0 && ingestPct < 100 && <progress value={ingestPct} max={100} className="mt-3 w-full" />}
        <p className="mt-3"><span className="text-zinc-500">status:</span> {status}</p>
        {src && (
          <table className="mt-3 w-full text-left">
            <tbody>
              <tr><td className="w-48 text-zinc-500">codec</td><td>{src.codec}</td></tr>
              <tr><td className="text-zinc-500">sample rate</td><td>{src.sampleRate.toLocaleString()} Hz</td></tr>
              <tr><td className="text-zinc-500">channels</td><td>{src.numberOfChannels}</td></tr>
              <tr><td className="text-zinc-500">duration</td><td>{durationSec.toFixed(2)} s</td></tr>
              <tr><td className="text-zinc-500">description</td><td>{src.description} bytes</td></tr>
            </tbody>
          </table>
        )}
      </section>

      {src && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Playback (user gesture required)</h2>
          <button onClick={startPlayback} disabled={busy || running} className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black">
            start
          </button>
          <button onClick={stopPlayback} disabled={busy || !running} className="ml-2 rounded border border-zinc-400 px-3 py-1 disabled:opacity-50">
            stop
          </button>
          <button onClick={clearAll} disabled={busy} className="ml-2 rounded border border-zinc-400 px-3 py-1 disabled:opacity-50">
            clear
          </button>
          <label className="ml-4 inline-flex items-center gap-2">
            <input type="checkbox" checked={compensate} onChange={(e) => setCompensate(e.target.checked)} />
            <span>compensate outputLatency in video target</span>
          </label>
        </section>
      )}

      {running && src && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Sync clock</h2>
          <table className="w-full text-left">
            <tbody>
              <tr><td className="w-56 text-zinc-500">AudioContext.currentTime</td><td>{stats.currentTime.toFixed(3)} s</td></tr>
              <tr><td className="text-zinc-500">AudioContext.outputLatency</td><td>{(stats.outputLatency * 1000).toFixed(1)} ms</td></tr>
              <tr><td className="text-zinc-500">audible video target</td><td>{stats.audibleSec.toFixed(3)} s ({stats.targetUs.toLocaleString()} μs)</td></tr>
              <tr><td className="text-zinc-500">writeFrames</td><td>{stats.writeFrames.toLocaleString()}</td></tr>
              <tr><td className="text-zinc-500">readFrames</td><td>{stats.readFrames.toLocaleString()}</td></tr>
              <tr><td className="text-zinc-500">buffer fill</td><td>{stats.bufferFillFrames.toLocaleString()} frames (~{bufferFillMs.toFixed(0)} ms)</td></tr>
              <tr><td className="text-zinc-500">underruns</td><td className={stats.underruns ? 'text-amber-600 dark:text-amber-400' : ''}>{stats.underruns.toLocaleString()}</td></tr>
            </tbody>
          </table>
        </section>
      )}

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li><code>crossOriginIsolated === true</code></li>
          <li>Audio plays without crackles; <code>underruns</code> stays at 0 during steady-state</li>
          <li>Wired output: <code>outputLatency</code> &lt; 20 ms; compensation barely changes the video target</li>
          <li>Bluetooth output: <code>outputLatency</code> jumps to 100–250 ms; compensation visibly reduces the video target by that amount</li>
          <li>Heap snapshot after 5 min playback shows no growth (every <code>AudioData.close()</code>d)</li>
        </ul>
      </section>
    </main>
  )
}
