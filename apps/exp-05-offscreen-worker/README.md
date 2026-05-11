# exp-05 · OffscreenCanvas Worker

## Purpose

Move the **entire** WebGPU render loop off the main thread using `OffscreenCanvas`. React UI, state updates, and DOM layout cannot drop video frames anymore. The render worker also owns the decode worker as a sub-worker so frame-fetching never goes through main thread.

## Architecture

```
Main Thread (page.tsx)
├── canvasRef.transferControlToOffscreen() -> OffscreenCanvas (one-way!)
├── new Worker("../workers/render.worker.ts", {type:"module"})
├── postMessage({type:"INIT", canvas, dpr}, [canvas])  # transfer
├── PLAY/PAUSE/SEEK messages -> render worker
├── React-stress button: 100 staggered setStates (must NOT cause frame drops)
└── Receives STATS (1Hz): fps, playheadUs

render.worker.ts
├── INIT: keep OffscreenCanvas; init WebGPU; build pipeline + sampler + uniform buf
├── Spawns sub-worker: new Worker(new URL("./decode.worker.ts", import.meta.url))
├── MessageChannel rAF replacement:
│     channel.port2.onmessage = () => { if (isPlaying) tick(); port1.postMessage(null); }
│     # Fires at vsync rate while tab active. setInterval is throttled and drifts.
├── tick(): advance playheadUs by elapsed wall-clock; loop on duration; requestFrame(playheadUs)
├── On {type:"FRAME"} from decoder: close prev currentFrame, drawCurrent()
├── drawCurrent(): importExternalTexture -> bindGroup -> draw -> submit (synchronous block)
└── 1Hz: post {type:"STATS", fps, playheadUs}

decode.worker.ts (sub-worker)
└── Same as exp-03/04: LOAD + SEEK; emits FRAME with VideoFrame transferable
```

## Research notes

- **`requestAnimationFrame` does not exist in workers.** The portable replacement is the `MessageChannel` ping-pong pattern: `port2.onmessage` fires *immediately* (not throttled) but is implicitly aligned to the browser's render scheduler when the tab is active. Drift-free unlike `setInterval`.
- **`transferControlToOffscreen()` is one-way and irreversible.** Once called, the original `<canvas>` cannot be drawn to from main thread ever again. Calling it twice on the same canvas (StrictMode double-effect) throws `InvalidStateError`. We guard with `initializedRef`.
- **Set canvas pixel size BEFORE transferring.** Default `<canvas>` is 300×150. Multiply `clientWidth/Height * devicePixelRatio` first; the OffscreenCanvas inherits whatever pixel dims existed at transfer time.
- **Chrome canvas limit is 32 hardware-accelerated canvases.** Each OffscreenCanvas with WebGPU counts. Editor must own exactly one render canvas.
- **Sub-worker spawning works inside Next 16 + Turbopack** when the path is `new URL("./decode.worker.ts", import.meta.url)` (relative to the worker file) and `{type:"module"}` is set.
- **Wall-clock advance vs frame-count advance.** `tick()` advances `playheadUs += elapsed_ms * 1000` rather than a fixed `stepUs` per call, so a single skipped vsync (GC pause, browser hiccup) self-corrects on the next tick rather than slipping behind audio.

## Files

| File | Purpose |
|---|---|
| `src/workers/render.worker.ts` | OffscreenCanvas + WebGPU + decode sub-worker + rAF loop |
| `src/workers/decode.worker.ts` | Inherited from exp-03 |
| `src/shaders/composite.wgsl.ts` | Inherited from exp-04 |
| `src/lib/types.ts` | Inherited from exp-02 |
| `src/app/page.tsx` | Transport controls + React-stress button |

## Run

```bash
pnpm --filter exp-05-offscreen-worker dev
```

## Success criteria

| Metric | Target |
|---|---|
| Steady playback fps reported by render worker | matches source fps ± 1 |
| 100 main-thread setStates while playing | zero frame drops |
| Main-thread CPU during playback | < 5% |
| Render-worker CPU at 1080p | < 20% |
| SEEK to new timestamp | < 500ms to first paint |
