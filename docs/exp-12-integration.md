# Exp-12 · Integration

## Goal

Wire experiments 01–11 into a minimal but functional NLE: import a video file, generate a proxy, place clips on a multi-track timeline, play with audio sync, toggle background removal, and export to MP4. This is the final integration checkpoint before building the production editor.

---

## App Location

`apps/exp-12-integration/`

## Why This Matters

Individual experiments prove concepts in isolation. Integration exposes the problems that only appear when sub-systems run simultaneously:
- Race conditions between workers (e.g., proxy worker and decode worker both holding OPFS handles)
- Message ordering bugs (SEEK arriving before INIT completes)
- VRAM exhaustion from running frame cache + AI inference + VideoEncoder simultaneously
- React Fast Refresh re-instantiating workers and creating duplicate instances

---

## Worker Topology (Full System)

```
Main Thread
├── React + Zustand UI
│   ├── Timeline (exp-09 state architecture)
│   ├── Preview canvas (OffscreenCanvas, owned by RenderWorker)
│   ├── Transport controls (play/pause/seek)
│   └── Properties panel (clip settings, background removal toggle)
│
├── RenderWorker  (owns OffscreenCanvas + WebGPU device)
│   ├── Frame cache Tier 1 (VRAM, exp-06)
│   ├── Frame cache Tier 2 (RAM, exp-06)
│   ├── WebGPU WGSL compositor (exp-04)
│   ├── MessageChannel rAF loop (exp-05)
│   └── Sub-worker: DecodeWorker
│       ├── VideoDecoder (exp-03)
│       ├── Demuxer module (exp-02)
│       └── OPFS reads (exp-01)
│
├── AudioWorker  (exp-08)
│   ├── AudioDecoder → SharedArrayBuffer ring buffer
│   └── Communicates with Main Thread AudioContext + AudioWorklet
│
├── ProxyWorker  (exp-07, background — starts on file import)
│   ├── Source VideoDecoder → 720p VideoEncoder → mediabunny muxer → OPFS
│   └── Reports progress to main thread; pauses if export starts
│
└── AIWorker  (exp-11, on-demand)
    ├── ONNX Runtime Web with WebGPU EP
    └── Produces mask textures → sent to RenderWorker
```

---

## Implementation Steps

### Phase 1: Scaffold and Worker Setup

```bash
cd apps/
npx create-next-app@latest exp-12-integration --typescript --tailwind --app --turbopack
cd exp-12-integration
npm install zustand immer react-window onnxruntime-web mp4box mediabunny idb
```

Copy `next.config.ts` from README shared config.

**File structure:**
```
src/
├── app/
│   ├── page.tsx              — Editor shell
│   └── layout.tsx
├── workers/
│   ├── render.worker.ts      — RenderWorker (owns OffscreenCanvas)
│   ├── decode.worker.ts      — DecodeWorker (sub-worker of render)
│   ├── audio.worker.ts       — AudioWorker
│   ├── proxy.worker.ts       — ProxyWorker
│   └── ai.worker.ts          — AIWorker
├── public/
│   └── audio-worklet-processor.js
├── store/
│   └── timeline.ts           — Zustand store (exp-09 architecture)
├── components/
│   ├── Timeline.tsx
│   ├── TrackRow.tsx
│   ├── ClipItem.tsx
│   ├── Playhead.tsx
│   ├── TransportControls.tsx
│   └── PropertiesPanel.tsx
├── lib/
│   ├── opfs.ts               — OPFS helpers (exp-01)
│   ├── demuxer.ts            — mp4box wrapper (exp-02)
│   ├── lru-cache.ts          — LRU cache (exp-06)
│   └── ring-buffer.ts        — SharedArrayBuffer ring buffer (exp-08)
```

### Phase 2: Worker Initialization Guard

**Critical:** React 18 StrictMode double-invokes effects in development. Workers must be initialized idempotently:

```ts
// In the editor page component:
const workerInitialized = useRef(false)

useEffect(() => {
  if (workerInitialized.current) return  // Prevent double-init in StrictMode
  workerInitialized.current = true

  // Initialize RenderWorker
  const canvas = previewCanvasRef.current!
  const offscreen = canvas.transferControlToOffscreen()
  const renderWorker = new Worker(new URL('../workers/render.worker.ts', import.meta.url))
  renderWorkerRef.current = renderWorker
  renderWorker.postMessage({ type: 'INIT', canvas: offscreen }, [offscreen])

  // Initialize AudioWorker
  const sab = createRingBuffer()
  const audioWorker = new Worker(new URL('../workers/audio.worker.ts', import.meta.url))
  audioWorkerRef.current = audioWorker
  audioWorker.postMessage({ type: 'INIT', sharedArrayBuffer: sab })
  sharedAudioBuffer.current = sab

  return () => {
    renderWorker.terminate()
    audioWorker.terminate()
    workerInitialized.current = false
  }
}, [])
```

Also store worker refs OUTSIDE React state (in `useRef`) — if stored in `useState`, every re-render that changes state could cause worker recreation.

### Phase 3: File Import Flow

```
User clicks "Import" → <input type="file"> →
  1. Generate fileId (crypto.randomUUID())
  2. OPFSModule.ingestFile(file, fileId) — progress shown in UI
  3. On OPFS_DONE: DemuxModule.demux(fileId) — extract codec config + sample index
  4. Add clip to Zustand store (start = 0, duration from demux)
  5. Start ProxyWorker: proxy.worker.postMessage({ type: 'START_PROXY', fileId })
  6. On PROXY_READY: update Zustand clip with proxyFileId
  7. Load first frame preview: ask RenderWorker to decode frame 0 of proxy
```

**Proxy vs source routing:**
- If `clip.proxyFileId` exists: DecodeWorker reads from proxy OPFS file
- If `clip.proxyFileId` is null (proxy not yet ready): DecodeWorker reads from source OPFS file (slower)
- During export: always read from source OPFS file

### Phase 4: Playback Clock

```ts
// Main Thread — the master playback clock

function startPlayback() {
  const startRealTime = performance.now()
  const startTimelineUs = currentTimelineUs

  function tick() {
    if (!isPlaying) return
    const elapsed = (performance.now() - startRealTime) * 1000  // ms → us
    const targetUs = startTimelineUs + elapsed

    // A/V sync: anchor to audio clock when audio is active
    const audioTargetUs = audioCtx
      ? (audioCtx.currentTime - audioCtx.outputLatency) * 1_000_000
      : targetUs

    // Notify render worker
    renderWorkerRef.current?.postMessage({ type: 'SEEK', timestampUs: audioTargetUs })

    // Update playhead (direct DOM, no React state)
    const px = (audioTargetUs / 1_000_000) * zoom
    playheadRef.current!.style.transform = `translateX(${px}px)`

    requestAnimationFrame(tick)
  }

  isPlaying = true
  requestAnimationFrame(tick)
}
```

### Phase 5: Message Ordering Safety

Workers process messages sequentially. But if SEEK arrives before INIT completes, the worker has no WebGPU device yet. Implement a message queue inside each worker:

```ts
// In render.worker.ts
let initialized = false
const pendingMessages: MessageEvent[] = []

self.onmessage = async (e) => {
  if (!initialized && e.data.type !== 'INIT') {
    pendingMessages.push(e)
    return
  }

  if (e.data.type === 'INIT') {
    await initWebGPU(e.data.canvas)
    initialized = true
    // Drain pending messages
    for (const pending of pendingMessages) {
      await handleMessage(pending)
    }
    pendingMessages.length = 0
    return
  }

  await handleMessage(e)
}
```

### Phase 6: VRAM Management During Export

When export starts:
1. Pause ProxyWorker (prevent concurrent hardware encoder usage)
2. Clear VRAM cache: `vramCache.clear()` — frees GPU memory for VideoEncoder
3. Pause AI inference (AIWorker)
4. After export completes: re-enable all workers

```ts
// Main thread export button handler:
async function startExport() {
  proxyWorkerRef.current?.postMessage({ type: 'PAUSE' })
  aiWorkerRef.current?.postMessage({ type: 'PAUSE' })
  renderWorkerRef.current?.postMessage({ type: 'EXPORT_START', timeline: getTimelineSnapshot() })
  // Wait for EXPORT_DONE, then re-enable workers
}
```

### Phase 7: Background Removal in the UI

```tsx
// PropertiesPanel.tsx
function PropertiesPanel({ selectedClipId }: { selectedClipId: string | null }) {
  const clip = useTimelineStore(s => selectedClipId ? s.clips[selectedClipId] : null)
  const toggleBgRemoval = useTimelineStore(s => s.toggleBgRemoval)

  if (!clip) return <div className="p-4 text-gray-500">No clip selected</div>

  return (
    <div className="p-4 space-y-4">
      <h3 className="font-semibold">Clip Properties</h3>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={clip.bgRemovalEnabled ?? false}
          onChange={() => toggleBgRemoval(clip.id)}
        />
        Background Removal
      </label>
      {clip.bgRemovalEnabled && (
        <p className="text-xs text-gray-400">
          AI processing every 15 frames (~0.5s). First inference ~2s.
        </p>
      )}
    </div>
  )
}
```

When `bgRemovalEnabled` is set on a clip, the RenderWorker starts requesting masks from AIWorker before rendering that clip's frames.

---

## UI Layout

```
┌──────────────────────────────────────────────────────┐
│  [Import]  [Export]  [Undo]  [Redo]    ReelForge     │  ← Top bar
├────────────────────────┬─────────────────────────────┤
│                        │                             │
│   Preview Canvas       │   Properties Panel          │
│   (OffscreenCanvas)    │   (clip settings)           │
│                        │                             │
├────────────────────────┴─────────────────────────────┤
│  [◀◀] [◀] [▶/⏸] [▶] [▶▶]    00:00:00 / 00:01:30    │  ← Transport
├──────────────────────────────────────────────────────┤
│  Zoom: [━━●━━━━]    [+Track]                         │
│  ▼ Video 1  ├──[Clip A]──┤     ├──[Clip B]──┤       │  ← Timeline
│  ▼ Video 2          ├──[Clip C]──┤                   │
│  ▼ Audio 1  ├──[Audio A]──────────────────┤          │
│             ↑ Playhead (red line)                     │
└──────────────────────────────────────────────────────┘
```

---

## Testing Checklist

Work through each flow explicitly:

- [ ] Import 1 video file → OPFS ingest → demux → proxy generated → clip appears on timeline
- [ ] Import 2nd video file → both clips on separate tracks
- [ ] Scrub timeline: proxy frames render for both clips
- [ ] Play: audio + video in sync (test with Bluetooth headphones)
- [ ] Seek mid-play: playhead jumps, audio and video both jump
- [ ] Trim clip (drag left/right edge): clip duration changes, neighboring frame renders correctly
- [ ] Select clip → toggle background removal → preview shows removal
- [ ] Export: 30-second timeline → MP4 → plays in Chrome/VLC
- [ ] Delete clip → OPFS cleanup → proxy deleted → cache evicted
- [ ] Refresh page → project state NOT restored (this is exp-12 scope: no persistence yet)

---

## Known Integration Pitfalls

**OPFS exclusive lock contention.**
If ProxyWorker and DecodeWorker both try to `createSyncAccessHandle()` on the same file simultaneously, one will throw. Solution: route all OPFS access through a single OPFSManager worker that serializes access. All other workers request reads via postMessage.

**Next.js Fast Refresh re-creates workers.**
During development, saving a file triggers HMR. If worker refs aren't properly guarded (the `workerInitialized.current` flag above), the old workers remain active while new ones are created. This causes 2× decode and 2× audio output. The `useEffect` cleanup + guard flag prevents this.

**SharedArrayBuffer size.**
The ring buffer for audio is fixed-size. If AudioWorker decodes faster than AudioWorklet consumes (which it will during a seek), the ring buffer fills and AudioWorker writes stale data. Add a "flush ring buffer on seek" message that AudioWorker handles by resetting the write pointer.

**AIWorker and RenderWorker GPU contention.**
Both use WebGPU. On integrated GPUs (MacBook Air, etc.), there is one GPU for everything. Running ONNX inference and WebGPU compositing simultaneously may cause visible frame drops. Stagger: run AI inference in the gap between rAF frames (idle time in the render loop).

**`transferControlToOffscreen` + React DevTools.**
React DevTools canvas overlay can conflict with OffscreenCanvas. If the preview appears black in development, check if React DevTools is interfering. This is a dev-only issue — production builds are not affected.

---

## Success Criteria

| Feature | Target |
|---|---|
| File import → clip on timeline | < 3 seconds (OPFS ingest) |
| Proxy ready for 1min 1080p clip | < 3 minutes |
| Playback: 2 tracks, 1080p proxy | Smooth 30fps, A/V sync ≤ 1 frame |
| Background removal visible in preview | < 2s after toggle (first inference) |
| Export: 30s 2-track timeline | < 120s, valid MP4 |
| No memory leaks after 10 minutes of use | DevTools heap stable |
| Worker count in Chrome Task Manager | Exactly 5 workers (render, decode, audio, proxy, ai) |
