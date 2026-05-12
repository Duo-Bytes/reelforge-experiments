'use client'

import { useEffect, useRef, useState } from 'react'

type CodecCfg = {
  codec: string
  codedWidth: number
  codedHeight: number
  description: Uint8Array
  timescale: number
}

type WorkerOut =
  | { type: 'PROGRESS'; reqId: string; percent: number }
  | {
      type: 'INGEST_DONE'
      reqId: string
      fileId: string
      size: number
      codec: CodecCfg
      frameCount: number
      keyframeCount: number
      durationUs: number
    }
  | { type: 'FRAME'; reqId: string; frame: VideoFrame; elapsedMs: number; peakQueue: number; targetUs: number }
  | { type: 'SEEK_MISS'; reqId: string; targetUs: number }
  | { type: 'PROBE_RESULT'; reqId: string; results: Array<{ label: string; codec: string; supported: boolean; acceleration: string }> }
  | { type: 'DECODER_ERROR'; message: string }
  | { type: 'DELETE_DONE'; reqId: string; fileId: string }
  | { type: 'ERROR'; reqId: string; message: string }

export default function DecodePage() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, (msg: WorkerOut) => void>>(new Map())
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [fileId, setFileId] = useState<string | null>(null)
  const [codec, setCodec] = useState<CodecCfg | null>(null)
  const [frameCount, setFrameCount] = useState(0)
  const [keyframeCount, setKeyframeCount] = useState(0)
  const [durationUs, setDurationUs] = useState(0)
  const [seekFrame, setSeekFrame] = useState(0)
  const [lastSeek, setLastSeek] = useState<{ elapsedMs: number; targetUs: number; peakQueue: number } | null>(null)
  const [stressResult, setStressResult] = useState<{ count: number; median: number; p95: number; min: number; max: number } | null>(null)
  const [probeResults, setProbeResults] = useState<Array<{ label: string; codec: string; supported: boolean; acceleration: string }> | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = new Worker(new URL('../workers/decode.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      if (m.type === 'PROGRESS') {
        setProgress(m.percent)
        return
      }
      if (m.type === 'DECODER_ERROR') {
        setStatus(`decoder error: ${m.message}`)
        return
      }
      const cb = pendingRef.current.get(m.reqId)
      if (cb) {
        pendingRef.current.delete(m.reqId)
        cb(m)
      }
    }
    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [])

  function request<T extends WorkerOut>(msg: { type: string } & Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
    const w = workerRef.current
    if (!w) return Promise.reject(new Error('worker not ready'))
    const reqId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      pendingRef.current.set(reqId, (out) => {
        if (out.type === 'ERROR') reject(new Error(out.message))
        else resolve(out as T)
      })
      w.postMessage({ ...msg, reqId }, transfer ?? [])
    })
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setStatus(`ingesting ${file.name}…`)
    setProgress(0)
    setLastSeek(null)
    setStressResult(null)
    const id = crypto.randomUUID()
    try {
      const done = await request<Extract<WorkerOut, { type: 'INGEST_DONE' }>>({ type: 'INGEST', file, fileId: id })
      setFileId(done.fileId)
      setCodec(done.codec)
      setFrameCount(done.frameCount)
      setKeyframeCount(done.keyframeCount)
      setDurationUs(done.durationUs)
      setSeekFrame(0)
      setStatus(`decoded ready: ${done.frameCount.toLocaleString()} frames, ${done.keyframeCount.toLocaleString()} keyframes`)
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  async function seekTo(frameIdx: number) {
    if (!frameCount || !durationUs) return
    // Approximate PTS for the requested frame index. The worker still snaps to
    // the actual sample timestamp internally because we look up by "largest pts <= targetUs".
    const targetUs = Math.round((frameIdx * durationUs) / frameCount)
    const r = await request<Extract<WorkerOut, { type: 'FRAME' } | { type: 'SEEK_MISS' }>>({
      type: 'SEEK',
      targetUs,
    })
    if (r.type === 'SEEK_MISS') {
      setLastSeek({ elapsedMs: -1, targetUs, peakQueue: -1 })
      return
    }
    setLastSeek({ elapsedMs: r.elapsedMs, targetUs: r.targetUs, peakQueue: r.peakQueue })
    const canvas = canvasRef.current
    if (canvas && codec) {
      canvas.width = codec.codedWidth
      canvas.height = codec.codedHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(r.frame, 0, 0, canvas.width, canvas.height)
    }
    r.frame.close()
  }

  async function runStress() {
    if (!frameCount) return
    setBusy(true)
    setStatus('stress: seeking to 100 random frames…')
    const N = 100
    const lat: number[] = []
    let misses = 0
    for (let i = 0; i < N; i++) {
      const idx = Math.floor(Math.random() * frameCount)
      const targetUs = Math.round((idx * durationUs) / frameCount)
      const r = await request<Extract<WorkerOut, { type: 'FRAME' } | { type: 'SEEK_MISS' }>>({
        type: 'SEEK', targetUs,
      })
      if (r.type === 'FRAME') {
        lat.push(r.elapsedMs)
        r.frame.close()
      } else {
        misses++
      }
    }
    lat.sort((a, b) => a - b)
    const median = lat[Math.floor(lat.length / 2)] ?? 0
    const p95 = lat[Math.floor(lat.length * 0.95)] ?? 0
    setStressResult({ count: lat.length, median, p95, min: lat[0] ?? 0, max: lat[lat.length - 1] ?? 0 })
    setStatus(`stress: ${lat.length}/${N} seeks landed, ${misses} misses`)
    setBusy(false)
  }

  async function runProbe() {
    setBusy(true)
    const r = await request<Extract<WorkerOut, { type: 'PROBE_RESULT' }>>({ type: 'PROBE' })
    setProbeResults(r.results)
    setBusy(false)
  }

  async function clearAll() {
    if (!fileId) return
    setBusy(true)
    await request({ type: 'DELETE', fileId })
    setFileId(null)
    setCodec(null)
    setFrameCount(0)
    setKeyframeCount(0)
    setDurationUs(0)
    setLastSeek(null)
    setStressResult(null)
    setStatus('cleared')
    setBusy(false)
  }

  const durationSec = durationUs / 1_000_000

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-03 · WebCodecs Decode</h1>
      <p className="mb-6 text-zinc-500">
        Feed GOP byte ranges from the mp4box index into <code>VideoDecoder</code>; emit the frame
        at exactly the requested PTS. Frames are transferred (not cloned) and explicitly
        <code>.close()</code>d after rendering.
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <button
          onClick={runProbe}
          disabled={busy}
          className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
        >
          probe codec support
        </button>
        {probeResults && (
          <table className="mt-3 w-full text-left">
            <thead>
              <tr className="border-b border-zinc-300 dark:border-zinc-700"><th className="py-1">codec</th><th>string</th><th>acceleration</th></tr>
            </thead>
            <tbody>
              {probeResults.map((r) => (
                <tr key={r.codec}>
                  <td className="py-1">{r.label}</td>
                  <td>{r.codec}</td>
                  <td className={r.acceleration === 'hardware' ? 'text-emerald-600 dark:text-emerald-400' : r.acceleration === 'unsupported' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}>{r.acceleration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <label className="block">
          <span className="block pb-2 font-semibold">Pick an MP4</span>
          <input type="file" accept="video/mp4,video/*" onChange={onFileChange} disabled={busy} />
        </label>
        {progress > 0 && progress < 100 && <progress value={progress} max={100} className="mt-3 w-full" />}
        <p className="mt-3"><span className="text-zinc-500">status:</span> {status}</p>
        {codec && (
          <p>
            <span className="text-zinc-500">codec:</span> {codec.codec} {codec.codedWidth}×{codec.codedHeight} —{' '}
            {frameCount.toLocaleString()} frames, {keyframeCount.toLocaleString()} keyframes ({((keyframeCount / frameCount) * 100).toFixed(1)}%), {durationSec.toFixed(2)} s
          </p>
        )}
      </section>

      {codec && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Seek</h2>
          <input
            type="range"
            min={0}
            max={Math.max(0, frameCount - 1)}
            value={seekFrame}
            onChange={(e) => setSeekFrame(Number(e.target.value))}
            disabled={busy}
            className="w-full"
          />
          <div className="mt-2 flex items-center justify-between text-zinc-500">
            <span>frame {seekFrame.toLocaleString()} / {frameCount.toLocaleString()}</span>
            <span>≈ {((seekFrame / frameCount) * durationSec).toFixed(3)} s</span>
          </div>
          <button
            onClick={() => seekTo(seekFrame)}
            disabled={busy}
            className="mt-3 rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
          >
            decode this frame
          </button>
          <button
            onClick={runStress}
            disabled={busy}
            className="ml-2 rounded border border-zinc-400 px-3 py-1 disabled:opacity-50"
          >
            stress: 100 random seeks
          </button>
          <button
            onClick={clearAll}
            disabled={busy || !fileId}
            className="ml-2 rounded border border-zinc-400 px-3 py-1 disabled:opacity-50"
          >
            clear
          </button>
          {lastSeek && lastSeek.elapsedMs >= 0 && (
            <p className="mt-3">
              <span className="text-zinc-500">last seek:</span> {lastSeek.elapsedMs.toFixed(1)} ms,
              peak decodeQueueSize {lastSeek.peakQueue}, frame PTS {(lastSeek.targetUs / 1000).toFixed(3)} ms
            </p>
          )}
          {lastSeek && lastSeek.elapsedMs < 0 && (
            <p className="mt-3 text-red-600 dark:text-red-400">SEEK_MISS — decoder did not emit a frame matching the target PTS.</p>
          )}
          {stressResult && (
            <p className="mt-3">
              <span className="text-zinc-500">stress {stressResult.count} seeks:</span>{' '}
              median {stressResult.median.toFixed(1)} ms, p95 {stressResult.p95.toFixed(1)} ms,
              min {stressResult.min.toFixed(1)} ms, max {stressResult.max.toFixed(1)} ms
            </p>
          )}
        </section>
      )}

      {codec && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Frame preview</h2>
          <canvas ref={canvasRef} className="w-full rounded border border-zinc-200 bg-black dark:border-zinc-800" />
        </section>
      )}

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>Cold seek to a non-keyframe &lt; 500 ms; seek to a keyframe &lt; 100 ms</li>
          <li>200 consecutive seeks: heap snapshot shows no growth (verify <code>frame.close()</code> coverage)</li>
          <li>Peak decodeQueueSize never exceeds 8 during stress</li>
          <li>Decoded frame visually matches a screenshot from a desktop player at the same timestamp</li>
          <li>Codec probe shows hardware acceleration for at least H.264</li>
        </ul>
      </section>
    </main>
  )
}
