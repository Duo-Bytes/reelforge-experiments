# Exp-34 · Saliency-Driven Auto-Reframe

## Goal

Take a 16:9 source clip, detect the salient subject per frame with a
lightweight on-device model, smooth the focus path with a low-pass +
jerk limiter, and apply the resulting crop+rescale as a GPU pass in the
exp-04 compositor — producing a clean 9:16 / 1:1 / 4:5 reformat in real
time without manual keyframing.

## App Location

`apps/exp-34-auto-reframe/`

## Why This Matters — Competitive Edge

CapCut "AutoCut" and Riverside "Smart Layouts" are both cloud features
requiring upload. Auto-reframing is the single most-used short-form
preprocessing step in 2026. Doing it locally with real-time preview,
manual override, and output into a *real timeline* (not a render-job
artifact) beats the cloud version on every axis except absolute model
quality — which is closing fast as MobileSAM-tier models hit WebGPU.

See [`research-competitive-edge.md`](./research-competitive-edge.md) §34.

## Key APIs

| API | Where used |
|---|---|
| `onnxruntime-web` WebGPU EP | MobileSAM-distilled or saliency classifier |
| `VideoFrame.copyTo` → `ImageBitmap` | Cheap 480p downsample for the model |
| WGSL fragment pass | Crop + rescale in compositor |
| Catmull-Rom / Hermite spline | Smoothing focus-point timeline |
| Zustand store (exp-09) | Per-clip reframe params, keyframed |

## Pipeline

```
source 4K VideoFrame
  ├─ exp-04 compositor texture_external  (unchanged path)
  └─ copyTo ImageBitmap @ 480p
        └─ ONNX saliency model (WebGPU EP)
             └─ argmax (x,y,w,h) ─► focus rect (clip-space)
                  └─ stored per sample frame in Zustand
                       └─ Catmull-Rom interpolated per-frame focus rect
                            └─ WGSL crop+rescale pass with target aspect
                                 └─ output canvas at 1080×1920 etc.
```

Sampling rate: model runs on ~10 % of frames (every 3rd at 30 fps), the
rest interpolate. Falls back to centered crop when confidence < threshold.

## Success Criteria

1. A 30-second 4K30 talking-head clip is reformatted to 9:16 in under
   real time on a 2024 MacBook Pro.
2. Subject stays within the centered safe area across head-tilts and
   pans; no visible "lock-on" jitter (jerk-limit kicks in).
3. Manual override: dragging the crop overlay locks the auto-track until
   the user releases.
4. Zero outbound bytes.
5. Memory snapshot stable after 10 consecutive 30-s reformats.

## Foot-guns

- Inference on a 4K frame is slow even at low res; always downscale to
  ≤ 480p first. Use `OffscreenCanvas.transferToImageBitmap` for the
  downscale — it's GPU-side.
- Saliency model output is a `Float32Array` heatmap; convert to a
  bounding box via thresholded center-of-mass, not greedy argmax.
- Smoothing window of 5 samples is the floor; 10+ feels less twitchy but
  loses fast pans.
- Aspect-ratio mismatch on edges: pad with a blurred copy of the source
  (Gaussian + brightness clamp) — the CapCut "blurred letterbox" look —
  rather than black bars.
- VideoFrame `copyTo` must `.close()` immediately after; the model
  worker owns the bitmap until inference returns.

## Demo

- Drop a `.mp4`. Pick target aspect (9:16, 1:1, 4:5).
- Real-time preview of the reframed output beside the original.
- Edit the per-frame focus rect by dragging; bezier handles for manual
  override.
- Outbound byte counter, always 0.
