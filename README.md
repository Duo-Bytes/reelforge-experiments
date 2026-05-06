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
