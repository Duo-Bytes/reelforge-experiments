'use client'

import { useEffect, useRef, useState } from 'react'

type WorkerOut =
  | { type: 'INITIALIZED' }
  | { type: 'FPS'; fps: number; totalFrames: number; elapsedSec: number }
  | { type: 'DEVICE_LOST'; reason: string; message: string }
  | { type: 'ERROR'; message: string }

export default function OffscreenPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const initializedRef = useRef(false)

  const [supported, setSupported] = useState<boolean | null>(null)
  const [status, setStatus] = useState('idle')
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [counter, setCounter] = useState(0)
  const [stressRunning, setStressRunning] = useState(false)
  const [mainTaskLogs, setMainTaskLogs] = useState<Array<{ when: number; dur: number }>>([])

  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && 'gpu' in navigator)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (initializedRef.current) return // StrictMode double-mount guard
    const canvas = canvasRef.current
    if (!canvas) return

    // Set the backing pixel size before transfer (transferControlToOffscreen snapshots dims).
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth || 800
    const cssH = canvas.clientHeight || Math.round((cssW * 9) / 16)
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)

    const offscreen = canvas.transferControlToOffscreen()
    const w = new Worker(new URL('../workers/render.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    initializedRef.current = true

    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      if (m.type === 'INITIALIZED') {
        setStatus('worker initialized; click play to start')
        return
      }
      if (m.type === 'FPS') {
        setFps(m.fps)
        setTotalFrames(m.totalFrames)
        setElapsedSec(m.elapsedSec)
        return
      }
      if (m.type === 'DEVICE_LOST') {
        setStatus(`worker GPU device lost: ${m.reason}: ${m.message}`)
        return
      }
      if (m.type === 'ERROR') {
        setStatus(`worker error: ${m.message}`)
      }
    }
    w.postMessage({ type: 'INIT', canvas: offscreen, width: canvas.width, height: canvas.height }, [offscreen])

    // Long Animation Frame observer on main thread — proves that even big
    // main-thread tasks don't pause the worker's render loop.
    let loafObs: PerformanceObserver | null = null
    if ('PerformanceObserver' in window) {
      try {
        loafObs = new PerformanceObserver((list) => {
          const xs = list.getEntries().map((e) => ({ when: e.startTime, dur: e.duration }))
          setMainTaskLogs((cur) => [...xs, ...cur].slice(0, 20))
        })
        loafObs.observe({ type: 'long-animation-frame', buffered: true })
      } catch {
        // older Chrome may not support LoAF — silently skip
      }
    }

    return () => {
      loafObs?.disconnect()
      w.terminate()
      workerRef.current = null
      initializedRef.current = false
    }
  }, [])

  function play() {
    workerRef.current?.postMessage({ type: 'PLAY' })
    setPlaying(true)
  }
  function pause() {
    workerRef.current?.postMessage({ type: 'PAUSE' })
    setPlaying(false)
  }

  function stressReact() {
    if (stressRunning) return
    setStressRunning(true)
    let n = 0
    const step = () => {
      setCounter((c) => c + 1)
      n++
      if (n < 100) requestAnimationFrame(step)
      else setStressRunning(false)
    }
    requestAnimationFrame(step)
  }

  function stressBlock() {
    // Burns ~120 ms of synchronous main-thread CPU. The worker render loop
    // must keep advancing at vsync rate during this — that's the point.
    const end = performance.now() + 120
    let n = 0
    // eslint-disable-next-line no-empty
    while (performance.now() < end) { n++ }
    setCounter((c) => c + 1)
    setStatus(`blocked main thread ~120 ms (busy-loop iters: ${n})`)
  }

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-05 · OffscreenCanvas Worker</h1>
      <p className="mb-6 text-zinc-500">
        Render loop runs entirely inside a Web Worker via{' '}
        <code>transferControlToOffscreen()</code> and a <code>MessageChannel</code> rAF-equivalent.
        Use the stress buttons below to flood the main thread; the worker FPS must stay rock-steady.
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <p>
          <span className="text-zinc-500">WebGPU available (main thread):</span>{' '}
          <span className={supported ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
            {supported === null ? '…' : String(supported)}
          </span>
        </p>
        <p className="text-zinc-500">status: {status}</p>
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <canvas
          ref={canvasRef}
          className="w-full rounded border border-zinc-200 bg-black dark:border-zinc-800"
          style={{ aspectRatio: '16 / 9' }}
        />
        <div className="mt-3 flex gap-2">
          <button onClick={play} disabled={playing} className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black">play</button>
          <button onClick={pause} disabled={!playing} className="rounded border border-zinc-400 px-3 py-1 disabled:opacity-50">pause</button>
        </div>
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Worker stats</h2>
        <table className="w-full text-left">
          <tbody>
            <tr><td className="w-48 text-zinc-500">fps (last 500 ms)</td><td>{fps.toFixed(1)}</td></tr>
            <tr><td className="text-zinc-500">total frames</td><td>{totalFrames.toLocaleString()}</td></tr>
            <tr><td className="text-zinc-500">elapsed</td><td>{elapsedSec.toFixed(2)} s</td></tr>
            <tr><td className="text-zinc-500">avg fps (lifetime)</td><td>{elapsedSec > 0 ? (totalFrames / elapsedSec).toFixed(1) : '—'}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Main-thread stress (should NOT affect worker fps)</h2>
        <button onClick={stressReact} disabled={stressRunning} className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black">
          100 React setState bursts
        </button>
        <button onClick={stressBlock} className="ml-2 rounded border border-zinc-400 px-3 py-1">
          block main thread ~120 ms
        </button>
        <p className="mt-2 text-zinc-500">counter: {counter}</p>
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-3 font-semibold">Long Animation Frames on main thread</h2>
        <p className="text-zinc-500">If any LoAF entry &gt; 50 ms appears here, the main thread had a long task. The worker FPS above should remain stable regardless.</p>
        <table className="mt-3 w-full text-left text-xs">
          <thead>
            <tr className="border-b border-zinc-300 dark:border-zinc-700">
              <th className="py-1 w-32">started @ (ms)</th>
              <th>duration (ms)</th>
            </tr>
          </thead>
          <tbody>
            {mainTaskLogs.length === 0 && (
              <tr><td className="py-1 text-zinc-500" colSpan={2}>(none yet — try the stress buttons)</td></tr>
            )}
            {mainTaskLogs.map((e, i) => (
              <tr key={i}><td className="py-1">{e.when.toFixed(0)}</td><td>{e.dur.toFixed(1)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>Worker fps stays at ~60 (vsync) during normal playback</li>
          <li>Worker fps stays at ~60 while the "100 setState bursts" stress runs</li>
          <li>Worker fps stays at ~60 while the main thread is busy-looped for ~120 ms (DevTools Performance: zero dropped frames in the WebGPU track)</li>
          <li>Main-thread CPU &lt; 5 % during steady-state worker playback</li>
          <li>StrictMode double-mount does not throw "InvalidStateError" (guarded by initializedRef)</li>
        </ul>
      </section>
    </main>
  )
}
