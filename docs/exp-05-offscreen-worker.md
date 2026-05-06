# Exp-05 · OffscreenCanvas Worker

## Goal

Move the entire WebGPU render loop (exp-04) off the main thread using `OffscreenCanvas`. The main thread only handles React UI and sends lightweight messages (PLAY/PAUSE/SEEK). Prove that React re-renders cannot drop video frames.

---

## App Location

`apps/exp-05-offscreen-worker/`

## Why This Matters in the Full NLE

React state updates, DOM layout recalculations, JavaScript GC — these all run on the main thread and take non-deterministic time. If WebGPU also runs on the main thread (exp-04 style), any React update while rendering a frame causes a dropped frame. With OffscreenCanvas, the render worker has its own execution context and the 60fps loop cannot be interrupted by anything happening in React.

---

## Key APIs

| API | Purpose |
|---|---|
| `canvas.transferControlToOffscreen()` | Creates an `OffscreenCanvas`, transfers GPU context ownership |
| `postMessage(msg, [offscreen])` | Transfer the OffscreenCanvas to a worker (transferable) |
| `MessageChannel` | rAF-equivalent in workers (see below) |
| `OffscreenCanvas.getContext('webgpu')` | Get WebGPU context inside the worker |

---

## Architecture

```
Main Thread (React)
│
├── <canvas ref={canvasRef}> — visible DOM canvas
│
├── useEffect on mount:
│   ├── const offscreen = canvasRef.current.transferControlToOffscreen()
│   ├── worker = new Worker(new URL('../workers/render.worker.ts', import.meta.url))
│   └── worker.postMessage({ type: 'INIT', canvas: offscreen }, [offscreen])
│
├── Play button click: worker.postMessage({ type: 'PLAY' })
├── Pause button click: worker.postMessage({ type: 'PAUSE' })
└── Seek slider change: worker.postMessage({ type: 'SEEK', timestampUs: T })

RenderWorker
├── Receives INIT: stores OffscreenCanvas, initializes WebGPU on it
├── MessageChannel rAF loop: renders frames continuously when playing
├── Receives PLAY: starts loop
├── Receives PAUSE: stops loop
└── Receives SEEK: jumps to timestamp, renders that frame
```

---

## Implementation Steps

### 1. The rAF-equivalent in workers

`requestAnimationFrame` is NOT available in Web Workers. `setInterval` in workers is throttled by Chrome (minimum 1ms but unreliable at 60fps). The standard workaround is `MessageChannel`:

```ts
// Inside render.worker.ts

let isPlaying = false
const { port1, port2 } = new MessageChannel()

// port2 fires immediately when port1 sends — no throttling
port2.onmessage = () => {
  if (isPlaying) {
    renderCurrentFrame()
    port1.postMessage(null)  // schedule next frame
  }
}

function startLoop() {
  isPlaying = true
  port1.postMessage(null)  // kick off the loop
}

function stopLoop() {
  isPlaying = false
  // loop stops naturally — port2.onmessage won't reschedule
}
```

The `MessageChannel` pattern fires at the browser's native vsync rate when the tab is active, giving ~16.67ms intervals at 60fps. Unlike `setInterval(fn, 16)`, it does not drift.

### 2. Transfer the OffscreenCanvas

```tsx
// page.tsx — 'use client'
useEffect(() => {
  if (typeof window === 'undefined') return

  const canvas = canvasRef.current!
  const offscreen = canvas.transferControlToOffscreen()
  // After this call: canvasRef.current still exists in the DOM but is a "detached" canvas
  // You can still read its clientWidth/clientHeight but cannot draw to it from main thread

  const worker = new Worker(
    new URL('../workers/render.worker.ts', import.meta.url)
  )
  workerRef.current = worker

  // offscreen is Transferable — must be in the transfer array
  worker.postMessage({ type: 'INIT', canvas: offscreen }, [offscreen])

  worker.onmessage = (e) => {
    if (e.data.type === 'FRAME_RENDERED') {
      // Update playhead position in React state (if needed for UI sync)
      setCurrentTimestampUs(e.data.timestampUs)
    }
  }

  return () => worker.terminate()
}, [])
```

### 3. Initialize WebGPU inside the worker

```ts
// render.worker.ts

let device: GPUDevice
let context: GPUCanvasContext
let pipeline: GPURenderPipeline

self.onmessage = async (e) => {
  if (e.data.type === 'INIT') {
    await initWebGPU(e.data.canvas as OffscreenCanvas)
    return
  }
  if (e.data.type === 'PLAY') { startLoop(); return }
  if (e.data.type === 'PAUSE') { stopLoop(); return }
  if (e.data.type === 'SEEK') { await seekAndRender(e.data.timestampUs); return }
}

async function initWebGPU(canvas: OffscreenCanvas) {
  const adapter = await navigator.gpu.requestAdapter()
  device = await adapter!.requestDevice()
  const format = navigator.gpu.getPreferredCanvasFormat()

  context = canvas.getContext('webgpu') as GPUCanvasContext
  context.configure({ device, format, alphaMode: 'premultiplied' })

  pipeline = createPipeline(device, format)  // from exp-04
  startLoop()
}
```

### 4. Coordinate the decode pipeline with the render worker

The render worker needs frames to render. Two options:

**Option A (Recommended): Render worker owns decode worker.**
The render worker spawns the decode worker as a sub-worker. When it needs a frame for timestamp T, it sends a `DECODE` message and the sub-worker responds with a `VideoFrame`.

**Option B: Main thread coordinates.**
Main thread asks decode worker for frames and forwards them to render worker. This adds one extra postMessage hop per frame (~0.1ms, usually acceptable but adds complexity).

For this experiment, use Option A. The render worker spawns:
```ts
// Inside render.worker.ts
const decodeWorker = new Worker(new URL('./decode.worker.ts', import.meta.url))
```

### 5. Demonstrate isolation

Add a "Stress React" button to the main thread that triggers 100 state updates in rapid succession (simulating a complex UI interaction). Measure: does the video playback stutter? With OffscreenCanvas, it should not.

```tsx
const stressReact = () => {
  for (let i = 0; i < 100; i++) {
    setTimeout(() => setCounter(c => c + 1), i * 5)
  }
}
```

Record before/after with Chrome DevTools Performance. The render worker's frame loop must be completely unaffected.

---

## Known Pitfalls

**Chrome canvas limit: 32 active hardware-accelerated canvases.**
Each `OffscreenCanvas` using WebGPU counts toward this limit. Never create a new OffscreenCanvas per clip or per worker — there is exactly one OffscreenCanvas per editor instance, owned by the single render worker. If you hit this limit, older canvases are demoted to software rendering without any error.

**`transferControlToOffscreen()` is one-way and irreversible.**
After calling it, you can NEVER draw to the original canvas from the main thread. The main thread canvas is permanently "detached." Its `width` and `height` are still readable, but any attempt to `getContext()` on it will return null. This is fine — the worker owns rendering.

**React StrictMode double-invocation.**
React 18 StrictMode in development invokes `useEffect` cleanup + setup twice to detect side effects. If `transferControlToOffscreen()` is called twice on the same canvas, the second call throws `InvalidStateError`. Guard with:
```ts
if (workerRef.current) return  // already initialized
```

**Worker file location in Next.js.**
Worker files must be in the `src/` directory (not `public/`) and imported via `new URL(...)` syntax. Files in `public/` are served as static assets and cannot be imported as workers with proper TypeScript bundling.

**OffscreenCanvas size.**
The `OffscreenCanvas` you create from `transferControlToOffscreen()` has the canvas's initial `width` and `height` attributes. If the React component hasn't set these (defaulting to 300×150), your video preview will be tiny. Set `canvas.width` and `canvas.height` from the DOM dimensions before calling `transferControlToOffscreen()`:
```ts
canvas.width = canvas.clientWidth * window.devicePixelRatio
canvas.height = canvas.clientHeight * window.devicePixelRatio
```

---

## Success Criteria

| Metric | Target |
|---|---|
| Video plays at 30fps without stutter | No frame drops during normal playback |
| 100 rapid React state updates cause 0 frame drops | Verified in DevTools Performance |
| Main thread CPU during video playback | < 5% |
| Render worker CPU during 1080p playback | < 20% |
| SEEK to a new timestamp | < 500ms to render the new frame |

---

## Feeds Into

- **Exp-06** adds the frame cache inside the render worker to reduce seek latency
- **Exp-08** adds audio sync by having the render worker read `AudioContext.currentTime` for timestamp targeting
- **Exp-10** replaces the rAF loop with an uncapped export loop in the render worker
