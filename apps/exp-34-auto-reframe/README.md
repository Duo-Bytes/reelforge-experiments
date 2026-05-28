# exp-34-auto-reframe · Saliency-Driven Auto-Reframe

## Purpose

Edge experiment for the privacy-first, in-browser NLE. Attacks: **CapCut AutoCut; Riverside Smart Layouts**.

Why this edge is real, the full design, success criteria, and foot-guns
are documented in [`docs/exp-34-auto-reframe.md`](../../docs/exp-34-auto-reframe.md). Broader
competitive context: [`docs/research-competitive-edge.md`](../../docs/research-competitive-edge.md).

## Run

```bash
pnpm --filter exp-34-auto-reframe dev
```

## Status

v2 — real on-device subject tracking. **YOLOS-tiny** object detection
runs via Transformers.js (onnxruntime-web, WebGPU EP, wasm fallback) in
`src/workers/detect.worker.ts`. The rAF loop samples a 256 px downscale
every ~150 ms (single inference in flight at a time), picks the
highest-confidence subject (preferring `person`), normalises the box,
and feeds it into the Catmull-Rom-smoothed focus path. The crop is
clamped to the source on both axes and rendered into the target aspect
(9:16 / 1:1 / 4:5) over a CapCut-style blurred letterbox. A brightness
center-of-mass heuristic drives the preview until the model is ready.
Model weights download once, then cache on-device.

Remaining: apply the crop in the exp-04 WGSL compositor; add a jerk
limit; manual override; optionally a distilled face model to cut
latency.
