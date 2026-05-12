# Exp-15 · GPU Device-Lost Recovery

## Goal

When `device.lost` fires (forced via DevTools, driver update,
background-tab eviction), recreate adapter/device, re-upload
pipelines/buffers/textures, and resume rendering within &lt; 1 s. Survive
a scripted loop of forced losses indefinitely.

## App Location

`apps/exp-15-device-lost/`

## Why This Matters in the Full NLE

No engine (Three.js, PlayCanvas, Bevy) has fully solved device-lost
recovery as of late 2025. Chrome loses the WebGPU device on driver
updates, OS sleep/wake, and tab throttle. Without a tested path, the
editor silently corrupts unsaved work in any session over a few hours.

## Key APIs

| API | Where used |
|---|---|
| `GPUDevice.lost` Promise | Resolves with `GPUDeviceLostInfo { reason, message }` |
| `GPUAdapter.requestDevice()` | Allocate a fresh device on recovery |
| `device.destroy()` | Force a loss for testing |
| `GPUDevice.addEventListener("uncapturederror")` | Log validation errors |

## Architecture

```
GpuRuntime (src/lib/registry.ts)
├── adapter, device
├── ResourceRegistry: name → factory(device) → resource
│   ├── shader-module
│   ├── pipeline (deps: shader-module)
│   ├── uniform buffer
│   ├── storage buffer
│   └── bind group (deps: pipeline, buffers)
├── device.lost.then(onLost)
│   ├── log LossEvent { reason, occurredAt }
│   ├── set state = "recovering"
│   ├── new adapter / device
│   ├── new ResourceRegistry, replay every factory
│   ├── reconfigure canvas context with new device
│   └── set state = "ready", record recoveryMs
└── render loop: only renders when state === "ready"
```

The page registers all GPU resources by name and looks them up by name
each frame. After recovery, the same names map to fresh resources on the
new device — no caller code changes.

## Success Criteria

1. Force-loss button: state cycles ready → lost → recovering → ready in
   100–500 ms; render resumes on the next frame.
2. Scripted loss loop at 5 s intervals for 5 minutes: zero failures,
   median recovery &lt; 1 s, fps within 10% of baseline between losses.
3. `recoveries` uniform increments by 1 per recovery — proves the
   storage buffer was re-uploaded after rebuild.

## Foot-guns

- `GPUCanvasContext` does not survive device loss; reconfigure with the
  new device after every recovery.
- `device.lost` is a one-shot Promise — re-attach the handler on the
  new device.
- Avoid recovery storms: cap at 5 unrecovered losses in 10 s and go to
  `failed` rather than spinning.
