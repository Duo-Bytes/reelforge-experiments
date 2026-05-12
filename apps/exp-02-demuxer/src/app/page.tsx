'use client'

import { useEffect, useRef, useState } from 'react'
import type { CodecConfig, GOPRange, TrackSummary } from '../types'

type WorkerOut =
  | { type: 'PROGRESS'; reqId: string; percent: number }
  | {
      type: 'INGEST_DONE'
      reqId: string
      fileId: string
      size: number
      elapsedMs: number
      codec: CodecConfig
      summary: TrackSummary
      sampleCount: number
    }
  | { type: 'GOP_RESULT'; reqId: string; range: GOPRange }
  | { type: 'MEDIABUNNY_RESULT'; reqId: string; summary: Record<string, unknown> }
  | { type: 'DELETE_DONE'; reqId: string; fileId: string }
  | { type: 'ERROR'; reqId: string; message: string }

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}
function fmtUs(us: number) {
  const s = us / 1_000_000
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`
}

export default function DemuxerPage() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, (msg: WorkerOut) => void>>(new Map())

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [fileId, setFileId] = useState<string | null>(null)
  const [size, setSize] = useState(0)
  const [ingestMs, setIngestMs] = useState<number | null>(null)
  const [codec, setCodec] = useState<CodecConfig | null>(null)
  const [summary, setSummary] = useState<TrackSummary | null>(null)
  const [sampleCount, setSampleCount] = useState(0)

  const [seekInput, setSeekInput] = useState('1000')
  const [gop, setGop] = useState<GOPRange | null>(null)

  const [mbResult, setMbResult] = useState<Record<string, unknown> | null>(null)
  const fileRef = useRef<File | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = new Worker(new URL('../workers/demux.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      if (m.type === 'PROGRESS') {
        setProgress(m.percent)
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
    fileRef.current = file
    setBusy(true)
    setStatus(`ingesting + demuxing ${file.name} (${fmtBytes(file.size)})…`)
    setProgress(0)
    setIngestMs(null)
    setCodec(null)
    setSummary(null)
    setGop(null)
    setMbResult(null)
    const id = crypto.randomUUID()
    try {
      const done = await request<Extract<WorkerOut, { type: 'INGEST_DONE' }>>({ type: 'INGEST', file, fileId: id })
      setFileId(done.fileId)
      setSize(done.size)
      setIngestMs(done.elapsedMs)
      setCodec(done.codec)
      setSummary(done.summary)
      setSampleCount(done.sampleCount)
      const mbps = done.size / 1024 / 1024 / (done.elapsedMs / 1000)
      setStatus(`demuxed ${done.sampleCount} samples in ${done.elapsedMs.toFixed(0)} ms (${mbps.toFixed(1)} MiB/s)`)
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  async function runSeek() {
    const ms = Number(seekInput)
    if (!Number.isFinite(ms)) return
    setBusy(true)
    try {
      const r = await request<Extract<WorkerOut, { type: 'GOP_RESULT' }>>({ type: 'GET_GOP', targetUs: Math.round(ms * 1000) })
      setGop(r.range)
    } catch (err) {
      setStatus(`seek error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function probeMediabunny() {
    if (!fileRef.current) return
    setBusy(true)
    try {
      const r = await request<Extract<WorkerOut, { type: 'MEDIABUNNY_RESULT' }>>({
        type: 'PROBE_MEDIABUNNY',
        file: fileRef.current,
      })
      setMbResult(r.summary)
    } catch (err) {
      setStatus(`mediabunny error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function clearAll() {
    if (!fileId) return
    setBusy(true)
    await request({ type: 'DELETE', fileId })
    setFileId(null)
    setSize(0)
    setIngestMs(null)
    setCodec(null)
    setSummary(null)
    setGop(null)
    setMbResult(null)
    setStatus('cleared')
    setBusy(false)
  }

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-02 · MP4 Demuxer</h1>
      <p className="mb-6 text-zinc-500">
        Stream the file into OPFS while feeding mp4box.js to build a per-sample seek index
        (timestamp → byte offset + size). Resolve any timestamp to its containing GOP in O(log n).
        Also probes mediabunny for comparison.
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <label className="block">
          <span className="block pb-2 font-semibold">Pick an MP4</span>
          <input type="file" accept="video/mp4,video/quicktime,video/*" onChange={onFileChange} disabled={busy} />
        </label>
        {progress > 0 && progress < 100 && <progress value={progress} max={100} className="mt-3 w-full" />}
        <p className="mt-3"><span className="text-zinc-500">status:</span> {status}</p>
        {ingestMs != null && (
          <p>
            <span className="text-zinc-500">ingest+demux:</span> {fmtBytes(size)} in {ingestMs.toFixed(0)} ms
          </p>
        )}
      </section>

      {summary && codec && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Track summary</h2>
          <table className="w-full text-left">
            <tbody>
              <tr><td className="w-48 text-zinc-500">codec</td><td>{codec.codec}</td></tr>
              <tr><td className="text-zinc-500">resolution</td><td>{codec.width} × {codec.height}</td></tr>
              <tr><td className="text-zinc-500">duration</td><td>{fmtUs(summary.durationUs)} ({(summary.durationUs / 1_000_000).toFixed(3)} s)</td></tr>
              <tr><td className="text-zinc-500">avg fps</td><td>{summary.fps}</td></tr>
              <tr><td className="text-zinc-500">frames</td><td>{summary.frameCount.toLocaleString()} ({sampleCount.toLocaleString()} indexed)</td></tr>
              <tr><td className="text-zinc-500">keyframes</td><td>{summary.keyframeCount.toLocaleString()} ({summary.frameCount ? ((summary.keyframeCount / summary.frameCount) * 100).toFixed(1) : 0}%)</td></tr>
              <tr><td className="text-zinc-500">codec desc bytes</td><td>{codec.description.byteLength} B (avcC/hvcC)</td></tr>
              <tr><td className="text-zinc-500">timescale</td><td>{codec.timescale}</td></tr>
              {summary.audioTrackId >= 0 && (
                <tr><td className="text-zinc-500">audio</td><td>{summary.audioCodec} @ {summary.audioSampleRate} Hz × {summary.audioChannels} ch</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {summary && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Seek → GOP</h2>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={seekInput}
              onChange={(e) => setSeekInput(e.target.value)}
              placeholder="timestamp (ms)"
              className="w-40 rounded border border-zinc-400 bg-transparent px-2 py-1"
              disabled={busy}
            />
            <button
              onClick={runSeek}
              disabled={busy}
              className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
            >
              find GOP
            </button>
          </div>
          {gop && (
            <table className="mt-4 w-full text-left">
              <tbody>
                <tr><td className="w-48 text-zinc-500">GOP start</td><td>{fmtUs(gop.startUs)} ({(gop.startUs / 1000).toFixed(3)} ms)</td></tr>
                <tr><td className="text-zinc-500">GOP end</td><td>{fmtUs(gop.endUs)}</td></tr>
                <tr><td className="text-zinc-500">byte range</td><td>{gop.firstOffset.toLocaleString()} – {gop.lastOffset.toLocaleString()} ({fmtBytes(gop.lastOffset - gop.firstOffset)})</td></tr>
                <tr><td className="text-zinc-500">frames in GOP</td><td>{gop.frameCount}</td></tr>
                <tr><td className="text-zinc-500">compute time</td><td>{gop.computeMs.toFixed(3)} ms <span className="text-zinc-500">(target &lt; 1 ms)</span></td></tr>
              </tbody>
            </table>
          )}
        </section>
      )}

      {summary && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Mediabunny probe</h2>
          <p className="mb-3 text-zinc-500">
            Mediabunny does not expose raw per-sample byte offsets — it abstracts them into
            EncodedPacket data. That's why mp4box.js builds the seek index here. Mediabunny is the
            better fit for the export and proxy pipelines (exp-07, exp-10).
          </p>
          <button
            onClick={probeMediabunny}
            disabled={busy || !fileRef.current}
            className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
          >
            run probe
          </button>
          {mbResult && (
            <pre className="mt-3 overflow-x-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
              {JSON.stringify(mbResult, null, 2)}
            </pre>
          )}
        </section>
      )}

      <section className="mb-6 flex gap-2">
        <button
          onClick={clearAll}
          disabled={busy || !fileId}
          className="rounded border border-zinc-400 px-3 py-1 disabled:opacity-50"
        >
          clear
        </button>
      </section>

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>1 GB MP4 ingest + demux finishes in &lt; 5 s</li>
          <li>GOP lookup compute time &lt; 1 ms anywhere on the timeline</li>
          <li>Codec string is accepted by <code>VideoDecoder.isConfigSupported()</code> (exp-03)</li>
          <li>For a known keyframe, GOP first-offset matches the source byte offset (hex-verified)</li>
          <li>Both moov-at-front and moov-at-end files succeed</li>
        </ul>
      </section>
    </main>
  )
}
