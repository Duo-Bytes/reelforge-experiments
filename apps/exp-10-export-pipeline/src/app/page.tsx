'use client'

import { useEffect, useRef, useState } from 'react'

type WorkerOut =
  | { type: 'INGEST_PROGRESS'; reqId: string; percent: number }
  | { type: 'INGEST_DONE'; reqId: string; fileId: string; codec: string; width: number; height: number; fps: number; durationUs: number; frameCount: number }
  | { type: 'EXPORT_PROGRESS'; reqId: string; framesProcessed: number; totalFrames: number }
  | { type: 'EXPORT_DONE'; reqId: string; outFileId: string; size: number; width: number; height: number; elapsedMs: number; framesEncoded: number; sourceDurationUs: number; realtime: number }
  | { type: 'BLOB'; reqId: string; blob: Blob }
  | { type: 'DELETE_DONE'; reqId: string; fileId: string }
  | { type: 'DEVICE_LOST'; reason: string; message: string }
  | { type: 'ENCODER_ERROR'; message: string }
  | { type: 'ERROR'; reqId: string; message: string }

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}

export default function ExportPage() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, (msg: WorkerOut) => void>>(new Map())
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('idle')
  const [ingestPct, setIngestPct] = useState(0)
  const [exportPct, setExportPct] = useState(0)
  const [framesProcessed, setFramesProcessed] = useState(0)
  const [src, setSrc] = useState<Extract<WorkerOut, { type: 'INGEST_DONE' }> | null>(null)
  const [out, setOut] = useState<Extract<WorkerOut, { type: 'EXPORT_DONE' }> | null>(null)
  const [effect, setEffect] = useState<'identity' | 'grayscale' | 'invert'>('grayscale')
  const [bitrateMbps, setBitrateMbps] = useState(8)
  const [outputCodec, setOutputCodec] = useState<'avc1.640028' | 'avc1.4d0028' | 'avc1.42E01E'>('avc1.640028')
  const [pickerSupported, setPickerSupported] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    setPickerSupported('showSaveFilePicker' in window)
    const w = new Worker(new URL('../workers/export.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      if (m.type === 'INGEST_PROGRESS') { setIngestPct(m.percent); return }
      if (m.type === 'EXPORT_PROGRESS') {
        setFramesProcessed(m.framesProcessed)
        setExportPct((m.framesProcessed / m.totalFrames) * 100)
        return
      }
      if (m.type === 'ENCODER_ERROR') { setStatus(`encoder error: ${m.message}`); return }
      if (m.type === 'DEVICE_LOST') { setStatus(`GPU device lost: ${m.reason} (${m.message})`); return }
      const cb = pendingRef.current.get(m.reqId)
      if (cb) { pendingRef.current.delete(m.reqId); cb(m) }
    }
    return () => { w.terminate(); workerRef.current = null }
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
    setBusy(true); setSrc(null); setOut(null); setIngestPct(0); setExportPct(0); setFramesProcessed(0)
    setStatus(`ingesting ${file.name}…`)
    const id = crypto.randomUUID()
    try {
      const r = await request<Extract<WorkerOut, { type: 'INGEST_DONE' }>>({ type: 'INGEST', file, fileId: id })
      setSrc(r)
      setStatus(`source ready: ${r.codec} ${r.width}×${r.height} @ ${r.fps} fps, ${r.frameCount.toLocaleString()} frames`)
    } catch (err) { setStatus(`error: ${(err as Error).message}`) }
    finally { setBusy(false); e.target.value = '' }
  }

  async function runExport() {
    if (!src) return
    setBusy(true)
    setStatus('exporting through WebGPU compositor → VideoEncoder → mediabunny mux → OPFS…')
    setExportPct(0); setFramesProcessed(0)
    try {
      const done = await request<Extract<WorkerOut, { type: 'EXPORT_DONE' }>>({
        type: 'EXPORT',
        sourceFileId: src.fileId,
        effect,
        bitrate: bitrateMbps * 1_000_000,
        outputCodec,
      })
      setOut(done)
      setStatus(`export done: ${fmtBytes(done.size)} in ${(done.elapsedMs / 1000).toFixed(1)} s — ${done.realtime.toFixed(2)}× real-time`)
    } catch (err) { setStatus(`export error: ${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  async function downloadViaPicker() {
    if (!out) return
    const r = await request<Extract<WorkerOut, { type: 'BLOB' }>>({ type: 'READ', fileId: out.outFileId })
    if ('showSaveFilePicker' in window) {
      const sfp = (window as { showSaveFilePicker: (opts: object) => Promise<{ createWritable: () => Promise<FileSystemWritableFileStream> }> }).showSaveFilePicker
      try {
        const handle = await sfp({
          suggestedName: `${out.outFileId}.mp4`,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        })
        const w = await handle.createWritable()
        await r.blob.stream().pipeTo(w)
        setStatus(`saved ${fmtBytes(out.size)} via showSaveFilePicker`)
      } catch (err) {
        setStatus(`save canceled or failed: ${(err as Error).message}`)
      }
    } else {
      const url = URL.createObjectURL(r.blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${out.outFileId}.mp4`
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  async function clearAll() {
    if (!src) return
    setBusy(true)
    await request({ type: 'DELETE', fileId: src.fileId })
    setSrc(null); setOut(null); setIngestPct(0); setExportPct(0); setStatus('cleared')
    setBusy(false)
  }

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-2xl font-bold">Exp-10 · Export Pipeline</h1>
      <p className="mb-6 text-zinc-500">
        VideoDecoder → WGSL effect on an OffscreenCanvas (worker WebGPU) →
        <code> new VideoFrame(canvas)</code> → VideoEncoder → mediabunny <code>EncodedVideoPacketSource</code>
        → <code>StreamTarget</code> wrapping an OPFS sync handle. The final file never lives in
        RAM; download via <code>showSaveFilePicker()</code>.
      </p>

      <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
        <label className="block">
          <span className="block pb-2 font-semibold">Source video</span>
          <input type="file" accept="video/mp4,video/*" onChange={onFileChange} disabled={busy} />
        </label>
        {ingestPct > 0 && ingestPct < 100 && <progress value={ingestPct} max={100} className="mt-3 w-full" />}
        <p className="mt-3"><span className="text-zinc-500">status:</span> {status}</p>
        {src && (
          <p className="text-zinc-500">
            {src.codec} {src.width}×{src.height} @ {src.fps} fps — {src.frameCount.toLocaleString()} frames, {(src.durationUs / 1_000_000).toFixed(2)} s
          </p>
        )}
      </section>

      {src && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Export settings</h2>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              <span className="text-zinc-500">WGSL effect</span>
              <select value={effect} onChange={(e) => setEffect(e.target.value as typeof effect)} className="rounded border border-zinc-400 bg-transparent px-2 py-1">
                <option value="identity">identity</option>
                <option value="grayscale">grayscale</option>
                <option value="invert">invert</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-zinc-500">bitrate</span>
              <input type="number" min={0.5} max={50} step={0.5} value={bitrateMbps} onChange={(e) => setBitrateMbps(Number(e.target.value))} className="w-20 rounded border border-zinc-400 bg-transparent px-2 py-1" />
              <span>Mbps</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-zinc-500">codec</span>
              <select value={outputCodec} onChange={(e) => setOutputCodec(e.target.value as typeof outputCodec)} className="rounded border border-zinc-400 bg-transparent px-2 py-1">
                <option value="avc1.640028">avc1.640028 (H.264 High L4.0)</option>
                <option value="avc1.4d0028">avc1.4d0028 (H.264 Main L4.0)</option>
                <option value="avc1.42E01E">avc1.42E01E (H.264 Baseline L3.0)</option>
              </select>
            </label>
          </div>
          <button onClick={runExport} disabled={busy} className="mt-3 rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black">
            export
          </button>
          <button onClick={clearAll} disabled={busy} className="ml-2 rounded border border-zinc-400 px-3 py-1 disabled:opacity-50">clear</button>
          {exportPct > 0 && exportPct < 100 && (
            <>
              <progress value={exportPct} max={100} className="mt-3 w-full" />
              <p className="text-zinc-500">{framesProcessed.toLocaleString()} frames processed</p>
            </>
          )}
        </section>
      )}

      {out && (
        <section className="mb-6 rounded border border-zinc-300 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-semibold">Result</h2>
          <table className="w-full text-left">
            <tbody>
              <tr><td className="w-48 text-zinc-500">size</td><td>{fmtBytes(out.size)}</td></tr>
              <tr><td className="text-zinc-500">resolution</td><td>{out.width} × {out.height}</td></tr>
              <tr><td className="text-zinc-500">elapsed</td><td>{(out.elapsedMs / 1000).toFixed(1)} s</td></tr>
              <tr><td className="text-zinc-500">real-time factor</td><td>{out.realtime.toFixed(2)}× ({out.realtime >= 1 ? 'faster' : 'slower'} than source duration)</td></tr>
              <tr><td className="text-zinc-500">frames encoded</td><td>{out.framesEncoded.toLocaleString()}</td></tr>
            </tbody>
          </table>
          <button onClick={downloadViaPicker} className="mt-3 rounded bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-black">
            {pickerSupported ? 'save as… (showSaveFilePicker)' : 'download (fallback)'}
          </button>
        </section>
      )}

      <section className="rounded border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        <p className="font-semibold">Manual verification checklist (Chrome 120+ desktop)</p>
        <ul className="ml-6 mt-2 list-disc">
          <li>Export of a 10 s 1080p source finishes in &lt; 10 s on a modern desktop GPU (≥ 1× real-time)</li>
          <li>Output MP4 plays in QuickTime / VLC and shows the chosen WGSL effect on every frame</li>
          <li>encoder.encodeQueueSize never blocks the worker (no saturation in DevTools)</li>
          <li>Output never lives in RAM: peak resident memory bounded by source bitrate + a few buffered frames, not output size</li>
          <li>showSaveFilePicker() opens the native save dialog; canceling does not corrupt the OPFS file</li>
        </ul>
      </section>
    </main>
  )
}
