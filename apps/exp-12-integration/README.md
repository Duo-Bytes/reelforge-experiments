# exp-12 · Integration

## Purpose

Wire experiments 01–11 into a single mini NLE with the **5-worker topology** the production editor will use: **render** (owns OffscreenCanvas + WebGPU + sub-decode worker), **audio**, **proxy**, and **AI**. Demonstrates the core control flow — file ingest → demux → decode → composite → preview, plus background proxy transcode, audio worklet wiring, and on-demand AI model load. Export & full A/V playback orchestration are stubbed in the skeleton; the wiring shows where they slot in.

## Architecture

```
Main Thread (page.tsx)
├── 5-worker topology
│     - render.worker.ts  → spawns decode.worker.ts as sub-worker
│     - audio.worker.ts
│     - proxy.worker.ts
│     - ai.worker.ts
├── Workers initialized once via `initRef` guard (StrictMode safe)
├── Zustand+Immer editor store: assets, tracks, clips, zoom, selection
├── Master rAF clock:
│     if AudioContext running -> playheadUs = (currentTime - outputLatency) * 1e6
│     else                    -> playheadUs += dt
│     clipAtTime(playheadUs, "video") -> {assetId, assetUs} -> snap to fps -> SEEK
└── UI: workers panel, preview canvas, properties panel, timeline tracks

src/store/timeline.ts
├── State: assets:Record, tracks:Track[], clips:Record, zoom, selectedClipId
├── Actions: addAsset, updateAsset, addClip, moveClip, trimClip, selectClip, toggleBgRemoval, reset
├── clipAtTime(playheadUs, kind)        → resolve which clip is on-screen
└── timelineToAssetUs(clip, timelineUs) → translate playhead PTS to asset PTS

src/workers/render.worker.ts (the conductor)
├── INIT    -> WebGPU device + cached.wgsl pipeline + spawn sub-decode workers per asset
├── LOAD(assetId, file)
│     -> spawns one decode.worker per asset (separate decoders, parallel)
├── SEEK(assetId, targetUs)
│     -> getTexture(assetId, targetUs):
│        1) vramCache key=`${assetId}:${ts}` -> tier "vram"
│        2) ramCache  key=`${assetId}:${ts}` -> uploadToVRAM -> tier "ram"
│        3) decodeBitmap(assetId, ts) -> uploadToVRAM -> tier "miss"
│     -> render quad, post {RENDERED, tier, totalMs}
├── Pending coalesce: same key, single decoder request, multiple resolvers
└── decoder onmessage(FRAME) -> createImageBitmap -> frame.close() -> ramCache.set -> resolve waiters

src/workers/proxy.worker.ts (inherited from exp-07)
├── INGEST  -> stream-copy file into OPFS via SyncAccessHandle
├── TRANSCODE -> source decode -> 720p OffscreenCanvas scale -> H.264 encode (every-frame keyframe)
│             -> mediabunny EncodedVideoPacketSource -> Mp4OutputFormat(in-memory) -> BufferTarget
│             -> write `proxy_<id>` to OPFS, IndexedDB metadata
└── On DONE -> Editor.updateAsset(assetId, {proxyFileId})

src/workers/audio.worker.ts (inherited from exp-08)
├── START(file, sab) -> mediabunny demux audio -> AudioDecoder -> interleaved stereo float32 -> SAB ringWrite
└── public/audio-worklet-processor.js drains the ring, emits silence on underrun

src/workers/ai.worker.ts (inherited from exp-11)
├── LOAD_URL  -> Cache API persistence
├── LOAD_BYTES (offline path)
└── SEGMENT(bitmap) -> ort WebGPU EP inference -> Uint8Array mask transferable
```

## Research notes

- **Single render worker, N decode sub-workers** (one per asset). Each decoder configures itself for the asset's codec once and serves its own frame requests in parallel. Avoids re-`configure()` between asset switches and lets distinct codecs (HEVC for clip A, AVC for clip B) coexist.
- **Master clock = AudioContext when running, wall-clock otherwise.** Switches transparently when the user starts audio. Frame target = `(currentTime − outputLatency) * 1e6`, so Bluetooth latency stays compensated.
- **Snap to fps boundary** before SEEK. The renderer caches by exact PTS; without snapping each rAF would request an unstable PTS that misses the cache.
- **Cache key = `${assetId}:${ptsUs}`.** Multi-asset isolation prevents one asset's frames from evicting another's during cross-fades.
- **`initRef` boolean guard** in the main `useEffect` neutralizes React StrictMode double-effect from spawning duplicate workers in development.
- **Worker refs in `useRef`, not `useState`.** State changes never trigger worker recreation, only setters wrapped in updaters.
- **`zustand+immer+enableMapSet()`** to allow Sets in the selection state. Immer 10+ ships Set/Map support but it's still opt-in.
- **`useShallow` everywhere on array selectors** (`tracks.map(t=>t.id)`, `track.clipIds`) — without it any store mutation triggers cascade re-renders.
- **Direct DOM mutation for clip drag** (pointer-capture + `style.transform`). Single Zustand commit on pointer up.
- **Worker topology mirrors production.** Adding export only requires forwarding the timeline state to a 6th worker (or wiring exp-10 into render.worker as an EXPORT command path) — no architectural rewrite.
- **Known gaps in this skeleton:**
  - Audio decode wiring — the import flow needs to retain the `File` ref alongside the asset and pass it to the audio worker on play. Current UI surfaces this as an explicit error to keep the limitation visible.
  - Multi-track compositing — the cached.wgsl pipeline renders one texture per call; the compositor needs to grow to N layers (exp-04 already prototypes blend, this is plumbing).
  - Background-removal in the render path — the AI worker is wired and the clip flag exists, but the render worker's compositor doesn't yet bind the mask texture per frame. exp-11 has the WGSL pattern; integrating is mechanical.
  - Export — `pnpm --filter exp-10-export-pipeline dev` proves the path standalone; the integration would forward `{type:"EXPORT_START", timeline}` to the render worker which would then drive exp-10's pipeline.
- **OPFS exclusive lock contention** is real: proxy.worker and decode.worker both want to read the same source file. The current design has each open its own `SyncAccessHandle` after the other closes; a centralised `OPFSManager` worker is the cleaner long-term answer (and matches the doc's recommendation).

## Files

| File | Purpose |
|---|---|
| `src/store/timeline.ts` | Zustand store + clipAtTime / timelineToAssetUs helpers |
| `src/workers/render.worker.ts` | Conductor: WebGPU + LRU caches + N decode sub-workers, SEEK route |
| `src/workers/decode.worker.ts` | Inherited from exp-03/06 (mp4box demux + VideoDecoder) |
| `src/workers/audio.worker.ts` | Inherited from exp-08 |
| `src/workers/proxy.worker.ts` | Inherited from exp-07 |
| `src/workers/ai.worker.ts` | Inherited from exp-11 |
| `src/lib/lru.ts`, `src/lib/types.ts`, `src/lib/ringBuffer.ts` | Shared inherited modules |
| `src/shaders/cached.wgsl.ts` | Inherited from exp-06 |
| `public/audio-worklet-processor.js` | Inherited from exp-08 |
| `src/app/page.tsx` | Editor shell: 5-worker init, master clock, timeline UI, properties panel |

## Run

```bash
pnpm --filter exp-12-integration dev
```

Test flow:
1. Pick a video file → asset appears, clip lands on V1, proxy worker starts.
2. Play / pause / scrub. Render tier badge shows vram/ram/miss.
3. Click "load AI model" → ~2s cached, ~30s cold.
4. Click "start AudioContext" → AudioWorklet prepared. (See note above on audio decode wiring.)

## Success criteria

| Metric | Target |
|---|---|
| Worker count in Chrome Task Manager | 5 (render, decode, audio, proxy, ai) |
| Import → first frame on canvas | < 3s |
| Scrub: vram-tier hits | < 2ms; ram-tier < 5ms |
| Proxy ready (60s 1080p) | < 3 min |
| No leaks after 10 minutes | heap stable |
