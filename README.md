# ReelForge Experiments

> Validate every sub-system of a full in-browser NLE before assembling the final editor.

## Vision

A fully client-side, privacy-first non-linear video editor running entirely in the browser. No server uploads. No render farm. Desktop-class performance. AI features on-device. Media never leaves the user's machine unless they explicitly export or share.

## Design Principles

1. **Local-first** — media stays on the user's disk; OPFS is the I/O layer
2. **Worker-isolated rendering** — WebGPU compositor runs in a dedicated worker, never blocks React
3. **Zero-copy pipeline** — VideoFrame travels from hardware decoder to WebGPU texture without a CPU round-trip
4. **Streaming I/O** — files live in OPFS, read in byte-range chunks; never fully loaded into RAM
5. **Proxy-first playback** — timeline scrubs 720p proxies; export uses original source files

## Target Environment

- **Browser:** Chrome 120+ only (WebCodecs + WebGPU most mature; cross-browser is a later concern)
- **Platform:** Desktop only
- **SharedArrayBuffer requires COOP/COEP headers** — every app in this repo sets them (see Shared Config below)

---

## Repo Layout

This repo is a **pnpm workspace**. Every experiment lives under `apps/exp-XX-name/` and is a standalone Next.js 16 app. Dependencies are hoisted via pnpm.

```
experiments/
├── package.json            # workspace root, packageManager pin
├── pnpm-workspace.yaml     # apps/* glob
├── apps/
│   ├── exp-01-opfs/
│   ├── exp-02-demuxer/
│   └── ...
└── docs/
```

### Setup

```bash
# install pnpm globally if you don't have it
npm i -g pnpm@11

# from repo root — installs all apps' deps in one shot
pnpm install
```

### Run an experiment

```bash
# from repo root
pnpm --filter exp-01-opfs dev
pnpm --filter exp-02-demuxer build
```

Or `cd apps/exp-XX-name && pnpm dev`.

### Add a new experiment

```bash
cd apps/
pnpm create next-app exp-XX-name --typescript --tailwind --app --src-dir --eslint --no-import-alias
# then copy shared next.config.ts (see below)
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router, Turbopack) | Latest stable |
| Language | TypeScript 5.5+ strict | No `any` |
| Styling | Tailwind CSS v4 + shadcn/ui | |
| State | Zustand 5 + Immer middleware | Timeline metadata only — never playhead position |
| Demuxer | mp4box.js AND mediabunny | Both evaluated in exp-02; winner used from exp-03 onward |
| Muxer | mediabunny AND mp4-muxer | Both evaluated in exp-10 |
| AI runtime | onnxruntime-web 1.19+ | WebGPU execution provider |

---

## System Architecture

```
Main Thread (React + Zustand UI)
│
├── [canvas.transferControlToOffscreen()] ──► RenderWorker
│                                              ├── WebGPU Device + WGSL Compositor
│                                              ├── FrameCache Tier 1 (VRAM GPUTextures, LRU ~200 frames)
│                                              └── FrameCache Tier 2 (RAM ImageBitmaps, LRU ~900 frames)
│
├── DecodeWorker
│   ├── VideoDecoder (WebCodecs)
│   ├── Demuxer (mp4box.js / mediabunny)
│   └── OPFS FileSystemSyncAccessHandle (byte-range reads)
│
├── AudioWorker
│   ├── AudioDecoder (WebCodecs)
│   └── SharedArrayBuffer ring buffer ──► AudioWorklet (Main Thread AudioContext)
│
├── ProxyWorker  (background — runs automatically on file ingest)
│   ├── Source VideoDecoder
│   ├── Proxy VideoEncoder (H.264, 720p, keyframe every frame)
│   └── mediabunny muxer ──► OPFS proxy file
│
└── AIWorker
    ├── ONNX Runtime Web (WebGPU execution provider)
    └── Segmentation model inference ──► mask GPUTexture ──► RenderWorker compositor
```

---

## Experiment Map

| # | Name | Proves | Key APIs | Depends On | Complexity |
|---|---|---|---|---|---|
| 01 | OPFS File System | Multi-GB ingest without RAM saturation; native-speed byte-range reads | `FileSystemSyncAccessHandle`, Web Worker | — | Low |
| 02 | MP4 Demuxer | Parse MP4 container; build seek index mapping timestamps → I-frame byte offsets | `mp4box.js`, `mediabunny` | 01 | Medium |
| 03 | WebCodecs Decode | Feed GOP byte ranges → VideoDecoder → frame-accurate VideoFrame | `VideoDecoder`, `EncodedVideoChunk`, `VideoFrame` | 02 | Medium |
| 04 | WebGPU Compositor | Zero-copy VideoFrame → `texture_external` → WGSL multi-layer blend | `GPUDevice`, `importExternalTexture`, WGSL | 03 | High |
| 05 | OffscreenCanvas Worker | Move WebGPU rendering off main thread; React UI at 60fps independent of compositor | `OffscreenCanvas`, `transferControlToOffscreen`, `MessageChannel` | 04 | Medium |
| 06 | Frame Cache | 3-tier cache (VRAM / RAM / OPFS); instant scrubbing without decoder round-trip | `LRUCache`, `GPUTexture.destroy()`, `createImageBitmap` | 05 | Medium |
| 07 | Proxy Workflow | Background-transcode source to 720p H.264 proxy; timeline uses proxy, export uses source | `VideoEncoder`, mediabunny, IndexedDB metadata | 03 | Medium |
| 08 | Audio Sync | Frame-accurate A/V sync accounting for `AudioContext.outputLatency` (Bluetooth safe) | `AudioDecoder`, `AudioWorklet`, `SharedArrayBuffer`, `outputLatency` | 03 | High |
| 09 | Timeline State | 500+ clips, playhead at 60fps, zero React re-renders on scrub | Zustand 5, Immer, `react-window`, `useRef` DOM mutation | — | Medium |
| 10 | Export Pipeline | WebGPU → VideoEncoder → mediabunny/mp4-muxer → OPFS → user download | `VideoEncoder`, `showSaveFilePicker`, muxer comparison | 05, 07 | High |
| 11 | AI Background Removal | Client-side segmentation at <100ms/frame via ONNX WebGPU; mask composited in WGSL | `onnxruntime-web`, ONNX WebGPU EP, `Cache API` | 04 | High |
| 12 | Integration | Full mini-NLE: import → proxy → multi-track timeline → play/seek → AI → export | All above | 01–11 | Very High |
| 13 | Color Management & HDR | BT.709 SDR + Display-P3 + HDR10/PQ composited correctly into a selectable target color space | `GPUCanvasContext.configure({colorSpace,toneMapping})`, `VideoFrame.colorSpace`, WGSL PQ/HLG/sRGB EOTF/OETF | 03, 04 | High |
| 14 | WebCodecs Backpressure & VideoFrame Lifetime | 4K60 sustained decode→GPU→close without VRAM growth; deliberate-leak harness | `VideoDecoder.decodeQueueSize`, `VideoFrame.close()` | 03, 06 | Medium |
| 15 | GPU Device-Lost Recovery | Force `device.lost`; rebuild every resource from a registry; resume in <1 s; survive scripted loss loop | `GPUDevice.lost`, `requestAdapter` re-request, resource registry pattern | 04, 05 | High |
| 16 | Project Format, Autosave & Crash Recovery | Versioned OPFS schema with write-ahead journal; reopen after tab-kill replays journal | OPFS sync handles, JSON action log, schema migrator | 01, 09 | Medium |
| 17 | Codec Coverage & HW-Accel Probe | Full `isConfigSupported` matrix → capability profile the rest of the app branches on | `VideoDecoder/VideoEncoder.isConfigSupported`, `navigator.gpu.requestAdapter().info` | 03, 07 | Low |
| 18 | Storage Quota & Eviction Drill | OPFS write loop hits `QuotaExceededError`, LRU-evicts proxies, `persist()` at the right moment | `navigator.storage.estimate/persist`, `QuotaExceededError`, OPFS | 01 | Low |
| 19 | Multi-Tab Coordination via Web Locks | Two tabs negotiate a single OPFS writer; primary fail-over on tab close | `navigator.locks.request`, `BroadcastChannel`, `pagehide` | 01, 16 | Medium |
| 20 | Color Grading: 3D LUT Sampling | Industry `.cube` LUTs (17/33/65-pt) into `texture_3d` with trilinear filtering, matches DaVinci ramp | `GPUTexture` `dimension:"3d"`, WGSL `textureSampleLevel`, `.cube` parser | 04, 13 | Medium |
| 21 | Subtitle/Caption Rendering | Burn-in + live overlay of `.ass` (styles, karaoke, positioning) and `.vtt` cues | `OffscreenCanvas` 2D in Worker, libass-WASM, VTT parser | 04, 05 | Medium |
| 22 | GPU Text Rendering (MSDF) | Arbitrary fonts, kerning, animated transforms at 60fps via SDF atlas | `FontFace.load`, `texture_2d_array<f32>`, WGSL `fwidth` | 04 | High |
| 23 | Effects/Transitions Framework + Bezier Keyframes | Typed effect params, broken-tangent bezier evaluator, deterministic stacked ordering | WGSL preprocessor, custom bezier evaluator, structured-clone | 04, 09 | High |
| 24 | Audio Mixing Graph | Multi-track gain/pan/EQ/compression + sidechain ducking glitch-free under 60fps render load | `AudioWorkletNode`, `AudioParam`, `SharedArrayBuffer`, Wasm AudioWorklets | 08 | High |
| 25 | Waveforms & Filmstrips | Multi-LOD peak files (256/4096/65536) + GOP-thumbnail strips persisted in OPFS | `AudioContext.decodeAudioData`, Worker, low-res WebCodecs decode | 01, 03 | Medium |
| 26 | On-Device Speech-to-Text | 1-hour file → word-level transcript < real-time via Whisper-tiny / Moonshine | `onnxruntime-web` WebGPU EP, WebNN, AudioWorklet VAD, `OfflineAudioContext` | 08, 11, 21 | High |
| 27 | Compute-Pressure Adaptive Quality | `PressureObserver` drops preview res / pauses background work before thermal throttle | `PressureObserver` (CPU+GPU), Long Animation Frames | 04, 07 | Low |
| 28 | Long Animation Frames Budget | Live LoAF observer attributes blocking work; CI fails when median > 50ms | `PerformanceObserver({type:"long-animation-frame"})`, `entry.scripts` | 09, 12 | Low |
| 29 | Screen / Camera Capture Ingest | `getDisplayMedia` 4K30 + system audio → encoder → OPFS, recoverable on crash | `getDisplayMedia`, `MediaStreamTrackProcessor`, `VideoEncoder` | 03, 10 | Medium |
| 30 | PWA Install + File Handlers | Open `.mp4/.mov/.reelproj` from OS via `LaunchQueue`; Web Share Target | `manifest.file_handlers`, `LaunchQueue`, `share_target`, Service Worker | 01 | Low |
| 31 | Snapping Engine + Trim Tools | Frame-accurate magnetic snap + ripple/roll/slip/slide on 500-clip timeline < 16ms latency | `PointerEvent` coalescing, `requestAnimationFrame`, useRef DOM mutation | 09, 25 | Medium |
| 32 | On-Device Silence & Filler-Word Removal | VAD on-device produces a frame-accurate EDL with zero audio upload | `onnxruntime-web` WebGPU EP, `OfflineAudioContext`, Silero-VAD ONNX | 08, 11 | Medium |
| 33 | On-Device Voice Isolation / Denoise | Studio-Sound-grade denoise on-device; AB toggle + render-to-OPFS | `onnxruntime-web` WebGPU EP, `AudioWorkletNode`, DeepFilterNet3 ONNX | 08, 11 | Medium |
| 34 | Saliency-Driven Auto-Reframe | 16:9 → 9:16 / 1:1 / 4:5 reformat with on-device subject tracking | ONNX saliency, `VideoFrame.copyTo`, WGSL crop+rescale, Catmull-Rom smoothing | 04, 11 | Medium |
| 35 | WebGPU Compute Scopes | Luma WFM, RGB parade, vectorscope, histogram via WGSL compute | `GPUComputePipeline`, atomic `r32uint` bins, `bitmaprenderer` mirror | 04, 05, 13 | Medium |
| 36 | Hardware Control Surfaces | X-Touch Mini → lift/gamma/gain; ShuttlePro → jog/scrub; zero install | `navigator.requestMIDIAccess`, `navigator.hid.requestDevice`, per-device parsers | 04, 09 | Low |
| 37 | Provable Privacy Mode | CSP lockdown + live audit panel proves zero outbound bytes per session | Service Worker `fetch` interception, strict CSP `connect-src 'none'`, `PerformanceObserver`, attestation export | — | Low |
| 38 | Plugin / Effect SDK | WGSL + JSON Schema plugins in a sandbox worker, hot-reload < 200 ms | `Worker` (module), `device.createShaderModule`, `FileSystemObserver`, WGSL preprocessor | 04, 05, 23 | High |
| 39 | On-Device Smart-Cut | Long-form → top-N ranked short candidates, on-device, frame-accurate | Whisper-tiny / Moonshine via `onnxruntime-web`, low-res WebCodecs decode, score reweight | 25, 26, 23 | High |

---

## Competitive-Edge Experiments (32 → 39)

Experiments 13–17 hardened the substrate. Experiments 32–39 turn that
substrate into shipping features that competitors **cannot match without
rearchitecting their business**:

- **32 silence-cut**, **33 voice-isolate**, **39 smart-cut** — beat
  Descript / Opus Clip / Submagic by running their flagship AI on-device
  with zero upload.
- **34 auto-reframe** — beat CapCut AutoCut on latency + privacy with
  the same model class.
- **35 scopes** — DaVinci-grade browser color tooling that no
  competitor ships.
- **36 control-surfaces** — WebMIDI + WebHID hardware support; cloud
  editors literally cannot deliver this without a native install.
- **37 privacy-proof** — the marketing differentiator no upload-based
  editor can credibly claim.
- **38 plugin-sdk** — the long-term moat once feature parity lands.

Strategy + market map + per-experiment rationale lives in
[`docs/research-competitive-edge.md`](./docs/research-competitive-edge.md).

---

## Build Order

Build strictly in this sequence. Each app is standalone under `apps/exp-XX-name/`.

```
01 ── 02 ── 03 ── 04 ── 05 ── 06 ── 10
                    │              ▲
                    └── 07 ────────┘
           03 ── 08
           09  (independent — build anytime after you understand Zustand)
           04 ── 11
           01–11 ── 12

# Risk-driven follow-ups (independent; build in priority order)
           03,04 ── 13       (color management & HDR)
           03,06 ── 14       (backpressure & VideoFrame lifetime)
           04,05 ── 15       (device-lost recovery)
           01,09 ── 16       (project format & crash recovery)
           03,07 ── 17       (codec coverage & HW-accel probe)

# Substrate / framework experiments (18–31). Build as integration needs them.
              01 ── 18       (storage quota & eviction)
           01,16 ── 19       (multi-tab web locks)
           04,13 ── 20       (3D LUT sampling)
           04,05 ── 21       (subtitles ASS/VTT)
              04 ── 22       (MSDF text rendering)
           04,09 ── 23       (effects + bezier keyframes)   # unblocks 38, 39
              08 ── 24       (audio mixing graph)
           01,03 ── 25       (waveforms + filmstrips)       # unblocks 31, 39
        08,11,21 ── 26       (on-device speech-to-text)     # unblocks 39
           04,07 ── 27       (compute-pressure adapt)
           09,12 ── 28       (LoAF performance budget)
           03,10 ── 29       (screen/camera capture)
              01 ── 30       (PWA file handlers)
           09,25 ── 31       (snapping + ripple/roll/slip/slide)

# Competitive-edge experiments (32–39). Recommended order:
# front-load the cheap, provably differentiating wins so the demo
# reel exists before the harder AI integrations land.
                  ── 37       (privacy proof — pure marketing leverage)
           04,05,13 ── 35     (GPU scopes)
              04,09 ── 36     (hardware control surfaces)
              04,11 ── 34     (auto-reframe)
              08,11 ── 32     (silence + filler cut)
              08,11 ── 33     (voice isolation)
        25,26,23   ── 39       (smart-cut)
        04,05,23   ── 38       (plugin SDK)
```

**Do not skip experiments.** Each one exposes specific pitfalls (memory leaks, API limits, browser quirks) that will silently break the next experiment if not understood first.

---

## Shared Next.js Config (apply to every experiment)

All experiments require COOP/COEP headers for `SharedArrayBuffer` (used in audio ring buffer) and for some WebGPU contexts.

```ts
// next.config.ts  (copy this to every apps/exp-XX-*/next.config.ts)
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ]
  },
}

export default nextConfig
```

---

## Worker Instantiation Pattern (Next.js 15 + Turbopack)

Next.js 15 with Turbopack resolves worker imports at build time when written as:

```ts
// ✅ Correct — Turbopack resolves this
const worker = new Worker(
  new URL('../workers/decode.worker.ts', import.meta.url)
)

// ❌ Wrong — breaks in SSR / Turbopack
const worker = new Worker('/workers/decode.worker.ts')
```

**Rules for every experiment:**
- Any page that touches Web APIs must have `'use client'` at the top
- Instantiate workers inside `useEffect(() => { ... }, [])`, never at module scope
- Guard with `if (typeof window === 'undefined') return` to prevent SSR crash
- Store worker in `useRef<Worker | null>(null)`, not `useState` — prevents re-instantiation on re-renders
- Always `workerRef.current?.terminate()` in the `useEffect` cleanup return

---

## Memory Leak Rules (apply everywhere)

These three rules must be followed in every experiment, no exceptions:

1. **Every `VideoFrame` must be `.close()`d** — frames hold GPU texture memory; leaks crash the tab
2. **Every `GPUTexture` must be `.destroy()`d** when evicted from cache
3. **Every `AudioData` must be `.close()`d** — holds audio buffer memory

Use Chrome DevTools → Memory tab → "Take heap snapshot" after 60 seconds of use to verify nothing accumulates.

---

## Definition of Done (per experiment)

An experiment is complete when:
1. `pnpm --filter exp-XX-name dev` starts without error
2. All success criteria in the experiment doc are met and measured (not estimated)
3. All known pitfalls listed in the doc have been explicitly handled
4. Chrome DevTools Memory snapshot shows no growing heap after 60s of use
5. Chrome DevTools Performance tab shows no long tasks (>50ms) on the main thread during the experiment's primary operation

---

## Experiments

- [01 · OPFS File System](./docs/exp-01-opfs.md)
- [02 · MP4 Demuxer](./docs/exp-02-demuxer.md)
- [03 · WebCodecs Decode](./docs/exp-03-webcodecs-decode.md)
- [04 · WebGPU Compositor](./docs/exp-04-webgpu-compositor.md)
- [05 · OffscreenCanvas Worker](./docs/exp-05-offscreen-worker.md)
- [06 · Frame Cache](./docs/exp-06-frame-cache.md)
- [07 · Proxy Workflow](./docs/exp-07-proxy-workflow.md)
- [08 · Audio Sync](./docs/exp-08-audio-sync.md)
- [09 · Timeline State](./docs/exp-09-timeline-state.md)
- [10 · Export Pipeline](./docs/exp-10-export-pipeline.md)
- [11 · AI Background Removal](./docs/exp-11-ai-background.md)
- [12 · Integration](./docs/exp-12-integration.md)
- [13 · Color Management & HDR](./docs/exp-13-color-management.md)
- [14 · WebCodecs Backpressure & VideoFrame Lifetime](./docs/exp-14-backpressure.md)
- [15 · GPU Device-Lost Recovery](./docs/exp-15-device-lost.md)
- [16 · Project Format, Autosave & Crash Recovery](./docs/exp-16-project-format.md)
- [17 · Codec Coverage & HW-Accel Probe](./docs/exp-17-codec-probe.md)
- [18 · Storage Quota & Eviction Drill](./docs/exp-18-storage-quota.md)
- [19 · Multi-Tab Coordination via Web Locks](./docs/exp-19-web-locks.md)
- [20 · Color Grading: 3D LUT Sampling](./docs/exp-20-lut-3d.md)
- [21 · Subtitle/Caption Rendering (ASS + WebVTT)](./docs/exp-21-subtitles.md)
- [22 · GPU Text Rendering (MSDF)](./docs/exp-22-msdf-text.md)
- [23 · Effects/Transitions Framework + Bezier Keyframes](./docs/exp-23-effects-keyframes.md)
- [24 · Audio Mixing Graph (Gain/Pan/EQ/Compression/Ducking)](./docs/exp-24-audio-mixing.md)
- [25 · Waveform Generation & Filmstrip Thumbnails](./docs/exp-25-waveforms.md)
- [26 · Speech-to-Text / Auto-Captions On-Device](./docs/exp-26-speech-to-text.md)
- [27 · Compute-Pressure Adaptive Quality](./docs/exp-27-compute-pressure.md)
- [28 · Long Animation Frames Performance Budget](./docs/exp-28-loaf-budget.md)
- [29 · Screen / Camera Capture Ingest](./docs/exp-29-capture-ingest.md)
- [30 · PWA Install + File Handlers + Web Share Target](./docs/exp-30-pwa-files.md)
- [31 · Snapping Engine + Ripple/Roll/Slip/Slide](./docs/exp-31-snapping-trim.md)
- [32 · On-Device Silence & Filler-Word Removal](./docs/exp-32-silence-cut.md)
- [33 · On-Device Voice Isolation / Denoise](./docs/exp-33-voice-isolate.md)
- [34 · Saliency-Driven Auto-Reframe](./docs/exp-34-auto-reframe.md)
- [35 · WebGPU Compute Scopes](./docs/exp-35-scopes.md)
- [36 · Hardware Control Surfaces (WebMIDI + WebHID)](./docs/exp-36-control-surfaces.md)
- [37 · Provable Privacy Mode](./docs/exp-37-privacy-proof.md)
- [38 · Plugin / Effect SDK](./docs/exp-38-plugin-sdk.md)
- [39 · On-Device Smart-Cut (Long-form → Short-form)](./docs/exp-39-smart-cut.md)

Strategy: [Competitive-Edge Research (May 2026)](./docs/research-competitive-edge.md)
